/**
 * The placement executor: turn a pinned {@link LockPackage} into materialized
 * bytes under a stage root, per its {@link Placement} discriminant.
 *
 *   - `link`       — link the object to a single target path (mod/resourcepack).
 *   - `extract`    — safe-extract the object (a natives jar) under a target dir,
 *                    excluding `META-INF/`, through the hardened `safeExtract`.
 *   - `asset-tree` — materialize a Mojang asset index AND every object it names
 *                    into the instance's `assets/` tree (`indexes/<id>.json` +
 *                    `objects/<xx>/<sha1>`), so the folder is a complete,
 *                    launch-ready `.minecraft` assets dir — not just the index.
 *   - `store-only` — assert the object is present; place nothing in the instance.
 *
 * Every target path passes through `safeJoin`, so a placement can never write
 * outside the instance or into a protected path (`saves/`, `.anvil/`). Every
 * call also passes `rejectColon: true` (LB-827): a target here is always
 * lock/manifest-derived, never a file already sitting in the user's own
 * instance, so refusing a `:`-bearing segment (an NTFS alternate-data-stream
 * trigger on Windows) costs nothing and closes the placement half of that gap.
 * `extract` additionally passes `rejectColon: true` through to `safeExtract`
 * itself — that guards the archive's OWN entries (a natives jar with a
 * `evil:stream.dll` member), which `destDir`'s `safeJoin` check cannot see,
 * because this extraction lands on the build's instance stage, not a
 * throwaway dir.
 */

import { randomUUID } from "node:crypto";
import { chmod, symlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Platform } from "../build/preflight.js";
import type { LinkStrategy } from "../events.js";
import { runForgeProcessors } from "../game/forge-build.js";
import { parseForgePlan } from "../game/forge-install.js";
import { type ProcessorRunner, allowAllProcessors } from "../game/forge-processors.js";
import { ensureDir, pathExists, removePath, safeJoin } from "../internal/fs.js";
import { MissingObject, PathEscape, UnsatisfiableTarget } from "../types/errors.js";
import type { AllowProcessor, Hash, LockPackage } from "../types/index.js";
import { shardOf } from "./hash.js";
import type { ReplayCache } from "./replay-cache.js";
import { excludeMetaInf, safeExtract } from "./safe-extract.js";
import type { ContentStore } from "./store.js";

/** The Mojang asset index shape (`assets/indexes/<id>.json`). */
export interface AssetIndex {
  readonly objects: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
}

/** One entry in a Mojang java-runtime per-platform manifest. */
export type RuntimeFile =
  | { readonly type: "directory" }
  | {
      readonly type: "file";
      readonly executable?: boolean;
      readonly downloads: {
        readonly raw: { readonly sha1: string; readonly size?: number; readonly url?: string };
      };
    }
  | { readonly type: "link"; readonly target: string };

/** The Mojang java-runtime per-platform manifest shape (`files` keyed by rel path). */
export interface RuntimeManifest {
  readonly files: Readonly<Record<string, RuntimeFile>>;
}

export interface PlacementContext {
  readonly store: ContentStore;
  /** The stage root the build materializes into before the atomic swap. */
  readonly stageRoot: string;
  /**
   * The instance root. An `asset-tree` fans its object closure into this
   * instance's `assets/objects/<xx>/<sha1>` (additive, content-addressed,
   * idempotent) so the built folder is a self-contained, launch-ready
   * `.minecraft` — the index alone (staged + swapped) is not enough.
   */
  readonly instanceDir: string;
  /**
   * The mapped `[paths].assets` shared object pool, when the instance redirects
   * `assets` to a directory the machine already has (e.g. an existing
   * `.minecraft/assets`). Asset objects then land in THAT pool instead of a
   * per-instance copy, and the instance references it through a single
   * `assets/objects` symlink — the folder stays a complete `.minecraft` either way.
   */
  readonly assetsDir?: string;
  /**
   * The per-instance replay cache. A `provenance: "replay"` package is
   * materialized **from here**, never from the shared store — the storage-layer
   * half of the replay-never-rehosted invariant. Required whenever the delta
   * contains a replay package; absent is fine for a copy-only build.
   */
  readonly replayCache?: ReplayCache;
  /**
   * The JVM runner a `forge-build` placement replays installer processors through
   * (Stage 9). Required whenever the delta contains a Forge/NeoForge install plan;
   * absent is fine for any other build.
   */
  readonly processorRunner?: ProcessorRunner;
  /** The build platform — needed to locate the pinned JRE for `forge-build`. */
  readonly platform?: Platform;
  /** Host-app policy hook for installer processors (default allow — trust the source). */
  readonly allowProcessor?: AllowProcessor;
  readonly onWarn?: (message: string) => void;
}

