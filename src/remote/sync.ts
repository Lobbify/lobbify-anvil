/**
 * `clone` / `pull` / `push` orchestration — the remote-sync heart of Stage 7.
 *
 * A remote is a served manifest + lock (+ VC history). The rules the plan pins:
 *
 *   - **clone**: fetch head → init `.anvil/` from the remote's history (or a single
 *     initial commit if it publishes none) → build in place.
 *   - **pull**: package-level lock diff drives the build; the joiner **fast-forwards**
 *     — HEAD is an ancestor of the remote tip. On **divergence** local commits are
 *     never discarded: they are stashed onto a `local/<ts>` branch and the current
 *     branch is fast-forwarded to the remote tip. `saves/` is never touched (the
 *     build honors `.anvilignore`; materialize only rewrites tracked source files).
 *   - **push**: publish the two files + VC history + **copy-only** content objects
 *     (never a replay object; the replay cache is never read) to a writable remote.
 *     Skipping `provenance: "replay"` rows covers the content objects, which come
 *     from the lock. It does **not** cover the VC history, whose tracked blobs
 *     carry no provenance at all. Those are refused at admission by the
 *     working-tree walk, refused on arrival by `importHistory`, and screened
 *     again by `assertPushableHistory` for history that predates either guard or
 *     that a merge carried in from a pull.
 *
 * VC history transfers as verbatim (zlib) objects the receiver re-verifies on
 * arrival (`VcObjectStore.importRaw`), so a corrupted/hostile mirror cannot inject
 * an object under a hash it does not hash to. Content objects flow through the
 * {@link RemotePullAcquirer} (store → endpoint → source), also sha-verified.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildEngineResult } from "../build/index.js";
import { readBuiltLock } from "../build/index.js";
import type { AnvilEvent } from "../events.js";
import { ensureDir, foldPath } from "../internal/fs.js";
import { parseLock } from "../lock/index.js";
import type { ContentStore } from "../store/index.js";
import {
  matchesReplayPin,
  readReplayPaths,
  recordReplayPaths,
  replayDigestsOf,
} from "../store/replay-provenance.js";
import { PushNotSupported, RemoteError, VcStateError } from "../types/errors.js";
import type { AllowSource, Hash, Lockfile } from "../types/index.js";
import { ancestors, isAncestor } from "../vc/graph.js";
import type { CommitObject, VcObjectStore } from "../vc/objects.js";
import { hashToString } from "../vc/objects.js";
import type { Refs } from "../vc/refs.js";
import { buildSnapshot, materializeSnapshot, replayPinsOfSnapshot } from "../vc/snapshot.js";
import { addRemote } from "./config.js";
import type { RemoteDescriptor } from "./descriptor.js";
import { remoteBranch } from "./descriptor.js";
import { type HostAddressResolver, validateRemoteLock } from "./transfer.js";
import type { RemoteTransport } from "./transport.js";

/** How the sync layer materializes an instance from a lock (wired by `Anvil`). */
export type RunBuild = (opts: {
  readonly previousLock?: Lockfile;
  readonly emit: (event: AnvilEvent) => void;
}) => Promise<BuildEngineResult>;

/** The dependencies every sync op runs against. */
export interface SyncDeps {
  readonly descriptor: RemoteDescriptor;
  readonly transport: RemoteTransport;
  readonly instanceDir: string;
  readonly vcStore: VcObjectStore;
  readonly refs: Refs;
  readonly sharedStore: ContentStore;
  readonly allowSource: AllowSource;
  /** Hostname resolver for the untrusted-lock DNS pre-vet (real DNS by default). */
  readonly resolveHost?: HostAddressResolver;
  readonly author: string;
  readonly now: () => number;
  readonly runBuild: RunBuild;
  /** The tracked branch/ref override. */
  readonly ref?: string;
  readonly emit?: (event: AnvilEvent) => void;
}

export interface CloneOutcome {
  readonly dir: string;
  readonly commit: Hash;
  readonly branch: string;
  /** Content objects transferred (fetched, not deduped) during the in-place build. */
  readonly objects: number;
}

