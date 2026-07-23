import { createHash } from "node:crypto";
import { lstat, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  ContentStore,
  FixtureAcquirer,
  buildInstance,
  currentPlatform,
  writeInputLock,
} from "../../index.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeScenario } from "../helpers/scenario.js";

interface AssetIndexShape {
  readonly objects: Record<string, { readonly hash: string; readonly size: number }>;
}

async function readIndex(instanceDir: string): Promise<AssetIndexShape> {
  const raw = await readFile(join(instanceDir, "assets", "indexes", "26.json"), "utf8");
  return JSON.parse(raw) as AssetIndexShape;
}

// GATE — asset-tree object materialization: an `asset-tree` build must fan the
// index's objects into `instance/assets/objects/<xx>/<sha1>` so the folder is a
// COMPLETE, launch-ready `.minecraft` (index + objects), not an index over an
// empty objects dir. `verify` must FAIL when an indexed object goes missing.
describe("asset-tree object materialization", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("materializes every indexed object into instance/assets/objects", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
    });

    const index = await readIndex(instanceDir);
    const hashes = Object.values(index.objects).map((o) => o.hash);
    expect(hashes.length).toBeGreaterThan(0);

    // Every object the index names is present in assets/objects AND hash-correct.
    for (const h of hashes) {
      const bytes = await readFile(join(instanceDir, "assets", "objects", h.slice(0, 2), h));
      expect(createHash("sha1").update(bytes).digest("hex")).toBe(h);
    }
    const files = await listFiles(instanceDir);
    expect(files.some((f) => f.startsWith("assets/objects/"))).toBe(true);
  });

  it("keeps objects deterministic + incremental: a no-op rebuild re-materializes nothing", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const acquire = new FixtureAcquirer(store, poolDir);
    await buildInstance({ instanceDir, lock, store, acquire, platform: currentPlatform() });

    const h = Object.values((await readIndex(instanceDir)).objects)[0]?.hash as string;
    const objPath = join(instanceDir, "assets", "objects", h.slice(0, 2), h);
    const before = await stat(objPath);

    // A rebuild with the built lock as the baseline is a no-op delta: the
    // asset-tree package is unchanged, so its objects are never re-linked.
    const rebuilt = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire,
      platform: currentPlatform(),
      previousLock: lock,
    });
    expect(rebuilt.objects).toBe(0);
    const after = await stat(objPath);
    expect(after.ino).toBe(before.ino); // same inode → never re-copied
  });

  it("verify passes when complete and FAILS when an indexed object is deleted", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);

    // Seed the input lock + populate the store (Anvil.build is offline).
    await writeInputLock(instanceDir, lock);
    const seedStore = new ContentStore({ root: storeDir });
    const seedAcquire = new FixtureAcquirer(seedStore, poolDir);
    for (const pkg of lock.resolved) {
      await seedAcquire.ensure(pkg);
    }

    const anvil = new Anvil({ dir: instanceDir, storeDir });
    await anvil.build();
    expect((await anvil.verify()).ok).toBe(true);

    // Remove one materialized asset object → no longer a complete assets dir.
    const h = Object.values((await readIndex(instanceDir)).objects)[0]?.hash as string;
    await rm(join(instanceDir, "assets", "objects", h.slice(0, 2), h));

    const result = await anvil.verify();
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain("asset-index");
  });

  it("honors a mapped assets pool: objects land in the shared dir, instance symlinks to it", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    const assetsDir = await mkTmp("shared-assets");
    dirs.push(poolDir, instanceDir, storeDir, assetsDir);
    const store = new ContentStore({ root: storeDir });
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
      assetsDir,
    });

    const h = Object.values((await readIndex(instanceDir)).objects)[0]?.hash as string;

    // The object lives in the shared pool — not copied per-instance.
    expect((await stat(join(assetsDir, "objects", h.slice(0, 2), h))).isFile()).toBe(true);

    // The instance references the pool through a single symlink, so the folder is
    // still a complete `.minecraft` a launcher can point at.
    const link = join(instanceDir, "assets", "objects");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const bytes = await readFile(join(instanceDir, "assets", "objects", h.slice(0, 2), h));
    expect(createHash("sha1").update(bytes).digest("hex")).toBe(h);
  });
});
