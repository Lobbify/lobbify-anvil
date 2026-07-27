/**
 * `game.from = "curseforge:<project>@<file>"` — a CurseForge modpack as a base.
 *
 * The assertions that matter are not "it produced some rows". They are the two
 * claims the design rests on: that a member resolves from **identity alone**
 * (no bytes, ever, at lock time), and that every member lands as a `replay` row
 * so the ToS boundary is enforced by the storage layer rather than by this file.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  CurseForgeBaseSource,
  type Manifest,
  SourceKeyMissing,
  buildBaseRegistry,
  canonicalKeyOf,
  resolveManifest,
} from "../../index.js";
import {
  CF_PACK_LOADER,
  CF_PACK_MC,
  type CfPackSpec,
  cfBaseResolverFor,
  cfPackWorld,
} from "../helpers/cf-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

const MEMBERS = [
  { projectID: 238222, fileID: 5000, slug: "jei" },
  { projectID: 306612, fileID: 6100, slug: "fabric-api" },
];

describe("a CurseForge base pack", () => {
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

  function manifestFor(from: string, extra: Partial<Manifest["game"]> = {}): Manifest {
    return {
      project: { name: "p", version: "1" },
      game: { minecraft: CF_PACK_MC, loader: CF_PACK_LOADER, from, ...extra },
      items: [],
    };
  }

  async function lockIt(
    spec: CfPackSpec,
    opts: {
      manifest?: Manifest;
      allowSource?: (ref: { source: string; id: string }) => boolean;
      curseforgeKey?: string | null;
    } = {},
  ) {
    const world = cfPackWorld(spec);
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const warnings: string[] = [];
    const lock = await resolveManifest({
      manifest: opts.manifest ?? manifestFor(world.from),
      registry: registryWith({ curseforge: world.http }),
      allowSource: () => true,
      now: NOW,
      baseDir: instanceDir,
      store,
      curseforgeKey: "TEST-CF-KEY",
      emit: (event) => {
        if (event.type === "warning") {
          warnings.push(event.message);
        }
      },
      resolveBase: cfBaseResolverFor(world, instanceDir, {
        now: NOW,
        store,
        ...(opts.allowSource ? { allowSource: opts.allowSource as never } : {}),
        ...(opts.curseforgeKey !== undefined ? { curseforgeKey: opts.curseforgeKey } : {}),
      }),
    });
    return { lock, world, instanceDir, store, warnings };
  }

  // --- the wiring -----------------------------------------------------------

  it("is registered in the default base registry", () => {
    // Every other test in this file constructs CurseForgeBaseSource directly, so
    // without this one the feature could be entirely unreachable in production
    // and the suite would still be green. (The negative control caught that:
    // deleting the registry entry survived all 85 tests.)
    const registry = buildBaseRegistry();
    const entry = registry.get("curseforge");
    expect(entry).toBeDefined();
    expect(entry?.source.kind).toBe("curseforge");
    expect(entry?.source).toBeInstanceOf(CurseForgeBaseSource);
    // It needs an HTTP client, or every resolve fails at the first fetch.
    expect(entry?.http).toBeDefined();
    // Modrinth is still there — adding one source must not displace the other.
    expect(registry.get("modrinth")?.source.kind).toBe("modrinth");
  });

  it("honors a CurseForge base-URL override, so a mirror or fixture can be used", () => {
    const entry = buildBaseRegistry({ curseforgeBaseUrl: "https://cf.example/api" }).get(
      "curseforge",
    );
    expect(entry?.source).toBeInstanceOf(CurseForgeBaseSource);
  });

  // --- the core claim: identity in, pinned set out, no member bytes ----------

  it("resolves game.from to a pinned member set, pinning (project, file) + sha1", async () => {
    const { lock } = await lockIt({ members: MEMBERS });
    const members = lock.resolved.filter((p) => p.source === "curseforge");
    expect(members).toHaveLength(2);

    const jei = members.find((p) => p.project === 238222);
    expect(jei).toBeDefined();
    expect(jei?.file).toBe(5000);
    expect(jei?.name).toBe("jei");
    expect(jei?.provenance).toBe("replay");
    // The pin CurseForge actually attests. sha1 is algo 1; algo 2 is md5.
    expect(jei?.hash.algo).toBe("sha1");
    expect(jei?.hash.value).toMatch(/^[0-9a-f]{40}$/);
    // A replay row is NEVER pinned to a rehostable URL.
    expect(jei?.url).toBeUndefined();
    expect(jei?.fromBase).toBe(true);
    // Identity is the CurseForge project — the axis the overlay overrides on.
    expect(canonicalKeyOf(jei as never)).toBe("curseforge:238222");
  });

  it("downloads the pack archive and NOTHING else — members resolve from metadata", async () => {
    const { world } = await lockIt({ members: MEMBERS });
    const cdnCalls = world.http.calls.filter((u) => u.includes("edge.forgecdn.net"));
    // Exactly one byte download: the pack zip itself.
    expect(cdnCalls).toHaveLength(1);
    expect(cdnCalls[0]).toContain("test-cf-pack");
    for (const member of MEMBERS) {
      expect(cdnCalls.some((u) => u.includes(`/${member.fileID}/`))).toBe(false);
    }
    // The member facts came from the metadata endpoints instead.
    expect(world.http.calls).toContain("https://api.curseforge.com/v1/mods/238222/files/5000");
    expect(world.http.calls).toContain("https://api.curseforge.com/v1/mods/238222");
  });

  it("carries the BYO key on every request and never lets it reach the lock", async () => {
    const { world, lock } = await lockIt({ members: MEMBERS });
    expect(world.http.apiKeys.length).toBeGreaterThan(0);
    expect(new Set(world.http.apiKeys)).toEqual(new Set(["TEST-CF-KEY"]));
    expect(JSON.stringify(lock)).not.toContain("TEST-CF-KEY");
    expect(JSON.stringify(lock)).not.toContain("forgecdn");
  });

  it("fails closed without a key — never a silent skip or an empty pack", async () => {
    await expect(lockIt({ members: MEMBERS }, { curseforgeKey: null })).rejects.toBeInstanceOf(
      SourceKeyMissing,
    );
  });

  // --- overrides ------------------------------------------------------------

  it("materializes overrides/ into .anvil/base/ as tracked local rows", async () => {
    const { lock, instanceDir } = await lockIt({
      members: MEMBERS,
      overrides: [{ path: "config/tuning.toml", data: "pack-owns-this\n" }],
    });
    const config = lock.resolved.find(
      (p) => p.placement.method === "link" && p.placement.target === "config/tuning.toml",
    );
    expect(config).toBeDefined();
    expect(config?.source).toBe("local");
    expect(config?.provenance).toBe("copy");
    expect(
      await readFile(join(instanceDir, ".anvil", "base", "config", "tuning.toml"), "utf8"),
    ).toBe("pack-owns-this\n");
  });

  it("honors a pack-declared overrides prefix", async () => {
    const { lock } = await lockIt({
      members: [],
      overridesPrefix: "client-files",
      overrides: [{ path: "options.txt", data: "fov:90\n" }],
    });
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target === "options.txt",
      ),
    ).toBe(true);
  });

  // --- the game target ------------------------------------------------------

  it("declares its own Minecraft version and cannot lie its way into another", async () => {
    const world = cfPackWorld({ members: MEMBERS, minecraft: "26.1" });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      resolveManifest({
        manifest: manifestFor(world.from),
        registry: registryWith({ curseforge: world.http }),
        allowSource: () => true,
        now: NOW,
        baseDir: instanceDir,
        store,
        curseforgeKey: "TEST-CF-KEY",
        resolveBase: cfBaseResolverFor(world, instanceDir, { now: NOW, store }),
      }),
    ).rejects.toThrow(/Minecraft/);
  });

  it("reads the loader out of manifest.json modLoaders", async () => {
    const world = cfPackWorld({ members: MEMBERS, loaderId: "neoforge-21.1.5" });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const pack = await cfBaseResolverFor(world, instanceDir, { now: NOW, store })({
      source: "curseforge",
      id: String(715572),
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
    expect(pack.game).toEqual({ minecraft: CF_PACK_MC, loader: "neoforge 21.1.5" });
  });

  // --- unpinnable members are skipped loudly, never silently ----------------

  it("skips a member CurseForge attests no sha1 for, with a warning naming it", async () => {
    const { lock, warnings } = await lockIt({
      members: [...MEMBERS, { projectID: 999111, fileID: 7000, slug: "nohash", noSha1: true }],
    });
    expect(lock.resolved.some((p) => p.project === 999111)).toBe(false);
    expect(warnings).toContainEqual(expect.stringContaining("attests no sha1"));
    // The honest members still resolved — one bad member is not a dead pack.
    expect(lock.resolved.filter((p) => p.source === "curseforge")).toHaveLength(2);
  });

  // --- the overlay reads a CF base on the identity axis ----------------------

  it("lets an instance item override a base member on CurseForge identity", async () => {
    const world = cfPackWorld({
      members: MEMBERS,
      // A newer build of the base's jei, published but not in the pack.
      alsoPublish: [{ projectID: 238222, fileID: 5001, slug: "jei", body: "jei-newer" }],
    });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const lock = await resolveManifest({
      manifest: {
        ...manifestFor(world.from),
        items: [
          {
            ref: {
              source: "curseforge",
              id: "238222",
              versionSpec: { kind: "pin", version: "5001" },
            },
          },
        ],
      },
      registry: registryWith({ curseforge: world.http }),
      allowSource: () => true,
      now: NOW,
      baseDir: instanceDir,
      store,
      curseforgeKey: "TEST-CF-KEY",
      resolveBase: cfBaseResolverFor(world, instanceDir, { now: NOW, store }),
    });
    const jei = lock.resolved.filter((p) => p.project === 238222);
    // Exactly one survives, and it is the instance's — never the base's.
    expect(jei).toHaveLength(1);
    expect(jei[0]?.fromBase).toBeUndefined();
  });
});
