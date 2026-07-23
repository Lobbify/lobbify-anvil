/**
 * Building a {@link SnapshotObject} from the working tree, and materializing one
 * back into it. A snapshot is the tracked source state — `anvil.toml`, `anvil.lock`,
 * `.anvilignore`, and the **carried local-blob closure** (every `local`-source
 * item's bytes, kept in the VC object store so an old commit is self-contained and
 * still switchable after the shared store has been GC'd).
 *
 * `switch`/materialize is minimal-touch ("by hash-diff"): a tracked file is only
 * rewritten when its content actually differs. The build product (`mods/`, the
 * game install) and `saves/` are never touched — those are `anvil build`'s job and
 * the user's worlds respectively.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../build/serialize.js";
import { safeJoin } from "../internal/fs.js";
import { ensureDir, pathExists } from "../internal/fs.js";
import { readLock } from "../lock/index.js";
import { readManifest } from "../manifest/index.js";
import { hashBuffer } from "../store/hash.js";
import type { ContentStore } from "../store/index.js";
import { LockStale } from "../types/errors.js";
import type { Hash, LockPackage, Lockfile, Manifest } from "../types/index.js";
import type { CarriedBlob, SnapshotObject, VcObjectStore } from "./objects.js";
import { hashToString } from "./objects.js";

const MANIFEST_FILE = "anvil.toml";
const LOCK_FILE = "anvil.lock";
const IGNORE_FILE = ".anvilignore";

async function readBytesIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function readStoreObject(store: ContentStore, hash: Hash): Promise<Uint8Array | undefined> {
  if (!(await store.has(hash))) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of store.read(hash)) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The bytes behind a `local`-source package: shared store first, then its `file://` path. */
async function localBytes(
  pkg: LockPackage,
  sharedStore: ContentStore,
): Promise<Uint8Array | undefined> {
  const fromStore = await readStoreObject(sharedStore, pkg.hash);
  if (fromStore) {
    return fromStore;
  }
  if (pkg.url?.startsWith("file:")) {
    try {
      const bytes = new Uint8Array(await readFile(fileURLToPath(pkg.url)));
      if (hashBuffer(bytes, pkg.hash.algo).value === pkg.hash.value) {
        return bytes;
      }
    } catch {
      // fall through
    }
  }
  return undefined;
}

export interface BuildSnapshotInput {
  readonly instanceDir: string;
  readonly vcStore: VcObjectStore;
  readonly sharedStore: ContentStore;
  /** Refuse when the lock is stale vs the manifest (the `commit` guard). */
  readonly requireLockFresh?: boolean;
  /** Reuse an existing VC blob for a content hash instead of re-reading bytes. */
  readonly knownBlobs?: ReadonlyMap<string, Hash>;
}

export interface BuiltSnapshot {
  readonly id: Hash;
  readonly snapshot: SnapshotObject;
  readonly manifest: Manifest;
  readonly lock: Lockfile;
}

/** The carried local-blob entries for a lock (self-contained across GC + switch). */
async function carryLocals(lock: Lockfile, input: BuildSnapshotInput): Promise<CarriedBlob[]> {
  const carried: CarriedBlob[] = [];
  for (const pkg of lock.resolved) {
    if (pkg.source !== "local") {
      continue;
    }
    const target = targetOf(pkg);
    if (target === undefined) {
      continue;
    }
    const known = input.knownBlobs?.get(pkg.hash.value);
    if (known) {
      carried.push({ path: target, blob: known, content: pkg.hash });
      continue;
    }
    const bytes = await localBytes(pkg, input.sharedStore);
    if (bytes === undefined) {
      throw new LockStale(
        `cannot carry local item "${pkg.name}" — its bytes are absent from the store and its source file. Re-run \`anvil lock\`.`,
      );
    }
    const blob = await input.vcStore.putBlob(bytes);
    carried.push({ path: target, blob, content: pkg.hash });
  }
  carried.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return carried;
}

/** The instance-relative target a placement writes to (for a linked local file). */
function targetOf(pkg: LockPackage): string | undefined {
  const p = pkg.placement;
  if (p.method === "link") {
    return p.target;
  }
  return undefined;
}

