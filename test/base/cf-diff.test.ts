/**
 * Diffing two versions of a CurseForge pack — the capability that motivated
 * doing CurseForge properly rather than flattening it into the `.mrpack` shape.
 *
 * ## The fixture
 *
 * The shape is taken from a real measurement against CurseForge's live API on
 * 2026-07-26: **All the Mods 10 v7.1 (fileId 8323938) → v7.2 (fileId 8469481)**,
 * 482 members each, diffing to **392 unchanged, 89 updated, 1 added, 1 removed**
 * — a 90-of-482 delta, 18.7%.
 *
 * It is reproduced here **synthetically and offline**. The suite must never
 * depend on CurseForge's live API: a network-backed test would be flaky, would
 * need a key anvil deliberately does not ship, and would silently change meaning
 * the next time ATM10 publishes. What is asserted is the arithmetic and the
 * mechanism — that two 482-member packs, resolved with no member downloads,
 * diff to exactly that delta on `(projectID, fileID)` alone.
 *
 * Note the counts are internally consistent, which is what makes them a usable
 * fixture: the intersection is 392 + 89 = 481; plus 1 removed = 482 in v7.1, and
 * plus 1 added = 482 in v7.2.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, diffMemberSets } from "../../index.js";
import type { LockPackage } from "../../index.js";
import { type CfMemberSpec, cfBaseResolverFor, cfPackWorld } from "../helpers/cf-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

/** The measured ATM10 v7.1 → v7.2 delta. */
const ATM10 = {
  members: 482,
  unchanged: 392,
  updated: 89,
  added: 1,
  removed: 1,
  v71FileId: 8323938,
  v72FileId: 8469481,
} as const;

/**
 * Build the two member lists.
 *
 * Projects `1..481` are in both versions. The first 89 of them get a bumped
 * `fileID` in v7.2 (updated); the remaining 392 keep theirs (unchanged).
 * Project `482` is only in v7.1 (removed); project `483` only in v7.2 (added).
 */
function atm10Members(): { v71: CfMemberSpec[]; v72: CfMemberSpec[] } {
  const v71: CfMemberSpec[] = [];
  const v72: CfMemberSpec[] = [];
  for (let p = 1; p <= 481; p += 1) {
    const baseFile = 100_000 + p;
    v71.push({ projectID: p, fileID: baseFile, slug: `mod-${p}` });
    const updated = p <= ATM10.updated;
    v72.push({
      projectID: p,
      fileID: updated ? baseFile + 500_000 : baseFile,
      slug: `mod-${p}`,
      ...(updated ? { body: `mod-${p}-v2` } : {}),
    });
  }
  v71.push({ projectID: 482, fileID: 100_482, slug: "mod-dropped" });
  v72.push({ projectID: 483, fileID: 100_483, slug: "mod-new" });
  return { v71, v72 };
}