export interface PullOutcome {
  readonly fastForwarded: number;
  readonly objects: number;
  readonly upToDate: boolean;
  /** The `local/<ts>` branch local commits were stashed onto, on divergence. */
  readonly stashedTo?: string;
  readonly commit: Hash;
}

export interface PushOutcome {
  readonly commit: Hash;
  readonly branch: string;
  readonly objects: number;
}

/** A counting emit: forwards every event and tallies real object transfers. */
function transferCounter(forward?: (event: AnvilEvent) => void): {
  emit: (event: AnvilEvent) => void;
  count: () => number;
} {
  let count = 0;
  return {
    emit(event) {
      if ((event.type === "object:store" && !event.deduped) || event.type === "replay:done") {
        count += 1;
      }
      forward?.(event);
    },
    count: () => count,
  };
}

// --- VC history transfer ---------------------------------------------------

/** Fetch + import one VC object (verify-on-arrival), unless already local. */
async function ensureVcObject(deps: SyncDeps, id: Hash, kind: string): Promise<void> {
  if (await deps.vcStore.has(id)) {
    return;
  }
  const raw = await deps.transport.fetchVcObject(id);
  if (!raw) {
    throw new RemoteError(
      deps.descriptor.name,
      `history is incomplete — missing ${kind} object ${hashToString(id)}`,
    );
  }
  await deps.vcStore.importRaw(id, raw); // content-address verified on arrival
}

/** What an import brought in, and what it declined to bring in. */
interface ImportedHistory {
  /** Replay content pins named by every lock in the transferred closure. */
  readonly pins: ReadonlySet<string>;
  /** Blob ids refused on arrival because their bytes match one of those pins. */
  readonly refusedBlobs: ReadonlySet<string>;
}

/**
 * Import the full commit closure reachable from `tip` into the local VC store,
 * refusing to admit any tracked blob whose bytes a lock in that same closure pins
 * as replay content.
 *
 * It runs in two passes because the answer is not local. The commit that strands
 * a CurseForge jar is the one whose lock stopped naming it, so the pin that
 * identifies those bytes lives in an ANCESTOR's lock — pass 1 therefore brings in
 * every commit, snapshot and lock and accumulates the pin union before pass 2
 * decides about a single tracked blob.
 *
 * A refused blob is never written: it is fetched, content-address-verified and
 * decoded in memory, and dropped. Importing first and deleting afterwards would
 * mean the CurseForge bytes were in `.anvil/objects/`, which is the thing being
 * prevented, and a joiner holding them could re-publish them to a third party.
 *
 * This is the receive side's whole defence, and it is deliberately self-contained:
 * a fresh `clone` has no replay-path ledger and no replay cache, so anything
 * keyed on local state is empty exactly when it is needed most.
 */
async function importHistory(deps: SyncDeps, tip: Hash): Promise<ImportedHistory> {
  const seen = new Set<string>();
  const stack: Hash[] = [tip];
  const pins = new Set<string>();
  const trackedBlobs = new Map<string, Hash>();

  // Pass 1 — the skeleton: commits, snapshots, the three source blobs, carried
  // bytes, and the replay pins every lock in the closure names.
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id.value)) {
      continue;
    }
    seen.add(id.value);
    await ensureVcObject(deps, id, "commit");
    const commit = await deps.vcStore.getCommit(id);
    await ensureVcObject(deps, commit.snapshot, "snapshot");
    const snap = await deps.vcStore.getSnapshot(commit.snapshot);
    for (const blob of [snap.manifest, snap.lock, snap.ignore]) {
      await ensureVcObject(deps, blob, "blob");
    }
    for (const pin of await replayPinsOfSnapshot(snap, deps.vcStore)) {
      pins.add(pin);
    }
    for (const carried of snap.carried) {
      await ensureVcObject(deps, carried.blob, "carried-blob");
    }
    for (const tracked of snap.tracked) {
      trackedBlobs.set(tracked.blob.value, tracked.blob);
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent.value)) {
        stack.push(parent);
      }
    }
  }

  // Pass 2 — tracked blobs, screened against the pins pass 1 collected.
  const refusedBlobs = new Set<string>();
  for (const blob of trackedBlobs.values()) {
    if (await deps.vcStore.has(blob)) {
      continue; // already ours — this transfer is not what put it here
    }
    const raw = await deps.transport.fetchVcObject(blob);
    if (!raw) {
      throw new RemoteError(
        deps.descriptor.name,
        `history is incomplete — missing tracked-blob object ${hashToString(blob)}`,
      );
    }
    if (pins.size > 0) {
      const bytes = deps.vcStore.decodeRaw(blob, raw);
      if (bytes && matchesReplayPin(replayDigestsOf(bytes), pins)) {
        refusedBlobs.add(blob.value);
        deps.emit?.({
          type: "warning",
          message: `refused an incoming object: its bytes are pinned as CurseForge (replay) content by a lock in ${deps.descriptor.name}'s history, and replay bytes are never re-hosted`,
        });
        continue;
      }
    }
    await deps.vcStore.importRaw(blob, raw); // content-address verified on arrival
  }
  return { pins, refusedBlobs };
}

