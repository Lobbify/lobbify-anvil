/**
 * `game.from` end to end: resolve a real `.mrpack` as a base layer, lay an
 * instance over it, and prove the two things the whole feature rests on —
 *
 *   1. a base-derived instance is **indistinguishable** from the equivalent
 *      instance that lists the same items directly, in the lock and in the bytes
 *      it builds;
 *   2. the base is resolved **once, at lock time** — a build from the lock never
 *      touches the pack.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type Lockfile,
  type Manifest,
  ManifestError,
  SourceNotAllowed,
  StoreOnlyAcquirer,
  buildInstance,
  currentPlatform,
  resolveManifest,
  serializeLock,
} from "../../index.js";
import {
  PACK_LOADER,
  PACK_MC,
  baseManifest,
  baseResolverFor,
  baseWorld,
} from "../helpers/base-pack.js";
import { listFiles, mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import { registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

const TWO_MODS = [
  { slug: "alpha", projectId: "ALPHA", version: "1.0.0" },
  { slug: "beta", projectId: "BETA", version: "2.0.0" },
];

describe("game.from — base packs", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function tmp(prefix: string): Promise<string> {
    const d = await mkTmp(prefix);
    dirs.push(d);
    return d;
  }

  async function lockWith(
    manifest: Manifest,
    world: ReturnType<typeof baseWorld>,
    opts: { instanceDir?: string; store?: ContentStore } = {},
  ): Promise<{ lock: Lockfile; store: ContentStore; instanceDir: string }> {
    const instanceDir = opts.instanceDir ?? (await tmp("inst"));
    const store = opts.store ?? new ContentStore({ root: await tmp("store") });
    const lock = await resolveManifest({
      manifest,
      registry: registryWith({ modrinth: world.http }),
      allowSource: () => true,
      now: NOW,
      baseDir: instanceDir,
      store,
      resolveBase: baseResolverFor(world, instanceDir, { now: NOW, store }),
    });
    return { lock, store, instanceDir };
  }

  /** Materialize a lock offline from an already-populated store. */
  async function build(lock: Lockfile, store: ContentStore): Promise<string> {
    const instanceDir = await tmp("built");
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: new StoreOnlyAcquirer(store),
      platform: currentPlatform(),
    });
    return instanceDir;
  }

  it("GATE equivalence: a base-derived instance and a directly-listed one lock and build alike", async () => {
    const world = baseWorld({ mods: TWO_MODS });

    const fromBase = await lockWith(baseManifest(world.from), world);
    const direct = await lockWith(
      {
        project: { name: "p", version: "1" },
        game: { minecraft: PACK_MC, loader: PACK_LOADER },
        items: [
          {
            ref: {
              source: "modrinth",
              id: "alpha",
              versionSpec: { kind: "pin", version: "1.0.0" },
            },
          },
          {
            ref: { source: "modrinth", id: "beta", versionSpec: { kind: "pin", version: "2.0.0" } },
          },
        ],
      },
      world,
    );

    // The rows differ in exactly two documented ways: the `from_base` marker and
    // the `[base]` identity block. Strip those and the locks are the same lock.
    const strip = (lock: Lockfile): Lockfile => ({
      meta: { ...lock.meta, manifestHash: { algo: "sha256", value: "0".repeat(64) } },
      resolved: lock.resolved.map(({ fromBase: _drop, ...rest }) => rest),
    });
    expect(serializeLock(strip(fromBase.lock))).toBe(serializeLock(strip(direct.lock)));
    expect(fromBase.lock.resolved.every((p) => p.fromBase === true)).toBe(true);
    expect(direct.lock.resolved.some((p) => p.fromBase === true)).toBe(false);

    // …and the same claim at the level that actually matters: the bytes on disk.
    const a = await build(fromBase.lock, fromBase.store);
    const b = await build(direct.lock, direct.store);
    const [ma, mb] = await Promise.all([treeManifest(a), treeManifest(b)]);
    expect(ma).toBe(mb);
    expect(ma.length).toBeGreaterThan(0);
    expect(await listFiles(a)).toEqual(expect.arrayContaining(world.memberTargets as string[]));
  });

  it("records the base identity + set digest, and flags every base-derived row", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const { lock } = await lockWith(baseManifest(world.from), world);
    expect(lock.base).toBeDefined();
    expect(lock.base?.ref).toBe(world.from);
    expect(lock.base?.id).toBe("testpack");
    expect(lock.base?.version).toBe("1.0.0");
    expect(lock.base?.members).toBe(2);
    expect(lock.base?.set.algo).toBe("sha256");
    // It round-trips through the canonical lock form.
    const text = serializeLock(lock);
    expect(text).toContain("[base]");
    expect(text).toContain("from_base = true");
  });

  it("two instances sharing a base carry the same set digest — the cheap-diff property", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    world.http.add({
      id: "GAMMA",
      slug: "gamma",
      title: "Gamma",
      projectType: "mod",
      versions: [
        {
          id: "gamma-v1",
          projectId: "GAMMA",
          versionNumber: "3.0.0",
          datePublished: "2026-06-01T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [PACK_MC],
          filename: "GAMMA-3.0.0.jar",
          bytes: new TextEncoder().encode("gamma-bytes"),
        },
      ],
    });
    const host = await lockWith(baseManifest(world.from), world);
    const joiner = await lockWith(
      // A different instance: same base, one genuinely extra item on top.
      {
        ...baseManifest(world.from),
        items: [{ ref: { source: "modrinth", id: "gamma", versionSpec: { kind: "latest" } } }],
      },
      world,
    );
    expect(joiner.lock.base?.set.value).toBe(host.lock.base?.set.value);
    // Equal digests ⇒ the flagged partitions need no comparison at all; what is
    // left to reconcile is only the unflagged overlay — here, one mod.
    const overlay = (lock: Lockfile) => lock.resolved.filter((p) => p.fromBase !== true);
    expect(overlay(host.lock)).toHaveLength(0);
    expect(overlay(joiner.lock).map((p) => p.name)).toEqual(["gamma"]);
  });

  it("listing exactly what the base already ships stays in the base partition", async () => {
    // Same bytes, same version, same destination — nothing was overridden, so the
    // row is attributed to where it came from rather than inflating the overlay a
    // base-sharing peer would have to reconcile.
    const world = baseWorld({ mods: TWO_MODS });
    const { lock } = await lockWith(
      {
        ...baseManifest(world.from),
        items: [
          {
            ref: {
              source: "modrinth",
              id: "alpha",
              versionSpec: { kind: "pin", version: "1.0.0" },
            },
          },
        ],
      },
      world,
    );
    const alpha = lock.resolved.filter((p) => p.name === "alpha");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.fromBase).toBe(true);
    expect(lock.resolved.filter((p) => p.fromBase !== true)).toHaveLength(0);
  });

  it("ADD: an instance item the base does not ship lands beside the base's", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const manifest = {
      ...baseManifest(world.from),
      items: [
        {
          ref: {
            source: "modrinth" as const,
            id: "gamma",
            versionSpec: { kind: "latest" as const },
          },
        },
      ],
    };
    world.http.add({
      id: "GAMMA",
      slug: "gamma",
      title: "Gamma",
      projectType: "mod",
      versions: [
        {
          id: "gamma-v1",
          projectId: "GAMMA",
          versionNumber: "3.0.0",
          datePublished: "2026-06-01T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [PACK_MC],
          filename: "GAMMA-3.0.0.jar",
          bytes: new TextEncoder().encode("gamma-bytes"),
        },
      ],
    });
    const { lock } = await lockWith(manifest, world);
    expect(lock.resolved.map((p) => p.name).sort()).toEqual(["alpha", "beta", "gamma"]);
    expect(lock.resolved.find((p) => p.name === "gamma")?.fromBase).toBeUndefined();
  });

  it("OVERRIDE: bumping a base mod replaces it — the base's old jar is not installed", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    // A newer alpha exists in the catalogue; the instance asks for it by name.
    // The pack's own 1.0.0 stays registered verbatim — it pinned those bytes.
    const alphaV1 = world.memberVersions.get("ALPHA");
    if (!alphaV1) {
      throw new Error("fixture: no ALPHA member version");
    }
    world.http.add({
      id: "ALPHA",
      slug: "alpha",
      title: "alpha",
      projectType: "mod",
      versions: [
        alphaV1,
        {
          id: "ALPHA-v-9.9.9",
          projectId: "ALPHA",
          versionNumber: "9.9.9",
          datePublished: "2026-06-20T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [PACK_MC],
          filename: "ALPHA-9.9.9.jar",
          bytes: new TextEncoder().encode("alpha-new"),
        },
      ],
    });
    const manifest = {
      ...baseManifest(world.from),
      items: [
        {
          ref: {
            source: "modrinth" as const,
            id: "alpha",
            versionSpec: { kind: "pin" as const, version: "9.9.9" },
          },
        },
      ],
    };
    const { lock, store } = await lockWith(manifest, world);
    const alpha = lock.resolved.filter((p) => p.name === "alpha");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.version).toBe("9.9.9");
    expect(alpha[0]?.fromBase).toBeUndefined();
    const files = await listFiles(await build(lock, store));
    expect(files).toContain("mods/ALPHA-9.9.9.jar");
    expect(files).not.toContain("mods/ALPHA-1.0.0.jar");
  });

  /**
   * Register a newer alpha alongside the one the pack pinned, plus a `gamma` that
   * *requires* alpha. Whether the dependency drags the base's alpha forward is the
   * behaviour under test.
   */
  function worldWithNewerAlphaAndDependent() {
    const world = baseWorld({ mods: TWO_MODS });
    const alphaV1 = world.memberVersions.get("ALPHA");
    if (!alphaV1) {
      throw new Error("fixture: no ALPHA member version");
    }
    world.http.add({
      id: "ALPHA",
      slug: "alpha",
      title: "alpha",
      projectType: "mod",
      versions: [
        alphaV1,
        {
          id: "ALPHA-v-9.9.9",
          projectId: "ALPHA",
          versionNumber: "9.9.9",
          datePublished: "2026-06-20T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [PACK_MC],
          filename: "ALPHA-9.9.9.jar",
          bytes: new TextEncoder().encode("alpha-new"),
        },
      ],
    });
    world.http.add({
      id: "GAMMA",
      slug: "gamma",
      title: "Gamma",
      projectType: "mod",
      versions: [
        {
          id: "gamma-v1",
          projectId: "GAMMA",
          versionNumber: "3.0.0",
          datePublished: "2026-06-01T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [PACK_MC],
          filename: "GAMMA-3.0.0.jar",
          bytes: new TextEncoder().encode("gamma-bytes"),
          dependencies: [{ project_id: "ALPHA", dependency_type: "required" }],
        },
      ],
    });
    return world;
  }

  it("a transitive dependency the base already provides reuses the base's pin", async () => {
    const world = worldWithNewerAlphaAndDependent();
    const manifest = {
      ...baseManifest(world.from),
      // gamma is the only thing listed. It requires alpha, which the base ships.
      items: [
        {
          ref: {
            source: "modrinth" as const,
            id: "gamma",
            versionSpec: { kind: "latest" as const },
          },
        },
      ],
    };
    const { lock } = await lockWith(manifest, world);
    const alpha = lock.resolved.filter((p) => p.name === "alpha");
    expect(alpha).toHaveLength(1);
    // Not 9.9.9: adding one mod must not silently bump a mod the pack chose.
    expect(alpha[0]?.version).toBe("1.0.0");
    expect(alpha[0]?.fromBase).toBe(true);
  });

  it("…but a root you listed yourself is resolved on its own terms, not the base's", async () => {
    const world = worldWithNewerAlphaAndDependent();
    const manifest = {
      ...baseManifest(world.from),
      // Same project, this time named by the manifest. You listed it, you control it.
      items: [
        {
          ref: {
            source: "modrinth" as const,
            id: "alpha",
            versionSpec: { kind: "latest" as const },
          },
        },
      ],
    };
    const { lock } = await lockWith(manifest, world);
    const alpha = lock.resolved.filter((p) => p.name === "alpha");
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.version).toBe("9.9.9");
    expect(alpha[0]?.fromBase).toBeUndefined();
  });

  it("REMOVE: a base mod named in game.remove is not installed", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const { lock, store } = await lockWith(
      baseManifest(world.from, { remove: ["modrinth:beta"] }),
      world,
    );
    expect(lock.resolved.map((p) => p.name)).toEqual(["alpha"]);
    // The base's own record is unchanged: `remove` is the instance's decision,
    // not a claim about what the pack contains.
    expect(lock.base?.members).toBe(2);
    const files = await listFiles(await build(lock, store));
    expect(files).toContain("mods/ALPHA-1.0.0.jar");
    expect(files).not.toContain("mods/BETA-2.0.0.jar");
  });

  it("OVERRIDE by path: an instance config beats the base's at the same target", async () => {
    const world = baseWorld({
      mods: [TWO_MODS[0] as (typeof TWO_MODS)[0]],
      overrides: [{ path: "config/tuning.toml", data: "from-the-pack\n" }],
    });
    const instanceDir = await tmp("inst");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(instanceDir, "config"), { recursive: true });
    await writeFile(join(instanceDir, "config", "tuning.toml"), "mine\n");

    const manifest = {
      ...baseManifest(world.from),
      items: [{ path: "./config/tuning.toml", kind: "config" as const }],
    };
    const { lock, store } = await lockWith(manifest, world, { instanceDir });
    const tuning = lock.resolved.filter(
      (p) => p.placement.method === "link" && p.placement.target === "config/tuning.toml",
    );
    expect(tuning).toHaveLength(1);
    expect(tuning[0]?.fromBase).toBeUndefined();
    const built = await build(lock, store);
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(built, "config", "tuning.toml"), "utf8")).toBe("mine\n");
  });

  it("a game.remove entry matching nothing fails the lock", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    await expect(
      lockWith(baseManifest(world.from, { remove: ["modrinth:not-in-this-pack"] }), world),
    ).rejects.toThrow(ManifestError);
  });

  it("refuses a base built for a different Minecraft version", async () => {
    const world = baseWorld({ mods: TWO_MODS, minecraft: "26.1" });
    const manifest = baseManifest(world.from); // declares 26.2
    await expect(lockWith(manifest, world)).rejects.toThrow(/Minecraft 26\.1/);
  });

  it("the allowSource gate runs on game.from before a single pack byte is fetched", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      resolveManifest({
        manifest: baseManifest(world.from),
        registry: registryWith({ modrinth: world.http }),
        allowSource: () => false,
        now: NOW,
        baseDir: instanceDir,
        store,
        resolveBase: baseResolverFor(world, instanceDir, { now: NOW, store }),
      }),
    ).rejects.toThrow(SourceNotAllowed);
    expect(world.http.calls).toHaveLength(0);
  });

  it("resolveManifest without a base resolver refuses game.from rather than ignoring it", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    await expect(
      resolveManifest({
        manifest: baseManifest(world.from),
        registry: registryWith({ modrinth: world.http }),
        allowSource: () => true,
        now: NOW,
        baseDir: await tmp("inst"),
      }),
    ).rejects.toThrow(/needs a base-pack resolver/);
  });

  it("GATE offline repeatability: building from the lock never touches the pack", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const { lock, store } = await lockWith(baseManifest(world.from), world);
    const callsAfterLock = world.http.calls.length;
    expect(callsAfterLock).toBeGreaterThan(0);

    const first = await build(lock, store);
    const second = await build(lock, store);
    // Not one further request — the build's sole input is the lock.
    expect(world.http.calls).toHaveLength(callsAfterLock);
    const [ma, mb] = await Promise.all([treeManifest(first), treeManifest(second)]);
    expect(ma).toBe(mb);
  });

  it("is deterministic: two resolves of one manifest produce the same lock bytes", async () => {
    const world = baseWorld({ mods: TWO_MODS });
    const a = await lockWith(baseManifest(world.from), world);
    const b = await lockWith(baseManifest(world.from), world);
    expect(serializeLock(a.lock)).toBe(serializeLock(b.lock));
  });
});