describe("diffing two CurseForge pack versions", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function resolveVersion(
    members: CfMemberSpec[],
    packFileId: number,
  ): Promise<{ members: readonly LockPackage[]; cdnCalls: number }> {
    const instanceDir = await mkTmp("inst");
    const storeRoot = await mkTmp("store");
    dirs.push(instanceDir, storeRoot);
    const world = cfPackWorld({ members, packFileId });
    const pack = await cfBaseResolverFor(world, instanceDir, {
      now: NOW,
      store: new ContentStore({ root: storeRoot }),
    })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(packFileId) },
    });
    return {
      members: pack.members,
      cdnCalls: world.http.calls.filter((u) => u.includes("edge.forgecdn.net")).length,
    };
  }

  it("diffs 482 members to the measured ATM10 v7.1 → v7.2 delta", async () => {
    const { v71, v72 } = atm10Members();
    const before = await resolveVersion(v71, ATM10.v71FileId);
    const after = await resolveVersion(v72, ATM10.v72FileId);

    expect(before.members).toHaveLength(ATM10.members);
    expect(after.members).toHaveLength(ATM10.members);

    const delta = diffMemberSets(before.members, after.members);
    expect({
      unchanged: delta.unchanged.length,
      updated: delta.updated.length,
      added: delta.added.length,
      removed: delta.removed.length,
    }).toEqual({
      unchanged: ATM10.unchanged,
      updated: ATM10.updated,
      added: ATM10.added,
      removed: ATM10.removed,
    });

    // "90 changed of 482" is measured against the NEWER version's member list:
    // of v7.2's 482 members, 392 are byte-identical carry-overs and 90 are not
    // (89 updated + 1 added). The 1 removed member is not one of v7.2's 482, so
    // adding it here would be counting across both sides — 91 is the size of the
    // symmetric difference, which is a different (also correct) statistic.
    const changed = delta.updated.length + delta.added.length;
    expect(changed).toBe(90);
    expect(changed).toBe(ATM10.members - delta.unchanged.length);
    expect(changed / ATM10.members).toBeCloseTo(0.187, 3);
  });

  it("computes that delta from identity alone — one download per pack, not 482", async () => {
    const { v71, v72 } = atm10Members();
    const before = await resolveVersion(v71, ATM10.v71FileId);
    const after = await resolveVersion(v72, ATM10.v72FileId);
    // The ONLY bytes fetched are the two pack archives. Diffing two 482-member
    // packs costs two zips, not ~30 GB of jars.
    expect(before.cdnCalls).toBe(1);
    expect(after.cdnCalls).toBe(1);
  });

  it("names what changed, on the (projectID, fileID) axis", async () => {
    const { v71, v72 } = atm10Members();
    const before = await resolveVersion(v71, ATM10.v71FileId);
    const after = await resolveVersion(v72, ATM10.v72FileId);
    const delta = diffMemberSets(before.members, after.members);

    expect(delta.added.map((p) => p.project)).toEqual([483]);
    expect(delta.removed.map((p) => p.project)).toEqual([482]);
    // An "updated" member keeps its project and moves its file — which is
    // exactly what a set difference on the pair reports, with no hashing.
    for (const { before: prior, after: next } of delta.updated) {
      expect(next.project).toBe(prior.project);
      expect(next.file).not.toBe(prior.file);
    }
    const updatedProjects = delta.updated
      .map((u) => u.after.project)
      .sort((a, b) => Number(a) - Number(b));
    expect(updatedProjects[0]).toBe(1);
    expect(updatedProjects.at(-1)).toBe(ATM10.updated);
  });

  it("keys the version axis on fileID, not on bytes — a re-upload still counts", async () => {
    // The discriminating case for "does this diff on (projectID, fileID) or is
    // it secretly hash-diffing?". Everywhere else in this suite an updated
    // member has BOTH a new file id and new bytes, so both rules agree and the
    // test proves nothing about which one is in force. (The negative control
    // caught exactly that: swapping the axis to the hash survived.)
    //
    // Here CurseForge re-published byte-identical content under a new file id.
    // The pack's pin moved, so the lock moves, so the diff must say "updated".
    const before = await resolveVersion(
      [{ projectID: 1, fileID: 100_001, slug: "mod-1", body: "same-bytes" }],
      ATM10.v71FileId,
    );
    const after = await resolveVersion(
      [{ projectID: 1, fileID: 900_001, slug: "mod-1", body: "same-bytes" }],
      ATM10.v72FileId,
    );
    // Precondition: the bytes really are identical, so a hash diff sees nothing.
    expect(after.members[0]?.hash).toEqual(before.members[0]?.hash);

    const delta = diffMemberSets(before.members, after.members);
    expect(delta.unchanged).toHaveLength(0);
    expect(delta.updated).toHaveLength(1);
    expect(delta.updated[0]?.before.file).toBe(100_001);
    expect(delta.updated[0]?.after.file).toBe(900_001);
  });

  it("reports an empty delta for a pack against itself", async () => {
    const { v71 } = atm10Members();
    const resolved = await resolveVersion(v71, ATM10.v71FileId);
    const delta = diffMemberSets(resolved.members, resolved.members);
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(delta.updated).toHaveLength(0);
    expect(delta.unchanged).toHaveLength(ATM10.members);
  });

  it("is antisymmetric — reversing the arguments swaps added and removed", async () => {
    const { v71, v72 } = atm10Members();
    const before = await resolveVersion(v71, ATM10.v71FileId);
    const after = await resolveVersion(v72, ATM10.v72FileId);
    const forward = diffMemberSets(before.members, after.members);
    const backward = diffMemberSets(after.members, before.members);
    expect(backward.added.map((p) => p.project)).toEqual(forward.removed.map((p) => p.project));
    expect(backward.removed.map((p) => p.project)).toEqual(forward.added.map((p) => p.project));
    expect(backward.updated).toHaveLength(forward.updated.length);
    expect(backward.unchanged).toHaveLength(forward.unchanged.length);
  });
});