/** The dedup key for one tracked entry: the same bytes at two paths are two entries. */
function trackedKey(path: string, blob: Hash): string {
  return `${path}::${blob.value}`;
}

/** What a push has to publish: the VC object closure, plus what it tracks. */
interface ReachableHistory {
  readonly objects: { id: Hash; raw: Uint8Array }[];
  /**
   * One entry per DISTINCT tracked (path, blob) pair across the closure. Deduped
   * because the tracked set is full state, not a delta: a file untouched for a
   * thousand commits appears in a thousand snapshots, and screening it once per
   * appearance turns a cheap gate into a per-push cost proportional to
   * `files × commits`.
   */
  readonly tracked: { path: string; blob: Hash }[];
  /** Replay content pins named by every lock in the closure. */
  readonly pins: ReadonlySet<string>;
}

/** Every VC object reachable from `tip`, raw (zlib) bytes, for a push. */
async function gatherVcObjects(vcStore: VcObjectStore, tip: Hash): Promise<ReachableHistory> {
  const out: { id: Hash; raw: Uint8Array }[] = [];
  const tracked = new Map<string, { path: string; blob: Hash }>();
  const pins = new Set<string>();
  const seen = new Set<string>();
  const stack: Hash[] = [tip];
  const push = async (id: Hash): Promise<void> => {
    if (seen.has(id.value)) {
      return;
    }
    seen.add(id.value);
    const raw = await vcStore.readRaw(id);
    if (raw) {
      out.push({ id, raw });
    }
  };
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) {
      continue;
    }
    await push(id);
    const commit = await vcStore.getCommit(id);
    await push(commit.snapshot);
    const snap = await vcStore.getSnapshot(commit.snapshot);
    for (const blob of [snap.manifest, snap.lock, snap.ignore]) {
      await push(blob);
    }
    for (const pin of await replayPinsOfSnapshot(snap, vcStore)) {
      pins.add(pin);
    }
    for (const carried of snap.carried) {
      await push(carried.blob);
    }
    for (const entry of snap.tracked) {
      await push(entry.blob);
      tracked.set(trackedKey(entry.path, entry.blob), { path: entry.path, blob: entry.blob });
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent.value)) {
        stack.push(parent);
      }
    }
  }
  return { objects: out, tracked: [...tracked.values()], pins };
}

/** The shared tail of every push refusal: what to do about it. */
const PUSH_REFUSAL_REMEDY =
  "Replay bytes are fetched per-client under your own CurseForge key and are never re-hosted, " +
  "so publishing this history would leak them. Such a commit predates the guard that keeps " +
  "replay bytes out of a tracked set. Drop or rewrite the commits that track that path, then " +
  "push again.";

