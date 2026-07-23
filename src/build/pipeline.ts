/**
 * The build pipeline: preflight → acquire → stage → verify → journaled atomic
 * swap → record `.anvil/refs/built`. Offline and fixture-driven in Stage 1; the
 * lock is the sole build input. Every build first recovers any interrupted prior
 * swap, so the instance is always reconciled to a consistent state before work.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AnvilEvent } from "../events.js";
import type { FaultHook } from "../internal/faults.js";
import { ensureDir } from "../internal/fs.js";
import type { ContentStore } from "../store/index.js";
import { executePlacement } from "../store/index.js";
import { hashFile } from "../store/index.js";
import type { ReplayCache } from "../store/replay-cache.js";
import { ShaMismatch } from "../types/errors.js";
import type { LockPackage, Lockfile } from "../types/index.js";
import type { Acquirer } from "./acquire.js";
import type { IgnoreSet } from "./anvilignore.js";
import { loadIgnoreSet } from "./anvilignore.js";
import { diffLocks } from "./incremental.js";
import type { Platform, Rule } from "./preflight.js";
import {
  assertNativesSatisfiable,
  checkDiskSpace,
  filterByRules,
  filterByTargets,
} from "./preflight.js";
import { writeBuiltLock } from "./refs.js";
import { journaledSwap, recoverSwap, stageRootOf } from "./swap.js";

export interface BuildEngineInput {
  readonly instanceDir: string;
  /** The sole build input. */
  readonly lock: Lockfile;
  readonly store: ContentStore;
  readonly acquire: Acquirer;
  /**
   * The per-instance replay cache — where `provenance: "replay"` (CurseForge)
   * objects are materialized from (never the shared store). Required when the
   * lock contains a replay item; a copy-only build may omit it.
   */
  readonly replayCache?: ReplayCache;
  /**
   * The mapped `[paths].assets` shared object pool, when set. Asset-tree objects
   * land there (referenced by an `assets/objects` symlink) instead of a
   * per-instance copy; absent → the instance's own `assets/` is self-contained.
   */
  readonly assetsDir?: string;
  readonly platform: Platform;
  /** The previous built lock, for the incremental delta (usually from refs). */
  readonly previousLock?: Lockfile;
  /** Protected paths; loaded from `.anvilignore` when omitted. */
  readonly ignore?: IgnoreSet;
  /** Optional per-package platform rules (Stage 2/3 feeds these). */
  readonly rules?: ReadonlyMap<string, readonly Rule[]>;
  /** Test-only crash hook threaded into the swap (and store writes). */
  readonly fault?: FaultHook;
  readonly emit?: (event: AnvilEvent) => void;
  readonly diskHeadroomBytes?: number;
}

export interface BuildEngineResult {
  readonly dir: string;
  /** Objects materialized this build (the delta size). */
  readonly objects: number;
  readonly stageId: string;
}

/** Re-hash the staged single-file targets against their pins before the swap. */
async function verifyStage(
  store: ContentStore,
  stageRoot: string,
  install: readonly LockPackage[],
  emit: (event: AnvilEvent) => void,
): Promise<void> {
  const single = install.filter(
    (p) => p.placement.method === "link" || p.placement.method === "asset-tree",
  );
  emit({ type: "verify:start", items: single.length });
  let mismatches = 0;
  for (const pkg of single) {
    const rel =
      pkg.placement.method === "link"
        ? pkg.placement.target
        : pkg.placement.method === "asset-tree"
          ? pkg.placement.indexTarget
          : "";
    const actual = await hashFile(join(stageRoot, rel), pkg.hash.algo);
    const ok = actual.value === pkg.hash.value;
    if (!ok) {
      mismatches += 1;
      emit({ type: "verify:item", name: pkg.name, ok: false });
      throw new ShaMismatch(`staged ${pkg.name}`, pkg.hash, actual);
    }
    emit({ type: "verify:item", name: pkg.name, ok: true });
  }
  emit({ type: "verify:done", ok: mismatches === 0, mismatches });
}

/** Run one build to completion (or throw, leaving the instance reconciled by recovery). */
export async function buildInstance(input: BuildEngineInput): Promise<BuildEngineResult> {
  const { instanceDir, store, acquire, platform, fault } = input;
  const emit = input.emit ?? (() => undefined);

  // 0. Reconcile any interrupted prior swap, then reap store temp orphans.
  await recoverSwap(instanceDir, fault);
  await store.sweepTmp();

  const ignore = input.ignore ?? (await loadIgnoreSet(instanceDir));
  const stageId = randomUUID();
  emit({ type: "build:start", stageId });

  // 1. Preflight: fail loud on any native the host needs but lacks for its arch,
  //    then filter to the host's applicable set (external rules map + each
  //    package's intrinsic per-platform `targets`), then check disk space.
  emit({ type: "build:stage", phase: "preflight" });
  assertNativesSatisfiable(input.lock.resolved, platform);
  const ruled = filterByRules(input.lock.resolved, platform, input.rules);
  const effective = filterByTargets(ruled, platform);
  const effectiveLock: Lockfile = { meta: input.lock.meta, resolved: effective };
  await checkDiskSpace(instanceDir, effective, input.diskHeadroomBytes);

  // 2. Incremental delta.
  const delta = diffLocks(input.previousLock, effectiveLock);
  const bytes = delta.install.reduce((s, p) => s + (p.size ?? 0), 0);
  emit({ type: "transfer:plan", objects: delta.install.length, bytes });

  // 3. Acquire the delta objects into the store (offline/fixture fetch).
  emit({ type: "build:stage", phase: "acquire" });
  for (const pkg of delta.install) {
    await acquire.ensure(pkg);
  }

  // 4. Stage: materialize the delta into a same-volume stage dir.
  emit({ type: "build:stage", phase: "stage" });
  const stageRoot = stageRootOf(instanceDir, stageId);
  await ensureDir(stageRoot);
  for (const pkg of delta.install) {
    const outcome = await executePlacement(pkg, {
      store,
      stageRoot,
      instanceDir,
      ...(input.assetsDir ? { assetsDir: input.assetsDir } : {}),
      ...(input.replayCache ? { replayCache: input.replayCache } : {}),
    });
    if (outcome.targets.length > 0) {
      emit({
        type: "object:link",
        hash: pkg.hash,
        placement: pkg.placement,
        strategy: outcome.strategy ?? "copy",
      });
    }
  }

  // 5. Verify the staged tree against the lock.
  emit({ type: "build:stage", phase: "verify" });
  await verifyStage(store, stageRoot, delta.install, emit);

  // 6. Journaled atomic swap.
  emit({ type: "build:stage", phase: "swap" });
  emit({ type: "build:swap", stageId });
  await journaledSwap({
    instanceDir,
    stageId,
    installs: delta.installTargets,
    removes: delta.removeTargets,
    ignore,
    fault,
  });

  // 7. Record the built lock (the incremental baseline + GC root).
  await writeBuiltLock(instanceDir, effectiveLock);

  emit({ type: "build:done", dir: instanceDir });
  return { dir: instanceDir, objects: delta.install.length, stageId };
}