/** Build (and store) a snapshot of the current working tree. */
export async function buildSnapshot(input: BuildSnapshotInput): Promise<BuiltSnapshot> {
  const { instanceDir, vcStore } = input;
  const manifest = await readManifest(instanceDir);
  const lock = await readLock(instanceDir);

  if (input.requireLockFresh) {
    const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
    if (manifestHash.value !== lock.meta.manifestHash.value) {
      throw new LockStale(
        "the lock is stale relative to the manifest — run `anvil lock` before committing",
      );
    }
  }

  const manifestBytes =
    (await readBytesIfPresent(join(instanceDir, MANIFEST_FILE))) ?? new Uint8Array();
  const lockBytes = (await readBytesIfPresent(join(instanceDir, LOCK_FILE))) ?? new Uint8Array();
  const ignoreBytes =
    (await readBytesIfPresent(join(instanceDir, IGNORE_FILE))) ?? new Uint8Array();

  const manifestBlob = await vcStore.putBlob(manifestBytes);
  const lockBlob = await vcStore.putBlob(lockBytes);
  const ignoreBlob = await vcStore.putBlob(ignoreBytes);
  const carried = await carryLocals(lock, input);

  const snapshot: SnapshotObject = {
    type: "snapshot",
    manifest: manifestBlob,
    lock: lockBlob,
    ignore: ignoreBlob,
    carried,
  };
  const id = await vcStore.put(snapshot);
  return { id, snapshot, manifest, lock };
}

export interface MaterializeInput {
  readonly instanceDir: string;
  readonly snapshot: SnapshotObject;
  readonly vcStore: VcObjectStore;
  readonly sharedStore: ContentStore;
  /** The snapshot currently materialized, so removed carried files are cleaned up. */
  readonly previous?: SnapshotObject;
}

/** Rewrite a tracked file from a VC blob only when its content differs (hash-diff). */
async function writeIfDiffer(path: string, want: Uint8Array): Promise<void> {
  const have = await readBytesIfPresent(path);
  if (have && Buffer.from(have).equals(Buffer.from(want))) {
    return;
  }
  await ensureDir(join(path, ".."));
  await writeFile(path, want);
}

/**
 * Materialize a snapshot into the working tree by hash-diff: rewrite the tracked
 * source files (manifest / lock / ignore) and the carried local files that
 * changed, delete carried files the target no longer tracks, and re-admit carried
 * bytes into the shared store. `saves/` and the build product are never touched.
 */
export async function materializeSnapshot(input: MaterializeInput): Promise<void> {
  const { instanceDir, snapshot, vcStore, sharedStore } = input;

  await writeIfDiffer(
    join(instanceDir, MANIFEST_FILE),
    await vcStore.getBlobBytes(snapshot.manifest),
  );
  await writeIfDiffer(join(instanceDir, LOCK_FILE), await vcStore.getBlobBytes(snapshot.lock));
  const ignoreBytes = await vcStore.getBlobBytes(snapshot.ignore);
  const ignorePath = join(instanceDir, IGNORE_FILE);
  if (ignoreBytes.byteLength === 0) {
    // An empty committed ignore means "no user overrides" — leave any existing one
    // only if it too is effectively empty; otherwise restore emptiness.
    if (await pathExists(ignorePath)) {
      await writeIfDiffer(ignorePath, ignoreBytes);
    }
  } else {
    await writeIfDiffer(ignorePath, ignoreBytes);
  }

  const targetPaths = new Set(snapshot.carried.map((c) => c.path));
  for (const prev of input.previous?.carried ?? []) {
    if (!targetPaths.has(prev.path)) {
      await rm(safeJoin(instanceDir, prev.path), { force: true });
    }
  }

  for (const c of snapshot.carried) {
    const bytes = await vcStore.getBlobBytes(c.blob);
    await writeIfDiffer(safeJoin(instanceDir, c.path), bytes);
    // Re-admit so a following `anvil build` finds the bytes in the shared store.
    await sharedStore.putBuffer(bytes, c.content.algo, c.content).catch(() => undefined);
  }
}