/**
 * Refuse a push whose reachable history tracks CurseForge content.
 *
 * The walk that produces a tracked set refuses those bytes at admission, and the
 * receive side refuses them on arrival, so nothing this instance authored reaches
 * this check. It exists for what neither of those can reach: commits recorded
 * before the admission guard existed, and — via `mergeTrackedSets`, which unions
 * two tracked sets without re-screening either — a foreign entry that a `pull`
 * brought in and a later local merge carried into a new commit.
 *
 * Three questions, in cost order:
 *
 *   1. **Is every tracked blob actually here?** A tracked entry pointing at an
 *      object the local store lacks is history that cannot be published intact.
 *      It is also what a refused import leaves behind, so this is the check that
 *      stops a joiner forwarding what it declined to store.
 *   2. **Do a blob's bytes match a replay pin from this history's own locks?**
 *      Byte-level and machine-independent — the pin lives in an ancestor's lock
 *      even once the stranding commit's lock has stopped naming the file.
 *   3. **Does a tracked path appear in this instance's replay ledger?** The
 *      local-knowledge backstop, for a history whose own locks no longer state
 *      the pin at all.
 *
 * It refuses loudly rather than dropping the object. Silently omitting a blob
 * publishes a snapshot whose tracked entry points at an object the remote does
 * not have — broken history that fails on the joiner's `pull`, far from the
 * cause. Every refusal names the path.
 */
async function assertPushableHistory(deps: SyncDeps, history: ReachableHistory): Promise<void> {
  const refuse = (path: string, why: string): never => {
    throw new RemoteError(
      deps.descriptor.name,
      `refusing to push: ${why} ("${path}"). ${PUSH_REFUSAL_REMEDY}`,
    );
  };

  const claimed = await readReplayPaths(deps.instanceDir);
  for (const entry of history.tracked) {
    const raw = await deps.vcStore.readRaw(entry.blob);
    if (!raw) {
      refuse(
        entry.path,
        "the commit history tracks a file whose object is not in this instance's store, so the " +
          "history cannot be published intact. This is what an incoming transfer leaves behind " +
          "when it declines to store CurseForge content",
      );
      return;
    }
    if (history.pins.size > 0) {
      const bytes = deps.vcStore.decodeRaw(entry.blob, raw);
      if (bytes && matchesReplayPin(replayDigestsOf(bytes), history.pins)) {
        refuse(
          entry.path,
          "a lock in this history pins the tracked file's bytes as CurseForge content",
        );
        return;
      }
    }
    if (claimed.has(foldPath(entry.path))) {
      refuse(
        entry.path,
        "the commit history tracks a path this instance recorded as holding CurseForge content",
      );
      return;
    }
  }
}

/** The number of commits reachable from `tip` but not from `base`. */
async function newCommitCount(vcStore: VcObjectStore, tip: Hash, base: Hash): Promise<number> {
  const tipAnc = await ancestors(vcStore, tip);
  const baseAnc = await ancestors(vcStore, base);
  let n = 0;
  for (const value of tipAnc.keys()) {
    if (!baseAnc.has(value)) {
      n += 1;
    }
  }
  return n;
}

// --- helpers ---------------------------------------------------------------

const MANIFEST_FILE = "anvil.toml";
const LOCK_FILE = "anvil.lock";
const IGNORE_FILE = ".anvilignore";

async function writeHeadFiles(
  instanceDir: string,
  files: { manifest: string; lock: string; ignore?: string },
): Promise<void> {
  const enc = new TextEncoder();
  await writeFile(join(instanceDir, MANIFEST_FILE), enc.encode(files.manifest));
  await writeFile(join(instanceDir, LOCK_FILE), enc.encode(files.lock));
  if (files.ignore !== undefined) {
    await writeFile(join(instanceDir, IGNORE_FILE), enc.encode(files.ignore));
  }
}

function remoteTrackingRef(name: string, branch: string): string {
  return `refs/remotes/${name}/${branch}`;
}

/** Reserve an unused `local/<ts>` branch and point it at `at` (the stash). */
async function stashLocal(deps: SyncDeps, at: Hash): Promise<string> {
  const base = `local/${deps.now()}`;
  let name = base;
  let n = 1;
  while (await deps.refs.readRef(`refs/heads/${name}`)) {
    name = `${base}-${n}`;
    n += 1;
  }
  await deps.refs.writeRef(`refs/heads/${name}`, at);
  await deps.refs.appendReflog(
    `refs/heads/${name}`,
    undefined,
    at,
    deps.author,
    "pull: stashed diverged local commits",
    deps.now(),
  );
  return name;
}

