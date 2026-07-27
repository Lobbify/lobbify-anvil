/**
 * LB-722 gate — a **superseded** CurseForge jar can never enter version control.
 *
 * The replay boundary was enforced on lock rows: the shared store, GC, transfer
 * and export code all skip `provenance: "replay"` packages. Tracked working-tree
 * files broke that. A replay item materializes as an ordinary file in `mods/`,
 * and the moment no lock names its path any more — a version bump renamed it, or
 * the built-lock ref was lost, or `.anvilignore` made the swap skip the removal —
 * it reads as an undeclared file. The walk then admitted its bytes as a VC blob
 * carrying no provenance and no content hash, and `push` shipped it.
 *
 * These tests drive the real `Anvil` end to end: resolve → build → bump → strand
 * → commit → push. Two mechanisms refuse the bytes and each is exercised **on its
 * own**, because a test that passes because both fired proves neither works:
 *
 *   - the recorded replay-path ledger, with the replay cache deleted;
 *   - the content check, at a path the ledger has never seen.
 *
 * Both hash domains are covered. A directly-referenced `curseforge:` item pins
 * sha256; a CurseForge base-pack member pins sha1, because the pack names only
 * `(projectID, fileID)` and sha1 is the strongest hash the API attests. Checking
 * one domain tests half the replay surface.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  type CommitRef,
  ContentStore,
  type Hash,
  type LockPackage,
  type Lockfile,
  type Manifest,
  Refs,
  RemoteError,
  ReplayCache,
  type SnapshotObject,
  VcObjectStore,
  canonicalJson,
  comparePackages,
  encodeObject,
  hashBuffer,
  idOfEncoding,
  parseRef,
  readManifest,
  readReplayPaths,
  recordReplayPaths,
  resolveManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { materializeSnapshot } from "../../src/vc/snapshot.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const CF_KEY = "TEST-CF-KEY";
const CF_PROJECT = 238222;
const CF_MOD_CLASS = 6;

/** The two versions of the same CurseForge mod: a bump renames the jar. */
const OLD_BYTES = fabricJar("jei-1.19.2");
const NEW_BYTES = fabricJar("jei-1.20.1");
const OLD_FILE = 5000;
const NEW_FILE = 6000;
const OLD_TARGET = "mods/jei-1.19.2.jar";
const NEW_TARGET = "mods/jei-1.20.1.jar";

/** The VC blob id a file's bytes would be admitted under. */
function blobIdOf(bytes: Uint8Array): Hash {
  return idOfEncoding(encodeObject({ type: "blob", bytes }));
}

/** Write a file, creating its parent directories. */
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** Every file NAME under `root`, recursively (object stores are hash-named). */
async function allFileNames(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else {
        out.push(entry.name);
      }
    }
  };
  await walk(root);
  return out;
}

