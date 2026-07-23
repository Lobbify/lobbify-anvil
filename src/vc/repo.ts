/**
 * The `VcRepo` — anvil's native version-control engine over one instance's
 * `.anvil/` object + ref database. It implements commit / branch / switch / log /
 * revert / merge / rebase directly on the item set; it is **not** a git wrapper.
 *
 * The two invariants it defends:
 *   - **Ordering is by generation number, never wall-clock.** Every commit carries
 *     an authoritative `gen`; LCA and log order derive from it, so clock skew (or a
 *     rebase that rewrites display times) can never corrupt history.
 *   - **Never merge two derived locks.** Merge/rebase merge the *item set* (authored
 *     intent), then re-derive the lock through a constrained, pin-preserving
 *     re-lock (the injected {@link RelockFn}, wired to the Stage-2 resolver).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../build/serialize.js";
import { isGamePackage } from "../game/index.js";
import { pathExists } from "../internal/fs.js";
import { comparePackages, writeLock } from "../lock/index.js";
import { parseLock } from "../lock/index.js";
import { parseManifest, readManifest, writeManifest } from "../manifest/index.js";
import { pinsFromLock } from "../resolver/index.js";
import { hashBuffer } from "../store/hash.js";
import type { ContentStore } from "../store/index.js";
import { DirtyWorkingTree, UnknownRef, VcStateError } from "../types/errors.js";
import type { Hash, LockPackage, Lockfile, Manifest } from "../types/index.js";
import type { Conflict, ConflictStrategy, OnConflict } from "./conflict.js";
import { findLca, isAncestor, nextGeneration } from "./graph.js";
import { type ItemDelta, type ItemSet, buildItemSet, diffItemSets, gameValue } from "./itemset.js";
import { type ResolutionPolicy, threeWayMerge } from "./merge.js";
import type { CommitObject, CommitOp, SnapshotObject, VcObjectStore } from "./objects.js";
import {
  type RebaseState,
  clearRebaseState,
  readRebaseState,
  rebaseInProgress,
  writeRebaseState,
} from "./rebase.js";
import { Refs } from "./refs.js";
import { buildSnapshot, materializeSnapshot } from "./snapshot.js";

/** A commit reference. Generation numbers order history — wall-clock never does. */
export interface CommitRef {
  readonly id: Hash;
  readonly generation: number;
}

/** The request the injected re-lock receives (the constrained pin-preserving re-lock). */
export interface RelockRequest {
  readonly manifest: Manifest;
  /** Prior pins to reuse verbatim, keyed canonically. */
  readonly seedPins: ReadonlyMap<string, LockPackage>;
  /** Canonical keys to force back through resolution (the game cascade). */
  readonly reResolveKeys: ReadonlySet<string>;
  /** The game packages for the merged `@game`, carried from the winning side. */
  readonly gamePackages: readonly LockPackage[];
  readonly gameMeta: { readonly minecraft: string; readonly loader: string; readonly java: string };
}

/** Re-derive a full lock from a merged manifest. Throws an `AnvilError` on a phase-2 conflict. */
export type RelockFn = (req: RelockRequest) => Promise<Lockfile>;

export interface VcRepoOptions {
  readonly instanceDir: string;
  readonly anvilDir: string;
  readonly sharedStore: ContentStore;
  readonly vcStore: VcObjectStore;
  readonly relock: RelockFn;
  readonly author: string;
  /** Injected clock (ms). Display-only in commits; ordering is by generation. */
  readonly now: () => number;
}

/** One `log` entry. */
export interface LogEntry {
  readonly id: Hash;
  readonly gen: number;
  readonly author: string;
  readonly time: number;
  readonly message: string;
  readonly op: CommitOp;
  readonly parents: readonly Hash[];
  /** The item delta vs the first parent (empty for a root). */
  readonly stat: ItemDelta;
  /** Ref names pointing at this commit (`refs/heads/main`, `refs/tags/v1`). */
  readonly refs: readonly string[];
}

/** Result of a {@link VcRepo.merge}. */
export interface MergeOutcome {
  readonly committed?: CommitRef;
  readonly conflicts: readonly Conflict[];
  readonly warnings: readonly string[];
  readonly fastForward: boolean;
  readonly upToDate: boolean;
}

