import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, SourceKeyMissing, importCurseForgeZip } from "../../index.js";
import type { GamePinsForImport } from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar } from "../helpers/net.js";
import { makeZip } from "../helpers/zip.js";

const GAME: GamePinsForImport = { packages: [], java: "runtime-gamma-21", loader: "fabric 0.19.1" };

function cfZip(files: Array<{ projectID: number; fileID: number; required?: boolean }>): Buffer {
  const manifest = {
    manifestType: "minecraftModpack",
    manifestVersion: 1,
    name: "MyPack",
    version: "1.2.3",
    minecraft: {
      version: "26.2",
      modLoaders: [{ id: "fabric-0.19.1", primary: true }],
    },
    files,
    overrides: "overrides",
  };
  return makeZip([
    { name: "manifest.json", data: JSON.stringify(manifest) },
    { name: "overrides/config/mymod.toml", data: "greeting = 'hi'\n" },
    { name: "overrides/options.txt", data: "fov:70\n" },
  ]);
}

describe("importCurseForgeZip", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function writeArchive(bytes: Buffer): Promise<string> {
    const work = await mkTmp("cfzip");
    dirs.push(work);
    const path = join(work, "pack.zip");
    await writeFile(path, bytes);
    return path;
  }

  it("turns files[] into REPLAY items (no url) and overrides/ into local copies", async () => {
    const instanceDir = await mkTmp("inst");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(instanceDir, store.root);

    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [
        { id: 5000, fileName: "jei-1.0.0.jar", gameVersions: ["26.2", "Fabric"], bytes: cfBytes },
      ],
    });
    const archive = await writeArchive(
      cfZip([{ projectID: 238222, fileID: 5000, required: true }]),
    );

    const result = await importCurseForgeZip({
      archivePath: archive,
      instanceDir,
      store,
      curseforgeHttp: cf,
      curseforgeKey: "cf-key",
      resolveGame: async () => GAME,
    });

    expect(result.files).toBe(1);
    expect(result.overrides).toBe(2);

    const replay = result.lock.resolved.find((p) => p.source === "curseforge");
    expect(replay).toBeDefined();
    expect(replay?.provenance).toBe("replay");
    expect(replay?.project).toBe(238222);
    expect(replay?.file).toBe(5000);
    expect(replay?.url).toBeUndefined(); // no rehostable URL
    expect(replay?.placement).toEqual({ method: "link", target: "mods/jei-1.0.0.jar" });

    // The CF (replay) bytes are NOT admitted to the shared store...
    const replayHash = replay?.hash;
    expect(replayHash && (await store.has(replayHash))).toBe(false);

    // ...but the overrides (copy/local) ARE in the shared store.
    const overrides = result.lock.resolved.filter((p) => p.source === "local");
    expect(overrides.length).toBe(2);
    for (const o of overrides) {
      expect(o.provenance).toBe("copy");
      expect(await store.has(o.hash)).toBe(true);
    }

    // A re-lock reproduces the pin: the manifest carries curseforge:238222@5000.
    expect(result.manifest.items).toContainEqual({
      ref: { source: "curseforge", id: "238222", versionSpec: { kind: "pin", version: "5000" } },
    });
  });

  it("REQUIRES a key to fully pin CF files (SourceKeyMissing without one)", async () => {
    const instanceDir = await mkTmp("inst");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(instanceDir, store.root);
    const archive = await writeArchive(cfZip([{ projectID: 238222, fileID: 5000 }]));
    await expect(
      importCurseForgeZip({
        archivePath: archive,
        instanceDir,
        store,
        curseforgeHttp: new FakeCurseForge(),
        // no curseforgeKey
        resolveGame: async () => GAME,
      }),
    ).rejects.toBeInstanceOf(SourceKeyMissing);
  });
});