export interface PlacementOutcome {
  /** Instance-relative target paths this placement created (empty for store-only). */
  readonly targets: readonly string[];
  /** The link strategy chosen, when the placement linked a single object. */
  readonly strategy?: LinkStrategy;
}

/** The relative instance target paths a package's placement will produce. */
export function targetsOf(pkg: LockPackage): readonly string[] {
  const p = pkg.placement;
  switch (p.method) {
    case "link":
      return [p.target];
    case "extract":
      return [p.targetDir];
    case "asset-tree":
      return [p.indexTarget];
    case "runtime-tree":
      return [p.targetDir];
    case "forge-build":
      return [...p.outputs];
    case "store-only":
      return [];
    default:
      return [];
  }
}

/** Parse and return the java-runtime manifest object under `manifestHash`. */
export async function readRuntimeManifest(
  store: ContentStore,
  manifestHash: Hash,
): Promise<RuntimeManifest> {
  const raw = await readFile(store.objectPath(manifestHash), "utf8");
  return JSON.parse(raw) as RuntimeManifest;
}

/** The sha1 leaf objects a java-runtime manifest references (deduped, stable order). */
export function runtimeLeafHashes(manifest: RuntimeManifest): Hash[] {
  const seen = new Set<string>();
  const out: Hash[] = [];
  for (const name of Object.keys(manifest.files).sort()) {
    const entry = manifest.files[name];
    if (entry && entry.type === "file" && !seen.has(entry.downloads.raw.sha1)) {
      seen.add(entry.downloads.raw.sha1);
      out.push({ algo: "sha1", value: entry.downloads.raw.sha1 });
    }
  }
  return out;
}

/**
 * The leaf objects a manifest-driven placement (`asset-tree` / `runtime-tree`)
 * fans out — needed by the acquirers (to bring them) and by GC (to root them).
 * The manifest object itself must already be present in the store.
 */
export async function treeLeaves(store: ContentStore, pkg: LockPackage): Promise<Hash[]> {
  if (pkg.placement.method === "asset-tree") {
    return assetHashes(await readAssetIndex(store, pkg.hash));
  }
  if (pkg.placement.method === "runtime-tree") {
    return runtimeLeafHashes(await readRuntimeManifest(store, pkg.hash));
  }
  return [];
}

/** Parse and return the asset objects referenced by an asset index object. */
export async function readAssetIndex(store: ContentStore, indexHash: Hash): Promise<AssetIndex> {
  const raw = await readFile(store.objectPath(indexHash), "utf8");
  return JSON.parse(raw) as AssetIndex;
}

/** The sha1 hashes an asset index references. */
export function assetHashes(index: AssetIndex): Hash[] {
  return Object.values(index.objects).map((o) => ({ algo: "sha1" as const, value: o.hash }));
}