// --- clone -----------------------------------------------------------------

/** `anvil clone` — create an instance from a remote and build it in place. */
export async function cloneInstance(deps: SyncDeps): Promise<CloneOutcome> {
  await ensureDir(deps.instanceDir);
  const head = await deps.transport.fetchHead(deps.ref);
  const remoteLock = parseLock(head.lock);
  // The remote lock is untrusted — veto hostile/vetoed sources before any I/O.
  await validateRemoteLock(remoteLock, deps.allowSource, deps.resolveHost);
  // Claim the remote lock's replay targets BEFORE anything is written. The build
  // that would otherwise record them runs last, so on a clone the ledger is
  // empty for the whole materialize. Necessary, and on its own not sufficient:
  // the byte-level check below is what actually holds here.
  await recordReplayPaths(deps.instanceDir, [remoteLock]);

  let commitId: Hash;
  if (head.commit) {
    const imported = await importHistory(deps, head.commit);
    commitId = head.commit;
    const commit = await deps.vcStore.getCommit(commitId);
    const snap = await deps.vcStore.getSnapshot(commit.snapshot);
    await materializeSnapshot({
      instanceDir: deps.instanceDir,
      snapshot: snap,
      vcStore: deps.vcStore,
      sharedStore: deps.sharedStore,
      replayPins: imported.pins,
      refusedBlobs: imported.refusedBlobs,
      onWarn: (message) => deps.emit?.({ type: "warning", message }),
    });
  } else {
    // A static remote with no VC history → one initial commit from the files.
    await writeHeadFiles(deps.instanceDir, head);
    const built = await buildSnapshot({
      instanceDir: deps.instanceDir,
      vcStore: deps.vcStore,
      sharedStore: deps.sharedStore,
      requireLockFresh: false,
    });
    const commit: CommitObject = {
      type: "commit",
      snapshot: built.id,
      parents: [],
      gen: 0,
      author: deps.author,
      time: deps.now(),
      message: `clone ${deps.descriptor.url}`,
      op: "import",
    };
    commitId = await deps.vcStore.put(commit);
  }

  const branchRef = `refs/heads/${head.branch}`;
  await deps.refs.writeRef(branchRef, commitId);
  await deps.refs.setHeadSymbolic(branchRef);
  await deps.refs.writeRef(remoteTrackingRef(deps.descriptor.name, head.branch), commitId);
  await deps.refs.appendReflog(
    "HEAD",
    undefined,
    commitId,
    deps.author,
    `clone: ${deps.descriptor.url}`,
    deps.now(),
  );
  await addRemote(deps.instanceDir, deps.descriptor);

  const counter = transferCounter(deps.emit);
  await deps.runBuild({ emit: counter.emit });
  return { dir: deps.instanceDir, commit: commitId, branch: head.branch, objects: counter.count() };
}

// --- pull ------------------------------------------------------------------

