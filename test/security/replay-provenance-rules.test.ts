/**
 * LB-722, part 2 — the admission RULE, as opposed to the end-to-end leak.
 *
 * `replay-provenance-tracking.test.ts` proves a stranded CurseForge jar cannot
 * reach a remote. This file pins the shape of the rule that stops it, which is
 * where the fix can go wrong in the other direction:
 *
 *   - a path-keyed veto that never expires silently swallows the user's own file;
 *   - the >=8 MiB streaming branch is a second implementation of the same check;
 *   - the sha1 pin domain is half the replay surface and is easy to assert only
 *     in prose;
 *   - the ledger has to fail loudly when it cannot be read, and must claim replay
 *     rows only.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  ReplayCache,
  ReplayVeto,
  VcObjectStore,
  WorktreeExclusion,
  encodeObject,
  idOfEncoding,
  parseRef,
  readManifest,
  readReplayPaths,
  recordReplayPaths,
  replayTargetsOf,
  resolveManifest,
  trackWorktree,
  writeLock,
  writeManifest,
} from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const CF_KEY = "TEST-CF-KEY";
const CF_PROJECT = 238222;

const OLD_BYTES = fabricJar("jei-1.19.2");
const NEW_BYTES = fabricJar("jei-1.20.1");
const OLD_FILE = 5000;
const NEW_FILE = 6000;
const OLD_TARGET = "mods/jei-1.19.2.jar";
const NEW_TARGET = "mods/jei-1.20.1.jar";

function blobIdOf(bytes: Uint8Array): Hash {
  return idOfEncoding(encodeObject({ type: "blob", bytes }));
}

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

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

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

function cfWorld(): FakeCurseForge {
  return new FakeCurseForge().add({
    modId: CF_PROJECT,
    slug: "jei",
    classId: 6,
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

interface CfInstance {
  readonly dir: string;
  readonly store: ContentStore;
  readonly anvil: Anvil;
  readonly vcStore: VcObjectStore;
}

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
  return {
    dir,
    store: new ContentStore({ root: storeDir }),
    anvil: new Anvil({ dir, storeDir, allowSource: () => true, curseforgeKey: CF_KEY }, env),
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

async function lockFor(inst: CfInstance, cf: FakeCurseForge, fileId: number): Promise<void> {
  await writeManifest(inst.dir, cfManifest(fileId));
  const disk = await readManifest(inst.dir);
  await writeLock(
    inst.dir,
    await resolveManifest({
      manifest: disk,
      registry: registryWith({ curseforge: cf }),
      allowSource: () => true,
      now: NOW,
      baseDir: inst.dir,
      store: inst.store,
      curseforgeKey: CF_KEY,
    }),
  );
}

async function trackedOf(inst: CfInstance, commit: CommitRef): Promise<string[]> {
  const c = await inst.vcStore.getCommit(commit.id);
  return (await inst.vcStore.getSnapshot(c.snapshot)).tracked.map((t) => t.path);
}

function collectWarnings(anvil: Anvil): string[] {
  const out: string[] = [];
  anvil.progress.on((e) => {
    if (e.type === "warning") {
      out.push(e.message);
    }
  });
  return out;
}

describe("LB-722 — the ledger must not swallow the user's own file", () => {
  it("GATE no-forever-exclusion: a hand-built jar at a claimed path IS committed", async () => {
    // The regression this pins. The ledger is union-only and never pruned, so an
    // unconditional path veto excluded whatever file later occupied a path a
    // CurseForge item once used: silently, forever, with no way to list or clear
    // it. `mods/<popular-mod>.jar` is exactly the name a user re-creates by hand
    // following CurseForge's own "download it yourself" workflow.
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-userfile");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();
    expect(await readReplayPaths(inst.dir)).toContain(OLD_TARGET);
    await inst.anvil.commit("c0: baseline"); // something for `status` to differ from

    // Drop the item, rebuild, then put the user's OWN jar at that exact path.
    await lockFor(inst, cf, NEW_FILE);
    await inst.anvil.build();
    await rm(join(inst.dir, OLD_TARGET), { force: true });
    await put(join(inst.dir, OLD_TARGET), "MY-OWN-HAND-BUILT-JAR");

    // Still claimed by the ledger, but the bytes are demonstrably not replay
    // bytes: the replay cache has never seen them.
    expect(await readReplayPaths(inst.dir)).toContain(OLD_TARGET);
    expect((await inst.anvil.status()).worktreeDirty).toBe(true);

    const c1 = await inst.anvil.commit("c1: my own jar");
    expect(await trackedOf(inst, c1)).toContain(OLD_TARGET);
    expect((await inst.anvil.status()).worktreeDirty).toBe(false);

    // ...and it round-trips through a switch like any other tracked file.
    await rm(join(inst.dir, OLD_TARGET));
    await inst.anvil.commit("c2: delete it");
    await inst.anvil.switch(c1.id.value);
    expect(await readFile(join(inst.dir, OLD_TARGET), "utf8")).toBe("MY-OWN-HAND-BUILT-JAR");
  });

  it("GATE degraded-warns: with no replay cache a claimed path vetoes AND warns", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-degraded");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();
    // Bump so no lock names the old path any more, then take the cache away: the
    // bytes there can no longer be identified, and only the ledger can answer.
    await rm(join(inst.dir, ".anvil", "refs", "built"));
    await lockFor(inst, cf, NEW_FILE);
    await inst.anvil.build();
    await rm(join(inst.dir, ".anvil", "replay-cache"), { recursive: true });
    await rm(join(inst.dir, OLD_TARGET), { force: true });
    await put(join(inst.dir, OLD_TARGET), "COULD-BE-ANYTHING");

    const warnings = collectWarnings(inst.anvil);
    const c1 = await inst.anvil.commit("c1: cache gone");
    expect(await trackedOf(inst, c1)).not.toContain(OLD_TARGET);
    // Fail safe, but never silently: the refusal names the path and says why.
    expect(warnings.some((w) => w.includes(OLD_TARGET))).toBe(true);
    expect(warnings.some((w) => w.includes("replay cache is missing"))).toBe(true);
  });

  it("GATE build-warns-degraded: a build with a ledger and no cache says so", async () => {
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-buildwarn");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();
    await rm(join(inst.dir, ".anvil", "replay-cache"), { recursive: true });

    const warnings = collectWarnings(inst.anvil);
    await inst.anvil.build();
    // The one state nothing can detect after the fact (cache gone AND the jar
    // renamed) is announced here, where the missing cache still is detectable.
    expect(warnings.some((w) => w.includes("no replay cache"))).toBe(true);
  });
});

describe("LB-722 — the >=8 MiB streaming branch", () => {
  // `trackOne` splits at STREAM_THRESHOLD_BYTES: under it the bytes are read into
  // memory, at or over it they are streamed and the digests fold into the same
  // chunk loop. Real CurseForge jars sit on both sides of 8 MiB, and the streamed
  // half had no coverage at all.
  //
  // The three sizes bracket the boundary, but note what they can and cannot pin.
  // Which SIDE of the comparison an exactly-8 MiB file falls on is not observable:
  // both branches produce the same blob id, compute the same content digests, and
  // run the same veto before any `putBlob`. They differ only in whether the file
  // is held in memory. So flipping `>=` to `>` leaves the whole suite green, and
  // that is correct rather than a coverage hole — it is an equivalent mutation,
  // and asserting otherwise would mean asserting an implementation detail. What
  // matters is that the streaming branch is genuinely exercised, which the
  // over-the-threshold case does under either spelling.
  const MIB8 = 8 * 1024 * 1024;

  /** Deterministic pseudo-random bytes. A constant buffer would compress to
   * nothing and would not exercise the chunked read the way a real jar does. */
  function bigBytes(size: number, seed: number): Uint8Array {
    const out = new Uint8Array(size);
    let x = seed >>> 0;
    for (let i = 0; i < size; i += 1) {
      x = (x * 1664525 + 1013904223) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  }

  const cases: readonly (readonly [string, number])[] = [
    ["just under the threshold", MIB8 - 1],
    ["exactly at the threshold", MIB8],
    ["just over the threshold", MIB8 + 1],
  ];

  for (const [label, size] of cases) {
    it(`GATE stream-veto (${label}): cached replay bytes are never admitted`, async () => {
      const dir = await mkTmp("lb722-stream");
      dirs.push(dir);
      const bytes = bigBytes(size, size);
      await new ReplayCache({ instanceDir: dir }).putBuffer(bytes, hashOf(bytes, "sha256"));

      // At a path no lock and no ledger has ever named: the content check alone.
      await mkdir(join(dir, "mods"), { recursive: true });
      await writeFile(join(dir, "mods", "big-renamed.jar"), Buffer.from(bytes));
      await put(join(dir, "options.txt"), "fov:70");

      const vcStore = new VcObjectStore({ anvilDir: join(dir, ".anvil") });
      const tracked = await trackWorktree({
        instanceDir: dir,
        vcStore,
        exclude: new WorktreeExclusion(),
        store: true,
        replayVeto: await ReplayVeto.load(dir),
      });

      expect(tracked.map((t) => t.path)).toEqual(["options.txt"]);
      // The object-store assertion is the one that catches a veto placed AFTER
      // the write: dropping the entry from the tracked list while the bytes sit
      // in `.anvil/objects/` is not the property being protected.
      expect(await vcStore.has(blobIdOf(bytes))).toBe(false);
      expect(await allFileNames(join(dir, ".anvil", "objects"))).not.toContain(
        blobIdOf(bytes).value,
      );
    });
  }
});

