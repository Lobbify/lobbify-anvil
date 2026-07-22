import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, FixtureAcquirer, buildInstance, currentPlatform } from "../../index.js";
import { mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import { makeScenario } from "../helpers/scenario.js";

// GATE — cross-volume: with the store and instance on different volumes (dev-id
// mismatch), materialization must detect it, fall back to a copy, and warn — while
// still producing the identical instance tree.
describe("cross-volume gate", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("detects a different-volume store, copies with a warning, tree still identical", async () => {
    const { poolDir, lock } = await makeScenario();
    dirs.push(poolDir);

    // Reference: a normal same-volume build.
    const refDir = await mkTmp("ref");
    const refStore = await mkTmp("refstore");
    dirs.push(refDir, refStore);
    const normalStore = new ContentStore({ root: refStore });
    await buildInstance({
      instanceDir: refDir,
      lock,
      store: normalStore,
      acquire: new FixtureAcquirer(normalStore, poolDir),
      platform: currentPlatform(),
    });
    const reference = await treeManifest(refDir);

    // Cross-volume: an injected dev probe reports the store on a different volume
    // than the instance, forcing the copy fallback.
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const warnings: string[] = [];
    const store = new ContentStore({
      root: storeDir,
      statDev: async (p) => (p.startsWith(storeDir) ? 10 : 20),
      onWarn: (m) => warnings.push(m),
    });
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
    });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.includes("different volumes"))).toBe(true);
    expect(await treeManifest(instanceDir)).toBe(reference);
  });
});
