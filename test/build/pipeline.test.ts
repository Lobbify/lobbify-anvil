import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEvent,
  ContentStore,
  FixtureAcquirer,
  MissingObject,
  StoreOnlyAcquirer,
  buildInstance,
  currentPlatform,
  resolveManifest,
  writeInputLock,
} from "../../index.js";
import { baseManifest, baseResolverFor, baseWorld } from "../helpers/base-pack.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { registryWith } from "../helpers/net.js";
import { makeScenario } from "../helpers/scenario.js";

describe("build pipeline", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("materializes a full instance from fixtures and records the built ref", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const events: AnvilEvent["type"][] = [];
    const result = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
      emit: (e) => events.push(e.type),
    });
    expect(result.objects).toBe(5);
    expect(events).toContain("build:done");
    expect(events).toContain("verify:done");
    const built = JSON.parse(await readFile(join(instanceDir, ".anvil", "refs", "built"), "utf8"));
    expect(built.resolved).toHaveLength(5);
  });

  it("errors clearly on the first missing object in an offline build", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir }); // empty store
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: new StoreOnlyAcquirer(store),
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(MissingObject);
  });

  it("drives the whole Anvil facade: build → verify → fsck → gc", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);

    // Seed the input lock and pre-populate the store (Anvil.build is offline).
    await writeInputLock(instanceDir, lock);
    const seedStore = new ContentStore({ root: storeDir });
    const seedAcquire = new FixtureAcquirer(seedStore, poolDir);
    for (const pkg of lock.resolved) {
      await seedAcquire.ensure(pkg);
    }

    const anvil = new Anvil({ dir: instanceDir, storeDir });
    const seen: string[] = [];
    anvil.on("progress", (e) => seen.push(e.type));

    const build = await anvil.build();
    expect(build.objects).toBe(5);
    expect(seen).toContain("build:done");
    const files = await listFiles(instanceDir);
    expect(files).toContain("mods/mod-a.jar");
    expect(files).toContain("natives/libfoo.so");

    expect((await anvil.verify()).ok).toBe(true);
    expect((await anvil.fsck()).ok).toBe(true);
    // Every stored object is rooted by the built lock → nothing to collect.
    expect((await anvil.gc()).removed).toBe(0);
  });

  it("LB-813: a built lock keeps the input lock's [base] block", async () => {
    // The platform-effective lock the build engine writes to `.anvil/refs/built`
    // was reconstructed as `{ meta, resolved }` — a hand-written field list that
    // does not mention `base`, the same shape LB-801 fixed at the 3-way-apply
    // call site. On any `game.from` instance this silently dropped `[base]` from
    // the built ref on every ordinary build, merge or not, leaving rows that
    // still carry `fromBase: true` beside a ref with nothing to name the pack
    // they came from.
    const NOW = Date.parse("2026-07-01T00:00:00Z");
    const world = baseWorld({
      mods: [
        { slug: "alpha", projectId: "ALPHA", version: "1.0.0" },
        { slug: "beta", projectId: "BETA", version: "2.0.0" },
      ],
    });
    const instanceDir = await mkTmp("base-resolve");
    const storeDir = await mkTmp("base-store");
    const builtDir = await mkTmp("base-built");
    dirs.push(instanceDir, storeDir, builtDir);
    const store = new ContentStore({ root: storeDir });

    const lock = await resolveManifest({
      manifest: baseManifest(world.from),
      registry: registryWith({ modrinth: world.http }),
      allowSource: () => true,
      now: NOW,
      baseDir: instanceDir,
      store,
      resolveBase: baseResolverFor(world, instanceDir, { now: NOW, store }),
    });
    // Guard against a vacuous pass: the fixture must actually be base-derived.
    expect(lock.base, "fixture is not base-derived — the test proves nothing").toBeDefined();
    expect(lock.resolved.some((p) => p.fromBase === true)).toBe(true);

    await buildInstance({
      instanceDir: builtDir,
      lock,
      store,
      acquire: new StoreOnlyAcquirer(store),
      platform: currentPlatform(),
    });

    const built = JSON.parse(await readFile(join(builtDir, ".anvil", "refs", "built"), "utf8"));
    expect(built.base, "the [base] block did not survive the build").toEqual(lock.base);
    expect(built.resolved.some((p: { fromBase?: true }) => p.fromBase === true)).toBe(true);
  });

  it("emits an error event and rejects when Anvil.build has no objects", async () => {
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    await writeInputLock(instanceDir, lock);

    const anvil = new Anvil({ dir: instanceDir, storeDir });
    const errors: AnvilEvent[] = [];
    anvil.on("progress", (e) => {
      if (e.type === "error") {
        errors.push(e);
      }
    });
    await expect(anvil.build()).rejects.toBeInstanceOf(MissingObject);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ type: "error", code: "MISSING_OBJECT" });
  });
});