/** `anvil pull` — content-addressed fast-forward (or stash-and-FF on divergence). */
export async function pullInstance(deps: SyncDeps): Promise<PullOutcome> {
  const head = await deps.transport.fetchHead(deps.ref);
  const remoteLock = parseLock(head.lock);
  await validateRemoteLock(remoteLock, deps.allowSource, deps.resolveHost);
  // Claim before any write, for the same reason as clone: the build that would
  // otherwise record these paths runs after materialize, not before it.
  await recordReplayPaths(deps.instanceDir, [remoteLock]);

  const localHead = await deps.refs.resolveHead();
  const currentBranch = await deps.refs.currentBranch();

  // A remote that publishes no VC history → linear import-as-commit (never diverges).
  if (!head.commit) {
    return pullStatic(deps, head, localHead, currentBranch);
  }
  const target = head.commit;
  const imported = await importHistory(deps, target);
  const inbound = {
    replayPins: imported.pins,
    refusedBlobs: imported.refusedBlobs,
    onWarn: (message: string) => deps.emit?.({ type: "warning" as const, message }),
  };
  const trackingRef = remoteTrackingRef(deps.descriptor.name, head.branch);

  // Unborn local HEAD → adopt the remote like a clone.
  if (!localHead) {
    const branchRef = currentBranch ?? `refs/heads/${head.branch}`;
    const commit = await deps.vcStore.getCommit(target);
    const snap = await deps.vcStore.getSnapshot(commit.snapshot);
    await materializeSnapshot({
      instanceDir: deps.instanceDir,
      snapshot: snap,
      vcStore: deps.vcStore,
      sharedStore: deps.sharedStore,
      ...inbound,
    });
    await deps.refs.writeRef(branchRef, target);
    await deps.refs.setHeadSymbolic(branchRef);
    await deps.refs.writeRef(trackingRef, target);
    const counter = transferCounter(deps.emit);
    await deps.runBuild({ emit: counter.emit });
    return { fastForwarded: 1, objects: counter.count(), upToDate: false, commit: target };
  }

  if (!currentBranch) {
    throw new VcStateError("cannot pull onto a detached HEAD — switch to a branch first");
  }

  // Up to date: the remote tip is already in our history.
  if (target.value === localHead.value || (await isAncestor(deps.vcStore, target, localHead))) {
    await deps.refs.writeRef(trackingRef, target);
    return { fastForwarded: 0, objects: 0, upToDate: true, commit: localHead };
  }

  const localCommit = await deps.vcStore.getCommit(localHead);
  const prevSnap = await deps.vcStore.getSnapshot(localCommit.snapshot);
  const targetCommit = await deps.vcStore.getCommit(target);
  const targetSnap = await deps.vcStore.getSnapshot(targetCommit.snapshot);

  let stashedTo: string | undefined;
  const canFf = await isAncestor(deps.vcStore, localHead, target);
  if (!canFf) {
    // Divergence: preserve local commits on a local/<ts> branch, then FF-force.
    stashedTo = await stashLocal(deps, localHead);
    deps.emit?.({
      type: "error",
      code: "NON_FAST_FORWARD",
      message: `local history diverged from ${deps.descriptor.name}; your commits are preserved on branch "${stashedTo}" — the pack was fast-forwarded to the remote.`,
    });
  }
  await deps.refs.writeOrigHead(localHead);
  await materializeSnapshot({
    instanceDir: deps.instanceDir,
    snapshot: targetSnap,
    vcStore: deps.vcStore,
    sharedStore: deps.sharedStore,
    previous: prevSnap,
    ...inbound,
  });
  await deps.refs.writeRef(currentBranch, target);
  await deps.refs.writeRef(trackingRef, target);
  const reflogMsg = stashedTo
    ? `pull: reset to ${head.branch} (local stashed to ${stashedTo})`
    : `pull: fast-forward ${head.branch}`;
  await deps.refs.appendReflog(
    currentBranch,
    localHead,
    target,
    deps.author,
    reflogMsg,
    deps.now(),
  );
  await deps.refs.appendReflog("HEAD", localHead, target, deps.author, reflogMsg, deps.now());

  const previousLock = await readBuiltLock(deps.instanceDir);
  const counter = transferCounter(deps.emit);
  await deps.runBuild({
    ...(previousLock ? { previousLock } : {}),
    emit: counter.emit,
  });
  const fastForwarded = await newCommitCount(deps.vcStore, target, localHead);
  return {
    fastForwarded,
    objects: counter.count(),
    upToDate: false,
    commit: target,
    ...(stashedTo ? { stashedTo } : {}),
  };
}