export async function executePlacement(
  pkg: LockPackage,
  ctx: PlacementContext,
): Promise<PlacementOutcome> {
  const p = pkg.placement;

  // Replay (CurseForge) bytes are materialized from the per-instance replay
  // cache — NEVER the shared store. A replay item is always a single-file
  // `link` (mod/resourcepack/shader/datapack); any other placement method for a
  // replay item is an invariant violation (a game/asset/runtime tree is never
  // replay), so we refuse rather than silently reach into the shared store.
  if (pkg.provenance === "replay") {
    if (p.method !== "link") {
      throw new UnsatisfiableTarget(
        pkg.name,
        `a replay item must use a single-file 'link' placement, not '${p.method}'`,
      );
    }
    const cache = ctx.replayCache;
    if (!cache) {
      throw new MissingObject(pkg.hash, `${pkg.name} (replay cache not provided to the build)`);
    }
    const dest = safeJoin(ctx.stageRoot, p.target, { rejectColon: true });
    const strategy = await cache.materialize(pkg.hash, dest);
    return { targets: [p.target], strategy };
  }

  switch (p.method) {
    case "link": {
      const dest = safeJoin(ctx.stageRoot, p.target, { rejectColon: true });
      const strategy = await ctx.store.materialize(pkg.hash, dest);
      return { targets: [p.target], strategy };
    }
    case "extract": {
      const destDir = safeJoin(ctx.stageRoot, p.targetDir, { rejectColon: true });
      // rejectColon: true (LB-827) — this unpacks straight onto the build's
      // instance stage, which is NOT a throwaway dir like the pack importers'
      // (see safe-extract.ts's module doc): an entry safeExtract let through
      // here would land in the built instance for real.
      await safeExtract(ctx.store.objectPath(pkg.hash), destDir, {
        exclude: excludeMetaInf,
        rejectColon: true,
      });
      return { targets: [p.targetDir] };
    }
    case "asset-tree":
      return materializeAssetTree(pkg, p.indexTarget, ctx);
    case "runtime-tree": {
      const destRoot = safeJoin(ctx.stageRoot, p.targetDir, { rejectColon: true });
      await materializeRuntime(pkg, destRoot, ctx);
      return { targets: [p.targetDir] };
    }
    case "forge-build": {
      const produced = await materializeForgeBuild(pkg, ctx);
      return { targets: produced };
    }
    case "store-only": {
      if (!(await ctx.store.has(pkg.hash))) {
        throw new MissingObject(pkg.hash, pkg.name);
      }
      return { targets: [] };
    }
    default:
      return { targets: [] };
  }
}

/**
 * Materialize an asset index AND its whole object closure so the instance's
 * `assets/` is a complete, launch-ready `.minecraft` assets dir (index +
 * objects) — the fix for a build that placed only the index and left
 * `assets/objects/` empty (neither the instance nor the store was, on its own, a
 * complete assets dir).
 *
 * Every sha1 object the index names is fanned out of the store's asset domain
 * into `assets/objects/<xx>/<sha1>` through the store's reflink→hardlink→symlink→
 * copy chain, **idempotently**: an object already present (a prior build, a shared
 * MC version, or the mapped pool) is left untouched, so a rebuild re-links nothing
 * and the tree stays byte-deterministic. Objects are additive and content-
 * addressed, so writing them straight into the instance (before the index is
 * swapped in) can never corrupt the currently-live build — the old index still
 * references only objects that remain present.
 *
 * The small index file itself flips atomically through the stage → swap, so a
 * launcher never observes an index without the objects it references.
 *
 * `[paths].assets` mapping: when `ctx.assetsDir` redirects assets to a shared
 * external pool, objects land THERE (no per-instance copy) and the instance
 * references the pool through a single `assets/objects` symlink.
 */
async function materializeAssetTree(
  pkg: LockPackage,
  indexTarget: string,
  ctx: PlacementContext,
): Promise<PlacementOutcome> {
  const index = await readAssetIndex(ctx.store, pkg.hash);

  const instanceAssets = resolve(ctx.instanceDir, "assets");
  const assetsRoot = ctx.assetsDir ? resolve(ctx.assetsDir) : instanceAssets;
  const objectsRoot = join(assetsRoot, "objects");
  const external = assetsRoot !== instanceAssets;

  // Fan every referenced object out of the store into the object pool. Presence
  // is asserted first (the acquirer brings these ahead of the build) so a missing
  // object is a clear MissingObject, never a silent gap in a "built" instance.
  for (const hash of assetHashes(index)) {
    if (!(await ctx.store.has(hash))) {
      throw new MissingObject(hash, `asset of ${pkg.name}`);
    }
    const dest = safeJoin(objectsRoot, join(shardOf(hash.value), hash.value), {
      rejectColon: true,
    });
    if (await pathExists(dest)) {
      continue; // idempotent — an object already in the pool is never re-linked
    }
    await ctx.store.materialize(hash, dest);
  }

  // A mapped external pool is referenced through one symlink — no per-instance
  // copy — so the instance folder is still a complete `.minecraft` to point at.
  if (external) {
    const link = join(instanceAssets, "objects");
    if (!(await pathExists(link))) {
      await ensureDir(instanceAssets);
      await symlink(objectsRoot, link);
    }
  }

  // The index flips atomically through the stage → swap (its objects are down).
  const dest = safeJoin(ctx.stageRoot, indexTarget, { rejectColon: true });
  const strategy = await ctx.store.materialize(pkg.hash, dest);
  return { targets: [indexTarget], strategy };
}

