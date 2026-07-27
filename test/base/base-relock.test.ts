/**
 * `Anvil.lock` with a base, across repeated locks.
 *
 * The property under test is the one a user notices: a plain re-lock must not
 * re-download the pack, and must not move a pin nobody asked to move. The
 * mechanism is `.anvil/base.lock`, which also has to hold the base's **full**
 * member set — the instance lock holds only the survivors, and re-running the
 * overlay against survivors would make `game.remove` match nothing the second
 * time round.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  MrpackBaseSource,
  readBaseCache,
  writeManifest,
} from "../../index.js";
import { PACK_MC, baseManifest, baseWorld } from "../helpers/base-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  FABRIC_LOADER,
  loaderMetaBase,
  makeGameFixtures,
  mojangOptions,
  resourcesBase,
} from "../helpers/game.js";
import { registryWith } from "../helpers/net.js";

const MODS = [
  { slug: "alpha", projectId: "ALPHA", version: "1.0.0" },
  { slug: "beta", projectId: "BETA", version: "2.0.0" },
];

describe("re-locking an instance with a base", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function setup(remove?: readonly string[]) {
    const world = baseWorld({ mods: MODS });
    const dir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(dir, storeDir);
    const game = makeGameFixtures();
    const env: AnvilEnv = {
      registry: () => registryWith({ modrinth: world.http }),
      baseRegistry: () =>
        new Map([["modrinth", { source: new MrpackBaseSource(), http: world.http }]]),
      gameHttp: () => game.http,
      mojangOptions,
      loaderMetaBase,
      resourcesBase,
    };
    const manifest = {
      ...baseManifest(world.from, remove ? { remove } : {}),
      game: {
        minecraft: PACK_MC,
        loader: `fabric ${FABRIC_LOADER}`,
        from: world.from,
        ...(remove ? { remove } : {}),
      },
    };
    await writeManifest(dir, manifest);
    const anvil = new Anvil({ dir, storeDir }, env);
    return { anvil, world, dir };
  }

  /** How many times the pack archive itself was fetched. */
  function packFetches(world: Awaited<ReturnType<typeof setup>>["world"]): number {
    return world.http.calls.filter((u) => u.endsWith(".mrpack")).length;
  }

  it("resolves the pack once, then reuses the cached base set on a re-lock", async () => {
    const { anvil, world } = await setup();
    const first = await anvil.lock();
    expect(packFetches(world)).toBe(1);
    expect(first.base?.members).toBe(2);

    // A second Anvil, so the in-process memo cannot be what makes this pass.
    const second = await new Anvil(anvil.options, {
      registry: () => registryWith({ modrinth: world.http }),
      baseRegistry: () =>
        new Map([["modrinth", { source: new MrpackBaseSource(), http: world.http }]]),
      ...anvilGameEnv(),
    }).lock();
    expect(packFetches(world)).toBe(1);
    expect(second.base?.set.value).toBe(first.base?.set.value);
    expect(second.resolved.filter((p) => p.fromBase).length).toBe(
      first.resolved.filter((p) => p.fromBase).length,
    );
  });

  it("caches the FULL member set, so a re-lock re-applies game.remove against the pack", async () => {
    const { anvil, dir } = await setup(["modrinth:beta"]);
    const first = await anvil.lock();
    expect(first.resolved.filter((p) => p.fromBase).map((p) => p.name)).toEqual(["alpha"]);
    expect(first.base?.members).toBe(2);

    const cached = await readBaseCache(dir);
    expect(cached?.pack.members.map((p) => p.name).sort()).toEqual(["alpha", "beta"]);

    // The remove still matches — which it could not if the cache held survivors.
    const second = await anvil.lock();
    expect(second.resolved.filter((p) => p.fromBase).map((p) => p.name)).toEqual(["alpha"]);
    expect(second.base?.set.value).toBe(first.base?.set.value);
  });

  it("dropping the remove brings the base member back — the base layer is not consumed", async () => {
    const { anvil, dir } = await setup(["modrinth:beta"]);
    await anvil.lock();
    const manifest = JSON.parse(
      JSON.stringify({
        project: { name: "p", version: "1" },
        game: {
          minecraft: PACK_MC,
          loader: `fabric ${FABRIC_LOADER}`,
          from: (await readBaseCache(dir))?.ref,
        },
        items: [],
      }),
    );
    await writeManifest(dir, manifest);
    const relocked = await anvil.lock();
    expect(
      relocked.resolved
        .filter((p) => p.fromBase)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["alpha", "beta"]);
  });

  it("an offline lock works from the cached base, and fails clearly without one", async () => {
    const { anvil, world, dir } = await setup();
    await anvil.lock();
    const offline = new Anvil(
      { ...anvil.options, offline: true },
      {
        registry: () => registryWith({ modrinth: world.http }),
        baseRegistry: () =>
          new Map([["modrinth", { source: new MrpackBaseSource(), http: world.http }]]),
        ...anvilGameEnv(),
      },
    );
    const locked = await offline.lock();
    expect(locked.base?.members).toBe(2);

    // Corrupt the cache. A *fresh* process (a fresh Anvil, so the in-process memo
    // is not what answers) must say so, not silently produce a base-less instance.
    await writeFile(join(dir, ".anvil", "base.lock"), "not a lock");
    const cold = new Anvil(
      { ...anvil.options, offline: true },
      {
        registry: () => registryWith({ modrinth: world.http }),
        baseRegistry: () =>
          new Map([["modrinth", { source: new MrpackBaseSource(), http: world.http }]]),
        ...anvilGameEnv(),
      },
    );
    await expect(cold.lock()).rejects.toThrow(/offline/i);
  });

  it("a cache for a different base is not reused", async () => {
    const { anvil, dir } = await setup();
    await anvil.lock();
    const text = await readFile(join(dir, ".anvil", "base.lock"), "utf8");
    expect(text).toContain('ref = "modrinth:testpack@1.0.0"');
  });
});

/** The hermetic game fixtures, as an env fragment. */
function anvilGameEnv(): Partial<AnvilEnv> {
  const game = makeGameFixtures();
  return { gameHttp: () => game.http, mojangOptions, loaderMetaBase, resourcesBase };
}
