/**
 * A CurseForge base pack is attacker-influenced input, so every thing one could
 * try gets an explicit test — the CurseForge counterpart to
 * `base-pack-hostile.test.ts`.
 *
 * Two of these are not bounds checks:
 *
 *   - **The licensing invariant.** CurseForge project files are never placed in
 *     a shared/global store. Here that holds in its strongest form: resolving a
 *     base downloads no member bytes at all, so there is nothing to leak.
 *   - **The lying surface a CurseForge pack does not have.** A `.mrpack` states
 *     each member's hash and URL, so it can lie about both and the resolver must
 *     catch it. A CurseForge `manifest.json` states only `(projectID, fileID)`,
 *     so the pack has nothing to lie *with* — every fact is read from the API.
 *     That is asserted rather than assumed, because it is the property the whole
 *     metadata-only design rests on.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  DecompressionBomb,
  type Manifest,
  ManifestError,
  PathEscape,
  SourceKeyMissing,
  SourceNotAllowed,
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
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HONEST = [{ projectID: 238222, fileID: 5000, slug: "jei" }];

/** Every file name under `root`, recursively. */
async function allFileNames(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      if ((await stat(p)).isDirectory()) {
        await walk(p);
      } else {
        out.push(name);
      }
    }
  }
  await walk(root);
  return out;
}

