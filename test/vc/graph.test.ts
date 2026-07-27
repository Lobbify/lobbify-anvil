import { afterEach, describe, expect, it } from "vitest";
import {
  type CommitObject,
  type Hash,
  type SnapshotObject,
  VcObjectStore,
  findLca,
  isAncestor,
  nextGeneration,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

/**
 * A commit factory that lets a test set the display `time` FREELY (even backwards)
 * while `gen` is assigned authoritatively from the parents — exactly the split the
 * design mandates: generation orders history, wall-clock is display-only.
 */
async function mkCommit(
  store: VcObjectStore,
  opts: { parents: Hash[]; time: number; message: string },
): Promise<{ id: Hash; commit: CommitObject }> {
  const snapshot: SnapshotObject = {
    type: "snapshot",
    manifest: await store.putBlob(new TextEncoder().encode(`m-${opts.message}`)),
    lock: await store.putBlob(new TextEncoder().encode(`l-${opts.message}`)),
    ignore: await store.putBlob(new Uint8Array()),
    carried: [],
    tracked: [],
  };
  const parentCommits = await Promise.all(opts.parents.map((p) => store.getCommit(p)));
  const commit: CommitObject = {
    type: "commit",
    snapshot: await store.put(snapshot),
    parents: opts.parents,
    gen: nextGeneration(parentCommits),
    author: "tester",
    time: opts.time,
    message: opts.message,
    op: "commit",
  };
  return { id: await store.put(commit), commit };
}

describe("vc commit graph (generation-ordered, clock-skew-proof)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function store(): Promise<VcObjectStore> {
    const anvilDir = await mkTmp("vc-graph");
    dirs.push(anvilDir);
    return new VcObjectStore({ anvilDir });
  }

  it("GATE clock-skew: LCA is correct even when timestamps run BACKWARDS", async () => {
    const s = await store();
    // Times run strictly backwards down the history (a badly-skewed clock), but
    // generation numbers still increase monotonically with depth.
    const root = await mkCommit(s, { parents: [], time: 9000, message: "root" });
    const a = await mkCommit(s, { parents: [root.id], time: 8000, message: "a" });
    const ours = await mkCommit(s, { parents: [a.id], time: 7000, message: "ours" });
    const theirs = await mkCommit(s, { parents: [a.id], time: 500, message: "theirs" });

    // Sanity: the skew is real — the merge base has the LATEST timestamp of all.
    expect(root.commit.time).toBeGreaterThan(theirs.commit.time);
    expect(a.commit.time).toBeGreaterThan(ours.commit.time);

    const lca = await findLca(s, ours.id, theirs.id);
    // The true LCA is `a` (highest-generation common ancestor), NOT `root` — and
    // NOT whatever the timestamps would suggest.
    expect(lca.base?.value).toBe(a.id.value);
    expect(lca.multiple).toBe(false);
    // Generations are authoritative.
    expect(a.commit.gen).toBe(1);
    expect(ours.commit.gen).toBe(2);
    expect(theirs.commit.gen).toBe(2);
  });

  it("GATE clock-skew: ancestry is structural, never time-based", async () => {
    const s = await store();
    const root = await mkCommit(s, { parents: [], time: 100, message: "root" });
    // A child with an EARLIER timestamp than its parent must still be a descendant.
    const child = await mkCommit(s, { parents: [root.id], time: 50, message: "child" });
    expect(await isAncestor(s, root.id, child.id)).toBe(true);
    expect(await isAncestor(s, child.id, root.id)).toBe(false);
  });

  it("reports multiple merge bases (criss-cross) and picks the highest generation", async () => {
    const s = await store();
    const root = await mkCommit(s, { parents: [], time: 0, message: "root" });
    const x = await mkCommit(s, { parents: [root.id], time: 0, message: "x" });
    const y = await mkCommit(s, { parents: [root.id], time: 0, message: "y" });
    // Two merges cross-pollinate x and y → both m1 and m2 are common ancestors of
    // the two tips, neither an ancestor of the other (a criss-cross).
    const m1 = await mkCommit(s, { parents: [x.id, y.id], time: 0, message: "m1" });
    const m2 = await mkCommit(s, { parents: [y.id, x.id], time: 0, message: "m2" });
    const tipA = await mkCommit(s, { parents: [m1.id], time: 0, message: "tipA" });
    const tipB = await mkCommit(s, { parents: [m2.id], time: 0, message: "tipB" });
    const lca = await findLca(s, tipA.id, tipB.id);
    // tipA's ancestry contains m1 (not m2); tipB's contains m2 (not m1); so the
    // maximal common ancestors are x and y — the classic criss-cross pair.
    expect(lca.multiple).toBe(true);
    expect(lca.bases).toHaveLength(2);
    expect([x.id.value, y.id.value]).toContain(lca.base?.value);
  });
});