/** Result of a {@link VcRepo.revert}. */
export interface RevertOutcome {
  readonly committed?: CommitRef;
  readonly conflicts: readonly Conflict[];
}

/** Result of a rebase (start / continue / skip / abort). */
export interface RebaseOutcome {
  readonly status: "done" | "conflicts" | "up-to-date" | "aborted" | "unrelated";
  readonly head?: CommitRef;
  readonly conflicts: readonly Conflict[];
  readonly warnings: readonly string[];
  /** Commits still queued to replay. */
  readonly remaining: number;
}

interface CommitContent {
  readonly id: Hash;
  readonly commit: CommitObject;
  readonly snapshot: SnapshotObject;
  readonly manifest: Manifest;
  readonly lock: Lockfile;
}

const EMPTY_MANIFEST_ITEMS: readonly never[] = [];

export class VcRepo {
  readonly #instanceDir: string;
  readonly #anvilDir: string;
  readonly #shared: ContentStore;
  readonly #objects: VcObjectStore;
  readonly #relock: RelockFn;
  readonly #author: string;
  readonly #now: () => number;
  readonly refs: Refs;

  constructor(opts: VcRepoOptions) {
    this.#instanceDir = opts.instanceDir;
    this.#anvilDir = opts.anvilDir;
    this.#shared = opts.sharedStore;
    this.#objects = opts.vcStore;
    this.#relock = opts.relock;
    this.#author = opts.author;
    this.#now = opts.now;
    this.refs = new Refs(opts.anvilDir);
  }

  get objects(): VcObjectStore {
    return this.#objects;
  }

  // --- ref resolution ------------------------------------------------------

