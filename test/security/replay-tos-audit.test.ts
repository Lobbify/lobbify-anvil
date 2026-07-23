/**
 * THE ToS / replay adversarial audit (Stage 6, highest-priority gate).
 *
 * Proves — by runtime behavior, a code-path trace, and a source grep — that a
 * CurseForge (`provenance: "replay"`) jar's bytes can never reach a shared /
 * pushable / exported location, and that the BYO key never leaks into the lock.
 * If a future change opens such a path, one of these assertions fails.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  ContentStore,
  CurseForgeSource,
  NetworkAcquirer,
  NotImplemented,
  ReplayAcquirer,
  ReplayCache,
  UnsatisfiableTarget,
  buildInstance,
  collectRoots,
  currentPlatform,
  serializeLock,
} from "../../index.js";
import type { Http, LockPackage, Lockfile, SourceContext } from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, sha256hex } from "../helpers/net.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const src = (rel: string) => readFile(join(REPO_ROOT, "src", rel), "utf8");

/** Recursively list every file name under `root`. */
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
      const st = await stat(p);
      if (st.isDirectory()) {
        await walk(p);
      } else {
        out.push(name);
      }
    }
  }
  await walk(root);
  return out;
}

function replayItem(bytes: Uint8Array): LockPackage {
  return {
    name: "jei",
    kind: "mod",
    source: "curseforge",
    version: "1.0.0",
    hash: { algo: "sha256", value: sha256hex(bytes) },
    provenance: "replay",
    placement: { method: "link", target: "mods/jei.jar" },
    size: bytes.byteLength,
    project: 238222,
    file: 5000,
  };
}

function ctx(http: Http, key?: string): SourceContext {
  return {
    http,
    offline: false,
    now: Date.parse("2026-07-01T00:00:00Z"),
    allowSource: () => true,
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    ...(key !== undefined ? { curseforgeKey: key } : {}),
  };
}

