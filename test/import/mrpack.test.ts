import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES } from "../../src/cli/errors.js";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FABRIC_LOADER, MC } from "../helpers/game.js";
import { buildMrpack } from "../helpers/mrpack.js";
import { fabricJar } from "../helpers/net.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;
const MIRROR = (name: string) => `https://cdn.modrinth.com/data/${name}/x/${name}.jar`;

/**
 * LB-829 — twelve real import → build → re-lock → build round trips over a
 * fresh CLI instance each `beforeEach`, so this file is fs- and
 * build-pipeline-heavy, and `windows-latest · Node 22` has timed out here on
 * both recent `main` runs at vitest's 5000ms default — a DIFFERENT test each
 * time (not one pathological case):
 *   - "LB-706 GATE: a root-level override survives ... AT THE ROOT" — 5601ms
 *     (run b398187).
 *   - "GATE: import pack.mrpack → build ..." — 5080ms (run 8af2bbc).
 * `windows-latest · Node 20`, same two runs: 4137ms / 3945ms for the whole
 * file. A clean `windows-latest · Node 22` run one PR earlier (LB-819, all
 * six jobs green): 3422ms, faster than that run's own Node 20 leg (4481ms).
 * That swing is Windows runner variance, not a fixed Node-version cost — so
 * headroom has to survive noise, not just the two timeouts already seen.
 * 20s is ~4x the clean baseline and ~3.5x the worst timeout; don't halve it
 * without re-measuring on windows-latest · Node 22.
 */
vi.setConfig({ testTimeout: 20_000 });

