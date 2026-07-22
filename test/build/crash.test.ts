import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  FixtureAcquirer,
  type Lockfile,
  buildInstance,
  currentPlatform,
  recoverSwap,
} from "../../index.js";
import { mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import { writeFixture } from "../helpers/fixtures.js";
import { makeScenario } from "../helpers/scenario.js";

// GATE — crash-injection: kill at every rename boundary during the swap; startup
// recovery must leave the instance fully-OLD or fully-NEW (never partial), and
// `saves/` must survive every crash point.
describe("crash-injection gate", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function setup(): Promise<{ poolDir: string; lockOld: Lockfile; lockNew: Lockfile }> {
    const { poolDir, lock: lockOld } = await makeScenario();
    dirs.push(poolDir);
    const modBv2 = Buffer.from("mod-b-content-v2-changed\n");
    const hBv2 = await writeFixture(poolDir, modBv2, "sha256");
    const lockNew: Lockfile = {
      meta: lockOld.meta,
      resolved: lockOld.resolved.map((p) =>
        p.name === "mod-b" ? { ...p, hash: hBv2, size: modBv2.length } : p,
      ),
    };
    return { poolDir, lockOld, lockNew };
  }

  async function referenceManifest(poolDir: string, lock: Lockfile): Promise<string> {
    const instanceDir = await mkTmp("ref");
    const storeDir = await mkTmp("refstore");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
    });
    return treeManifest(instanceDir);
  }

  it("recovery leaves OLD or NEW (never partial) and preserves saves/ at every boundary", async () => {
    const { poolDir, lockOld, lockNew } = await setup();
    const oldManifest = await referenceManifest(poolDir, lockOld);
    const newManifest = await referenceManifest(poolDir, lockNew);
    expect(oldManifest).not.toBe(newManifest); // the rebuild really changes the tree

    const observed = new Set<string>();
    // Cover every swap boundary; a few extra iterations exercise the clean path.
    for (let killAt = 1; killAt <= 12; killAt += 1) {
      const instanceDir = await mkTmp("inst");
      const storeDir = await mkTmp("store");
      dirs.push(instanceDir, storeDir);
      const store = new ContentStore({ root: storeDir });
      const acquire = new FixtureAcquirer(store, poolDir);

      // Establish the OLD instance, then a played-world sentinel under saves/.
      await buildInstance({
        instanceDir,
        lock: lockOld,
        store,
        acquire,
        platform: currentPlatform(),
      });
      await mkdir(join(instanceDir, "saves", "world"), { recursive: true });
      await writeFile(join(instanceDir, "saves", "world", "level.dat"), "WORLD-DATA");

      // Rebuild to NEW, killing at the killAt-th swap boundary.
      let swapFaults = 0;
      const fault = (point: string): void => {
        if (point.startsWith("swap:")) {
          swapFaults += 1;
          if (swapFaults === killAt) {
            throw new Error(`injected crash at ${point}`);
          }
        }
      };
      try {
        await buildInstance({
          instanceDir,
          lock: lockNew,
          store,
          acquire,
          platform: currentPlatform(),
          previousLock: lockOld,
          fault,
        });
      } catch {
        // simulated kill
      }

      // Startup recovery reconciles the interrupted swap.
      await recoverSwap(instanceDir);

      const manifest = await treeManifest(instanceDir);
      expect([oldManifest, newManifest]).toContain(manifest); // old-or-new, never partial
      observed.add(manifest === oldManifest ? "old" : "new");

      // saves/ is never in the swap set — the world survives every crash point.
      expect(await readFile(join(instanceDir, "saves", "world", "level.dat"), "utf8")).toBe(
        "WORLD-DATA",
      );
    }

    // The boundary sweep must actually observe both a rolled-back and a completed swap.
    expect(observed.has("old")).toBe(true);
    expect(observed.has("new")).toBe(true);
  });

  it("a clean rebuild (no crash) yields the NEW tree", async () => {
    const { poolDir, lockOld, lockNew } = await setup();
    const newManifest = await referenceManifest(poolDir, lockNew);

    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const acquire = new FixtureAcquirer(store, poolDir);
    await buildInstance({
      instanceDir,
      lock: lockOld,
      store,
      acquire,
      platform: currentPlatform(),
    });
    const result = await buildInstance({
      instanceDir,
      lock: lockNew,
      store,
      acquire,
      platform: currentPlatform(),
      previousLock: lockOld,
    });
    expect(result.objects).toBe(1); // only the changed mod re-materialized
    expect(await treeManifest(instanceDir)).toBe(newManifest);
  });
});