/** The no-VC-history pull path: adopt the served files as a linear commit + build. */
async function pullStatic(
  deps: SyncDeps,
  head: Awaited<ReturnType<RemoteTransport["fetchHead"]>>,
  localHead: Hash | undefined,
  currentBranch: string | undefined,
): Promise<PullOutcome> {
  await writeHeadFiles(deps.instanceDir, head);
  const built = await buildSnapshot({
    instanceDir: deps.instanceDir,
    vcStore: deps.vcStore,
    sharedStore: deps.sharedStore,
    requireLockFresh: false,
  });
  // No change → up to date.
  if (localHead) {
    const cur = await deps.vcStore.getCommit(localHead);
    if (cur.snapshot.value === built.id.value) {
      return { fastForwarded: 0, objects: 0, upToDate: true, commit: localHead };
    }
  }
  const branchRef = currentBranch ?? `refs/heads/${head.branch}`;
  const parents = localHead ? [localHead] : [];
  const parentCommits = await Promise.all(parents.map((p) => deps.vcStore.getCommit(p)));
  const gen = parentCommits.length === 0 ? 0 : 1 + Math.max(...parentCommits.map((c) => c.gen));
  const commit: CommitObject = {
    type: "commit",
    snapshot: built.id,
    parents,
    gen,
    author: deps.author,
    time: deps.now(),
    message: `pull ${deps.descriptor.url}`,
    op: "import",
  };
  const commitId = await deps.vcStore.put(commit);
  if (localHead) {
    await deps.refs.writeOrigHead(localHead);
  }
  await deps.refs.writeRef(branchRef, commitId);
  await deps.refs.setHeadSymbolic(branchRef);
  await deps.refs.appendReflog(
    "HEAD",
    localHead,
    commitId,
    deps.author,
    `pull: ${deps.descriptor.url}`,
    deps.now(),
  );
  const previousLock = await readBuiltLock(deps.instanceDir);
  const counter = transferCounter(deps.emit);
  await deps.runBuild({ ...(previousLock ? { previousLock } : {}), emit: counter.emit });
  return { fastForwarded: 1, objects: counter.count(), upToDate: false, commit: commitId };
}

// --- push ------------------------------------------------------------------

/** Read a copy content object's bytes from the shared store, or `undefined`. */
async function readStoreBytes(store: ContentStore, hash: Hash): Promise<Uint8Array | undefined> {
  if (!(await store.has(hash))) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of store.read(hash)) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * `anvil push` — publish the current branch to a writable remote. Transfers the
 * two files + VC history + **copy-only** content objects. Replay rows are skipped
 * and the replay cache is never read — the ToS boundary is enforced structurally.
 */
export async function pushInstance(deps: SyncDeps): Promise<PushOutcome> {
  if (!deps.transport.pushable) {
    // Surfaced as PushNotSupported by the transport's publish(); check up front.
    throw new PushNotSupported(deps.descriptor.name, deps.descriptor.kind);
  }
  const localHead = await deps.refs.resolveHead();
  if (!localHead) {
    throw new VcStateError("nothing to push — the branch has no commits yet");
  }
  const branch = remoteBranch(deps.descriptor, deps.ref);
  const history = await gatherVcObjects(deps.vcStore, localHead);
  await assertPushableHistory(deps, history);
  const vcObjects = history.objects;

  // Content objects: COPY provenance only, from the shared store. A replay row is
  // skipped entirely and the replay cache is never opened.
  const contentObjects: { hash: Hash; bytes: Uint8Array }[] = [];
  if (deps.transport.hostsContent) {
    const built =
      (await readBuiltLock(deps.instanceDir)) ??
      parseLock(await readFile(join(deps.instanceDir, LOCK_FILE), "utf8"));
    const emitted = new Set<string>();
    for (const pkg of built.resolved) {
      if (pkg.provenance === "replay") {
        continue; // NEVER transfer CurseForge bytes
      }
      if (emitted.has(pkg.hash.value)) {
        continue;
      }
      const bytes = await readStoreBytes(deps.sharedStore, pkg.hash);
      if (bytes) {
        emitted.add(pkg.hash.value);
        contentObjects.push({ hash: pkg.hash, bytes });
      }
    }
  }

  const manifest = await readFile(join(deps.instanceDir, MANIFEST_FILE), "utf8");
  const lock = await readFile(join(deps.instanceDir, LOCK_FILE), "utf8");
  const ignore = await readFile(join(deps.instanceDir, IGNORE_FILE), "utf8").catch(() => undefined);

  await deps.transport.publish({
    branch,
    commit: localHead,
    manifest,
    lock,
    ...(ignore !== undefined ? { ignore } : {}),
    vcObjects,
    contentObjects,
  });
  await deps.refs.writeRef(remoteTrackingRef(deps.descriptor.name, branch), localHead);
  return { commit: localHead, branch, objects: contentObjects.length };
}
