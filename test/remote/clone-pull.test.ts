/**
 * Stage-7 gate — clone + content-addressed pull + fast-forward-on-divergence.
 *
 * These are the flagship remote-sync guarantees: a joiner clones a served
 * instance and builds it; a later `pull` transfers **only the objects a
 * package-level lock diff changed**; and when local history has diverged the
 * local commits are **preserved on a `local/<ts>` branch** while the pack is
 * fast-forwarded and `saves/` is left untouched.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Hash, type TrackedFile, VcObjectStore } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { bumpMod, makeInstance, modWorldOf, writeAndLock } from "../helpers/remote.js";

/**
 * LB-829 — the 40-item-pack test below builds a real pack, serves it from a
 * real remote, and content-addresses a pull against it; that's genuine I/O,
 * not incidental slowness, and it's the ONE test that has hit
 * `windows-latest · Node 22`'s 5000ms default on BOTH recent `main` runs:
 *   - "a 40-item pack, host bumps 1 mod → exactly 1 object transfers,
 *     the rest stay linked" — 5627ms (run b398187), 5096ms (run 8af2bbc).
 * `windows-latest · Node 20`, same two runs, whole-file total: 5087ms /
 * 5646ms — already brushing 5s even there, just distributed across 5 tests
 * instead of concentrated in one. A clean `windows-latest · Node 22` run one
 * PR earlier (LB-819, all six jobs green): 4208ms, faster than that run's
 * own Node 20 leg (6218ms) — this is Windows runner variance riding on a
 * margin that was already too thin, not a one-way Node 22 regression.
 * 20s is ~4x the clean baseline and ~3.5x the worst timeout observed so
 * far; don't halve it without re-measuring on windows-latest · Node 22.
 */
vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

async function sha(dir: string, rel: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await readFile(join(dir, rel)))
    .digest("hex");
}

async function modFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "mods"))).sort();
  } catch {
    return [];
  }
}

describe("clone + content-addressed pull", () => {
  it("a 40-item pack, host bumps 1 mod → exactly 1 object transfers, the rest stay linked", async () => {
    const fake = modWorldOf(40);
    const host = await makeInstance(fake, "host");
    const joiner = await makeInstance(fake, "joiner");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    const items = Array.from({ length: 40 }, (_, i) => `modrinth:mod${i}`);
    await writeAndLock(host, items);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("initial 40-mod pack");

    // Joiner clones + builds in place (re-fetching all 40 mods from source).
    const cloneResult = await joiner.anvil().clone(host.dir);
    expect(cloneResult.objects).toBe(40);
    expect((await modFiles(joiner.dir)).length).toBe(40);

    // Snapshot the 39 unchanged mods on the joiner before the pull.
    const unchanged = Array.from({ length: 39 }, (_, i) => `mods/mod${i + 1}-1.0.0.jar`);
    const before = new Map<string, string>();
    for (const rel of unchanged) {
      before.set(rel, await sha(joiner.dir, rel));
    }

    // Host bumps exactly one mod, rebuilds, commits.
    bumpMod(fake, "mod0", "2.0.0");
    await writeAndLock(host, ["modrinth:mod0@2.0.0", ...items.slice(1)]);
    await hostAnvil.build();
    await hostAnvil.commit("bump mod0 → 2.0.0");

    // Joiner pulls: fast-forward + build. EXACTLY ONE object transfers.
    const pull = await joiner.anvil().pull();
    expect(pull.upToDate).toBe(false);
    expect(pull.fastForwarded).toBe(1);
    expect(pull.objects).toBe(1); // content-addressed: only the bumped mod moved

    // The 39 unchanged mods are byte-for-byte identical (stayed linked).
    for (const rel of unchanged) {
      expect(await sha(joiner.dir, rel)).toBe(before.get(rel));
    }
    // The bumped mod is now the new version; the old file is gone.
    const after = await modFiles(joiner.dir);
    expect(after).toContain("mod0-2.0.0.jar");
    expect(after).not.toContain("mod0-1.0.0.jar");
    expect(after.length).toBe(40);
  });

  it("pulling with nothing new is a no-op (up to date)", async () => {
    const fake = modWorldOf(3);
    const host = await makeInstance(fake, "host2");
    const joiner = await makeInstance(fake, "joiner2");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1", "modrinth:mod2"]);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("base");

    await joiner.anvil().clone(host.dir);
    const pull = await joiner.anvil().pull();
    expect(pull.upToDate).toBe(true);
    expect(pull.fastForwarded).toBe(0);
    expect(pull.objects).toBe(0);
  });
});

