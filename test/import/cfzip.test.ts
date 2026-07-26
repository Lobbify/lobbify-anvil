import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  SourceKeyMissing,
  importCurseForgeZip,
  pinsFromLock,
  resolveManifest,
} from "../../index.js";
import type { GamePinsForImport } from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";
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

  it("LB-704 GATE: overrides/ files are registered into the manifest (not just the lock)", async () => {
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

    // The bug: overrides/ only ever reached `input.placeable` (which feeds the
    // initial hand-built lock) and never `manifestItems`. Without an entry here,
    // a later `anvil lock` has nothing in anvil.toml to reproduce the override
    // from, and silently drops it.
    expect(result.manifest.items).toContainEqual({ path: "config/mymod.toml", kind: "config" });
    expect(result.manifest.items).toContainEqual({ path: "options.txt", kind: "config" });

    // Simulate the state after a `build` has materialized the overrides onto
    // disk at their placement target (what a real build does before any later
    // re-lock could run) — the tracked `.anvil/overrides/` copy is only ever
    // consulted at import time, per the `local` source contract.
    for (const [rel, bytes] of [
      ["config/mymod.toml", "greeting = 'hi'\n"],
      ["options.txt", "fov:70\n"],
    ] as const) {
      const dest = join(instanceDir, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
    }

    // Re-lock from the manifest alone (constrained re-lock, reusing the prior
    // lock's pins where possible) — this is exactly what `anvil lock` does.
    // The CurseForge item itself always re-verifies against the API (its pin
    // spec is a fileId, not the pkg's human-readable `version`, so the no-network
    // direct-pin shortcut never applies to it) — wire the same fake so that leg
    // still resolves; the point under test is the LOCAL override entries.
    const relocked = await resolveManifest({
      manifest: result.manifest,
      registry: registryWith({ curseforge: cf }),
      allowSource: () => true,
      now: Date.now(),
      baseDir: instanceDir,
      offline: false,
      store,
      curseforgeKey: "cf-key",
      lockedPins: pinsFromLock(result.lock),
    });

    // The point under test: both overrides SURVIVE the re-lock (source=local,
    // still present) rather than silently vanishing, which is what happened
    // before this fix (manifest.items had no entry for them at all, so this
    // resolveManifest loop never even queued them).
    const relockedLocals = relocked.resolved.filter((p) => p.source === "local");
    expect(relockedLocals.length).toBe(2);
    expect(relockedLocals.map((p) => p.placement)).toContainEqual({
      method: "link",
      target: "config/mymod.toml",
    });
    // NOTE (separate, pre-existing quirk — not this ticket's diagnosis, and
    // shared verbatim by importPrism's identical `{ path, kind }` shape): a
    // re-resolved local item's placement is recomputed by LocalSource from
    // kind+basename (`singleFilePlacement`), not carried over from the
    // original pack path. "options.txt" (root-level, kind "config" by
    // default) lands back at "config/options.txt", not the instance root, on
    // any re-lock. That's a placement-drift bug, distinct from LB-704's
    // drop/delete bug — the file is NOT dropped, just potentially relocated.
    expect(relockedLocals.map((p) => p.placement)).toContainEqual({
      method: "link",
      target: "config/options.txt",
    });
    // The CurseForge replay item survives the re-lock too (sanity: the fix
    // didn't disturb the already-correct path).
    expect(relocked.resolved.find((p) => p.source === "curseforge")?.project).toBe(238222);
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