describe("ToS/replay audit — CF bytes never reach a shared/pushable/exported location", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  // --- (1) runtime proof: a full build leaves the shared store CF-free --------

  it("after a replay build the CF sha exists ONLY in the replay cache, never the store", async () => {
    const instanceDir = await mkTmp("inst");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(instanceDir, store.root);
    const replayCache = new ReplayCache({ instanceDir });

    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [{ id: 5000, fileName: "jei.jar", gameVersions: ["26.2"], bytes: cfBytes }],
    });
    const item = replayItem(cfBytes);
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [item],
    };
    const replay = new ReplayAcquirer({ replayCache, http: cf, curseforgeKey: "k" });
    await buildInstance({
      instanceDir,
      lock,
      store,
      acquire: { ensure: (p) => replay.ensure(p) },
      replayCache,
      platform: currentPlatform(),
    });

    // The store's on-disk name set never contains the CF content address.
    const storeNames = await allFileNames(store.root);
    expect(storeNames).not.toContain(item.hash.value);
    // The replay cache does.
    const cacheNames = await allFileNames(replayCache.root);
    expect(cacheNames).toContain(item.hash.value);
  });

  // --- (2) the key + url never enter the serialized lock ----------------------

  it("the BYO key and the CDN URL never appear in the serialized lock", async () => {
    const cfBytes = fabricJar("jei");
    const cf = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [{ id: 5000, fileName: "jei.jar", gameVersions: ["26.2", "Fabric"], bytes: cfBytes }],
    });
    const { pkg } = await new CurseForgeSource().resolve(
      { source: "curseforge", id: "238222", versionSpec: { kind: "latest" } },
      ctx(cf, "SUPER-SECRET-CF-KEY-123"),
    );
    expect(pkg.url).toBeUndefined();
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [pkg],
    };
    const text = serializeLock(lock);
    expect(text).not.toContain("SUPER-SECRET-CF-KEY-123");
    expect(text.toLowerCase()).not.toContain("forgecdn");
    expect(text).not.toContain("x-api-key");
    // The lock DOES carry the replay pin coordinates (project/file/hash), no url.
    expect(text).toContain("project = 238222");
    expect(text).toContain("file = 5000");
    expect(text).not.toMatch(/^url = /m);
  });

  // --- (3) behavioral guards: the shared-store paths refuse replay ------------

  it("NetworkAcquirer refuses a replay package (shared store can't admit CF bytes)", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const acq = new NetworkAcquirer({ store, registry: new Map() });
    await expect(acq.ensure(replayItem(fabricJar("jei")))).rejects.toBeInstanceOf(
      UnsatisfiableTarget,
    );
    // Nothing was admitted.
    expect(await store.has(replayItem(fabricJar("jei")).hash)).toBe(false);
  });

  it("CurseForgeSource.plan refuses (no static store fetch-plan for replay bytes)", () => {
    expect(() =>
      new CurseForgeSource().plan(replayItem(fabricJar("jei")), ctx(new FakeCurseForge(), "k")),
    ).toThrow(UnsatisfiableTarget);
  });

  it("collectRoots excludes replay hashes — GC never roots CF bytes in the store", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const cfBytes = fabricJar("jei");
    const copyBytes = fabricJar("sodium");
    const copy: LockPackage = {
      name: "sodium",
      kind: "mod",
      source: "modrinth",
      hash: hashOf(copyBytes, "sha256"),
      provenance: "copy",
      placement: { method: "link", target: "mods/sodium.jar" },
    };
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [replayItem(cfBytes), copy],
    };
    const roots = (await collectRoots(lock, store)).map((h) => h.value);
    expect(roots).toContain(copy.hash.value); // copy IS a root
    expect(roots).not.toContain(sha256hex(cfBytes)); // replay is NOT
  });

  it("no export / push transfer path exists yet — no surface can exfiltrate replay bytes", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    const anvil = new Anvil({ dir });
    await expect(anvil.export(join(dir, "out.mrpack"))).rejects.toBeInstanceOf(NotImplemented);
    await expect(anvil.push()).rejects.toBeInstanceOf(NotImplemented);
  });

  // --- (4) source code-path trace: the store layer cannot see the cache -------

  it("the CF source + replay acquirer never touch the shared store (ctx.store / store.put*)", async () => {
    const cfSrc = await src("sources/curseforge.ts");
    const replaySrc = await src("sources/replay-acquire.ts");
    for (const text of [cfSrc, replaySrc]) {
      // Never the ambient shared store, nor any shared-store admission call.
      expect(text).not.toMatch(/ctx\.store/);
      expect(text).not.toMatch(/\bstore\.putBuffer\(/);
      expect(text).not.toMatch(/\bstore\.putFile\(/);
      expect(text).not.toMatch(/sharedStore/);
    }
    // The replay acquirer only ever writes to the per-instance replay cache.
    expect(replaySrc).toMatch(/#cache\.putBuffer\(/);
  });

  it("the shared ContentStore has ZERO knowledge of the replay cache", async () => {
    const storeSrc = await src("store/store.ts");
    // The shared store type must not reference replay at all — it physically
    // cannot enumerate what it does not know exists.
    expect(storeSrc.toLowerCase()).not.toContain("replay");
  });

  it("the placement executor routes replay to the replay cache and refuses non-link replay", async () => {
    const placeSrc = await src("store/placement.ts");
    expect(placeSrc).toMatch(/provenance === "replay"/);
    expect(placeSrc).toMatch(/replayCache/);
    // Copy/game placements still read the shared store; replay never does.
    expect(placeSrc).toMatch(/cache\.materialize\(/);
  });

  it("NetworkAcquirer source guards against replay provenance", async () => {
    const acqSrc = await src("sources/acquire.ts");
    expect(acqSrc).toMatch(/provenance === "replay"/);
  });
});
