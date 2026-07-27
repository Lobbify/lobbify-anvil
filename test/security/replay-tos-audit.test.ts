/**
 * THE ToS / replay adversarial audit (Stage 6, highest-priority gate).
 *
 * Proves — by runtime behavior, a code-path trace, and a source grep — that a
 * CurseForge (`provenance: "replay"`) jar's bytes can never reach a shared /
 * pushable / exported location, and that the BYO key never leaks into the lock.
 * If a future change opens such a path, one of these assertions fails.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  CurseForgeSource,
  NetworkAcquirer,
  ReplayAcquirer,
  ReplayCache,
  UnsatisfiableTarget,
  VcObjectStore,
  WorktreeExclusion,
  buildInstance,
  collectRoots,
  currentPlatform,
  encodeObject,
  idOfEncoding,
  ReplayVeto,
  serializeLock,
  trackWorktree,
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

  it("the Stage-7 export / push / pull paths never enumerate the replay cache", async () => {
    // The transfer + export code physically cannot see a replay object: it reads
    // only the shared store and skips `provenance: "replay"` rows. Assert none of
    // the new surfaces references the replay cache at all, and that each explicitly
    // excludes replay rows.
    //
    // ⚠️ This is a SOURCE GREP, and it is necessary but not sufficient. It passed
    // for the entire time LB-722 was live, because the leak did not go through the
    // replay cache or through a lock row at all: a superseded CurseForge jar was
    // tracked as an ordinary undeclared working-tree file, and `push` shipped it as
    // a VC blob that carries no provenance. A grep proves this file cannot NAME the
    // cache; only the behavioral test below proves the bytes cannot travel. Add a
    // behavioral assertion whenever a new surface is added here.
    const exportSrc = await src("export/mrpack-export.ts");
    const syncSrc = await src("remote/sync.ts");
    const transferSrc = await src("remote/transfer.ts");
    for (const text of [exportSrc, syncSrc, transferSrc]) {
      expect(text).not.toMatch(/replay-cache/i);
      expect(text).not.toMatch(/ReplayCache/);
      expect(text).not.toMatch(/replayCache/);
    }
    // export omits replay; push/transfer skip replay rows before any byte moves.
    expect(exportSrc).toMatch(/provenance === "replay"/);
    expect(syncSrc).toMatch(/provenance === "replay"/);
    expect(transferSrc).toMatch(/provenance !== "copy"/);
  });

  it("BEHAVIORAL: a replay jar at a path no lock owns is never admitted as a VC blob", async () => {
    // The counterpart to the grep above, and the assertion LB-722 needed. It does
    // not build: it puts CurseForge bytes in the replay cache the way a build
    // would, then leaves a copy of those exact bytes at a path the lock does not
    // name — which is what a version bump, a lost built-lock ref, or an
    // `.anvilignore` line over `mods/` each leave behind. The bytes must not reach
    // the VC object store, and therefore cannot reach a push.
    const instanceDir = await mkTmp("audit-strand");
    const storeDir = await mkTmp("audit-strand-store");
    dirs.push(instanceDir, storeDir);

    const cfBytes = fabricJar("jei");
    const pin = { algo: "sha256" as const, value: sha256hex(cfBytes) };
    await new ReplayCache({ instanceDir }).putBuffer(cfBytes, pin);

    // Superseded: the jar is on disk under its old name, owned by nothing.
    await mkdir(join(instanceDir, "mods"), { recursive: true });
    await writeFile(join(instanceDir, "mods", "jei-OLD.jar"), Buffer.from(cfBytes));
    // …and one genuinely user-authored file, so an empty tracked set cannot pass.
    await writeFile(join(instanceDir, "options.txt"), "fov:70");

    const vcStore = new VcObjectStore({ anvilDir: join(instanceDir, ".anvil") });
    const tracked = await trackWorktree({
      instanceDir,
      vcStore,
      exclude: new WorktreeExclusion(),
      replayVeto: await ReplayVeto.load(instanceDir),
    });

    expect(tracked.map((t) => t.path)).toEqual(["options.txt"]);
    const blobId = idOfEncoding(encodeObject({ type: "blob", bytes: cfBytes }));
    expect(await vcStore.has(blobId)).toBe(false);
    // Nothing under `.anvil/objects/` is named after the CF content address either.
    expect(await allFileNames(join(instanceDir, ".anvil", "objects"))).not.toContain(pin.value);
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
