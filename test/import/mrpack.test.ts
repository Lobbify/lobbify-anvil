import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../src/cli/errors.js";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FABRIC_LOADER, MC } from "../helpers/game.js";
import { buildMrpack } from "../helpers/mrpack.js";
import { fabricJar } from "../helpers/net.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;
const MIRROR = (name: string) => `https://cdn.modrinth.com/data/${name}/x/${name}.jar`;

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
