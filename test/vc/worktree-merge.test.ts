/**
 * The tracked-set 3-way (LB-705): the pure `mergeTrackedSets` matrix, then the
 * same rules driven end to end through `Anvil.merge`.
 *
 * The matrix is the whole point of the function, so every row of its doc-comment
 * table is a separate case here — including the two modify/delete rows, where the
 * result is only correct if the **warning** is emitted too. A merge that silently
 * discarded one side's edit is exactly the loss tracked files exist to prevent, so
 * "the file outcome is right" is not a sufficient assertion.
 *
 * The one-sided modify rows (LB-819) are here for the same reason, and they carry
 * the converse assertion: the file outcome is only correct if **no** warning is
 * emitted. The both-present branch used to resolve ours-wins whatever the base
 * said, so a config the other branch retuned was dropped and the warning called it
 * a two-sided change. Nothing was red, because neither row existed.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Hash, type TrackedFile, VcObjectStore, mergeTrackedSets } from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

const H = (c: string): Hash => ({ algo: "sha256", value: c.repeat(64) });
const f = (path: string, c: string): TrackedFile => ({ path, blob: H(c) });

const P = "config/shared.toml";

interface Row {
  readonly name: string;
  readonly base: readonly TrackedFile[];
  readonly ours: readonly TrackedFile[];
  readonly theirs: readonly TrackedFile[];
  /** The blob letter the merged set must hold at `P`, or `undefined` for deleted. */
  readonly kept: string | undefined;
  /** A substring the single expected warning must contain (none when absent). */
  readonly warning?: string;
}

const ROWS: readonly Row[] = [
  {
    name: "absent / absent / present → take theirs (their addition)",
    base: [],
    ours: [],
    theirs: [f(P, "2")],
    kept: "2",
  },
  {
    name: "absent / present / absent → keep ours (our addition)",
    base: [],
    ours: [f(P, "1")],
    theirs: [],
    kept: "1",
  },
  {
    name: "absent / present / present, blobs differ → ours wins, with a warning",
    base: [],
    ours: [f(P, "1")],
    theirs: [f(P, "2")],
    kept: "1",
    warning: "changed on both sides — keeping ours and discarding theirs",
  },
  {
    name: "present as B / equals B / absent → delete (theirs deleted it)",
    base: [f(P, "b")],
    ours: [f(P, "b")],
    theirs: [],
    kept: undefined,
  },
  {
    name: "present as B / differs from B / absent → keep ours, WITH a warning",
    base: [f(P, "b")],
    ours: [f(P, "1")],
    theirs: [],
    kept: "1",
    warning: "edited here and deleted on the other side",
  },
  {
    name: "present as B / absent / equals B → stay deleted (theirs untouched)",
    base: [f(P, "b")],
    ours: [],
    theirs: [f(P, "b")],
    kept: undefined,
  },
  {
    name: "present as B / absent / differs from B → stay deleted, WITH a warning",
    base: [f(P, "b")],
    ours: [],
    theirs: [f(P, "2")],
    kept: undefined,
    warning: "deleted here and edited on the other side",
  },
  {
    name: "present as B / equals B / differs from B → take theirs (ours untouched)",
    base: [f(P, "b")],
    ours: [f(P, "b")],
    theirs: [f(P, "2")],
    kept: "2",
  },
  {
    name: "present as B / differs from B / equals B → keep ours (theirs untouched)",
    base: [f(P, "b")],
    ours: [f(P, "1")],
    theirs: [f(P, "b")],
    kept: "1",
  },
  {
    name: "present / present / present, both differ from B and each other → ours wins, with a warning",
    base: [f(P, "b")],
    ours: [f(P, "1")],
    theirs: [f(P, "2")],
    kept: "1",
    warning: "changed on both sides — keeping ours and discarding theirs",
  },
  {
    name: "same blob on both sides → keep, no warning",
    base: [f(P, "b")],
    ours: [f(P, "1")],
    theirs: [f(P, "1")],
    kept: "1",
  },
  {
    name: "deleted by both sides → gone, no warning",
    base: [f(P, "b")],
    ours: [],
    theirs: [],
    kept: undefined,
  },
];

