import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FABRIC_LOADER, MC } from "../helpers/game.js";
import { type FakeModrinthProject, fabricJar } from "../helpers/net.js";

function mod(slug: string, id: string): FakeModrinthProject {
  return {
    id,
    slug,
    title: slug,
    projectType: "mod",
    versions: [
      {
        id: `${slug}-v1`,
        projectId: id,
        versionNumber: "1.0.0",
        datePublished: "2026-06-01T00:00:00Z",
        loaders: ["fabric"],
        gameVersions: [MC],
        filename: `${slug}-1.0.0.jar`,
        bytes: fabricJar(slug),
      },
    ],
  };
}

describe("CLI end-to-end — version control (offline)", () => {
  const dirs: string[] = [];
  let cwd: string;
  let cli: OfflineCli;

  beforeEach(async () => {
    cwd = await mkTmp("vc-cli-inst");
    const store = await mkTmp("vc-cli-store");
    dirs.push(cwd, store);
    cli = makeOfflineCli({ cwd, storeDir: store });
    for (const [slug, id] of [
      ["sodium", "SODIUM"],
      ["lithium", "LITHIUM"],
      ["phosphor", "PHOSPHOR"],
      ["starlight", "STARLIGHT"],
    ] as const) {
      cli.modrinth.add(mod(slug, id));
    }
  });
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function commitCycle(add: string, message: string): Promise<void> {
    expect((await cli.run(["add", add])).code).toBe(0);
    expect((await cli.run(["lock"])).code).toBe(0);
    expect((await cli.run(["commit", "-m", message])).code).toBe(0);
  }

  it("GATE: init → lock → commit → branch → divergent commits → merge → log", async () => {
    expect(
      (await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]))
        .code,
    ).toBe(0);

    // c1 on main.
    await commitCycle("modrinth:sodium", "c1: sodium");
    // Branch, then diverge: main adds lithium, the branch adds phosphor.
    expect((await cli.run(["branch", "feature"])).code).toBe(0);
    await commitCycle("modrinth:lithium", "c2 main: lithium");

    expect((await cli.run(["switch", "feature"])).code).toBe(0);
    // The switch reverted the manifest to c1 (sodium only, no lithium).
    expect(await readFile(join(cwd, "anvil.toml"), "utf8")).not.toContain("lithium");
    await commitCycle("modrinth:phosphor", "c2 feature: phosphor");

    // Merge feature into main → a clean 3-way (different items).
    expect((await cli.run(["switch", "main"])).code).toBe(0);
    const merge = await cli.run(["merge", "feature"]);
    expect(merge.code).toBe(0);
    expect(merge.stdout).toContain("merged as");
    const manifest = await readFile(join(cwd, "anvil.toml"), "utf8");
    expect(manifest).toContain("sodium");
    expect(manifest).toContain("lithium");
    expect(manifest).toContain("phosphor");

    // log --json lists the merge commit at the top with two parents.
    const log = await cli.run(["log", "--json"]);
    expect(log.code).toBe(0);
    const parsed = JSON.parse(log.stdout) as { commits: { op: string; parents: string[] }[] };
    expect(parsed.commits[0]?.op).toBe("merge");
    expect(parsed.commits[0]?.parents).toHaveLength(2);
  });

  it("GATE: revert undoes a commit's items and re-locks", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await commitCycle("modrinth:sodium", "c1: sodium");
    await commitCycle("modrinth:lithium", "c2: lithium");

    // Reverting HEAD (the lithium commit) drops lithium again.
    const revert = await cli.run(["revert", "HEAD"]);
    expect(revert.code).toBe(0);
    const manifest = await readFile(join(cwd, "anvil.toml"), "utf8");
    expect(manifest).toContain("sodium");
    expect(manifest).not.toContain("lithium");
  });
});
