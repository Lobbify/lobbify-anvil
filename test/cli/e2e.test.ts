import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/cli/errors.js";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FABRIC_LOADER, MC } from "../helpers/game.js";
import { type FakeModrinthProject, fabricJar } from "../helpers/net.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;

/** A Modrinth mod fixture (optionally a required dep of another). */
function modProject(slug: string, id: string): FakeModrinthProject {
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

describe("CLI end-to-end (offline)", () => {
  const dirs: string[] = [];
  let cwd: string;
  let store: string;
  let cli: OfflineCli;

  beforeEach(async () => {
    cwd = await mkTmp("cli-inst");
    store = await mkTmp("cli-store");
    dirs.push(cwd, store);
    cli = makeOfflineCli({ cwd, storeDir: store });
    cli.modrinth.add(modProject("sodium", "SODIUM"));
  });
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE: init → add → lock → build → verify installs a launch-ready instance", async () => {
    const init = await cli.run([
      "init",
      "--name",
      "pack",
      "--mc",
      MC,
      "--loader",
      `fabric ${FABRIC_LOADER}`,
    ]);
    expect(init.code).toBe(0);
    expect(await readFile(join(cwd, "anvil.toml"), "utf8")).toContain(`minecraft = "${MC}"`);
    expect(await readFile(join(cwd, ".anvilignore"), "utf8")).toContain("saves/");

    const add = await cli.run(["add", "modrinth:sodium"]);
    expect(add.code).toBe(0);
    expect(await readFile(join(cwd, "anvil.toml"), "utf8")).toContain("modrinth:sodium");

    const lock = await cli.run(["lock"]);
    expect(lock.code).toBe(0);
    const lockText = await readFile(join(cwd, "anvil.lock"), "utf8");
    expect(lockText).toContain("sodium");

    const build = await cli.run(["build"]);
    expect(build.code).toBe(0);

    const files = await listFiles(cwd);
    expect(files).toContain("mods/sodium-1.0.0.jar");
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.jar`);
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.json`);

    const verify = await cli.run(["verify"]);
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain("verify: ok");

    const verifyStrict = await cli.run(["verify", "--strict"]);
    expect(verifyStrict.code).toBe(0);
  });

  it("GATE: --json output is a single stable, parseable object", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await cli.run(["add", "modrinth:sodium"]);
    const lock = await cli.run(["lock", "--json"]);
    expect(lock.code).toBe(0);
    const parsed = JSON.parse(lock.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.minecraft).toBe(MC);
    expect(parsed.packages).toBeGreaterThan(1);
    // Exactly one JSON object — no interleaved progress noise on stdout.
    expect(lock.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("GATE: --offline errors clearly on a missing object with a stable exit code", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await cli.run(["add", "modrinth:sodium"]);
    await cli.run(["lock"]);
    // lock admits copy items + version.json, but the Mojang CDN bytes (client,
    // libraries, JRE, assets) are fetched at build — absent in an offline build.
    const build = await cli.run(["build", "--offline"]);
    expect(build.code).toBe(EXIT_CODES.MISSING_OBJECT);
    expect(build.stderr.toLowerCase()).toContain("not present in the store");
    expect(build.stderr).toContain("hint:");
  });

  it("GATE flagship: a build over an instance with existing saves/ leaves worlds untouched", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await cli.run(["add", "modrinth:sodium"]);
    await cli.run(["lock"]);
    expect((await cli.run(["build"])).code).toBe(0);

    // The user plays: a world appears under saves/ + a hand-edited config.
    await mkdir(join(cwd, "saves", "my-world"), { recursive: true });
    await writeFile(join(cwd, "saves", "my-world", "level.dat"), "PRECIOUS-WORLD-BYTES");

    // A second build (re-materialize) must never touch saves/.
    expect((await cli.run(["build"])).code).toBe(0);
    expect(await readFile(join(cwd, "saves", "my-world", "level.dat"), "utf8")).toBe(
      "PRECIOUS-WORLD-BYTES",
    );
  });

  it("status reflects the manifest-vs-lock-vs-built lifecycle", async () => {
    const before = await cli.run(["status"]);
    expect(before.stdout).toContain("no anvil.toml");

    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    expect((await cli.run(["status"])).stdout).toContain("not locked");

    await cli.run(["add", "modrinth:sodium"]);
    await cli.run(["lock"]);
    expect((await cli.run(["status"])).stdout).toContain("never built");

    await cli.run(["build"]);
    expect((await cli.run(["status"])).stdout).toContain("clean");

    // Editing the manifest without re-locking marks it stale.
    cli.modrinth.add(modProject("lithium", "LITHIUM"));
    await cli.run(["add", "modrinth:lithium"]);
    const dirty = await cli.run(["status", "--json"]);
    expect(JSON.parse(dirty.stdout.trim()).status.manifestDirty).toBe(true);
  });

  it("diff shows the delta a build would apply, and why traces a root", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await cli.run(["add", "modrinth:sodium"]);
    await cli.run(["lock"]);
    await cli.run(["build"]);

    const diff = await cli.run(["diff"]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("no changes");

    const why = await cli.run(["why", "sodium"]);
    expect(why.code).toBe(0);
    expect(why.stdout).toContain("sodium");

    const whyMissing = await cli.run(["why", "nonexistent-mod"]);
    expect(whyMissing.stdout).toContain("not in the dependency graph");
  });
});