describe("vc worktree: mergeTrackedSets — the full 3-way matrix", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const result = mergeTrackedSets(row.base, row.ours, row.theirs);
      expect(result.tracked).toEqual(
        row.kept === undefined ? [] : [{ path: P, blob: H(row.kept) }],
      );
      if (row.warning === undefined) {
        expect(result.warnings).toEqual([]);
      } else {
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain(P);
        expect(result.warnings[0]).toContain(row.warning);
      }
    });
  }

  it("merges each path independently and returns the set sorted by path", () => {
    const result = mergeTrackedSets(
      [f("b.txt", "b")],
      [f("c.txt", "1"), f("b.txt", "1")],
      [f("a.txt", "2"), f("b.txt", "1")],
    );
    expect(result.tracked).toEqual([
      { path: "a.txt", blob: H("2") }, // theirs' addition
      { path: "b.txt", blob: H("1") }, // both sides made the same edit
      { path: "c.txt", blob: H("1") }, // ours' addition
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("names every divergent path, one warning each", () => {
    const result = mergeTrackedSets(
      [],
      [f("x.txt", "1"), f("y.txt", "1")],
      [f("x.txt", "2"), f("y.txt", "2")],
    );
    expect(result.tracked).toEqual([
      { path: "x.txt", blob: H("1") },
      { path: "y.txt", blob: H("1") },
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.filter((w) => w.includes("x.txt"))).toHaveLength(1);
    expect(result.warnings.filter((w) => w.includes("y.txt"))).toHaveLength(1);
  });

  it("is empty for three empty sets", () => {
    expect(mergeTrackedSets([], [], [])).toEqual({ tracked: [], warnings: [] });
  });
});

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
  ]);
}

