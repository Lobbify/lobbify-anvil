/**
 * Stage-7 gate — the replay boundary under transport + export.
 *
 * CurseForge (`provenance: "replay"`) bytes are never re-hosted. This proves it at
 * the two Stage-7 surfaces:
 *   - **push** publishes only copy content objects; the replay sha never reaches
 *     the remote endpoint, and the replay cache is never read;
 *   - **export** omits every CurseForge item with a clear warning; the exported
 *     `.mrpack` carries no replay bytes.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type LockPackage,
  type Lockfile,
  type Manifest,
  ReplayCache,
  canonicalJson,
  comparePackages,
  exportMrpack,
  hashBuffer,
  parseRef,
  readZipEntry,
  writeLock,
  writeManifest,
} from "../../index.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeModrinth, fabricJar } from "../helpers/net.js";
import { makeInstance } from "../helpers/remote.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

const COPY_BYTES = fabricJar("sodium");
const REPLAY_BYTES = fabricJar("jei");

function copyPkg(): LockPackage {
  return {
    name: "sodium",
    kind: "mod",
    source: "modrinth",
    version: "1.0.0",
    hash: hashOf(COPY_BYTES, "sha256"),
    provenance: "copy",
    placement: { method: "link", target: "mods/sodium.jar" },
    size: COPY_BYTES.byteLength,
    url: "https://cdn.modrinth.com/data/x/versions/y/sodium.jar",
  };
}

function replayPkg(): LockPackage {
  return {
    name: "jei",
    kind: "mod",
    source: "curseforge",
    version: "jei-1.0.0",
    hash: hashOf(REPLAY_BYTES, "sha256"),
    provenance: "replay",
    placement: { method: "link", target: "mods/jei.jar" },
    size: REPLAY_BYTES.byteLength,
    project: 238222,
    file: 5000,
  };
}

function mixedManifest(): Manifest {
  return {
    project: { name: "mixed-pack", version: "1.0.0" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [{ ref: parseRef("modrinth:sodium") }, { ref: parseRef("curseforge:238222@5000") }],
  };
}

function mixedLock(manifest: Manifest): Lockfile {
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
  return {
    meta: { version: 1, manifestHash, minecraft: "26.2", loader: "fabric 0.19.1", java: "j" },
    resolved: [copyPkg(), replayPkg()].sort(comparePackages),
  };
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const rec = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await rec(p);
      } else {
        out.push(e.name);
      }
    }
  };
  await rec(root);
  return out;
}

describe("push never transfers a replay object", () => {
  it("only the copy object reaches the remote endpoint; the replay sha never does", async () => {
    // The push test hand-builds its lock; the registry only constructs the Anvil.
    const host = await makeInstance(new FakeModrinth(), "rx-host");
    const remoteDir = await mkTmp("rx-remote");
    dirs.push(host.dir, host.storeDir, remoteDir);

    // Hand-build a committed instance with one copy + one replay item.
    const manifest = mixedManifest();
    const lock = mixedLock(manifest);
    await writeManifest(host.dir, manifest);
    await writeLock(host.dir, lock);
    // Copy bytes → shared store; replay bytes → the per-instance replay cache.
    await host.store.putBuffer(COPY_BYTES, "sha256", hashOf(COPY_BYTES, "sha256"));
    await new ReplayCache({ instanceDir: host.dir }).putBuffer(
      REPLAY_BYTES,
      hashOf(REPLAY_BYTES, "sha256"),
    );

    const hostAnvil = host.anvil();
    await hostAnvil.commit("mixed copy + replay");
    await hostAnvil.addRemote("dst", remoteDir);
    const result = await hostAnvil.push("dst");

    // Exactly one content object (the copy) was published.
    expect(result.objects).toBe(1);
    const endpointNames = await walk(join(remoteDir, "objects-content"));
    expect(endpointNames).toContain(hashOf(COPY_BYTES, "sha256").value);
    expect(endpointNames).not.toContain(hashOf(REPLAY_BYTES, "sha256").value);

    // The replay sha appears nowhere in the entire remote tree.
    const everything = await walk(remoteDir);
    expect(everything).not.toContain(hashOf(REPLAY_BYTES, "sha256").value);
  });
});

describe("export omits CurseForge (replay) items with a warning", () => {
  it("the .mrpack carries the copy item + a warning, never the replay bytes", async () => {
    const storeDir = await mkTmp("ex-store");
    const outDir = await mkTmp("ex-out");
    dirs.push(storeDir, outDir);
    const store = new ContentStore({ root: storeDir });
    await store.putBuffer(COPY_BYTES, "sha256", hashOf(COPY_BYTES, "sha256"));

    const manifest = mixedManifest();
    const lock = mixedLock(manifest);
    const target = join(outDir, "out.mrpack");
    const result = await exportMrpack({ manifest, lock, store, targetPath: target });

    // The copy item is a files[] entry; the CurseForge item is omitted + warned.
    expect(result.files).toBe(1);
    expect(result.omitted).toContain("jei");
    expect(result.warnings.some((w) => w.includes("CurseForge"))).toBe(true);

    // The exported index lists sodium but nothing CurseForge, and the archive
    // contains no jei override.
    const zipBytes = new Uint8Array(await readFile(target));
    const indexBytes = await readZipEntry(zipBytes, "modrinth.index.json");
    expect(indexBytes).toBeDefined();
    const index = JSON.parse(new TextDecoder().decode(indexBytes as Uint8Array)) as {
      files: { path: string; downloads: string[] }[];
    };
    expect(index.files).toHaveLength(1);
    expect(index.files[0]?.path).toBe("mods/sodium.jar");
    expect(await readZipEntry(zipBytes, "overrides/mods/jei.jar")).toBeUndefined();
  });
});
