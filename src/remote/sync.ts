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
import { ensureDir } from "../internal/fs.js";
import { parseLock } from "../lock/index.js";
import type { ContentStore } from "../store/index.js";
import { PushNotSupported, RemoteError, VcStateError } from "../types/errors.js";
import type { AllowSource, Hash, Lockfile } from "../types/index.js";
import { ancestors, isAncestor } from "../vc/graph.js";
import type { CommitObject, VcObjectStore } from "../vc/objects.js";
import { hashToString } from "../vc/objects.js";
import type { Refs } from "../vc/refs.js";
import { buildSnapshot, materializeSnapshot } from "../vc/snapshot.js";
import { addRemote } from "./config.js";
import type { RemoteDescriptor } from "./descriptor.js";
import { remoteBranch } from "./descriptor.js";
import { validateRemoteLock } from "./transfer.js";
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

/** Import the full commit closure reachable from `tip` into the local VC store. */
async function importHistory(deps: SyncDeps, tip: Hash): Promise<void> {
  const seen = new Set<string>();
  const stack: Hash[] = [tip];
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
    for (const carried of snap.carried) {
      await ensureVcObject(deps, carried.blob, "carried-blob");
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent.value)) {
        stack.push(parent);
      }
    }
  }
}

/** Every VC object reachable from `tip`, raw (zlib) bytes, for a push. */
async function gatherVcObjects(
  vcStore: VcObjectStore,
  tip: Hash,
): Promise<{ id: Hash; raw: Uint8Array }[]> {
  const out: { id: Hash; raw: Uint8Array }[] = [];
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
    for (const carried of snap.carried) {
      await push(carried.blob);
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent.value)) {
        stack.push(parent);
      }
    }
  }
  return out;
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
  validateRemoteLock(remoteLock, deps.allowSource);

  let commitId: Hash;
  if (head.commit) {
    await importHistory(deps, head.commit);
    commitId = head.commit;
    const commit = await deps.vcStore.getCommit(commitId);
    const snap = await deps.vcStore.getSnapshot(commit.snapshot);
    await materializeSnapshot({
      instanceDir: deps.instanceDir,
      snapshot: snap,
      vcStore: deps.vcStore,
      sharedStore: deps.sharedStore,
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
  validateRemoteLock(remoteLock, deps.allowSource);

  const localHead = await deps.refs.resolveHead();
  const currentBranch = await deps.refs.currentBranch();

  // A remote that publishes no VC history → linear import-as-commit (never diverges).
  if (!head.commit) {
    return pullStatic(deps, head, localHead, currentBranch);
  }
  const target = head.commit;
  await importHistory(deps, target);
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
  const vcObjects = await gatherVcObjects(deps.vcStore, localHead);

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