  /** Resolve a branch name / tag / full ref / commit id to a commit hash. */
  async resolveRef(ref: string): Promise<Hash> {
    if (ref === "HEAD") {
      const head = await this.refs.resolveHead();
      if (!head) {
        throw new UnknownRef(ref, "HEAD is unborn (no commits yet)");
      }
      return head;
    }
    for (const full of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/${ref}`]) {
      const id = await this.refs.readRef(full);
      if (id) {
        return id;
      }
    }
    // A raw commit id (`sha256:hex` or bare hex).
    const value = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
    if (/^[0-9a-f]{64}$/.test(value)) {
      const hash: Hash = { algo: "sha256", value };
      if (await this.#objects.has(hash)) {
        return hash;
      }
    }
    throw new UnknownRef(ref);
  }

  async #loadCommit(id: Hash): Promise<CommitContent> {
    const commit = await this.#objects.getCommit(id);
    const snapshot = await this.#objects.getSnapshot(commit.snapshot);
    const manifest = parseManifest(
      new TextDecoder().decode(await this.#objects.getBlobBytes(snapshot.manifest)),
    );
    const lock = parseLock(
      new TextDecoder().decode(await this.#objects.getBlobBytes(snapshot.lock)),
    );
    return { id, commit, snapshot, manifest, lock };
  }

  #itemSetOf(content: { manifest: Manifest; lock: Lockfile }): ItemSet {
    return buildItemSet(content.manifest, this.#instanceDir, pinsFromLock(content.lock));
  }

  // --- commit --------------------------------------------------------------

  /** Snapshot the working tree and record a commit, advancing HEAD's branch. */
  async commit(
    message: string,
    opts: {
      readonly op?: CommitOp;
      readonly parents?: readonly Hash[];
      readonly requireLockFresh?: boolean;
    } = {},
  ): Promise<CommitRef> {
    const built = await buildSnapshot({
      instanceDir: this.#instanceDir,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      requireLockFresh: opts.requireLockFresh ?? true,
    });
    return this.#recordCommit(built.id, message, opts.op ?? "commit", opts.parents);
  }

  async #recordCommit(
    snapshotId: Hash,
    message: string,
    op: CommitOp,
    explicitParents?: readonly Hash[],
  ): Promise<CommitRef> {
    const head = await this.refs.readHead();
    const headId = await this.refs.resolveHead();
    const parents = explicitParents ?? (headId ? [headId] : []);
    const parentCommits = await Promise.all(parents.map((p) => this.#objects.getCommit(p)));
    const gen = nextGeneration(parentCommits);
    const commit: CommitObject = {
      type: "commit",
      snapshot: snapshotId,
      parents,
      gen,
      author: this.#author,
      time: this.#now(),
      message,
      op,
    };
    const id = await this.#objects.put(commit);
    await this.#advanceHead(head.symbolic, headId, id, `${op}: ${message}`);
    return { id, generation: gen };
  }

  async #advanceHead(
    symbolic: string | undefined,
    old: Hash | undefined,
    next: Hash,
    reflogMsg: string,
  ): Promise<void> {
    if (symbolic) {
      await this.refs.writeRef(symbolic, next);
      await this.refs.appendReflog(symbolic, old, next, this.#author, reflogMsg, this.#now());
    } else {
      await this.refs.setHeadDetached(next);
    }
    await this.refs.appendReflog("HEAD", old, next, this.#author, reflogMsg, this.#now());
  }

  // --- branch --------------------------------------------------------------

  /** Create a branch at HEAD (or at `startPoint`). Does not switch to it. */
  async branch(name: string, startPoint?: string): Promise<CommitRef> {
    const refName = `refs/heads/${name}`;
    if (await this.refs.readRef(refName)) {
      throw new VcStateError(`branch "${name}" already exists`);
    }
    const at = startPoint ? await this.resolveRef(startPoint) : await this.refs.resolveHead();
    if (!at) {
      throw new VcStateError("cannot create a branch before the first commit");
    }
    await this.refs.writeRef(refName, at);
    await this.refs.appendReflog(
      refName,
      undefined,
      at,
      this.#author,
      `branch: created ${name}`,
      this.#now(),
    );
    const commit = await this.#objects.getCommit(at);
    return { id: at, generation: commit.gen };
  }

  /** List local branch names, sorted. */
  async branches(): Promise<{ current?: string; names: string[] }> {
    const refs = await this.refs.listRefs("refs/heads");
    const names = [...refs.keys()].map((r) => r.replace("refs/heads/", "")).sort();
    const cur = await this.refs.currentBranch();
    return { ...(cur ? { current: cur.replace("refs/heads/", "") } : {}), names };
  }

  // --- switch --------------------------------------------------------------

  /** The snapshot id the working tree currently represents (undefined if untracked). */
  async #worktreeSnapshotId(): Promise<Hash | undefined> {
    if (!(await pathExists(join(this.#instanceDir, "anvil.lock")))) {
      return undefined;
    }
    try {
      const built = await buildSnapshot({
        instanceDir: this.#instanceDir,
        vcStore: this.#objects,
        sharedStore: this.#shared,
        requireLockFresh: false,
      });
      return built.id;
    } catch {
      return undefined;
    }
  }

  /** Switch the working tree (and HEAD) to a branch / tag / commit, by hash-diff. */
  async switchTo(ref: string): Promise<CommitRef> {
    const targetId = await this.resolveRef(ref);
    const target = await this.#loadCommit(targetId);

    const headId = await this.refs.resolveHead();
    const worktreeId = await this.#worktreeSnapshotId();
    if (headId) {
      const head = await this.#objects.getCommit(headId);
      // Refuse if the working tree has changes not in HEAD (and not already at target).
      if (
        worktreeId &&
        worktreeId.value !== head.snapshot.value &&
        worktreeId.value !== target.commit.snapshot.value
      ) {
        throw new DirtyWorkingTree();
      }
    }

    const previous = headId ? (await this.#objects.getCommit(headId)).snapshot : undefined;
    await materializeSnapshot({
      instanceDir: this.#instanceDir,
      snapshot: target.snapshot,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      ...(previous ? { previous: await this.#objects.getSnapshot(previous) } : {}),
    });

    // A bare branch name → symbolic HEAD; anything else → detached.
    const branchRef = `refs/heads/${ref}`;
    if (await this.refs.readRef(branchRef)) {
      await this.refs.setHeadSymbolic(branchRef);
    } else {
      await this.refs.setHeadDetached(targetId);
    }
    await this.refs.appendReflog(
      "HEAD",
      headId,
      targetId,
      this.#author,
      `switch: to ${ref}`,
      this.#now(),
    );
    return { id: targetId, generation: target.commit.gen };
  }

  // --- log -----------------------------------------------------------------

  /** History reachable from `start` (default HEAD), newest → oldest by generation. */
  async log(start?: string): Promise<LogEntry[]> {
    const from = start ? await this.resolveRef(start) : await this.refs.resolveHead();
    if (!from) {
      return [];
    }
    // Ref index: commit value → ref names pointing there.
    const refIndex = new Map<string, string[]>();
    for (const prefix of ["refs/heads", "refs/tags", "refs/remotes"]) {
      for (const [name, id] of await this.refs.listRefs(prefix)) {
        (refIndex.get(id.value) ?? refIndex.set(id.value, []).get(id.value) ?? []).push(name);
      }
    }
    const loaded = new Map<string, CommitContent>();
    const stack: Hash[] = [from];
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || loaded.has(id.value)) {
        continue;
      }
      const content = await this.#loadCommit(id);
      loaded.set(id.value, content);
      for (const p of content.commit.parents) {
        if (!loaded.has(p.value)) {
          stack.push(p);
        }
      }
    }
    const ordered = [...loaded.values()].sort(
      (a, b) =>
        b.commit.gen - a.commit.gen ||
        b.commit.time - a.commit.time ||
        (a.id.value < b.id.value ? 1 : -1),
    );
    const entries: LogEntry[] = [];
    for (const c of ordered) {
      const parentContent = c.commit.parents[0] ? loaded.get(c.commit.parents[0].value) : undefined;
      const parentSet: ItemSet = parentContent
        ? this.#itemSetOf(parentContent)
        : {
            items: new Map(),
            game: { minecraft: c.manifest.game.minecraft, loader: c.manifest.game.loader },
          };
      const stat = diffItemSets(parentSet, this.#itemSetOf(c));
      entries.push({
        id: c.id,
        gen: c.commit.gen,
        author: c.commit.author,
        time: c.commit.time,
        message: c.commit.message,
        op: c.commit.op,
        parents: c.commit.parents,
        stat,
        refs: refIndex.get(c.id.value) ?? [],
      });
    }
    return entries;
  }

  // --- shared 3-way apply (merge / revert / rebase step) -------------------

  /** Pick the game packages + meta whose game matches the merged `@game`. */
  #gameFor(
    merged: { minecraft: string; loader: string },
    sides: readonly CommitContent[],
  ): { gamePackages: readonly LockPackage[]; gameMeta: RelockRequest["gameMeta"] } {
    for (const side of sides) {
      if (
        gameValue({ minecraft: side.lock.meta.minecraft, loader: side.lock.meta.loader }) ===
        gameValue(merged)
      ) {
        return {
          gamePackages: side.lock.resolved.filter(isGamePackage),
          gameMeta: {
            minecraft: side.lock.meta.minecraft,
            loader: side.lock.meta.loader,
            java: side.lock.meta.java,
          },
        };
      }
    }
    const fallback = sides[0];
    if (!fallback) {
      throw new VcStateError("no side lock to source the game install from");
    }
    return {
      gamePackages: fallback.lock.resolved.filter(isGamePackage),
      gameMeta: {
        minecraft: fallback.lock.meta.minecraft,
        loader: fallback.lock.meta.loader,
        java: fallback.lock.meta.java,
      },
    };
  }

  /** VC blobs already holding carried local bytes across a set of snapshots. */
  #knownBlobs(snapshots: readonly SnapshotObject[]): Map<string, Hash> {
    const map = new Map<string, Hash>();
    for (const snap of snapshots) {
      for (const c of snap.carried) {
        map.set(c.content.value, c.blob);
      }
    }
    return map;
  }

  /**
   * Write a merged manifest + re-derived lock to the working tree, patched clean.
   * The lock's `manifestHash` is computed from the manifest **as read back from
   * disk** (not the in-memory object), so the pair provably agrees regardless of
   * any serialize→parse normalization — the subsequent `requireLockFresh` snapshot
   * of this same tree can never spuriously trip the stale-lock guard.
   */
  async #writeWorktree(manifest: Manifest, lock: Lockfile): Promise<void> {
    await writeManifest(this.#instanceDir, manifest);
    const disk = await readManifest(this.#instanceDir);
    const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(disk)), "sha256");
    const finalLock: Lockfile = { meta: { ...lock.meta, manifestHash }, resolved: lock.resolved };
    await writeLock(this.#instanceDir, finalLock);
  }

  // --- merge ---------------------------------------------------------------

  async merge(
    branch: string,
    policy: { strategy?: ConflictStrategy; onConflict?: OnConflict } = {},
  ): Promise<MergeOutcome> {
    const oursId = await this.refs.resolveHead();
    if (!oursId) {
      throw new VcStateError("cannot merge into an unborn HEAD");
    }
    if (await rebaseInProgress(this.#anvilDir)) {
      throw new VcStateError("a rebase is in progress — finish or abort it before merging");
    }
    const theirsId = await this.resolveRef(branch);
    if (theirsId.value === oursId.value || (await isAncestor(this.#objects, theirsId, oursId))) {
      return { conflicts: [], warnings: [], fastForward: false, upToDate: true };
    }
    if (await isAncestor(this.#objects, oursId, theirsId)) {
      // Fast-forward: our history is fully contained in theirs.
      const target = await this.#loadCommit(theirsId);
      const previous = await this.#objects.getSnapshot(
        (await this.#objects.getCommit(oursId)).snapshot,
      );
      await materializeSnapshot({
        instanceDir: this.#instanceDir,
        snapshot: target.snapshot,
        vcStore: this.#objects,
        sharedStore: this.#shared,
        previous,
      });
      const head = await this.refs.readHead();
      await this.refs.writeOrigHead(oursId);
      await this.#advanceHead(head.symbolic, oursId, theirsId, `merge: fast-forward ${branch}`);
      return {
        committed: { id: theirsId, generation: target.commit.gen },
        conflicts: [],
        warnings: [],
        fastForward: true,
        upToDate: false,
      };
    }

    const lca = await findLca(this.#objects, oursId, theirsId);
    const warnings: string[] = [];
    if (lca.multiple) {
      warnings.push(
        "criss-cross history: multiple merge bases — using the highest-generation base (recursive virtual-base merge is deferred to v1+)",
      );
    }
    if (!lca.base) {
      throw new VcStateError("refusing to merge unrelated histories (no common ancestor)");
    }

    const ours = await this.#loadCommit(oursId);
    const theirs = await this.#loadCommit(theirsId);
    const base = await this.#loadCommit(lca.base);

    await this.refs.writeMergeHead(theirsId);
    try {
      const outcome = await this.#applyThreeWay({
        base,
        ours,
        theirs,
        project: ours.manifest.project,
        policy,
        message: `merge branch '${branch}'`,
        op: "merge",
        parents: [oursId, theirsId],
      });
      if (!outcome.committed) {
        return { conflicts: outcome.conflicts, warnings, fastForward: false, upToDate: false };
      }
      await this.refs.writeOrigHead(oursId);
      return {
        committed: outcome.committed,
        conflicts: [],
        warnings,
        fastForward: false,
        upToDate: false,
      };
    } finally {
      await this.refs.clearMergeHead();
    }
  }

  /**
   * The shared engine for a 3-way apply used by merge / revert / one rebase step:
   * item-set merge → (phase 1 conflicts → abort) → constrained re-lock → (phase 2
   * conflict → abort) → write worktree + record commit.
   */
  async #applyThreeWay(args: {
    base: { manifest: Manifest; lock: Lockfile };
    ours: CommitContent;
    theirs: { manifest: Manifest; lock: Lockfile; snapshot?: SnapshotObject };
    project: Manifest["project"];
    policy: ResolutionPolicy;
    message: string;
    op: CommitOp;
    parents: readonly Hash[];
    /** When set, do not advance HEAD (rebase manages its own tip); just record. */
    readonly recordOnly?: boolean;
  }): Promise<{ committed?: CommitRef; conflicts: readonly Conflict[] }> {
    const merged = await threeWayMerge({
      base: this.#itemSetOf(args.base),
      ours: this.#itemSetOf(args.ours),
      theirs: this.#itemSetOf(args.theirs),
      project: args.project,
      oursPins: pinsFromLock(args.ours.lock),
      theirsPins: pinsFromLock(args.theirs.lock),
      basePins: pinsFromLock(args.base.lock),
      policy: args.policy,
    });
    if (!merged.manifest) {
      return { conflicts: merged.conflicts };
    }

    const game = this.#gameFor(merged.manifest.game, [
      args.ours,
      args.theirs as CommitContent,
      args.base as CommitContent,
    ]);
    let relocked: Lockfile;
    try {
      relocked = await this.#relock({
        manifest: merged.manifest,
        seedPins: merged.seedPins,
        reResolveKeys: merged.reResolveKeys,
        gamePackages: game.gamePackages,
        gameMeta: game.gameMeta,
      });
    } catch (err) {
      // A phase-2 secondary (no-compatible-version / dependency) — abort, no commit.
      const message = err instanceof Error ? err.message : String(err);
      const conflict: Conflict = {
        key: "@relock",
        kind: "no-compatible-version",
        severity: "high",
        message,
      };
      return { conflicts: [conflict] };
    }

    await this.#writeWorktree(merged.manifest, relocked);
    const carriedKnown = this.#knownBlobs(
      [
        args.ours.snapshot,
        (args.theirs as CommitContent).snapshot,
        (args.base as CommitContent).snapshot,
      ].filter((s): s is SnapshotObject => Boolean(s)),
    );
    const built = await buildSnapshot({
      instanceDir: this.#instanceDir,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      requireLockFresh: true,
      knownBlobs: carriedKnown,
    });
    // Materialize the merged carried local files back onto the working tree, so a
    // local item whose winning side differs from the current working tree (e.g.
    // theirs won a config edit) is written to disk — the tree now matches the
    // commit, not just the manifest+lock.
    await materializeSnapshot({
      instanceDir: this.#instanceDir,
      snapshot: built.snapshot,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      previous: args.ours.snapshot,
    });
    if (args.recordOnly) {
      const parentCommits = await Promise.all(args.parents.map((p) => this.#objects.getCommit(p)));
      const commit: CommitObject = {
        type: "commit",
        snapshot: built.id,
        parents: args.parents,
        gen: nextGeneration(parentCommits),
        author: this.#author,
        time: this.#now(),
        message: args.message,
        op: args.op,
      };
      const id = await this.#objects.put(commit);
      return { committed: { id, generation: commit.gen }, conflicts: [] };
    }
    const committed = await this.#recordCommit(built.id, args.message, args.op, args.parents);
    return { committed, conflicts: [] };
  }

  // --- revert --------------------------------------------------------------

  /** Create a new commit that undoes the item-delta a past commit introduced. */
  async revert(ref: string): Promise<RevertOutcome> {
    const headId = await this.refs.resolveHead();
    if (!headId) {
      throw new VcStateError("cannot revert on an unborn HEAD");
    }
    const targetId = await this.resolveRef(ref);
    const target = await this.#loadCommit(targetId);
    const head = await this.#loadCommit(headId);
    const parentId = target.commit.parents[0];
    const parent = parentId
      ? await this.#loadCommit(parentId)
      : {
          manifest: { ...target.manifest, items: EMPTY_MANIFEST_ITEMS } as Manifest,
          lock: target.lock,
        };

    // Undo `target`: base = target's state, ours = HEAD, theirs = target's parent.
    const outcome = await this.#applyThreeWay({
      base: target,
      ours: head,
      theirs: parent as { manifest: Manifest; lock: Lockfile },
      project: head.manifest.project,
      policy: {},
      message: `revert "${target.commit.message}"`,
      op: "revert",
      parents: [headId],
    });
    if (outcome.committed) {
      await this.refs.writeOrigHead(headId);
    }
    return { committed: outcome.committed, conflicts: outcome.conflicts };
  }

  // --- rebase --------------------------------------------------------------

  /** Begin a rebase of the current branch onto `onto`. */
  async rebase(
    onto: string,
    policy: { strategy?: ConflictStrategy; onConflict?: OnConflict } = {},
  ): Promise<RebaseOutcome> {
    if (await rebaseInProgress(this.#anvilDir)) {
      throw new VcStateError("a rebase is already in progress — use --continue / --skip / --abort");
    }
    const branch = await this.refs.currentBranch();
    if (!branch) {
      throw new VcStateError("cannot rebase a detached HEAD");
    }
    const oursId = await this.refs.resolveHead();
    if (!oursId) {
      throw new VcStateError("cannot rebase an unborn HEAD");
    }
    const ontoId = await this.resolveRef(onto);
    if (oursId.value === ontoId.value || (await isAncestor(this.#objects, oursId, ontoId))) {
      // Our tip is already at/under onto: fast-forward the branch to onto.
      if (oursId.value !== ontoId.value) {
        await this.refs.writeRef(branch, ontoId);
      }
      return { status: "up-to-date", conflicts: [], warnings: [], remaining: 0 };
    }

    // The commits unique to our side (ours minus onto's ancestors), oldest → newest.
    const todo = await this.#commitsToReplay(oursId, ontoId);
    if (todo.length === 0) {
      return { status: "up-to-date", conflicts: [], warnings: [], remaining: 0 };
    }
    await this.refs.writeOrigHead(oursId);
    const state: RebaseState = {
      onto: ontoId,
      origHead: oursId,
      branch,
      tip: ontoId,
      todo,
      done: [],
    };
    // Materialize onto so the working tree starts from the new base.
    const ontoContent = await this.#loadCommit(ontoId);
    const oursSnap = await this.#objects.getSnapshot(
      (await this.#objects.getCommit(oursId)).snapshot,
    );
    await materializeSnapshot({
      instanceDir: this.#instanceDir,
      snapshot: ontoContent.snapshot,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      previous: oursSnap,
    });
    await writeRebaseState(this.#anvilDir, state);
    return this.#runRebase(state, policy);
  }

  /** Continue a paused rebase, taking the resolved working tree as the current step. */
  async rebaseContinue(
    policy: { strategy?: ConflictStrategy; onConflict?: OnConflict } = {},
  ): Promise<RebaseOutcome> {
    const state = await readRebaseState(this.#anvilDir);
    if (!state) {
      throw new VcStateError("no rebase in progress");
    }
    if (state.current) {
      // Record the user-resolved working tree as the rebased commit for this step.
      const built = await buildSnapshot({
        instanceDir: this.#instanceDir,
        vcStore: this.#objects,
        sharedStore: this.#shared,
        requireLockFresh: true,
      });
      const tipCommit = await this.#objects.getCommit(state.tip);
      const commit: CommitObject = {
        type: "commit",
        snapshot: built.id,
        parents: [state.tip],
        gen: nextGeneration([tipCommit]),
        author: this.#author,
        time: this.#now(),
        message: (await this.#objects.getCommit(state.current)).message,
        op: "rebase",
      };
      const id = await this.#objects.put(commit);
      // The resolved commit replaces the paused `current` (todo[0]) → advance past it.
      const advanced: RebaseState = {
        ...state,
        tip: id,
        done: [...state.done, id],
        todo: state.todo.slice(1),
      };
      const { current: _drop, ...cleared } = advanced;
      void _drop;
      await writeRebaseState(this.#anvilDir, cleared);
      return this.#runRebase(cleared, policy);
    }
    return this.#runRebase(state, policy);
  }

  /** Skip the current (conflicting) commit and continue. */
  async rebaseSkip(
    policy: { strategy?: ConflictStrategy; onConflict?: OnConflict } = {},
  ): Promise<RebaseOutcome> {
    const state = await readRebaseState(this.#anvilDir);
    if (!state) {
      throw new VcStateError("no rebase in progress");
    }
    // Drop the current (conflicting) commit entirely: advance past todo[0], tip unchanged.
    const { current: _drop, ...rest } = state;
    void _drop;
    const cleared: RebaseState = { ...rest, todo: state.todo.slice(1) };
    await writeRebaseState(this.#anvilDir, cleared);
    return this.#runRebase(cleared, policy);
  }

  /** Abort the rebase, restoring ORIG_HEAD and the pre-rebase working tree. */
  async rebaseAbort(): Promise<RebaseOutcome> {
    const state = await readRebaseState(this.#anvilDir);
    if (!state) {
      throw new VcStateError("no rebase in progress");
    }
    const orig = await this.#loadCommit(state.origHead);
    await this.refs.writeRef(state.branch, state.origHead);
    const tipSnap = await this.#objects
      .getCommit(state.tip)
      .then((c) => this.#objects.getSnapshot(c.snapshot))
      .catch(() => undefined);
    await materializeSnapshot({
      instanceDir: this.#instanceDir,
      snapshot: orig.snapshot,
      vcStore: this.#objects,
      sharedStore: this.#shared,
      ...(tipSnap ? { previous: tipSnap } : {}),
    });
    await this.refs.appendReflog(
      "HEAD",
      state.tip,
      state.origHead,
      this.#author,
      "rebase: aborted",
      this.#now(),
    );
    await clearRebaseState(this.#anvilDir);
    return { status: "aborted", conflicts: [], warnings: [], remaining: 0 };
  }

  /** Drive the rebase todo list, one item-delta replay + re-lock per step. */
  async #runRebase(initial: RebaseState, policy: ResolutionPolicy): Promise<RebaseOutcome> {
    let state = initial;
    while (state.todo.length > 0) {
      const currentId = state.todo[0];
      if (!currentId) {
        break;
      }
      const current = await this.#loadCommit(currentId);
      const parentId = current.commit.parents[0];
      const parent = parentId
        ? await this.#loadCommit(parentId)
        : {
            manifest: { ...current.manifest, items: EMPTY_MANIFEST_ITEMS } as Manifest,
            lock: current.lock,
          };
      const tip = await this.#loadCommit(state.tip);

      // Replay `current`'s delta (parent → current) onto the rebased tip.
      const applied = await this.#applyThreeWay({
        base: parent as { manifest: Manifest; lock: Lockfile },
        ours: tip,
        theirs: current,
        project: tip.manifest.project,
        policy,
        message: current.commit.message,
        op: "rebase",
        parents: [state.tip],
        recordOnly: true,
      });
      if (!applied.committed) {
        // Pause: persist which commit is stuck; the working tree holds tip's state.
        const paused: RebaseState = { ...state, current: currentId };
        await writeRebaseState(this.#anvilDir, paused);
        return {
          status: "conflicts",
          conflicts: applied.conflicts,
          warnings: [],
          remaining: state.todo.length,
        };
      }
      state = {
        ...state,
        tip: applied.committed.id,
        done: [...state.done, applied.committed.id],
        todo: state.todo.slice(1),
      };
      const { current: _c, ...advanced } = state;
      void _c;
      state = advanced;
      await writeRebaseState(this.#anvilDir, state);
    }

    // Finished: move the branch to the rebased tip, then clear the state.
    const origHead = state.origHead;
    await this.refs.writeRef(state.branch, state.tip);
    await this.refs.appendReflog(
      state.branch,
      origHead,
      state.tip,
      this.#author,
      `rebase: onto ${state.onto.value.slice(0, 12)}`,
      this.#now(),
    );
    await this.refs.appendReflog(
      "HEAD",
      origHead,
      state.tip,
      this.#author,
      "rebase: finished",
      this.#now(),
    );
    await clearRebaseState(this.#anvilDir);
    const tipCommit = await this.#objects.getCommit(state.tip);
    return {
      status: "done",
      head: { id: state.tip, generation: tipCommit.gen },
      conflicts: [],
      warnings: [],
      remaining: 0,
    };
  }

  /** The commits on `ours`'s first-parent chain that are not ancestors of `onto`. */
  async #commitsToReplay(oursId: Hash, ontoId: Hash): Promise<Hash[]> {
    const { ancestors } = await import("./graph.js");
    const ontoAnc = await ancestors(this.#objects, ontoId);
    const chain: Hash[] = [];
    let cursor: Hash | undefined = oursId;
    while (cursor && !ontoAnc.has(cursor.value)) {
      chain.push(cursor);
      const commit = await this.#objects.getCommit(cursor);
      cursor = commit.parents[0];
    }
    return chain.reverse(); // oldest → newest
  }
}