describe("LB-722 — the sha1 pin domain, checked by content", () => {
  it("GATE sha1-content-veto-alone: a RENAMED sha1-pinned jar is refused", async () => {
    // The build-driven sha1 gate passes even with sha1 removed from the pin
    // algorithms, because the ledger also claims that path. Renaming the jar puts
    // it out of the ledger's reach, leaving the sha1 content check as the only
    // thing that can refuse it.
    const dir = await mkTmp("lb722-sha1-content");
    dirs.push(dir);
    await new ReplayCache({ instanceDir: dir }).putBuffer(OLD_BYTES, hashOf(OLD_BYTES, "sha1"));

    await mkdir(join(dir, "mods"), { recursive: true });
    await writeFile(join(dir, "mods", "renamed-by-the-user.jar"), Buffer.from(OLD_BYTES));
    await put(join(dir, "config", "foo.toml"), "level = 1");

    const vcStore = new VcObjectStore({ anvilDir: join(dir, ".anvil") });
    const tracked = await trackWorktree({
      instanceDir: dir,
      vcStore,
      exclude: new WorktreeExclusion(),
      store: true,
      replayVeto: await ReplayVeto.load(dir),
    });

    expect(tracked.map((t) => t.path)).toEqual(["config/foo.toml"]);
    expect(await vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
  });
});

describe("LB-722 — the replay-path ledger itself", () => {
  it("claims replay placement targets only, never a copy row's", async () => {
    const dir = await mkTmp("lb722-ledger-rows");
    dirs.push(dir);
    const copy: LockPackage = {
      name: "sodium",
      kind: "mod",
      source: "modrinth",
      hash: hashOf(NEW_BYTES, "sha256"),
      provenance: "copy",
      placement: { method: "link", target: "mods/sodium.jar" },
    };
    const replay: LockPackage = {
      name: "jei",
      kind: "mod",
      source: "curseforge",
      hash: hashOf(OLD_BYTES, "sha256"),
      provenance: "replay",
      placement: { method: "link", target: OLD_TARGET },
      project: CF_PROJECT,
      file: OLD_FILE,
    };
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(new Uint8Array([1]), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [copy, replay],
    };
    expect([...replayTargetsOf([lock])]).toEqual([OLD_TARGET]);

    await recordReplayPaths(dir, [lock]);
    const claimed = await readReplayPaths(dir);
    expect(claimed).toContain(OLD_TARGET);
    // A ledger that claimed every placement target would put the whole game
    // install and every mod one missing cache away from being un-committable.
    expect(claimed).not.toContain("mods/sodium.jar");
    expect(claimed.size).toBe(1);
  });

  it("GATE ledger-read-fails-loud: a ledger that cannot be read is never an empty one", async () => {
    const dir = await mkTmp("lb722-ledger-eio");
    dirs.push(dir);
    // A directory where the file belongs: `readFile` gives EISDIR, which is not
    // ENOENT. Degrading that to "nothing is claimed" turns the protection off
    // with no trace, which is the whole reason only ENOENT is tolerated.
    await mkdir(join(dir, ".anvil", "refs", "replay-paths"), { recursive: true });
    await expect(readReplayPaths(dir)).rejects.toThrow();
  });

  it("GATE ledger-union: the PREVIOUS built lock is claimed, not just the current one", async () => {
    // The first build after upgrading from a version with no ledger: the current
    // lock names the new jar, and only `previousLock` still names the old one. A
    // pipeline recording `[effectiveLock]` alone would claim nothing for it.
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-union");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();

    // Simulate the upgrade: the built ref survives, the ledger does not exist yet.
    await rm(join(inst.dir, ".anvil", "refs", "replay-paths"));
    expect((await readReplayPaths(inst.dir)).size).toBe(0);

    await lockFor(inst, cf, NEW_FILE);
    await inst.anvil.build();
    const claimed = await readReplayPaths(inst.dir);
    expect(claimed).toContain(NEW_TARGET); // from the current lock
    expect(claimed).toContain(OLD_TARGET); // from the built lock alone
  });

  it("survives a restart: the ledger is fsynced before the rename", async () => {
    // Not observable as durability in a test, but the file must at least exist,
    // be non-empty and parse after the call returns — the failure this guards is
    // a zero-length ledger reading as "nothing claimed".
    const dir = await mkTmp("lb722-ledger-durable");
    dirs.push(dir);
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: hashOf(new Uint8Array([1]), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [
        {
          name: "jei",
          kind: "mod",
          source: "curseforge",
          hash: hashOf(OLD_BYTES, "sha256"),
          provenance: "replay",
          placement: { method: "link", target: OLD_TARGET },
          project: CF_PROJECT,
          file: OLD_FILE,
        },
      ],
    };
    await recordReplayPaths(dir, [lock]);
    const text = await readFile(join(dir, ".anvil", "refs", "replay-paths"), "utf8");
    expect(text.trim()).toBe(OLD_TARGET);
    // No temp file is left behind for anything to trip over.
    expect(await allFileNames(join(dir, ".anvil", "refs"))).toEqual(["replay-paths"]);
  });
});

describe("LB-722 — status and commit reach the same verdict", () => {
  it("GATE status-agrees: a stranded jar leaves the tree clean, not permanently dirty", async () => {
    // If `status` counted the stranded jar as a candidate and `commit` refused it,
    // the tree would report dirty forever and `switch` would refuse over a file no
    // commit can ever record.
    const cf = cfWorld();
    const inst = await makeInstance(cf, "lb722-status");
    await lockFor(inst, cf, OLD_FILE);
    await inst.anvil.build();
    await rm(join(inst.dir, ".anvil", "refs", "built"));
    await lockFor(inst, cf, NEW_FILE);
    await inst.anvil.build();
    expect(await readFile(join(inst.dir, OLD_TARGET))).toBeDefined();
    await inst.anvil.commit("c1: baseline");

    expect((await inst.anvil.status()).worktreeDirty).toBe(false);
    // A real change still registers, so "clean" is not a stuck answer.
    await put(join(inst.dir, "config", "foo.toml"), "level = 1");
    expect((await inst.anvil.status()).worktreeDirty).toBe(true);
    await inst.anvil.commit("c2: a config");
    expect((await inst.anvil.status()).worktreeDirty).toBe(false);
  });
});
