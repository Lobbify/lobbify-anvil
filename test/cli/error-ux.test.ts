import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Anvil, readManifest, writeManifest } from "../../index.js";
import type { AnvilEnv } from "../../index.js";
import { EXIT_CODES, EXIT_ERROR } from "../../src/cli/errors.js";
import { runCli } from "../../src/cli/run.js";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import {
  FABRIC_LOADER,
  MC,
  loaderMetaBase,
  mojangOptions,
  resourcesBase,
} from "../helpers/game.js";
import { FakeModrinth, makeScriptedHttp, registryWith } from "../helpers/net.js";

/**
 * The error-UX contract: expected/common failures surface as typed, actionable
 * errors (with a stable exit code + hint), never the "this is a bug — please
 * report it" catch-all reserved for genuinely-unexpected failures.
 */
describe("CLI error UX (typed, actionable failures)", () => {
  const dirs: string[] = [];
  let cwd: string;
  let store: string;
  let cli: OfflineCli;

  beforeEach(async () => {
    const { mkTmp } = await import("../helpers/fixtures.js");
    cwd = await mkTmp("ux-inst");
    store = await mkTmp("ux-store");
    dirs.push(cwd, store);
    cli = makeOfflineCli({ cwd, storeDir: store });
  });
  afterEach(async () => {
    const { rmTmp } = await import("../helpers/fixtures.js");
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  // --- item 1: no lock yet ---------------------------------------------------

  it("build with no lock → typed LOCK_MISSING (run `anvil lock` first), not a bug", async () => {
    const r = await cli.run(["build"]);
    expect(r.code).toBe(EXIT_CODES.LOCK_MISSING);
    expect(r.stderr).toContain("no anvil.lock");
    expect(r.stderr).toContain("anvil lock");
    expect(r.stderr).not.toContain("this is a bug");
  });

  it("verify with no lock → typed LOCK_MISSING, not a bug", async () => {
    const r = await cli.run(["verify"]);
    expect(r.code).toBe(EXIT_CODES.LOCK_MISSING);
    expect(r.stderr).toContain("anvil lock");
    expect(r.stderr).not.toContain("this is a bug");
  });

  it("the no-lock error honors the --json contract (one typed object)", async () => {
    const r = await cli.run(["build", "--json"]);
    expect(r.code).toBe(EXIT_CODES.LOCK_MISSING);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("LOCK_MISSING");
    expect(parsed.error.exitCode).toBe(r.code);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  // --- item 1: network transport failure -------------------------------------

  it("a network transport failure at lock → typed NETWORK_ERROR naming the host, not a bug", async () => {
    // A real RateLimitedHttp whose low-level fetch throws a connection-refused
    // transport error — the exact seam production uses for the game/source CDNs.
    const failing = makeScriptedHttp({
      handler: () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
            code: "ECONNREFUSED",
          }),
        });
      },
    });
    const env: AnvilEnv = {
      registry: () => registryWith({ modrinth: new FakeModrinth() }),
      gameHttp: () => failing.http,
      mojangOptions,
      loaderMetaBase,
      resourcesBase,
    };
    await cli.run(["init", "--name", "pack", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["lock"], {
      cwd,
      env: { ANVIL_STORE_DIR: store },
      stdout: sink(out),
      stderr: sink(err),
      makeAnvil: (options) => new Anvil(options, env),
    });
    const stderr = err.join("");
    expect(code).toBe(EXIT_CODES.NETWORK_ERROR);
    expect(stderr).toContain("could not reach");
    expect(stderr).toContain("fixtures.test"); // the host is named
    expect(stderr).toContain("connection refused"); // the reason is human-readable
    expect(stderr).not.toContain("this is a bug");
    // No raw stack noise leaked into the rendered message.
    expect(stderr).not.toContain("ECONNREFUSED 10.0.0.1");
  });

  // --- item 2: init positional dir/name + missing minecraft ------------------

  it("init accepts a positional dir/name, equivalent to --dir (round-trips)", async () => {
    // Positional target: writes into cwd/<positional>, name defaults to it.
    const viaPos = await cli.run(["init", "packp", "--mc", MC]);
    expect(viaPos.code).toBe(0);
    const posToml = await readFile(join(cwd, "packp", "anvil.toml"), "utf8");
    expect(posToml).toContain('name = "packp"');
    expect(posToml).toContain(`minecraft = "${MC}"`);
    // The .anvilignore lands in the positional dir, proving it set the target.
    expect(await readFile(join(cwd, "packp", ".anvilignore"), "utf8")).toContain("saves/");

    // The same target expressed via --dir produces a byte-identical manifest.
    const viaDir = await cli.run(["init", "--dir", "packd", "--name", "packp", "--mc", MC]);
    expect(viaDir.code).toBe(0);
    const dirToml = await readFile(join(cwd, "packd", "anvil.toml"), "utf8");
    expect(posToml).toBe(dirToml);
  });

  it("init accepts a positional and --dir that agree", async () => {
    const r = await cli.run(["init", "packz", "--dir", "packz", "--mc", MC]);
    expect(r.code).toBe(0);
    expect(await readFile(join(cwd, "packz", "anvil.toml"), "utf8")).toContain('name = "packz"');
  });

  it("init errors clearly when the positional and --dir conflict", async () => {
    const r = await cli.run(["init", "packx", "--dir", "packy", "--mc", MC]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain("conflicting target directory");
    expect(r.stderr).not.toContain("Extraneous positional");
  });

  it("init without --minecraft → an actionable typed message (with an example)", async () => {
    const r = await cli.run(["init", "my-pack"]); // positional dir, no --mc
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain("Minecraft version is required");
    expect(r.stderr).toContain("--minecraft");
    expect(r.stderr).toContain("26.2"); // the concrete example
    expect(r.stderr).not.toContain("this is a bug");
  });

  it("the missing-minecraft error honors the --json contract", async () => {
    const r = await cli.run(["init", "--name", "pack", "--json"]);
    expect(r.code).not.toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.exitCode).toBe(r.code);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  });

  // --- item 3: status distinguishes absent vs unparseable manifest -----------

  it("status on an absent manifest → missing (run `anvil init`), exit 0", async () => {
    const r = await cli.run(["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no anvil.toml");
    expect(r.stdout).toContain("run `anvil init`");
  });

  it("status on a present-but-unparseable manifest → distinct message + non-zero exit", async () => {
    await writeFile(join(cwd, "anvil.toml"), "this is = = not valid toml [[[\n");
    const r = await cli.run(["status"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stdout).toContain("present but could not be parsed");
    expect(r.stdout).toContain("fix the manifest");
    // The bug being fixed: it must NOT be mislabeled as missing.
    expect(r.stdout).not.toContain("no anvil.toml");
    expect(r.stdout).toContain("manifest: unparseable");
    // And it must not crash into the bug catch-all.
    expect(r.stderr).not.toContain("this is a bug");
    // The reported reason is a single clean line, not a multi-line dump.
    expect(r.stdout.split("\n")[0]).not.toContain("^");
  });

  // --- item 4: `remove` never exits 0 without changing something (LB-725) ---

  it("GATE: remove of a spec that matches nothing → non-zero, names it, changes nothing", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC]);
    const manifestPath = join(cwd, "anvil.toml");
    const before = await readFile(manifestPath, "utf8");

    // The exact invocation from the ticket: a plausible-looking local path
    // that happens to match no item in the manifest.
    const r = await cli.run(["remove", "./config/sodium.json"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("./config/sodium.json");
    expect(r.stderr).toContain("matched nothing");
    expect(r.stderr).not.toContain("this is a bug");
    // Never exit 0 without having changed something — and here, nothing did.
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  it("remove by the placement path of a tracked-copy item → refused, not silently ignored", async () => {
    // A tracked-copy item's identity is its `path` (where anvil reads the
    // bytes from — `.anvil/overrides/...`), not its `target` (where the file
    // is placed in the instance — the path a user actually sees and would
    // naturally type to remove it). This is the concrete, documented shape
    // (`ManifestItem.target`, CHANGELOG v0.2.1) most likely behind LB-725.
    await cli.run(["init", "--name", "pack", "--mc", MC]);
    const manifest = await readManifest(cwd);
    await writeManifest(cwd, {
      ...manifest,
      items: [
        {
          path: ".anvil/overrides/config/sodium.json",
          target: "config/sodium.json",
        },
      ],
    });

    const r = await cli.run(["remove", "./config/sodium.json"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("./config/sodium.json");
    // The item is still there — a plausible, ticket-accurate typed path did
    // not silently drop it.
    const after = await readManifest(cwd);
    expect(after.items).toHaveLength(1);
  });

  it("remove of a spec that DOES match → removes it and exits 0", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC]);
    await cli.run(["add", "modrinth:sodium"]);
    expect(await readFile(join(cwd, "anvil.toml"), "utf8")).toContain("modrinth:sodium");

    const r = await cli.run(["remove", "modrinth:sodium"]);

    expect(r.code).toBe(0);
    expect(await readFile(join(cwd, "anvil.toml"), "utf8")).not.toContain("modrinth:sodium");
  });

  it("remote remove of a name that isn't configured → non-zero, not the old silent 0 (LB-725 sibling)", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC]);

    const r = await cli.run(["remote", "remove", "nope"]);

    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("no such remote");
  });

  it("remote remove of a name that IS configured → removes it and exits 0", async () => {
    await cli.run(["init", "--name", "pack", "--mc", MC]);
    await cli.run(["remote", "add", "origin", "https://example.com/pack.git"]);

    const r = await cli.run(["remote", "remove", "origin"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('removed remote "origin"');
  });
});

/** A Writable that appends chunks to `out` (test stream capture). */
function sink(out: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      out.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      cb();
    },
  });
}
