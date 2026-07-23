import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  FixtureAcquirer,
  MissingObject,
  ReplayAcquirer,
  ReplayCache,
  ReplayUnavailable,
  ShaMismatch,
  SourceKeyMissing,
  buildInstance,
  currentPlatform,
} from "../../index.js";
import type { Acquirer, LockPackage, Lockfile } from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { hashOf, mkTmp, rmTmp, writeFixture } from "../helpers/fixtures.js";
import { fabricJar, sha256hex } from "../helpers/net.js";

/** Recursively find whether any file named `value` exists under `root`. */
async function fileNamedExistsUnder(root: string, value: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return false;
  }
  for (const name of names) {
    const p = join(root, name);
    const st = await stat(p);
    if (st.isDirectory()) {
      if (await fileNamedExistsUnder(p, value)) {
        return true;
      }
    } else if (name === value) {
      return true;
    }
  }
  return false;
}

function replayPkg(bytes: Uint8Array): LockPackage {
  return {
    name: "jei",
    kind: "mod",
    source: "curseforge",
    version: "1.0.0",
    hash: { algo: "sha256", value: sha256hex(bytes) },
    provenance: "replay",
    placement: { method: "link", target: "mods/jei-1.0.0.jar" },
    size: bytes.byteLength,
    project: 238222,
    file: 5000,
    // NOTE: no `url`.
  };
}

/** A routing acquirer mirroring anvil's: replay → replay cache; else → copy. */
function routing(replay: ReplayAcquirer, copy: Acquirer): Acquirer {
  return {
    ensure: (pkg: LockPackage) =>
      pkg.provenance === "replay" ? replay.ensure(pkg) : copy.ensure(pkg),
  };
}

describe("replay build — CurseForge bytes never enter the shared store", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function setup() {
    const instanceDir = await mkTmp("inst");
    const store = new ContentStore({ root: await mkTmp("store") });
    const poolDir = await mkTmp("pool");
    dirs.push(instanceDir, store.root, poolDir);
    const replayCache = new ReplayCache({ instanceDir });
    return { instanceDir, store, poolDir, replayCache };
  }

  it("materializes the CF jar into mods/, verified, while the store stays clean", async () => {
    const { instanceDir, store, poolDir, replayCache } = await setup();

    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [
        { id: 5000, fileName: "jei-1.0.0.jar", gameVersions: ["26.2", "Fabric"], bytes: cfBytes },
      ],
    });
    const replayItem = replayPkg(cfBytes);

    // A plain copy mod alongside it (goes to the SHARED store).
    const copyBytes = fabricJar("sodium");
    const copyHash = await writeFixture(poolDir, copyBytes, "sha256");
    const copyItem: LockPackage = {
      name: "sodium",
      kind: "mod",
      source: "modrinth",
      version: "1.0.0",
      hash: copyHash,
      provenance: "copy",
      placement: { method: "link", target: "mods/sodium.jar" },
      size: copyBytes.byteLength,
    };

    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "runtime-gamma-21",
      },
      resolved: [replayItem, copyItem],
    };

    const replay = new ReplayAcquirer({ replayCache, http: cf, curseforgeKey: "k" });
    const copy = new FixtureAcquirer(store, poolDir);
    const result = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: routing(replay, copy),
      replayCache,
      platform: currentPlatform(),
    });
    expect(result.objects).toBe(2);

    // 1. The CF jar landed in the instance, byte-identical + sha-verified.
    const placed = new Uint8Array(await readFile(join(instanceDir, "mods", "jei-1.0.0.jar")));
    expect(placed).toEqual(cfBytes);

    // 2. THE ToS INVARIANT: the CF bytes are NOT in the shared store — not via
    //    the API, and not physically anywhere under the store root.
    expect(await store.has(replayItem.hash)).toBe(false);
    expect(await fileNamedExistsUnder(store.root, replayItem.hash.value)).toBe(false);

    // 3. They ARE in the per-instance replay cache (which the store cannot see).
    expect(await replayCache.has(replayItem.hash)).toBe(true);
    expect(await fileNamedExistsUnder(replayCache.root, replayItem.hash.value)).toBe(true);

    // 4. The copy mod went the other way: shared store yes, replay cache no.
    expect(await store.has(copyHash)).toBe(true);
    expect(await replayCache.has(copyHash)).toBe(false);
  });

  it("a key-missing replay build fails with SourceKeyMissing (never a silent skip)", async () => {
    const { instanceDir, store, replayCache } = await setup();
    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [{ id: 5000, fileName: "jei.jar", gameVersions: ["26.2"], bytes: cfBytes }],
    });
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [replayPkg(cfBytes)],
    };
    const replay = new ReplayAcquirer({ replayCache, http: cf }); // no key
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: routing(replay, new FixtureAcquirer(store, instanceDir)),
        replayCache,
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(SourceKeyMissing);
  });

  it("a disabled download surfaces ReplayUnavailable at build", async () => {
    const { instanceDir, store, replayCache } = await setup();
    const cfBytes = fabricJar("d");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "d",
      classId: 6,
      files: [
        {
          id: 5000,
          fileName: "d.jar",
          gameVersions: ["26.2"],
          bytes: cfBytes,
          downloadDisabled: true,
        },
      ],
    });
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [replayPkg(cfBytes)],
    };
    const replay = new ReplayAcquirer({ replayCache, http: cf, curseforgeKey: "k" });
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: routing(replay, new FixtureAcquirer(store, instanceDir)),
        replayCache,
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(ReplayUnavailable);
  });

  it("fetched bytes that do not match the pinned sha are a HARD fail (never built)", async () => {
    const { instanceDir, store, replayCache } = await setup();
    const indexed = fabricJar("real");
    const evil = fabricJar("evil");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [
        {
          id: 5000,
          fileName: "jei.jar",
          gameVersions: ["26.2"],
          bytes: indexed,
          cdnBytes: evil, // CDN serves DIFFERENT bytes than the pin
        },
      ],
    });
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [replayPkg(indexed)],
    };
    const replay = new ReplayAcquirer({ replayCache, http: cf, curseforgeKey: "k" });
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: routing(replay, new FixtureAcquirer(store, instanceDir)),
        replayCache,
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(ShaMismatch);
    // The evil bytes never entered the cache.
    expect(await replayCache.has(hashOf(evil, "sha256"))).toBe(false);
  });

  it("a CDN 403 surfaces ReplayUnavailable WITHOUT leaking the forgecdn URL", async () => {
    const { replayCache } = await setup();
    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [
        { id: 5000, fileName: "jei.jar", gameVersions: ["26.2"], bytes: cfBytes, cdn403: true },
      ],
    });
    const replay = new ReplayAcquirer({ replayCache, http: cf, curseforgeKey: "k" });
    await replay.ensure(replayPkg(cfBytes)).then(
      () => {
        throw new Error("expected a rejection");
      },
      (err: Error) => {
        expect(err).toBeInstanceOf(ReplayUnavailable);
        // The resolved CDN URL must never appear in the surfaced message.
        expect(err.message.toLowerCase()).not.toContain("forgecdn");
        expect(err.message).toContain("403");
      },
    );
  });

  it("offline cannot re-fetch a replay item that is not already cached", async () => {
    const { instanceDir, store, replayCache } = await setup();
    const cfBytes = fabricJar("jei");
    const replay = new ReplayAcquirer({ replayCache, offline: true, curseforgeKey: "k" });
    await expect(replay.ensure(replayPkg(cfBytes))).rejects.toBeInstanceOf(MissingObject);
    void store;
    void instanceDir;
  });
});