describe("a hostile CurseForge base pack", () => {
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

  function manifestFor(from: string): Manifest {
    return {
      project: { name: "p", version: "1" },
      game: { minecraft: CF_PACK_MC, loader: CF_PACK_LOADER, from },
      items: [],
    };
  }

  async function lockIt(
    spec: CfPackSpec,
    opts: {
      manifest?: Manifest;
      allowSource?: (ref: { source: string; id: string }) => boolean;
      instanceDir?: string;
    } = {},
  ) {
    const world = cfPackWorld(spec);
    const instanceDir = opts.instanceDir ?? (await tmp("inst"));
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
      }),
    });
    return { lock, world, instanceDir, store, warnings };
  }

  // --- the licensing invariant ----------------------------------------------

  it("puts NO CurseForge project-file bytes in the shared store — none are fetched", async () => {
    const { lock, store, world } = await lockIt({ members: HONEST });
    const members = lock.resolved.filter((p) => p.source === "curseforge");
    expect(members.length).toBeGreaterThan(0);

    // 1. No member's content address exists anywhere under the shared store.
    const storeNames = await allFileNames(store.root);
    for (const member of members) {
      expect(storeNames).not.toContain(member.hash.value);
      expect(await store.has(member.hash)).toBe(false);
    }
    // 2. Stronger: the bytes were never even downloaded, so nothing *could*
    //    have been admitted. Only the pack archive was fetched from the CDN.
    const cdnCalls = world.http.calls.filter((u) => u.includes("edge.forgecdn.net"));
    expect(cdnCalls).toHaveLength(1);
    // 3. Every member is a replay row, which is what routes it away from the
    //    store, GC roots, push/sync, and export — structurally, elsewhere.
    for (const member of members) {
      expect(member.provenance).toBe("replay");
      expect(member.url).toBeUndefined();
      expect(member.project).toBeDefined();
      expect(member.file).toBeDefined();
    }
  });

  it("admits EXACTLY the override objects and nothing else", async () => {
    // Behavioral, not a source grep. An earlier version of this test asserted
    // the absence of two spellings (`ctx.store?.putBuffer`, `store.putFile`)
    // that this file's architecture never uses anyway — it would have passed a
    // member admitted through the `sinkFor(ctx)` helper the file DOES use, which
    // is the realistic regression. Counting objects catches any spelling.
    const store = new ContentStore({ root: await tmp("store") });
    const instanceDir = await tmp("inst");
    const world = cfPackWorld({
      members: [
        { projectID: 238222, fileID: 5000, slug: "jei" },
        { projectID: 306612, fileID: 6100, slug: "fabric-api" },
      ],
      overrides: [
        { path: "config/a.toml", data: "a\n" },
        { path: "config/b.toml", data: "b\n" },
      ],
    });
    const pack = await cfBaseResolverFor(world, instanceDir, { now: NOW, store })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
    expect(pack.members.filter((p) => p.source === "curseforge")).toHaveLength(2);

    // 2 members + 2 overrides resolved, but the store holds exactly the 2
    // override objects. Not "does not contain the member hash" — exactly two.
    const overrideHashes = pack.members
      .filter((p) => p.source === "local")
      .map((p) => p.hash.value)
      .sort();
    expect(overrideHashes).toHaveLength(2);
    const stored = (await allFileNames(store.root)).filter((n) => /^[0-9a-f]{40,64}$/.test(n));
    expect(stored.sort()).toEqual(overrideHashes);

    // And exactly one CDN fetch: the pack archive. No member bytes moved.
    expect(world.http.calls.filter((u) => u.includes("edge.forgecdn.net"))).toHaveLength(1);
  });

  // --- what the pack cannot lie about ---------------------------------------

  it("takes every member fact from the API, not the pack — the pack states none", async () => {
    const { lock } = await lockIt({ members: HONEST });
    const jei = lock.resolved.find((p) => p.project === 238222);
    // The pack named only (238222, 5000). Name, version, size and hash all came
    // from the CurseForge API for that pair.
    expect(jei?.name).toBe("jei");
    expect(jei?.hash.value).toMatch(/^[0-9a-f]{40}$/);
    expect(jei?.size).toBeGreaterThan(0);
  });

  it("refuses a member whose API answer is a different (project, file) pair", async () => {
    await expect(
      lockIt({
        members: [{ projectID: 238222, fileID: 5000, slug: "jei", identitySwap: { id: 9999 } }],
      }),
      // Assert WHICH failure: a bare toThrow() is green for any unrelated
      // breakage in this fixture path.
    ).rejects.toThrow(/answered for 238222\/9999 when asked for member 238222\/5000/);
  });

  it("skips a member the catalogue does not publish, loudly", async () => {
    const { lock, warnings } = await lockIt({
      members: [...HONEST, { projectID: 424242, fileID: 8888, unpublished: true }],
    });
    expect(lock.resolved.some((p) => p.project === 424242)).toBe(false);
    expect(warnings.join("\n")).toMatch(/424242/);
  });

  // --- bounds ---------------------------------------------------------------

  it("cannot declare an unbounded member list", async () => {
    const rawFiles = Array.from({ length: 10_001 }, (_, i) => ({
      projectID: i + 1,
      fileID: i + 1,
      required: true,
    }));
    await expect(lockIt({ members: [], rawFiles })).rejects.toBeInstanceOf(ManifestError);
  });

  it("rejects a manifest.json that is not valid JSON, rather than reading it as empty", async () => {
    await expect(lockIt({ members: [], rawManifest: "{not json" })).rejects.toBeInstanceOf(
      ManifestError,
    );
  });

  it("rejects a zip with no manifest.json, naming that as the reason", async () => {
    // The message matters. Without the missing-entry guard the flow falls
    // through to the JSON parser, which also throws a ManifestError — so an
    // assertion on the TYPE alone passes whether or not the guard exists.
    // (Caught by the negative control: this test used to survive that mutation.)
    await expect(lockIt({ members: [], omitManifest: true })).rejects.toThrow(
      /not a CurseForge modpack \(no manifest\.json\)/,
    );
  });

  it("rejects a non-modpack manifestType", async () => {
    await expect(
      lockIt({
        members: [],
        rawManifest: JSON.stringify({
          manifestType: "minecraftInstance",
          minecraft: { version: CF_PACK_MC, modLoaders: [{ id: "fabric-0.19.1", primary: true }] },
          files: [],
        }),
      }),
    ).rejects.toBeInstanceOf(ManifestError);
  });

  it("rejects a files[] entry with a non-numeric projectID", async () => {
    await expect(
      lockIt({ members: [], rawFiles: [{ projectID: "../../etc", fileID: 1 }] }),
    ).rejects.toBeInstanceOf(ManifestError);
  });

  it("rejects a files[] entry with a negative id", async () => {
    await expect(
      lockIt({ members: [], rawFiles: [{ projectID: -1, fileID: -1 }] }),
    ).rejects.toBeInstanceOf(ManifestError);
  });

  // --- the overrides tree ---------------------------------------------------

  it("cannot zip-slip out of overrides/", async () => {
    await expect(
      lockIt({
        members: HONEST,
        malicious: [{ name: "overrides/../../escape.txt", data: "pwned" }],
      }),
    ).rejects.toBeInstanceOf(PathEscape);
  });

  it("cannot plant a symlink through overrides/", async () => {
    await expect(
      lockIt({
        members: HONEST,
        malicious: [{ name: "overrides/link", type: "symlink", linkTarget: "/etc/passwd" }],
      }),
    ).rejects.toThrow(/symlink|link/i);
  });

  it("cannot write into saves/ — the override is skipped, the world is untouched", async () => {
    // Note this is NOT the traversal case (that is the zip-slip test above, and
    // it is a hard reject). The entry is perfectly well-formed and lands inside
    // the instance; it is refused because `saves/` is protected, by invariant.
    const instanceDir = await tmp("inst");
    await mkdir(join(instanceDir, "saves", "MyWorld"), { recursive: true });
    await writeFile(join(instanceDir, "saves", "MyWorld", "level.dat"), "mine");
    const { lock, warnings } = await lockIt(
      {
        members: HONEST,
        malicious: [{ name: "overrides/saves/MyWorld/level.dat", data: "hostile-world" }],
      },
      { instanceDir },
    );
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target.startsWith("saves/"),
      ),
    ).toBe(false);
    // The player's world is exactly as it was.
    expect(await readFile(join(instanceDir, "saves", "MyWorld", "level.dat"), "utf8")).toBe("mine");
    expect(warnings.join("\n")).toMatch(/protected|unsafe/i);
  });

  it("cannot write into .anvil/ through overrides/", async () => {
    const { lock } = await lockIt({
      members: HONEST,
      malicious: [{ name: "overrides/.anvil/config.toml", data: "hostile" }],
    });
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target.startsWith(".anvil"),
      ),
    ).toBe(false);
  });

  it("cannot widen extraction with a traversing overrides prefix", async () => {
    // A pack naming `overrides: ".."` would select entries outside its own
    // subtree. The prefix is normalized back to the default instead.
    const { lock } = await lockIt({
      members: HONEST,
      overridesPrefix: "..",
      malicious: [{ name: "../secret.txt", data: "nope" }],
    });
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target.includes("secret"),
      ),
    ).toBe(false);
  });

  // --- policy + key ---------------------------------------------------------

  it("is stopped by the host policy BEFORE any member request is made", async () => {
    const world = cfPackWorld({ members: HONEST });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const allow = (ref: { source: string; id: string }): boolean =>
      !(ref.source === "curseforge" && ref.id === "238222");
    await expect(
      resolveManifest({
        manifest: manifestFor(world.from),
        registry: registryWith({ curseforge: world.http }),
        allowSource: () => true,
        now: NOW,
        baseDir: instanceDir,
        store,
        curseforgeKey: "TEST-CF-KEY",
        resolveBase: cfBaseResolverFor(world, instanceDir, {
          now: NOW,
          store,
          allowSource: allow as never,
        }),
      }),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
    // The veto landed before the member's metadata was ever requested.
    expect(world.http.calls).not.toContain("https://api.curseforge.com/v1/mods/238222/files/5000");
  });

  it("refuses the base ref itself when the policy vetoes CurseForge, before any I/O", async () => {
    const world = cfPackWorld({ members: HONEST });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      resolveManifest({
        manifest: manifestFor(world.from),
        registry: registryWith({ curseforge: world.http }),
        allowSource: (ref) => ref.source !== "curseforge",
        now: NOW,
        baseDir: instanceDir,
        store,
        curseforgeKey: "TEST-CF-KEY",
        resolveBase: cfBaseResolverFor(world, instanceDir, { now: NOW, store }),
      }),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
    // Not a single request was made — the gate is upstream of the resolver.
    expect(world.http.calls).toHaveLength(0);
  });

  it("fails closed without a key rather than resolving an empty pack", async () => {
    const world = cfPackWorld({ members: HONEST });
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW, store, curseforgeKey: null })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "pin", version: String(world.packFileId) },
      }),
    ).rejects.toBeInstanceOf(SourceKeyMissing);
    expect(world.http.calls).toHaveLength(0);
  });

  it("refuses a non-numeric CurseForge base reference", async () => {
    const world = cfPackWorld({ members: HONEST });
    const instanceDir = await tmp("inst");
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "../../etc/passwd",
        versionSpec: { kind: "latest" },
      }),
    ).rejects.toThrow(/numeric project id/);
  });

  // --- the pack archive itself ----------------------------------------------

  it("refuses a pack archive whose bytes disagree with CurseForge's attested sha1", async () => {
    const world = cfPackWorld({ members: HONEST });
    const instanceDir = await tmp("inst");
    // Same routing, but the CDN serves something other than what was indexed —
    // a substituted pack archive. The attested sha1 is the tamper guard.
    world.http.add({
      modId: 715572,
      slug: "test-cf-pack",
      classId: 4471,
      files: [
        {
          id: world.packFileId,
          fileName: "test-cf-pack.zip",
          gameVersions: [CF_PACK_MC],
          bytes: new TextEncoder().encode("the honest archive"),
          cdnBytes: new TextEncoder().encode("SUBSTITUTED ARCHIVE"),
        },
      ],
    });
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "pin", version: String(world.packFileId) },
      }),
    ).rejects.toThrow(/sha1/i);
  });

  it("bounds the pack archive", async () => {
    // A 129 MB archive is over the cap; the guard fires on the declared read.
    const huge = new Uint8Array(129 * 1024 * 1024);
    const world = cfPackWorld({ members: [] });
    const instanceDir = await tmp("inst");
    // Re-register the pack project with an oversized "zip".
    world.http.add({
      modId: 715572,
      slug: "test-cf-pack",
      classId: 4471,
      files: [
        {
          id: world.packFileId,
          fileName: "huge.zip",
          gameVersions: [CF_PACK_MC],
          bytes: huge,
        },
      ],
    });
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "pin", version: String(world.packFileId) },
      }),
    ).rejects.toBeInstanceOf(DecompressionBomb);
  }, 30_000);

  it("cannot shadow a file the instance declared — the instance always wins", async () => {
    const instanceDir = await tmp("inst");
    await mkdir(join(instanceDir, "config"), { recursive: true });
    await writeFile(join(instanceDir, "config", "tuning.toml"), "mine\n");
    const { lock } = await lockIt(
      {
        members: HONEST,
        overrides: [{ path: "config/tuning.toml", data: "pack-owns-this\n" }],
      },
      {
        instanceDir,
        manifest: {
          project: { name: "p", version: "1" },
          game: {
            minecraft: CF_PACK_MC,
            loader: CF_PACK_LOADER,
            from: "curseforge:715572@8323938",
          },
          items: [{ path: "./config/tuning.toml", kind: "config" }],
        },
      },
    );
    const tuning = lock.resolved.filter(
      (p) => p.placement.method === "link" && p.placement.target === "config/tuning.toml",
    );
    expect(tuning).toHaveLength(1);
    expect(tuning[0]?.fromBase).toBeUndefined();
  });
});