interface CfInstance {
  readonly dir: string;
  readonly storeDir: string;
  readonly store: ContentStore;
  readonly anvil: Anvil;
  readonly vcStore: VcObjectStore;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

/** A CurseForge world publishing both versions of the mod under one project. */
function cfWorld(): FakeCurseForge {
  return new FakeCurseForge().add({
    modId: CF_PROJECT,
    slug: "jei",
    classId: CF_MOD_CLASS,
    files: [
      {
        id: OLD_FILE,
        fileName: "jei-1.19.2.jar",
        gameVersions: ["26.2", "Fabric"],
        bytes: OLD_BYTES,
      },
      {
        id: NEW_FILE,
        fileName: "jei-1.20.1.jar",
        gameVersions: ["26.2", "Fabric"],
        bytes: NEW_BYTES,
      },
    ],
  });
}

/** A real `Anvil` over temp dirs, wired to a fake CurseForge and a BYO key. */
async function makeInstance(cf: FakeCurseForge, label: string): Promise<CfInstance> {
  const dir = await mkTmp(label);
  const storeDir = await mkTmp(`${label}-store`);
  dirs.push(dir, storeDir);
  const env: AnvilEnv = {
    registry: () => registryWith({ curseforge: cf }),
    now: () => NOW,
    author: "tester",
    resolveHost: async () => ["93.184.216.34"],
  };
  const anvil = new Anvil({ dir, storeDir, allowSource: () => true, curseforgeKey: CF_KEY }, env);
  return {
    dir,
    storeDir,
    store: new ContentStore({ root: storeDir }),
    anvil,
    vcStore: new VcObjectStore({ anvilDir: join(dir, ".anvil") }),
  };
}

function cfManifest(fileId: number): Manifest {
  return {
    project: { name: "cf-pack", version: "1.0.0" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [{ ref: parseRef(`curseforge:${CF_PROJECT}@${fileId}`) }],
  };
}

/** Write `anvil.toml` for one pinned CurseForge file and resolve `anvil.lock`. */
async function lockFor(inst: CfInstance, cf: FakeCurseForge, fileId: number): Promise<Lockfile> {
  await writeManifest(inst.dir, cfManifest(fileId));
  const disk = await readManifest(inst.dir);
  const lock = await resolveManifest({
    manifest: disk,
    registry: registryWith({ curseforge: cf }),
    allowSource: () => true,
    now: NOW,
    baseDir: inst.dir,
    store: inst.store,
    curseforgeKey: CF_KEY,
  });
  await writeLock(inst.dir, lock);
  return lock;
}

/** How the bump leaves the old jar behind. Both are real, reported paths. */
type Strand = "anvilignore" | "no-built-ref";

/**
 * Install the old version, then bump to the new one in a way that strands the
 * old jar on disk with no lock naming its path.
 *
 *   - `anvilignore` — `.anvilignore` matches by top-level segment, so a line
 *     naming anything under `mods/` makes `journaledSwap` skip the removal.
 *   - `no-built-ref` — with no `.anvil/refs/built` there is no previous lock, so
 *     the delta computes no removals at all and both jars end up installed.
 */
async function strandOldJar(inst: CfInstance, cf: FakeCurseForge, strand: Strand): Promise<void> {
  await lockFor(inst, cf, OLD_FILE);
  await inst.anvil.build();
  expect(await pathExists(join(inst.dir, OLD_TARGET))).toBe(true);

  if (strand === "anvilignore") {
    await writeFile(join(inst.dir, ".anvilignore"), "mods/\n");
  } else {
    await rm(join(inst.dir, ".anvil", "refs", "built"));
  }
  await lockFor(inst, cf, NEW_FILE);
  await inst.anvil.build();

  // The old jar is still on disk and no lock names it any more — the exact state
  // the working-tree walk used to read as "an undeclared file the user dropped".
  expect(await pathExists(join(inst.dir, OLD_TARGET))).toBe(true);
  const lockText = await readFile(join(inst.dir, "anvil.lock"), "utf8");
  expect(lockText).not.toContain("jei-1.19.2.jar");
}

/** Push to a fresh directory remote and return every file name it received. */
async function pushAndList(inst: CfInstance, label: string): Promise<string[]> {
  const remoteDir = await mkTmp(label);
  dirs.push(remoteDir);
  await inst.anvil.addRemote("dst", remoteDir);
  await inst.anvil.push("dst");
  return allFileNames(remoteDir);
}

async function trackedOf(inst: CfInstance, commit: CommitRef): Promise<string[]> {
  const c = await inst.vcStore.getCommit(commit.id);
  return (await inst.vcStore.getSnapshot(c.snapshot)).tracked.map((t) => t.path);
}

describe("LB-722 — a stranded CurseForge jar never becomes a tracked file", () => {
  it("GATE cf-sha256: bump strands the old jar; it is untracked, unstored, and unpushed", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-sha256");
    await strandOldJar(inst, cf, "anvilignore");

    // A hand-edited config and a jar the user really did drop in: the feature
    // must refuse replay bytes, not stop tracking.
    await put(join(inst.dir, "config", "foo.toml"), "level = 1");
    await put(join(inst.dir, "mods", "handmade.jar"), "USER-BUILT-JAR");

    const commit = await inst.anvil.commit("c1: after the bump");
    const tracked = await trackedOf(inst, commit);

    expect(tracked).not.toContain(OLD_TARGET);
    expect(tracked).toEqual(["config/foo.toml", "mods/handmade.jar"]);

    // The bytes were never admitted — vetoing after `putBlob` would leave them
    // in `.anvil/objects/` and merely hide them from the tracked list.
    expect(await inst.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
    expect(await inst.vcStore.has(blobIdOf(NEW_BYTES))).toBe(false);

    const published = await pushAndList(inst, "lb722-sha256-remote");
    expect(published).not.toContain(blobIdOf(OLD_BYTES).value);
    expect(published).not.toContain(hashOf(OLD_BYTES, "sha256").value);
    // The push is not empty: the user's own jar did travel, so "nothing shipped"
    // cannot be what makes this pass.
    expect(published).toContain(blobIdOf(new Uint8Array(Buffer.from("USER-BUILT-JAR"))).value);
  });

  it("GATE cf-sha1: a base-pack member (sha1 pin) strands the same way and is refused", async () => {
    // A CurseForge base pack pins its members from catalogue metadata, so the pin
    // is sha1. The lock rows are hand-built to the exact shape `cf-base.ts`
    // emits — same source, same provenance, same single-file placement — because
    // what is under test is the hash domain, not the pack resolver.
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-sha1");

    const memberLock = (fileId: number, target: string, bytes: Uint8Array): Lockfile => {
      const manifest = cfManifest(fileId);
      const member: LockPackage = {
        name: "jei",
        kind: "mod",
        source: "curseforge",
        version: target,
        hash: hashOf(bytes, "sha1"),
        provenance: "replay",
        placement: { method: "link", target },
        size: bytes.byteLength,
        project: CF_PROJECT,
        file: fileId,
      };
      return {
        meta: {
          version: 1,
          manifestHash: hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256"),
          minecraft: "26.2",
          loader: "fabric 0.19.1",
          java: "j",
        },
        resolved: [member].sort(comparePackages),
      };
    };

    const writeBoth = async (fileId: number, target: string, bytes: Uint8Array): Promise<void> => {
      await writeManifest(inst.dir, cfManifest(fileId));
      const disk = await readManifest(inst.dir);
      const lock = memberLock(fileId, target, bytes);
      await writeLock(inst.dir, {
        ...lock,
        meta: {
          ...lock.meta,
          manifestHash: hashBuffer(new TextEncoder().encode(canonicalJson(disk)), "sha256"),
        },
      });
    };

    await writeBoth(OLD_FILE, OLD_TARGET, OLD_BYTES);
    await inst.anvil.build();
    // The sha1 pin really did drive the fetch: the cache holds it in that domain.
    expect(await new ReplayCache({ instanceDir: inst.dir }).has(hashOf(OLD_BYTES, "sha1"))).toBe(
      true,
    );

    await rm(join(inst.dir, ".anvil", "refs", "built"));
    await writeBoth(NEW_FILE, NEW_TARGET, NEW_BYTES);
    await inst.anvil.build();
    expect(await pathExists(join(inst.dir, OLD_TARGET))).toBe(true);
    expect(await pathExists(join(inst.dir, NEW_TARGET))).toBe(true);

    await put(join(inst.dir, "config", "foo.toml"), "level = 1");
    const commit = await inst.anvil.commit("c1: after the base bump");
    expect(await trackedOf(inst, commit)).toEqual(["config/foo.toml"]);
    expect(await inst.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);

    const published = await pushAndList(inst, "lb722-sha1-remote");
    expect(published).not.toContain(blobIdOf(OLD_BYTES).value);
    expect(published).not.toContain(hashOf(OLD_BYTES, "sha1").value);
  });

  it("GATE content-veto-alone: a stranded jar RENAMED to an unseen path is still refused", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-rename");
    await strandOldJar(inst, cf, "no-built-ref");

    // A path the ledger has never held. Only the content check can see this.
    const renamed = "mods/totally-innocent.jar";
    await rename(join(inst.dir, OLD_TARGET), join(inst.dir, renamed));
    expect(await readReplayPaths(inst.dir)).not.toContain(renamed);
    await put(join(inst.dir, "config", "foo.toml"), "level = 1");

    const tracked = await trackedOf(inst, await inst.anvil.commit("c1: renamed"));
    expect(tracked).not.toContain(renamed);
    expect(tracked).toEqual(["config/foo.toml"]);
    expect(await inst.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
  });

  it("GATE ledger-alone: with the replay cache deleted, a stranded jar is still refused", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-ledger");
    await strandOldJar(inst, cf, "no-built-ref");

    // Delete the cache, so the content check has nothing to compare against —
    // `ReplayByteGuard.active()` goes false and no content digest is computed.
    await rm(join(inst.dir, ".anvil", "replay-cache"), { recursive: true });
    expect(await readReplayPaths(inst.dir)).toContain(OLD_TARGET);
    await put(join(inst.dir, "config", "foo.toml"), "level = 1");

    const tracked = await trackedOf(inst, await inst.anvil.commit("c1: no cache"));
    expect(tracked).not.toContain(OLD_TARGET);
    expect(tracked).toEqual(["config/foo.toml"]);
    expect(await inst.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
  });

  it("GATE no-over-exclusion: ordinary undeclared files are still tracked, and restore", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-normal");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();

    await put(join(inst.dir, "config", "foo.toml"), "level = 1");
    await put(join(inst.dir, "mods", "handmade.jar"), "USER-BUILT-JAR");
    await put(join(inst.dir, "options.txt"), "fov:70");

    const c1 = await inst.anvil.commit("c1: user files");
    expect(await trackedOf(inst, c1)).toEqual([
      "config/foo.toml",
      "mods/handmade.jar",
      "options.txt",
    ]);
    // The declared replay item's own target is excluded because the lock owns it,
    // exactly as before — not because of anything added here.
    expect(await trackedOf(inst, c1)).not.toContain(OLD_TARGET);

    await rm(join(inst.dir, "mods", "handmade.jar"));
    const c2 = await inst.anvil.commit("c2: drop the hand-built jar");
    expect(await trackedOf(inst, c2)).not.toContain("mods/handmade.jar");
    await inst.anvil.switch(c1.id.value);
    expect(await readFile(join(inst.dir, "mods", "handmade.jar"), "utf8")).toBe("USER-BUILT-JAR");
  });
});

describe("LB-722 — inbound: a pulled commit cannot write replay bytes into the instance", () => {
  it("GATE inbound: materialize skips a tracked path the local ledger claims", async () => {
    const dir = await mkTmp("lb722-inbound");
    const storeDir = await mkTmp("lb722-inbound-store");
    dirs.push(dir, storeDir);
    const vcStore = new VcObjectStore({ anvilDir: join(dir, ".anvil") });
    const sharedStore = new ContentStore({ root: storeDir });

    // This machine has held CurseForge bytes at `mods/jei-1.19.2.jar`.
    const replayItem: LockPackage = {
      name: "jei",
      kind: "mod",
      source: "curseforge",
      hash: hashOf(OLD_BYTES, "sha256"),
      provenance: "replay",
      placement: { method: "link", target: OLD_TARGET },
      project: CF_PROJECT,
      file: OLD_FILE,
    };
    await recordReplayPaths(dir, [
      {
        meta: {
          version: 1,
          manifestHash: hashOf(new Uint8Array([1]), "sha256"),
          minecraft: "26.2",
          loader: "fabric 0.19.1",
          java: "j",
        },
        resolved: [replayItem],
      },
    ]);

    // A commit made elsewhere — before the admission guard, or by a client that
    // never had one — that tracks that path anyway.
    const empty = await vcStore.putBlob(new Uint8Array());
    const cfBlob = await vcStore.putBlob(OLD_BYTES);
    const ok = await vcStore.putBlob(new TextEncoder().encode("SAFE"));
    const snapshot: SnapshotObject = {
      type: "snapshot",
      manifest: empty,
      lock: empty,
      ignore: empty,
      carried: [],
      tracked: [
        { path: "config/ok.toml", blob: ok },
        { path: OLD_TARGET, blob: cfBlob },
      ],
    };

    await materializeSnapshot({ instanceDir: dir, snapshot, vcStore, sharedStore });

    // The CurseForge jar is not written into this joiner's mods/…
    expect(await pathExists(join(dir, OLD_TARGET))).toBe(false);
    // …and the rest of the commit materialized normally, so this is not a
    // materialize that simply did nothing.
    expect(await readFile(join(dir, "config", "ok.toml"), "utf8")).toBe("SAFE");
  });
});

describe("LB-722 — push refuses history that already tracks a replay path", () => {
  it("GATE push-backstop: a pre-existing poisoned commit cannot be published", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-backstop");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();

    // Commit an ordinary file first, so there is a real history to push.
    await put(join(inst.dir, "config", "foo.toml"), "level = 1");
    const tip = await inst.anvil.commit("c1: a config");

    // Forge the state the admission guard can no longer produce but older
    // anvils did: a snapshot whose tracked set names a claimed replay path. The
    // branch is moved onto it through the ref database directly, because no
    // supported code path can author such a commit any more.
    const commit = await inst.vcStore.getCommit(tip.id);
    const snap = await inst.vcStore.getSnapshot(commit.snapshot);
    const poisoned: SnapshotObject = {
      ...snap,
      tracked: [...snap.tracked, { path: OLD_TARGET, blob: await inst.vcStore.putBlob(OLD_BYTES) }],
    };
    const poisonedCommit = await inst.vcStore.put({
      ...commit,
      snapshot: await inst.vcStore.put(poisoned),
      message: "c2: poisoned by an older anvil",
      gen: commit.gen + 1,
      parents: [tip.id],
    });
    const refs = new Refs(join(inst.dir, ".anvil"));
    const branch = await refs.currentBranch();
    expect(branch).toBeDefined();
    await refs.writeRef(branch ?? "refs/heads/main", poisonedCommit);

    const remoteDir = await mkTmp("lb722-backstop-remote");
    dirs.push(remoteDir);
    await inst.anvil.addRemote("dst", remoteDir);
    await expect(inst.anvil.push("dst")).rejects.toBeInstanceOf(RemoteError);
    // It refuses loudly and names the path; it does not silently drop the blob
    // and publish a snapshot pointing at an object the remote does not have.
    await expect(inst.anvil.push("dst")).rejects.toThrow(OLD_TARGET);
    expect(await allFileNames(remoteDir)).not.toContain(blobIdOf(OLD_BYTES).value);
  });
});
