/**
 * Commit-graph walks over the VC object store.
 *
 * **Generation numbers are the single source of truth for ordering and lowest-
 * common-ancestor (LCA).** Wall-clock commit `time` is display-only and is NEVER
 * consulted here — a machine with a skewed clock (or a rebase that rewrites times)
 * must not be able to corrupt history ordering. `gen` is assigned monotonically at
 * commit creation (`gen = parents.length ? 1 + max(parent gens) : 0`), so an
 * ancestor always has a strictly smaller generation than its descendants.
 */

import type { Hash } from "../types/index.js";
import type { CommitObject, VcObjectStore } from "./objects.js";

/** Load a commit and its id together. */
export interface LoadedCommit {
  readonly id: Hash;
  readonly commit: CommitObject;
}

/** The generation number a new commit with these parents must carry. */
export function nextGeneration(parents: readonly CommitObject[]): number {
  if (parents.length === 0) {
    return 0;
  }
  return 1 + Math.max(...parents.map((p) => p.gen));
}

/**
 * All ancestors of `start` (inclusive), id → commit. A full walk of the DAG; fine
 * at the scale anvil histories reach and immune to clock skew (structure only).
 */
export async function ancestors(
  store: VcObjectStore,
  start: Hash,
): Promise<Map<string, CommitObject>> {
  const out = new Map<string, CommitObject>();
  const stack: Hash[] = [start];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || out.has(id.value)) {
      continue;
    }
    const commit = await store.getCommit(id);
    out.set(id.value, commit);
    for (const p of commit.parents) {
      if (!out.has(p.value)) {
        stack.push(p);
      }
    }
  }
  return out;
}

/** True when `maybeAncestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(
  store: VcObjectStore,
  maybeAncestor: Hash,
  descendant: Hash,
): Promise<boolean> {
  if (maybeAncestor.value === descendant.value) {
    return true;
  }
  const anc = await store.getCommit(maybeAncestor);
  const target = await store.getCommit(descendant);
  // A commit with gen ≥ the descendant's can never be a proper ancestor.
  if (anc.gen >= target.gen) {
    return false;
  }
  const seen = await ancestors(store, descendant);
  return seen.has(maybeAncestor.value);
}

/** The result of an LCA query. */
export interface LcaResult {
  /** The chosen merge base (highest-generation maximal common ancestor). */
  readonly base?: Hash;
  /** Every maximal common ancestor (>1 ⇒ criss-cross; `base` is the highest-gen). */
  readonly bases: readonly Hash[];
  /** True when more than one maximal common ancestor exists (a warn-worthy merge). */
  readonly multiple: boolean;
}

/**
 * The lowest common ancestor(s) of `a` and `b`, computed purely from the graph +
 * generation numbers. The maximal common ancestors are the common commits not
 * themselves an ancestor of another common commit. With more than one (a criss-
 * cross history), we pick the **highest-generation** base (ties broken by id) and
 * flag `multiple` so the caller can warn — recursive virtual-base merge is a v1+
 * item (deferred per the plan).
 */
export async function findLca(store: VcObjectStore, a: Hash, b: Hash): Promise<LcaResult> {
  const ancA = await ancestors(store, a);
  const ancB = await ancestors(store, b);
  const common: LoadedCommit[] = [];
  for (const [value, commit] of ancA) {
    if (ancB.has(value)) {
      common.push({ id: { algo: "sha256", value }, commit });
    }
  }
  if (common.length === 0) {
    return { bases: [], multiple: false };
  }
  const commonValues = new Set(common.map((c) => c.id.value));
  // A maximal common ancestor is one that is NOT an ancestor of any other common
  // ancestor. Test structurally: does any OTHER common commit have this one in its
  // ancestor set?
  const maximal: LoadedCommit[] = [];
  for (const c of common) {
    let dominated = false;
    for (const other of common) {
      if (other.id.value === c.id.value) {
        continue;
      }
      const otherAnc = await ancestors(store, other.id);
      if (otherAnc.has(c.id.value)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      maximal.push(c);
    }
  }
  void commonValues;
  // Deterministic pick: highest generation, then lexicographically-smallest id.
  maximal.sort((x, y) => y.commit.gen - x.commit.gen || (x.id.value < y.id.value ? -1 : 1));
  const bases = maximal.map((m) => m.id);
  return {
    ...(bases[0] ? { base: bases[0] } : {}),
    bases,
    multiple: bases.length > 1,
  };
}