describe("vc merge: tracked files survive a 3-way", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE merge-keeps-tracked: a file only THEIRS added is in the merge commit, not dropped", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const objects = new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") });

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("theirs");

    // ours diverges on the ITEM set only, so the tracked 3-way is what has to
    // carry theirs' file across — not the item merge.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("ours: add beta");

    await anvil.switch("theirs");
    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(join(fx.dir, "config", "theirs.toml"), "THEIRS-ONLY");
    await anvil.commit("theirs: add config/theirs.toml");

    await anvil.switch("main");
    // Ours genuinely does not have the file — otherwise "it is still there after
    // the merge" would pass without the merge doing anything.
    expect(await pathExists(join(fx.dir, "config", "theirs.toml"))).toBe(false);

    const result = await anvil.merge("theirs");
    expect(result.fastForward).toBe(false);
    expect(result.committed).toBeDefined();
    expect(result.warnings).toEqual([]);
    // On disk…
    expect(await readFile(join(fx.dir, "config", "theirs.toml"), "utf8")).toBe("THEIRS-ONLY");
    // …and recorded in the merge commit's snapshot, not merely left lying around.
    const merged = result.committed;
    expect(merged).toBeDefined();
    if (!merged) {
      return;
    }
    const snap = await objects.getSnapshot((await objects.getCommit(merged.id)).snapshot);
    expect(snap.tracked.map((t) => t.path)).toContain("config/theirs.toml");
  });

  it("resolves a tracked file changed on both sides ours-wins, and says so in the warnings", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const objects = new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") });
    const shared = join(fx.dir, "config", "shared.toml");

    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(shared, "BASE");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("theirs");

    await writeFile(shared, "OURS");
    await anvil.commit("ours: edit shared.toml");

    await anvil.switch("theirs");
    expect(await readFile(shared, "utf8")).toBe("BASE"); // the switch restored it
    await writeFile(shared, "THEIRS");
    await anvil.commit("theirs: edit shared.toml");

    await anvil.switch("main");
    expect(await readFile(shared, "utf8")).toBe("OURS");

    const result = await anvil.merge("theirs");
    expect(result.committed).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("config/shared.toml");
    expect(result.warnings[0]).toContain("changed on both sides");
    expect(result.warnings[0]).toContain("keeping ours and discarding theirs");
    // anvil never splices file contents: ours survives whole.
    expect(await readFile(shared, "utf8")).toBe("OURS");

    const merged = result.committed;
    expect(merged).toBeDefined();
    if (!merged) {
      return;
    }
    const snap = await objects.getSnapshot((await objects.getCommit(merged.id)).snapshot);
    const entry = snap.tracked.find((t) => t.path === "config/shared.toml");
    expect(entry).toBeDefined();
    if (entry) {
      expect(new TextDecoder().decode(await objects.getBlobBytes(entry.blob))).toBe("OURS");
    }
  });

  it("GATE merge-takes-theirs: theirs' edit to a file OURS never touched survives the merge", async () => {
    // LB-819, end to end: the ticket's own scenario, driven through `Anvil.merge`
    // rather than `mergeTrackedSets`, so the fix is proven where a user meets it.
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const objects = new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") });
    const iris = join(fx.dir, "config", "iris.properties");

    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(iris, "shaderPack=none");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("variant-b");

    // ours diverges on the ITEM set only, so this is a real 3-way and not a
    // fast-forward, while ours leaves iris.properties exactly as the base had it.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("ours: add beta");

    await anvil.switch("variant-b");
    await writeFile(iris, "shaderPack=BSL");
    await anvil.commit("theirs: set shaderPack=BSL");

    await anvil.switch("main");
    // Ours really is still on the base bytes — otherwise "theirs won" could pass
    // without the merge having decided anything.
    expect(await readFile(iris, "utf8")).toBe("shaderPack=none");

    const result = await anvil.merge("variant-b");
    expect(result.fastForward).toBe(false);
    expect(result.committed).toBeDefined();
    // Ours expressed no intent about this file, so nothing was discarded and
    // there is nothing to report. A warning here would be the noise that trains
    // a reader to skip the ones that matter.
    expect(result.warnings).toEqual([]);
    expect(await readFile(iris, "utf8")).toBe("shaderPack=BSL");

    const merged = result.committed;
    expect(merged).toBeDefined();
    if (!merged) {
      return;
    }
    // …and recorded in the merge commit, not merely left on disk for the next
    // switch to overwrite.
    const snap = await objects.getSnapshot((await objects.getCommit(merged.id)).snapshot);
    const entry = snap.tracked.find((t) => t.path === "config/iris.properties");
    expect(entry).toBeDefined();
    if (entry) {
      expect(new TextDecoder().decode(await objects.getBlobBytes(entry.blob))).toBe(
        "shaderPack=BSL",
      );
    }
  });

  it("keeps ours SILENTLY when theirs never moved off the base", async () => {
    // The converse control for LB-819: the outcome was always right here, but the
    // warning claimed a two-sided change and so could not be told apart from the
    // case above, which was losing work.
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const iris = join(fx.dir, "config", "iris.properties");

    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(iris, "shaderPack=none");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("variant-b");

    await writeFile(iris, "shaderPack=OURS");
    await anvil.commit("ours: retune iris");

    await anvil.switch("variant-b");
    // theirs diverges on the ITEM set only, leaving iris.properties on the base.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("theirs: add beta");

    await anvil.switch("main");
    const result = await anvil.merge("variant-b");
    expect(result.committed).toBeDefined();
    expect(result.warnings).toEqual([]);
    expect(await readFile(iris, "utf8")).toBe("shaderPack=OURS");
  });

  it("honours theirs' deletion of a file ours never touched", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const doomed = join(fx.dir, "config", "doomed.toml");

    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(doomed, "BASE");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("theirs");

    // ours changes only the item set, leaving doomed.toml exactly as the base had it.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("ours: add beta");

    await anvil.switch("theirs");
    await rm(doomed);
    await anvil.commit("theirs: delete doomed.toml");

    await anvil.switch("main");
    expect(await pathExists(doomed)).toBe(true); // ours still has it

    const result = await anvil.merge("theirs");
    expect(result.committed).toBeDefined();
    // A clean one-sided deletion is silent — every switch would be noise otherwise.
    expect(result.warnings).toEqual([]);
    expect(await pathExists(doomed)).toBe(false);
  });
});
