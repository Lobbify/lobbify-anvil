/**
 * Version-control garbage collection reachability.
 *
 * The GC root set is the **full ref closure**: every branch / tag / remote-tracking
 * ref, `HEAD` / `ORIG_HEAD` / `MERGE_HEAD`, every commit ever named by a reflog,
 * and any in-progress operation state (an in-flight rebase's `REBASE_STATE`). From
 * each root we walk the commit DAG, and from each reachable commit its snapshot and
 * that snapshot's blobs — including the **carried local blobs**, so switching to an
 * old commit after a GC never hits a missing object.
 *
 * The same walk yields the reachable commits' locks + carried content hashes, which
 * the shared content-store GC unions into its roots so a mod pinned only by an old
 * commit is not reclaimed out from under a future `switch` + `build`.
 */

import { parseLock } from "../lock/index.js";
import type { Hash, Lockfile } from "../types/index.js";
import type { VcObjectStore } from "./objects.js";
import { readRebaseState, rebaseStateHashes } from "./rebase.js";
import type { Refs } from "./refs.js";

export interface VcReachability {
  /** Every VC object id to keep (commits, snapshots, blobs, carried blobs). */
  readonly keep: ReadonlySet<string>;
  /** Every reachable commit's lock (for the shared-store root union). */
  readonly commitLocks: readonly Lockfile[];
  /** Every carried local blob's shared-store content hash. */
  readonly carriedContent: readonly Hash[];
}

/** Compute VC reachability from the full ref closure + reflog + in-progress op state. */
export async function vcReachability(
  refs: Refs,
  objects: VcObjectStore,
  anvilDir: string,
): Promise<VcReachability> {
  const seeds: Hash[] = [];
  const pushSeed = (h: Hash | undefined): void => {
    if (h) {
      seeds.push(h);
    }
  };

  for (const prefix of ["refs/heads", "refs/tags", "refs/remotes"]) {
    for (const id of (await refs.listRefs(prefix)).values()) {
      pushSeed(id);
    }
  }
  pushSeed(await refs.resolveHead());
  pushSeed(await refs.readOrigHead());
  pushSeed(await refs.readMergeHead());
  for (const h of await refs.allReflogHashes()) {
    pushSeed(h);
  }
  const rebase = await readRebaseState(anvilDir);
  if (rebase) {
    for (const h of rebaseStateHashes(rebase)) {
      pushSeed(h);
    }
  }

  const keep = new Set<string>();
  const commitLocks: Lockfile[] = [];
  const carriedContent: Hash[] = [];
  const visited = new Set<string>();
  const stack = [...seeds];

  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || visited.has(id.value)) {
      continue;
    }
    visited.add(id.value);
    let commit: Awaited<ReturnType<VcObjectStore["getCommit"]>>;
    try {
      commit = await objects.getCommit(id);
    } catch {
      continue; // a dangling seed (already-pruned reflog entry) — skip
    }
    keep.add(id.value);
    keep.add(commit.snapshot.value);
    try {
      const snapshot = await objects.getSnapshot(commit.snapshot);
      keep.add(snapshot.manifest.value);
      keep.add(snapshot.lock.value);
      keep.add(snapshot.ignore.value);
      for (const c of snapshot.carried) {
        keep.add(c.blob.value);
        carriedContent.push(c.content);
      }
      try {
        const lockText = new TextDecoder().decode(await objects.getBlobBytes(snapshot.lock));
        commitLocks.push(parseLock(lockText));
      } catch {
        // a lock blob that won't parse — leave it out of the shared root union
      }
    } catch {
      // a snapshot object missing — the commit is still kept, nothing to expand
    }
    for (const p of commit.parents) {
      if (!visited.has(p.value)) {
        stack.push(p);
      }
    }
  }

  return { keep, commitLocks, carriedContent };
}