describe("mrpack import (untrusted input) → build", () => {
  const dirs: string[] = [];
  let cwd: string;
  let store: string;
  let cli: OfflineCli;

  beforeEach(async () => {
    cwd = await mkTmp("mr-inst");
    store = await mkTmp("mr-store");
    dirs.push(cwd, store);
    cli = makeOfflineCli({ cwd, storeDir: store });
  });
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function writePack(spec: Parameters<typeof buildMrpack>[0]): Promise<string> {
    const path = join(cwd, "pack.mrpack");
    await writeFile(path, buildMrpack(spec));
    return path;
  }

  it("GATE: import pack.mrpack → build; the resulting mod set matches the mrpack", async () => {
    const clientMod = fabricJar("sodium");
    const serverMod = fabricJar("server-only");
    cli.urlBytes.set(MIRROR("sodium"), clientMod);
    cli.urlBytes.set(MIRROR("server-only"), serverMod);

    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      files: [
        { path: "mods/sodium.jar", bytes: clientMod, mirror: MIRROR("sodium") },
        {
          path: "mods/server-only.jar",
          bytes: serverMod,
          mirror: MIRROR("server-only"),
          env: { client: "unsupported", server: "required" },
        },
      ],
      overrides: [{ path: "config/sodium.json", data: '{"quality":"high"}' }],
      clientOverrides: [{ path: "options.txt", data: "fov:90" }],
    });

    const imported = await cli.run(["import", pack]);
    expect(imported.code).toBe(0);
    // The server-only file is filtered with a warning.
    expect(imported.stdout).toContain("server-only");

    const built = await cli.run(["build"]);
    expect(built.code).toBe(0);

    const files = await listFiles(cwd);
    // The client mod + game are present; the server-only mod is not.
    expect(files).toContain("mods/sodium.jar");
    expect(files).not.toContain("mods/server-only.jar");
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.jar`);
    // Overrides are placed verbatim (client-overrides at the instance root).
    expect(files).toContain("config/sodium.json");
    expect(files).toContain("options.txt");
    expect(await readFile(join(cwd, "options.txt"), "utf8")).toBe("fov:90");

    // The lock records the client mod but not the server-only one.
    const lock = await readFile(join(cwd, "anvil.lock"), "utf8");
    expect(lock).toContain("mods/sodium.jar");
    expect(lock).not.toContain("server-only");
  });

  it("client-overrides/ wins a path collision over overrides/", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/shared.txt", data: "PACK-DEFAULT" }],
      clientOverrides: [{ path: "config/shared.txt", data: "CLIENT-WINS" }],
    });
    expect((await cli.run(["import", pack])).code).toBe(0);
    expect((await cli.run(["build"])).code).toBe(0);
    expect(await readFile(join(cwd, "config", "shared.txt"), "utf8")).toBe("CLIENT-WINS");
  });

  it("refuses a zip-slip traversal entry in overrides/ (PATH_ESCAPE)", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      malicious: [{ name: "overrides/../../escape.txt", data: "pwned" }],
    });
    const res = await cli.run(["import", pack]);
    expect(res.code).toBe(EXIT_CODES.PATH_ESCAPE);
    expect(res.stderr.toLowerCase()).toContain("unsafe path");
  });

  it("refuses a symlink entry in overrides/ (PATH_ESCAPE)", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      malicious: [{ name: "overrides/link", type: "symlink", linkTarget: "/etc/passwd" }],
    });
    expect((await cli.run(["import", pack])).code).toBe(EXIT_CODES.PATH_ESCAPE);
  });

  it("rejects a file whose bytes do not match its declared sha512 (SHA_MISMATCH)", async () => {
    const declared = fabricJar("honest");
    const tampered = fabricJar("tampered"); // different bytes, same declared hash
    cli.urlBytes.set(MIRROR("evil"), tampered);
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      files: [{ path: "mods/evil.jar", bytes: declared, mirror: MIRROR("evil") }],
    });
    const res = await cli.run(["import", pack]);
    expect(res.code).toBe(EXIT_CODES.SHA_MISMATCH);
    expect(res.stderr.toLowerCase()).toContain("sha512");
  });

  it("LB-704 GATE: an override survives import → build → re-lock → build (not dropped/deleted)", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/sodium.json", data: '{"quality":"high"}' }],
    });

    const imported = await cli.run(["import", pack]);
    expect(imported.code).toBe(0);

    // The manifest itself must carry the override — it is the sole input to a
    // later `lock`. If it's absent here, a re-lock has nothing to reproduce it
    // from, no matter what the just-imported anvil.lock says.
    const manifestToml = await readFile(join(cwd, "anvil.toml"), "utf8");
    expect(manifestToml).toContain("config/sodium.json");

    const built1 = await cli.run(["build"]);
    expect(built1.code).toBe(0);
    expect(await readFile(join(cwd, "config", "sodium.json"), "utf8")).toBe('{"quality":"high"}');

    // Re-lock: regenerates anvil.lock FROM anvil.toml.
    const relocked = await cli.run(["lock"]);
    expect(relocked.code).toBe(0);
    const lockAfterRelock = await readFile(join(cwd, "anvil.lock"), "utf8");
    expect(lockAfterRelock).toContain("config/sodium.json");

    // A second build reconciles disk against the (re-)lock. If the override
    // fell out of the lock, this is where it gets deleted from the instance.
    const built2 = await cli.run(["build"]);
    expect(built2.code).toBe(0);
    const files = await listFiles(cwd);
    expect(files).toContain("config/sodium.json");
    expect(await readFile(join(cwd, "config", "sodium.json"), "utf8")).toBe('{"quality":"high"}');
  });

  it("LB-706 GATE: a root-level override survives import → build → re-lock → build AT THE ROOT", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      clientOverrides: [{ path: "options.txt", data: "fov:70" }],
    });

    expect((await cli.run(["import", pack])).code).toBe(0);
    expect((await cli.run(["build"])).code).toBe(0);
    expect(await listFiles(cwd)).toContain("options.txt");

    // Re-lock regenerates anvil.lock FROM anvil.toml. The local source used to
    // recompute the placement from kind + basename, so an override whose path is
    // not already `<kind-dir>/<basename>` came back somewhere else — "options.txt"
    // (kind "config") reappeared as "config/options.txt".
    expect((await cli.run(["lock"])).code).toBe(0);
    const relocked = await readFile(join(cwd, "anvil.lock"), "utf8");
    expect(relocked).not.toContain("config/options.txt");

    // The second build reconciles disk against the re-lock — where the file
    // physically moves if the lock says it belongs elsewhere.
    expect((await cli.run(["build"])).code).toBe(0);
    const files = await listFiles(cwd);
    expect(files).toContain("options.txt");
    expect(files).not.toContain("config/options.txt");
    expect(await readFile(join(cwd, "options.txt"), "utf8")).toBe("fov:70");
  });

  it("LB-706 GATE: a NESTED config path round-trips import → build → re-lock → build intact", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/a/b/c.toml", data: "nested = true\n" }],
    });

    expect((await cli.run(["import", pack])).code).toBe(0);
    expect((await cli.run(["build"])).code).toBe(0);
    expect(await listFiles(cwd)).toContain("config/a/b/c.toml");

    // The whole point: nesting is preserved, not collapsed to "config/c.toml".
    expect((await cli.run(["lock"])).code).toBe(0);
    expect(await readFile(join(cwd, "anvil.lock"), "utf8")).toContain("config/a/b/c.toml");

    expect((await cli.run(["build"])).code).toBe(0);
    const files = await listFiles(cwd);
    expect(files).toContain("config/a/b/c.toml");
    expect(files).not.toContain("config/c.toml");
    expect(await readFile(join(cwd, "config", "a", "b", "c.toml"), "utf8")).toBe("nested = true\n");
  });

  it("LB-719 GATE: import → lock with NO build in between succeeds and reproduces the import's lock", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/a/b/c.toml", data: "nested = true\n" }],
      clientOverrides: [{ path: "options.txt", data: "fov:70" }],
    });

    expect((await cli.run(["import", pack])).code).toBe(0);
    const importLock = await readFile(join(cwd, "anvil.lock"), "utf8");

    // No `build` runs here — that is the whole point. The override bytes exist
    // only at `.anvil/overrides/<path>`; nothing has been materialized yet.
    const beforeLock = await listFiles(cwd);
    expect(beforeLock).not.toContain("config/a/b/c.toml");
    expect(beforeLock).not.toContain("options.txt");

    const locked = await cli.run(["lock"]);
    // Used to be exit 70 + "unexpected failure: ENOENT … /config/a/b/c.toml"
    // with the internal-error banner, on a perfectly ordinary command sequence.
    expect(locked.code).toBe(0);
    expect(locked.stderr).not.toContain("ENOENT");
    expect(locked.stderr).not.toContain("please report it");

    // "Equivalent to the import's own lock" — byte for byte, in fact.
    expect(await readFile(join(cwd, "anvil.lock"), "utf8")).toBe(importLock);

    // And the placement survived the round trip: a build off the re-lock puts
    // both overrides exactly where the pack had them.
    expect((await cli.run(["build"])).code).toBe(0);
    const files = await listFiles(cwd);
    expect(files).toContain("config/a/b/c.toml");
    expect(files).toContain("options.txt");
    expect(await readFile(join(cwd, "options.txt"), "utf8")).toBe("fov:70");
  });

  it("LB-719 GATE: import → lock with NO build and NO prior lock resolves the override from scratch", async () => {
    // The sibling gate above is satisfied by the constrained re-lock reusing the
    // import's pin verbatim (a local ref's key now matches the pin's, which is
    // half of what was broken). This one deletes the lock first, so the override
    // has to be resolved from the manifest alone — `local` actually reads the
    // file. That is the state a fresh clone or a post-merge re-lock is in.
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/sodium.json", data: '{"quality":"high"}' }],
    });
    expect((await cli.run(["import", pack])).code).toBe(0);
    await rm(join(cwd, "anvil.lock"));

    const locked = await cli.run(["lock"]);
    expect(locked.code).toBe(0);
    const lock = await readFile(join(cwd, "anvil.lock"), "utf8");
    // Placed at the pack-relative path, not at the path it was read from.
    expect(lock).toContain('target = "config/sodium.json"');
    expect(lock).not.toContain('target = ".anvil/overrides/config/sodium.json"');

    expect((await cli.run(["build"])).code).toBe(0);
    expect(await readFile(join(cwd, "config", "sodium.json"), "utf8")).toBe('{"quality":"high"}');
  });

  it("LB-719 GATE: a deleted tracked override fails the lock LOUDLY, never a silent drop", async () => {
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [{ path: "config/sodium.json", data: '{"quality":"high"}' }],
    });
    expect((await cli.run(["import", pack])).code).toBe(0);
    // Drop the prior lock so the item is genuinely re-resolved rather than
    // reused from its pin — otherwise nothing reads the file and this proves
    // nothing about the missing-file path.
    await rm(join(cwd, "anvil.lock"));

    // Now remove the bytes the manifest reads from. The tempting fix for LB-719
    // was to let the resolver shrug at a missing local file — which turns this
    // into an item that quietly leaves the lock, and a file the next build
    // deletes from the instance without a word. That is LB-704 all over again.
    await rm(join(cwd, ".anvil", "overrides", "config", "sodium.json"));

    const locked = await cli.run(["lock"]);
    expect(locked.code).not.toBe(0);
    expect(locked.stderr).toContain("sodium.json");
    // And it refused rather than writing a lock with the item missing.
    expect(await listFiles(cwd)).not.toContain("anvil.lock");
  });

  it("skips an override targeting a protected path (saves/) rather than clobbering it", async () => {
    // A pre-existing world the user cares about.
    await writeFile(join(cwd, "options.txt"), "unused");
    const pack = await writePack({
      minecraft: MC,
      loader: { name: "fabric-loader", version: FABRIC_LOADER },
      overrides: [
        { path: "config/ok.txt", data: "fine" },
        { path: "saves/world/level.dat", data: "PACK-TRIED-TO-OVERWRITE" },
      ],
    });
    const res = await cli.run(["import", pack]);
    expect(res.code).toBe(0);
    // The protected override is skipped (warned), the benign one kept.
    expect(res.stdout.toLowerCase()).toContain("protected");
    const lock = await readFile(join(cwd, "anvil.lock"), "utf8");
    expect(lock).toContain("config/ok.txt");
    expect(lock).not.toContain("level.dat");
  });
});
