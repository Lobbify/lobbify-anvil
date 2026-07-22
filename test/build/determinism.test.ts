import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, FixtureAcquirer, buildInstance, currentPlatform } from "../../index.js";
import { listFiles, mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import { makeScenario } from "../helpers/scenario.js";

// GATE — determinism: the same fixture lock produces byte-identical instance
// trees across two fully independent builds (separate stores + separate dirs).
describe("determinism gate", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function buildOnce(
    poolDir: string,
    lock: Awaited<ReturnType<typeof makeScenario>>["lock"],
  ) {
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const acquire = new FixtureAcquirer(store, poolDir);
    await buildInstance({ instanceDir, lock, store, acquire, platform: currentPlatform() });
    return instanceDir;
  }

  it("same lock → byte-identical trees across two independent builds", async () => {
    const { poolDir, lock } = await makeScenario();
    dirs.push(poolDir);
    const a = await buildOnce(poolDir, lock);
    const b = await buildOnce(poolDir, lock);
    const [ma, mb] = await Promise.all([treeManifest(a), treeManifest(b)]);
    expect(ma).toBe(mb);
    expect(ma.length).toBeGreaterThan(0);
  });

  it("materializes every placement kind, excludes META-INF, and never places store-only", async () => {
    const { poolDir, lock } = await makeScenario();
    dirs.push(poolDir);
    const inst = await buildOnce(poolDir, lock);
    const files = await listFiles(inst);
    expect(files).toContain("mods/mod-a.jar");
    expect(files).toContain("mods/mod-b.jar");
    expect(files).toContain("natives/libfoo.so");
    expect(files).toContain("natives/sub/libbar.so");
    expect(files).toContain("assets/indexes/26.json");
    // extract excludes META-INF; store-only (client jar) is never placed in the tree.
    expect(files.some((f) => f.includes("META-INF"))).toBe(false);
    expect(files.some((f) => f.includes("mods/client") || f === "client")).toBe(false);
  });

  it("is stable across a rebuild from the same lock (no delta re-materialized)", async () => {
    const { poolDir, lock } = await makeScenario();
    dirs.push(poolDir);
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const acquire = new FixtureAcquirer(store, poolDir);

    const first = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire,
      platform: currentPlatform(),
    });
    const before = await treeManifest(instanceDir);

    // A rebuild with the built lock as the baseline is a no-op delta.
    const second = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire,
      platform: currentPlatform(),
      previousLock: lock,
    });
    const after = await treeManifest(instanceDir);

    expect(first.objects).toBe(5);
    expect(second.objects).toBe(0);
    expect(after).toBe(before);
  });
});
