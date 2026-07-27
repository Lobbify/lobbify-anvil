/**
 * Building a {@link SnapshotObject} from the working tree, and materializing one
 * back into it. A snapshot holds the whole source state at a commit:
 *
 *   - `anvil.toml`, `anvil.lock`, `.anvilignore` — one blob each;
 *   - the **carried local-blob closure** (every `local`-source item's bytes, kept
 *     in the VC object store so an old commit is self-contained and still
 *     switchable after the shared store has been GC'd);
 *   - the **tracked set** — the undeclared working-tree files the walk in
 *     `worktree.ts` finds (hand-edited configs, a jar dropped into `mods/`).
 *
 * The two sets stay separate on purpose. Carried bytes are build inputs: they keep
 * their lock-pin content hash and are re-admitted to the **shared** store on
 * materialize, so a following `anvil build` finds them. Tracked bytes are not
 * build inputs and are never re-admitted — a global store filling up with every
 * instance's `options.txt` would be GC pressure for no benefit.
 *
 * `switch`/materialize is minimal-touch ("by hash-diff"): a file is only rewritten
 * when its content actually differs. A tracked file the target commit does not
 * list is deleted (absence IS the deletion — there are no tombstones) and its
 * now-empty parents are pruned. The build product (the game install) and `saves/`
 * are never touched — those are `anvil build`'s job and the user's worlds
 * respectively.
 */

import { readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../build/serialize.js";
import { safeJoin } from "../internal/fs.js";
import { ensureDir, pathExists } from "../internal/fs.js";
import { readLock } from "../lock/index.js";
import { readManifest } from "../manifest/index.js";
import { hashBuffer } from "../store/hash.js";
import type { ContentStore } from "../store/index.js";
import { LockStale, VcStateError } from "../types/errors.js";
import type { Hash, LockPackage, Lockfile, Manifest } from "../types/index.js";
import type { CarriedBlob, SnapshotObject, VcObjectStore } from "./objects.js";
import { hashToString, trackedPathCollision } from "./objects.js";
import {
  WorktreeExclusion,
  isExcludeFilePath,
  loadWorktreeExclusion,
  parseAnvilexclude,
  snapshotExclusion,
  trackWorktree,
} from "./worktree.js";

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
  /**
   * Admit the tracked files' bytes as VC blobs (default `true`).
   *
   * `false` is for a caller that wants only the snapshot **id** — the dirty-check
   * behind `switch`, which runs on every attempt including the ones it then
   * refuses. The id is unaffected: it is the sha256 of the canonical encoding,
   * which holds each tracked file's blob **id**, and that id is computed from the
   * file's bytes whether or not they are then written to the store. So the same
   * tree yields the same snapshot id either way, and only the store writes differ.
   */
  readonly storeTracked?: boolean;
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
  const tracked = await trackWorktree({
    instanceDir,
    vcStore,
    exclude: await snapshotExclusion(instanceDir, lock),
    store: input.storeTracked !== false,
  });
  // Refuse a tree whose tracked paths collide under case folding before it can
  // become a commit — see `trackedPathCollision`. Checked here as well as on
  // decode: this is where such a set is authored, and the message can still name
  // files the user is looking at.
  const collision = trackedPathCollision(tracked);
  if (collision) {
    throw new VcStateError(collision);
  }

  const snapshot: SnapshotObject = {
    type: "snapshot",
    manifest: manifestBlob,
    lock: lockBlob,
    ignore: ignoreBlob,
    carried,
    tracked,
  };
  const id = await vcStore.put(snapshot);
  return { id, snapshot, manifest, lock };
}

export interface MaterializeInput {
  readonly instanceDir: string;
  readonly snapshot: SnapshotObject;
  readonly vcStore: VcObjectStore;
  readonly sharedStore: ContentStore;
  /** The snapshot currently materialized, so removed carried/tracked files are cleaned up. */
  readonly previous?: SnapshotObject;
}

/** Rewrite a file from a VC blob only when its content differs (hash-diff). */
async function writeIfDiffer(path: string, want: Uint8Array): Promise<void> {
  const have = await readBytesIfPresent(path);
  if (have && Buffer.from(have).equals(Buffer.from(want))) {
    return;
  }
  await ensureDir(join(path, ".."));
  await writeFile(path, want);
}

/**
 * Remove the directories a deleted tracked file leaves empty, climbing to (but
 * never including) the instance root and stopping at the first non-empty one.
 *
 * This is load-bearing, not tidiness: it is what lets `config/foo/bar` (a file) in
 * one commit become `config/foo` (a file) in the next. Without the prune the
 * leftover `config/foo` directory blocks the write.
 */
async function pruneEmptyParents(instanceDir: string, absPath: string): Promise<void> {
  const root = resolve(instanceDir);
  let dir = dirname(resolve(absPath));
  while (dir !== root && dir.startsWith(root + sep)) {
    try {
      await rmdir(dir);
    } catch {
      return; // still holds something (or already gone) — stop climbing
    }
    dir = dirname(dir);
  }
}

