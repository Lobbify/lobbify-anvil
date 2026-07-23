import { utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  ContentStore,
  FixtureAcquirer,
  type Hash,
  type InstanceRegistryEntry,
  type LockPackage,
  type Lockfile,
  StoreRegistryCorrupt,
  instanceRegistryPath,
  readInstanceRegistry,
  writeBuiltLock,
  writeInputLock,
  writeInstanceRegistry,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeScenario } from "../helpers/scenario.js";

/**
 * F1 — the shared-store instance registry unions every instance's built-lock roots
 * before a GC sweeps, so `gc` in instance A can never reclaim an object instance B
 * still references. These tests set up two instances against ONE shared store by
 * hand (built lock + registry entry + store objects), age the store objects past
 * the grace window so root-reachability — not the grace guard — decides what is
 * swept, then drive the real `Anvil.gc()`.
 */

const OLD = new Date(Date.now() - 3_600_000); // 1h ago: past DEFAULT_GC_GRACE_MS

/** A single-file `link` package pinned at `hash`. */
function pkg(name: string, hash: Hash, target: string): LockPackage {
  return {
    name,
    kind: "mod",
    source: "modrinth",
    hash,
    provenance: "copy",
    placement: { method: "link", target },
  };
}

/** A minimal built lock referencing one store object. */
function builtLock(p: LockPackage): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "0".repeat(64) },
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "runtime-test-21",
    },
    resolved: [p],
  };
}

async function putAged(store: ContentStore, content: string): Promise<Hash> {
  const { hash } = await store.putBuffer(new TextEncoder().encode(content), "sha256");
  // Age the object so the non-zero GC grace window does not shield it; only root
  // reachability should keep it alive.
  await utimes(store.objectPath(hash), OLD, OLD);
  return hash;
}

describe("shared-store instance registry gates cross-instance GC (F1)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("A's gc does NOT delete objects B's built lock still references", async () => {
    const storeDir = await mkTmp("shared-store");
    const dirA = await mkTmp("inst-a");
    const dirB = await mkTmp("inst-b");
    dirs.push(storeDir, dirA, dirB);
    const store = new ContentStore({ root: storeDir });

    const hashA = await putAged(store, "A-mod-bytes");
    const hashB = await putAged(store, "B-mod-bytes");
    const dangling = await putAged(store, "unreferenced-garbage");

    await writeBuiltLock(dirA, builtLock(pkg("mod-a", hashA, "mods/a.jar")));
    await writeBuiltLock(dirB, builtLock(pkg("mod-b", hashB, "mods/b.jar")));
    await writeInstanceRegistry(storeDir, {
      version: 1,
      instances: [{ dir: resolve(dirA) }, { dir: resolve(dirB) }],
    });

    const anvilA = new Anvil({ dir: dirA, storeDir, allowSource: () => true });
    const result = await anvilA.gc();

    // A's own object survives; B's object survives via the registry union; only the
    // genuinely-unreferenced object is reclaimed.
    expect(await store.has(hashA)).toBe(true);
    expect(await store.has(hashB)).toBe(true); // THE fix: cross-instance root
    expect(await store.has(dangling)).toBe(false);
    expect(result.removed).toBeGreaterThanOrEqual(1);
  });

  it("collects the objects of a STALE instance whose directory no longer exists", async () => {
    const storeDir = await mkTmp("shared-store");
    const dirA = await mkTmp("inst-a");
    const dirB = await mkTmp("inst-b");
    dirs.push(storeDir, dirA); // dirB is deleted below
    const store = new ContentStore({ root: storeDir });

    const hashA = await putAged(store, "A-mod-bytes");
    const hashB = await putAged(store, "B-only-bytes");

    await writeBuiltLock(dirA, builtLock(pkg("mod-a", hashA, "mods/a.jar")));
    await writeBuiltLock(dirB, builtLock(pkg("mod-b", hashB, "mods/b.jar")));
    await writeInstanceRegistry(storeDir, {
      version: 1,
      instances: [{ dir: resolve(dirA) }, { dir: resolve(dirB) }],
    });

    // B is uninstalled: its directory disappears (no `destroy` hook yet → gc prunes).
    await rmTmp(dirB);

    const anvilA = new Anvil({ dir: dirA, storeDir, allowSource: () => true });
    await anvilA.gc();

    // A's object survives; the stale B's object is reclaimed (no longer rooted).
    expect(await store.has(hashA)).toBe(true);
    expect(await store.has(hashB)).toBe(false);

    // The stale entry was pruned from the registry, and A remains (self-healed).
    const registry = await readInstanceRegistry(storeDir);
    const registeredDirs = registry.instances.map((e: InstanceRegistryEntry) => e.dir);
    expect(registeredDirs).toContain(resolve(dirA));
    expect(registeredDirs).not.toContain(resolve(dirB));
  });

  it("REFUSES to sweep when the registry is corrupt/unreadable (no deletion)", async () => {
    const storeDir = await mkTmp("shared-store");
    const dirA = await mkTmp("inst-a");
    dirs.push(storeDir, dirA);
    const store = new ContentStore({ root: storeDir });

    const hashA = await putAged(store, "A-mod-bytes");
    const dangling = await putAged(store, "would-be-collected");

    await writeBuiltLock(dirA, builtLock(pkg("mod-a", hashA, "mods/a.jar")));
    // A malformed registry file (not valid TOML).
    await writeFile(instanceRegistryPath(storeDir), "this is not = valid = toml [[[");

    const anvilA = new Anvil({ dir: dirA, storeDir, allowSource: () => true });
    await expect(anvilA.gc()).rejects.toBeInstanceOf(StoreRegistryCorrupt);

    // Nothing was deleted — not even the genuinely-dangling object — because GC
    // refused before any sweep.
    expect(await store.has(hashA)).toBe(true);
    expect(await store.has(dangling)).toBe(true);
  });

  it("a successful build registers the instance in the shared store", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);

    // Seed the input lock + pre-populate the store (Anvil.build is offline).
    await writeInputLock(instanceDir, lock);
    const seedStore = new ContentStore({ root: storeDir });
    const seedAcquire = new FixtureAcquirer(seedStore, poolDir);
    for (const p of lock.resolved) {
      await seedAcquire.ensure(p);
    }

    // Before the build, nothing is registered.
    expect((await readInstanceRegistry(storeDir)).instances).toHaveLength(0);

    const anvil = new Anvil({ dir: instanceDir, storeDir });
    await anvil.build();

    // The build registered this instance with a built-lock content hash, so a gc
    // from a DIFFERENT instance sharing this store would now union its roots.
    const registry = await readInstanceRegistry(storeDir);
    const entry = registry.instances.find(
      (e: InstanceRegistryEntry) => e.dir === resolve(instanceDir),
    );
    expect(entry).toBeDefined();
    expect(entry?.builtLockHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