/** File modes for a materialized JRE entry — the executable bit is load-bearing. */
const RUNTIME_MODE_EXEC = 0o755;
const RUNTIME_MODE_PLAIN = 0o644;

/**
 * Materialize a pinned java-runtime manifest into a JRE tree under `destRoot`,
 * preserving the executable bit on files and re-creating the mac-bundle symlinks.
 * Entries are applied in a fixed (path-sorted) order so the tree is deterministic;
 * every destination — and every symlink target — is asserted to stay under the
 * runtime root (defense-in-depth even though the manifest is sha-pinned).
 *
 * Files are materialized via reflink/copy (never a hardlink) so their mode can be
 * set without disturbing the immutable `0444` store object they share bytes with.
 */
async function materializeRuntime(
  pkg: LockPackage,
  destRoot: string,
  ctx: PlacementContext,
): Promise<void> {
  const manifest = await readRuntimeManifest(ctx.store, pkg.hash);
  const root = resolve(destRoot);
  const names = Object.keys(manifest.files).sort();

  // Directories first (sorted → parents precede children), then files, then links
  // (a symlink may target a sibling that must already exist).
  for (const name of names) {
    if (manifest.files[name]?.type === "directory") {
      await ensureDir(safeChild(root, name));
    }
  }
  for (const name of names) {
    const entry = manifest.files[name];
    if (!entry || entry.type !== "file") {
      continue;
    }
    const dest = safeChild(root, name);
    await ensureDir(dirname(dest));
    const hash: Hash = { algo: "sha1", value: entry.downloads.raw.sha1 };
    if (!(await ctx.store.has(hash))) {
      throw new MissingObject(hash, `runtime file ${name} of ${pkg.name}`);
    }
    await ctx.store.materialize(hash, dest, { order: ["reflink", "copy"] });
    await chmod(dest, entry.executable ? RUNTIME_MODE_EXEC : RUNTIME_MODE_PLAIN);
  }
  for (const name of names) {
    const entry = manifest.files[name];
    if (!entry || entry.type !== "link") {
      continue;
    }
    const dest = safeChild(root, name);
    await ensureDir(dirname(dest));
    // The link target is manifest-controlled: assert it cannot escape the runtime
    // root before creating it (a symlink out of root is a zip-slip-class hazard).
    const resolvedTarget = resolve(dirname(dest), entry.target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + sep)) {
      throw new PathEscape(name, "runtime symlink target escapes the runtime root");
    }
    await symlink(entry.target, dest);
  }
}

/** safeJoin a manifest-relative entry under an absolute runtime root. */
function safeChild(root: string, rel: string): string {
  return safeJoin(root, rel, { allowProtected: true, rejectColon: true });
}

/**
 * Replay a pinned Forge/NeoForge install plan (the object under `pkg.hash`) through
 * the {@link ProcessorRunner}, materializing the produced files (the patched client
 * libraries) into the stage. Requires the build to have supplied a
 * {@link ProcessorRunner} + platform — running installer processors is carried
 * explicitly, never implicit.
 */
async function materializeForgeBuild(
  pkg: LockPackage,
  ctx: PlacementContext,
): Promise<readonly string[]> {
  if (!ctx.processorRunner || !ctx.platform) {
    throw new UnsatisfiableTarget(
      pkg.name,
      "a Forge/NeoForge build requires a processor runner and platform in the build context",
    );
  }
  const plan = parseForgePlan(await readFile(ctx.store.objectPath(pkg.hash)));
  const scratchDir = join(ctx.instanceDir, ".anvil", `forge-${randomUUID()}`);
  try {
    return await runForgeProcessors({
      plan,
      store: ctx.store,
      scratchDir,
      stageRoot: ctx.stageRoot,
      platform: ctx.platform,
      runner: ctx.processorRunner,
      consent: ctx.allowProcessor ?? allowAllProcessors,
      instanceDir: ctx.instanceDir,
    });
  } finally {
    await removePath(scratchDir);
  }
}
