/**
 * A representative build scenario reused by the determinism / crash / incremental
 * tests: a mixed lock exercising every placement method — `link` (mods),
 * `extract` (a natives jar with a `META-INF/` to exclude), `asset-tree` (an asset
 * index fanning out a sha1 asset), and `store-only` (a client jar kept in-store).
 */

import type { LockPackage, Lockfile } from "../../index.js";
import { hashOf, mkTmp, writeFixture } from "./fixtures.js";
import { makeZip } from "./zip.js";

export interface Scenario {
  readonly poolDir: string;
  readonly lock: Lockfile;
}

/** Build the fixtures pool + a lock. `modB` varies one mod's bytes for delta tests. */
export async function makeScenario(opts: { modB?: string } = {}): Promise<Scenario> {
  const poolDir = await mkTmp("pool");

  const modA = Buffer.from("mod-a-content-v1\n");
  const modB = Buffer.from(opts.modB ?? "mod-b-content-v1\n");
  const clientJar = Buffer.from("minecraft-client-26.2\n");
  const nativesZip = makeZip([
    { name: "libfoo.so", data: "NATIVE-FOO-BYTES" },
    { name: "sub/libbar.so", data: "NATIVE-BAR-BYTES" },
    { name: "META-INF/MANIFEST.MF", data: "excluded" },
  ]);
  const assetBytes = Buffer.from("en_us-lang-blob\n");
  const assetHash = hashOf(assetBytes, "sha1");
  const indexBytes = Buffer.from(
    JSON.stringify({
      objects: { "minecraft/lang/en_us.json": { hash: assetHash.value, size: assetBytes.length } },
    }),
  );

  const [hA, hB, hClient, hNatives, hIndex] = await Promise.all([
    writeFixture(poolDir, modA, "sha256"),
    writeFixture(poolDir, modB, "sha256"),
    writeFixture(poolDir, clientJar, "sha256"),
    writeFixture(poolDir, nativesZip, "sha256"),
    writeFixture(poolDir, indexBytes, "sha256"),
  ]);
  await writeFixture(poolDir, assetBytes, "sha1"); // the asset the index fans out

  const resolved: LockPackage[] = [
    {
      name: "mod-a",
      kind: "mod",
      source: "modrinth",
      version: "1.0.0",
      hash: hA,
      provenance: "copy",
      placement: { method: "link", target: "mods/mod-a.jar" },
      size: modA.length,
    },
    {
      name: "mod-b",
      kind: "mod",
      source: "modrinth",
      version: "1.0.0",
      hash: hB,
      provenance: "copy",
      placement: { method: "link", target: "mods/mod-b.jar" },
      size: modB.length,
    },
    {
      name: "client",
      kind: "game",
      source: "mojang",
      version: "26.2",
      hash: hClient,
      provenance: "copy",
      placement: { method: "store-only" },
      size: clientJar.length,
    },
    {
      name: "natives",
      kind: "library",
      source: "mojang",
      hash: hNatives,
      provenance: "copy",
      placement: { method: "extract", targetDir: "natives" },
      size: nativesZip.length,
    },
    {
      name: "asset-index",
      kind: "game",
      source: "mojang",
      version: "26.2",
      hash: hIndex,
      provenance: "copy",
      placement: { method: "asset-tree", indexTarget: "assets/indexes/26.json" },
      size: indexBytes.length,
    },
  ];

  const lock: Lockfile = {
    meta: {
      version: 1,
      manifestHash: hashOf(Buffer.from("manifest"), "sha256"),
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "runtime-gamma-21",
    },
    resolved,
  };

  return { poolDir, lock };
}