/**
 * The exclusion the **target commit** carries: `.anvilexclude` is itself a tracked
 * file, so a commit ships the rules it was made under. A commit without one gets
 * the built-in defaults alone, which `WorktreeExclusion` always applies.
 */
async function targetExclusion(
  snapshot: SnapshotObject,
  vcStore: VcObjectStore,
): Promise<WorktreeExclusion> {
  const entry = snapshot.tracked.find((t) => isExcludeFilePath(t.path));
  if (!entry) {
    return new WorktreeExclusion();
  }
  const text = new TextDecoder().decode(await vcStore.getBlobBytes(entry.blob));
  return new WorktreeExclusion({ patterns: parseAnvilexclude(text) });
}

/**
 * Materialize a snapshot into the working tree by hash-diff: rewrite the source
 * files (manifest / lock / ignore), the carried local files and the tracked files
 * that changed, delete the carried/tracked files the target no longer lists, and
 * re-admit carried bytes into the shared store. `saves/` and the build product are
 * never touched.
 *
 * Two rules govern what it will and will not touch:
 *
 *   - **Excluded paths are skipped in both directions**, but the two directions
 *     ask different exclusions — see the comment in the body, which is where the
 *     asymmetry is explained.
 *   - **`safeJoin` throws on a protected top.** A snapshot claiming to write or
 *     delete `saves/level.dat` fails loudly rather than being quietly skipped.
 */
export async function materializeSnapshot(input: MaterializeInput): Promise<void> {
  const { instanceDir, snapshot, vcStore, sharedStore } = input;
  // Two exclusion sets, and the asymmetry between them is deliberate. Do not
  // "simplify" it back into one — that is the bug it replaced.
  //
  //   - **Writes** obey the TARGET commit's own `.anvilexclude`. That file is
  //     tracked, so a commit travels with the rules it was authored under, and
  //     those are the rules that must decide what it materializes. Reading the
  //     on-disk copy instead applies whatever happens to be checked out right now,
  //     and on the first switch after a clone there is no on-disk copy at all — so
  //     the incoming rules would never be the ones in force.
  //   - **Deletes** obey the UNION of the on-disk and the target rules, which is
  //     the more protective of the two: a path *either* side calls excluded is
  //     never deleted. Adding `screenshots/` locally and then switching to a
  //     branch whose commit tracked screenshots must not remove them, even though
  //     that commit knows nothing about the new local rule.
  //
  // Materialize has no lock to derive build ownership from, so neither set holds
  // build-owned paths; both still carry the built-in defaults unconditionally,
  // which is what keeps `logs/` and the game install safe in either direction.
  const onDisk = await loadWorktreeExclusion({ instanceDir });
  const exclude = await targetExclusion(snapshot, vcStore);
  const undeletable = (path: string): boolean => exclude.excludes(path) || onDisk.excludes(path);

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

  // Deletions run before writes, and a path the target still lists is never
  // deleted — a file that moves between the carried and tracked sets stays put.
  const targetPaths = new Set([
    ...snapshot.carried.map((c) => c.path),
    ...snapshot.tracked.map((t) => t.path),
  ]);
  for (const prev of input.previous?.carried ?? []) {
    if (!targetPaths.has(prev.path)) {
      await rm(safeJoin(instanceDir, prev.path), { force: true });
    }
  }
  for (const prev of input.previous?.tracked ?? []) {
    if (targetPaths.has(prev.path)) {
      continue;
    }
    // `safeJoin` BEFORE the exclusion skip, in both tracked loops. The exclusion
    // set answers `true` for a protected top too, so asking it first would swallow
    // a history claiming `saves/level.dat` in silence — safe, but silent, and the
    // carried loop next door throws. An ordinarily-excluded path (`logs/`,
    // `screenshots/`) still skips quietly, one line down.
    const abs = safeJoin(instanceDir, prev.path);
    if (undeletable(prev.path)) {
      continue;
    }
    await rm(abs, { force: true });
    await pruneEmptyParents(instanceDir, abs);
  }

  for (const c of snapshot.carried) {
    const bytes = await vcStore.getBlobBytes(c.blob);
    await writeIfDiffer(safeJoin(instanceDir, c.path), bytes);
    // Re-admit so a following `anvil build` finds the bytes in the shared store.
    await sharedStore.putBuffer(bytes, c.content.algo, c.content).catch(() => undefined);
  }

  for (const t of snapshot.tracked) {
    // Same ordering as the delete loop above, for the same reason: a snapshot
    // claiming to WRITE `saves/level.dat` must fail loudly, not be skipped.
    const abs = safeJoin(instanceDir, t.path);
    if (exclude.excludes(t.path)) {
      continue;
    }
    // Tracked bytes stay VC-only: they are not build inputs, so unlike carried
    // bytes they are never re-admitted to the shared store.
    await writeIfDiffer(abs, await vcStore.getBlobBytes(t.blob));
  }
}