describe("fast-forward on divergence — local work is never discarded", () => {
  it("a joiner with a local commit pulls → local preserved on local/<ts>, pack FF'd, saves/ intact", async () => {
    const fake = modWorldOf(3);
    const host = await makeInstance(fake, "host3");
    const joiner = await makeInstance(fake, "joiner3");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1"]);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("base");

    // Joiner clones the base, then does its own local commit (adds mod2).
    await joiner.anvil().clone(host.dir);
    await writeAndLock(joiner, ["modrinth:mod0", "modrinth:mod1", "modrinth:mod2"]);
    const joinerAnvil = joiner.anvil();
    await joinerAnvil.build();
    await joinerAnvil.commit("local: add mod2");

    // The joiner has a world save that must survive the pull untouched.
    await mkdir(join(joiner.dir, "saves", "myworld"), { recursive: true });
    const savePath = join(joiner.dir, "saves", "myworld", "level.dat");
    await writeFile(savePath, "PRECIOUS-WORLD-BYTES");

    // Host advances on a DIVERGENT line (removes mod1).
    await writeAndLock(host, ["modrinth:mod0"]);
    await hostAnvil.build();
    await hostAnvil.commit("host: drop mod1");

    // Joiner pulls: histories diverged → local commit stashed, pack fast-forwarded.
    const pull = await joiner.anvil().pull();
    expect(pull.stashedTo).toBeDefined();
    expect(pull.stashedTo).toMatch(/^local\//);

    // The local commit is preserved on the stash branch.
    const stashLog = await joiner.anvil().log(pull.stashedTo);
    expect(stashLog.some((e) => e.message === "local: add mod2")).toBe(true);

    // The pack was fast-forwarded to the host tip (mod1 removed, mod2 gone).
    const mods = await modFiles(joiner.dir);
    expect(mods).toContain("mod0-1.0.0.jar");
    expect(mods).not.toContain("mod1-1.0.0.jar");
    expect(mods).not.toContain("mod2-1.0.0.jar");

    // saves/ is byte-for-byte intact.
    expect(await readFile(savePath, "utf8")).toBe("PRECIOUS-WORLD-BYTES");
  });
});

/**
 * LB-705: an undeclared working-tree file is part of the commit, so it has to
 * survive every transfer path. A blob that is walked for the snapshot but not for
 * the transfer produces a clone that either misses the file or dies on a missing
 * object — silent on the host, total on the joiner.
 */
describe("tracked working-tree files travel over a remote", () => {
  /** The tracked entry a commit records for `rel`. */
  async function trackedBlob(
    dir: string,
    commit: Hash,
    rel: string,
  ): Promise<TrackedFile | undefined> {
    const objects = new VcObjectStore({ anvilDir: join(dir, ".anvil") });
    const snap = await objects.getSnapshot((await objects.getCommit(commit)).snapshot);
    return snap.tracked.find((t) => t.path === rel);
  }

  it("a clone materializes the host's undeclared config, and a pull carries the edit", async () => {
    const fake = modWorldOf(2);
    const host = await makeInstance(fake, "trk-host");
    const joiner = await makeInstance(fake, "trk-joiner");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1"]);
    await mkdir(join(host.dir, "config"), { recursive: true });
    await writeFile(join(host.dir, "config", "server.toml"), "HOST-V1");
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    const c1 = await hostAnvil.commit("host: base + an undeclared config");

    await joiner.anvil().clone(host.dir);
    const joinerConfig = join(joiner.dir, "config", "server.toml");
    expect(await readFile(joinerConfig, "utf8")).toBe("HOST-V1");

    // The blob object itself transferred — not just bytes that happen to match.
    const entry = await trackedBlob(host.dir, c1.id, "config/server.toml");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    const joinerObjects = new VcObjectStore({ anvilDir: join(joiner.dir, ".anvil") });
    expect(await joinerObjects.has(entry.blob)).toBe(true);

    // The host edits the file only (no lock change) and commits; the joiner pulls.
    await writeFile(join(host.dir, "config", "server.toml"), "HOST-V2");
    await hostAnvil.commit("host: edit the config");
    const pull = await joiner.anvil().pull();
    expect(pull.upToDate).toBe(false);
    expect(pull.fastForwarded).toBe(1);
    expect(await readFile(joinerConfig, "utf8")).toBe("HOST-V2");
  });

  it("a push publishes the tracked blobs, so a clone from that remote finds them", async () => {
    const fake = modWorldOf(2);
    const host = await makeInstance(fake, "push-host");
    const joiner = await makeInstance(fake, "push-joiner");
    const remoteDir = await mkTmp("push-remote");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir, remoteDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1"]);
    await mkdir(join(host.dir, "config"), { recursive: true });
    await writeFile(join(host.dir, "config", "server.toml"), "PUSHED-BYTES");
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    const c1 = await hostAnvil.commit("host: base + an undeclared config");

    await hostAnvil.addRemote("dst", remoteDir);
    await hostAnvil.push("dst");

    // The tracked blob is published at the remote endpoint, under its own id.
    const entry = await trackedBlob(host.dir, c1.id, "config/server.toml");
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }
    const shard = entry.blob.value.slice(0, 2);
    expect(await readdir(join(remoteDir, ".anvil", "objects"))).toContain(shard);
    const published = await readFile(join(remoteDir, ".anvil", "objects", shard, entry.blob.value));
    expect(published.byteLength).toBeGreaterThan(0);

    // And a joiner cloning from that remote gets the file, not a missing object.
    await joiner.anvil().clone(remoteDir);
    expect(await readFile(join(joiner.dir, "config", "server.toml"), "utf8")).toBe("PUSHED-BYTES");
  });
});
