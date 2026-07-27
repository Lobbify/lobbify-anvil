/**
 * Working-tree tracking end to end (LB-705): `commit` records the undeclared
 * files, `status` reports the tree dirty until it does, `switch` restores and
 * removes them, and none of it ever touches `saves/`.
 *
 * The exclusion rules are unit-tested in `worktree-exclusion.test.ts`; this file
 * drives them through the real `Anvil` so a rule that is correct in isolation but
 * unwired still fails.
 */

import { lstat, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommitRef,
  ContentStore,
  type Manifest,
  PathEscape,
  type SnapshotObject,
  VcObjectStore,
  parseRef,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { materializeSnapshot } from "../../src/vc/snapshot.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
  ]);
}

function objectsOf(dir: string): VcObjectStore {
  return new VcObjectStore({ anvilDir: join(dir, ".anvil") });
}

async function snapshotOf(dir: string, commit: CommitRef): Promise<SnapshotObject> {
  const objects = objectsOf(dir);
  return objects.getSnapshot((await objects.getCommit(commit.id)).snapshot);
}

async function trackedPaths(dir: string, commit: CommitRef): Promise<string[]> {
  return (await snapshotOf(dir, commit)).tracked.map((t) => t.path);
}

async function snapshotIdOf(dir: string, commit: CommitRef): Promise<string> {
  return (await objectsOf(dir).getCommit(commit.id)).snapshot.value;
}

/** Write a file, creating its parent directories. */
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("vc worktree tracking: commit captures undeclared files", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE worktree-dirty: a hand-edited config reports dirty until it is committed", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    // Before the first commit there is nothing to be dirty against.
    expect((await anvil.status()).worktreeDirty).toBe(false);
    await anvil.commit("c1: baseline");
    expect((await anvil.status()).worktreeDirty).toBe(false);

    // A brand-new undeclared file dirties the tree...
    const config = join(fx.dir, "config", "mymod.toml");
    await put(config, "level = 1");
    expect((await anvil.status()).worktreeDirty).toBe(true);
    // ...and exactly one commit clears it.
    const c2 = await anvil.commit("c2: capture the config");
    expect((await anvil.status()).worktreeDirty).toBe(false);
    expect(await trackedPaths(fx.dir, c2)).toEqual(["config/mymod.toml"]);

    // Editing an already-tracked file is dirty too, not just adding one.
    await writeFile(config, "level = 2");
    expect((await anvil.status()).worktreeDirty).toBe(true);
    await anvil.commit("c3: bump the config");
    expect((await anvil.status()).worktreeDirty).toBe(false);

    // …and so is deleting one.
    await rm(config);
    expect((await anvil.status()).worktreeDirty).toBe(true);
  });

  it("switching to the prior commit brings the old bytes back", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    const config = join(fx.dir, "config", "mymod.toml");
    await put(config, "level = 1");
    const c1 = await anvil.commit("c1: level = 1");

    await writeFile(config, "level = 2");
    await anvil.commit("c2: level = 2");
    expect(await readFile(config, "utf8")).toBe("level = 2");

    await anvil.switch(c1.id.value);
    expect(await readFile(config, "utf8")).toBe("level = 1");
    // …and forward again, so this is a real restore and not a one-way revert.
    await anvil.switch("main");
    expect(await readFile(config, "utf8")).toBe("level = 2");
  });

  it("an undeclared jar dropped into mods/ lands in the commit and restores on checkout", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    const c1 = await anvil.commit("c1: no jar yet");

    const dropped = join(fx.dir, "mods", "dropped.jar");
    await put(dropped, "DROPPED-BYTES");
    const c2 = await anvil.commit("c2: drop a jar into mods/");
    expect(await trackedPaths(fx.dir, c2)).toEqual(["mods/dropped.jar"]);

    // Checking out the commit before it removes the jar…
    await anvil.switch(c1.id.value);
    expect(await pathExists(dropped)).toBe(false);
    // …and coming back restores its exact bytes.
    await anvil.switch("main");
    expect(await readFile(dropped, "utf8")).toBe("DROPPED-BYTES");
  });

  it("captures a deletion by absence — the snapshot id moves and the prior commit restores the file", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    const keep = join(fx.dir, "config", "keep.toml");
    await put(keep, "KEEP-ME");
    const c1 = await anvil.commit("c1: with keep.toml");
    expect(await trackedPaths(fx.dir, c1)).toEqual(["config/keep.toml"]);

    await rm(keep);
    const c2 = await anvil.commit("c2: delete keep.toml");
    // Absence IS the deletion: no tombstone, a different snapshot, a real commit.
    expect(await trackedPaths(fx.dir, c2)).toEqual([]);
    expect(await snapshotIdOf(fx.dir, c2)).not.toBe(await snapshotIdOf(fx.dir, c1));

    await anvil.switch(c1.id.value);
    expect(await readFile(keep, "utf8")).toBe("KEEP-ME");
    // Forward again re-applies the deletion.
    await anvil.switch("main");
    expect(await pathExists(keep)).toBe(false);
  });

  it("GATE saves-untouched: no commit, switch, or tracked deletion touches saves/ — bytes AND mtime", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    const level = join(fx.dir, "saves", "myworld", "level.dat");
    await put(level, "PRECIOUS-WORLD-BYTES");
    // Pin the mtime to a fixed instant in the past. A rewrite with identical bytes
    // would leave the content assertion happy and move this by seconds.
    const pinned = new Date("2026-01-02T03:04:05.000Z");
    await utimes(level, pinned, pinned);
    expect((await stat(level)).mtimeMs).toBe(pinned.getTime());

    const commits: CommitRef[] = [];
    const untouched = async (where: string): Promise<void> => {
      expect(await readFile(level, "utf8"), where).toBe("PRECIOUS-WORLD-BYTES");
      expect((await stat(level)).mtimeMs, where).toBe(pinned.getTime());
    };

    const config = join(fx.dir, "config", "mymod.toml");
    const dropped = join(fx.dir, "mods", "dropped.jar");

    commits.push(await anvil.commit("c1: baseline"));
    await untouched("after the baseline commit");

    await put(config, "level = 1");
    commits.push(await anvil.commit("c2: hand-edited config"));
    await untouched("after committing a hand-edited config");

    await writeFile(config, "level = 2");
    commits.push(await anvil.commit("c3: edit the config again"));
    await untouched("after committing an edit");

    await put(dropped, "DROPPED-BYTES");
    commits.push(await anvil.commit("c4: undeclared jar in mods/"));
    await untouched("after committing an undeclared jar");

    await rm(config);
    commits.push(await anvil.commit("c5: delete the config"));
    await untouched("after committing a deletion");

    const first = commits[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    await anvil.switch(first.id.value);
    await untouched("after switching back to the first commit");
    await anvil.switch("main");
    await untouched("after switching forward again");

    // The world file is not merely intact — it was never a candidate. Nothing
    // under saves/ appears in ANY commit's tracked set.
    for (const commit of commits) {
      const paths = await trackedPaths(fx.dir, commit);
      expect(paths.filter((p) => p.toLowerCase().startsWith("saves"))).toEqual([]);
    }
  });

  it("GATE tracked-prune: config/foo/bar (a file) can become config/foo (a file) across a switch", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    const deep = join(fx.dir, "config", "foo", "bar");
    const flat = join(fx.dir, "config", "foo");
    await put(deep, "DEEP");
    const a = await anvil.commit("A: config/foo/bar is a file");
    expect(await trackedPaths(fx.dir, a)).toEqual(["config/foo/bar"]);

    await rm(join(fx.dir, "config", "foo"), { recursive: true });
    await put(flat, "FLAT");
    const b = await anvil.commit("B: config/foo is a file");
    expect(await trackedPaths(fx.dir, b)).toEqual(["config/foo"]);

    // A → B is the load-bearing direction: without pruning the now-empty
    // `config/foo` DIRECTORY, writing the file at that path fails outright.
    await anvil.switch(a.id.value);
    expect(await readFile(deep, "utf8")).toBe("DEEP");
    expect((await lstat(flat)).isDirectory()).toBe(true);

    await anvil.switch("main");
    expect((await lstat(flat)).isFile()).toBe(true);
    expect(await readFile(flat, "utf8")).toBe("FLAT");
  });

  it("never tracks the game install or the runtime churn directories", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    for (const rel of [
      ["assets", "objects", "ab", "abcdef0123"],
      ["libraries", "org", "lwjgl", "lwjgl.jar"],
      ["versions", "26.2", "26.2.json"],
      ["natives", "liblwjgl.so"],
      ["runtime", "jre-21", "bin", "java"],
      ["logs", "latest.log"],
      ["crash-reports", "crash-2026.txt"],
      ["screenshots", "shot.png"],
      [".fabric", "remappedJars", "x.jar"],
      [".mixin.out", "class.class"],
      ["usercache.json"],
      ["realms_persistence.json"],
    ]) {
      await put(join(fx.dir, ...rel), `bytes of ${rel.join("/")}`);
    }
    // One ordinary undeclared file, so an empty tracked set cannot pass this test.
    await put(join(fx.dir, "options.txt"), "fov:70");

    const commit = await anvil.commit("c1: a full-looking instance");
    expect(await trackedPaths(fx.dir, commit)).toEqual(["options.txt"]);
  });

  it("skips the paths the lock says the build owns, but not their undeclared siblings", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const lock = await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    const declared = lock.resolved.find((p) => p.source === "modrinth")?.placement;
    expect(declared?.method).toBe("link");
    const target = declared?.method === "link" ? declared.target : undefined;
    expect(target).toBeDefined();
    if (target === undefined) {
      return;
    }

    // Stand in for what `anvil build` would have placed, plus an undeclared jar
    // sitting right next to it in the same directory.
    await put(join(fx.dir, target), "DECLARED-BYTES");
    await put(join(fx.dir, "mods", "dropped.jar"), "UNDECLARED-BYTES");

    const commit = await anvil.commit("c1: a built mods/ with one extra jar");
    expect(await trackedPaths(fx.dir, commit)).toEqual(["mods/dropped.jar"]);
  });

  it("GATE carried-vs-tracked: no path is ever in both sets", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    // A declared LOCAL item is carried; the file beside it is tracked.
    await writeFile(join(fx.dir, "patch.jar"), "LOCAL-BYTES");
    const localManifest: Manifest = {
      project: { name: "vc-pack", version: "1.0.0" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [{ ref: parseRef("modrinth:alpha") }, { ref: parseRef("./patch.jar") }],
    };
    await fx.writeLockFor(localManifest);
    await put(join(fx.dir, "config", "mymod.toml"), "level = 1");

    const commit = await anvil.commit("c1: a local item and a hand-edited config");
    const snap = await snapshotOf(fx.dir, commit);
    const carried = snap.carried.map((c) => c.path);
    const tracked = snap.tracked.map((t) => t.path);

    expect(carried).toEqual(["patch.jar"]);
    expect(tracked).toEqual(["config/mymod.toml"]);
    // The general invariant, not just this pair.
    expect(carried.filter((p) => tracked.includes(p))).toEqual([]);
  });

  it("honours .anvilexclude prefixes and basename globs, case-insensitively", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    await writeFile(join(fx.dir, ".anvilexclude"), "NOTES/\n*.BAK\n");
    await put(join(fx.dir, "notes", "todo.txt"), "scratch");
    await put(join(fx.dir, "config", "a.toml"), "keep me");
    await put(join(fx.dir, "config", "a.toml.bak"), "editor leftover");

    const commit = await anvil.commit("c1: with an exclude file");
    // `.anvilexclude` is itself tracked, so the rules travel with the commit.
    expect(await trackedPaths(fx.dir, commit)).toEqual([".anvilexclude", "config/a.toml"]);
  });

  it("GATE anvilignore-is-tracked: .anvilignore entries are recorded, not excluded", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    // The shipped `.anvilignore` template tells users to list exactly these. They
    // mean "the build must not touch this", which is the opposite of "do not
    // record this" — the files it names are the hand-edited ones tracking exists
    // to capture, so they MUST reach the commit.
    await writeFile(join(fx.dir, ".anvilignore"), "config/\noptions.txt\n");
    await put(join(fx.dir, "config", "x.toml"), "HAND-EDITED");
    await put(join(fx.dir, "options.txt"), "fov:70");

    const commit = await anvil.commit("c1: ignored-by-the-build files");
    // `.anvilignore` itself has its own snapshot slot, so it is not tracked twice.
    expect(await trackedPaths(fx.dir, commit)).toEqual(["config/x.toml", "options.txt"]);
  });

  it("does not delete a path the current .anvilexclude excludes, even when an older commit tracked it", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    const note = join(fx.dir, "notes", "todo.txt");
    await put(note, "SCRATCH");
    const a = await anvil.commit("A: notes/todo.txt tracked");
    expect(await trackedPaths(fx.dir, a)).toEqual(["notes/todo.txt"]);

    // The user decides notes/ is theirs alone and stops recording it.
    await writeFile(join(fx.dir, ".anvilexclude"), "notes/\n");
    const b = await anvil.commit("B: exclude notes/");
    expect(await trackedPaths(fx.dir, b)).toEqual([".anvilexclude"]);

    // Going back to A re-adopts the file (A tracked it)...
    await anvil.switch(a.id.value);
    expect(await readFile(note, "utf8")).toBe("SCRATCH");
    // ...and coming forward to B must NOT delete it. "Excluded" means version
    // control does not manage the path — in BOTH directions.
    await anvil.switch("main");
    expect(await pathExists(note)).toBe(true);
    expect(await readFile(note, "utf8")).toBe("SCRATCH");
  });

  it("does not track symlinks", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    await put(join(fx.dir, "config", "real.toml"), "REAL");
    await symlink(join(fx.dir, "config", "real.toml"), join(fx.dir, "alias.toml"));
    await symlink(join(fx.dir, "config"), join(fx.dir, "config-link"));

    const commit = await anvil.commit("c1: a file and two symlinks");
    // The real file is tracked (so this is not an empty-set pass); neither link is.
    expect(await trackedPaths(fx.dir, commit)).toEqual(["config/real.toml"]);
  });
});

/**
 * `safeJoin` runs on every tracked path, and it throws on a protected top. That
 * ordering is the point: `materializeSnapshot` calls it *before* consulting the
 * exclusion set, because `WorktreeExclusion` returns `true` for any protected top
 * and would otherwise `continue` past a snapshot naming `saves/level.dat` in
 * silence. `saves/` would still never be touched, but a malformed or hostile
 * history would be accepted without a word instead of rejected. An ordinarily
 * excluded path (`logs/`, `screenshots/`) still skips quietly — only a protected
 * top throws.
 */
describe("vc materialize: a tracked path can never escape the instance", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function scaffold(): Promise<{
    dir: string;
    vcStore: VcObjectStore;
    sharedStore: ContentStore;
    empty: SnapshotObject["manifest"];
    evil: SnapshotObject["manifest"];
  }> {
    const dir = await mkTmp("materialize-safety");
    const storeDir = await mkTmp("materialize-store");
    dirs.push(dir, storeDir);
    const vcStore = new VcObjectStore({ anvilDir: join(dir, ".anvil") });
    const sharedStore = new ContentStore({ root: storeDir });
    const empty = await vcStore.putBlob(new Uint8Array());
    const evil = await vcStore.putBlob(new TextEncoder().encode("EVIL-BYTES"));
    return { dir, vcStore, sharedStore, empty, evil };
  }

  it("GATE materialize-escape: a tracked ../escape throws PathEscape and writes nothing", async () => {
    const { dir, vcStore, sharedStore, empty, evil } = await scaffold();
    const snapshot: SnapshotObject = {
      type: "snapshot",
      manifest: empty,
      lock: empty,
      ignore: empty,
      carried: [],
      tracked: [{ path: "../escape", blob: evil }],
    };
    await expect(
      materializeSnapshot({ instanceDir: dir, snapshot, vcStore, sharedStore }),
    ).rejects.toBeInstanceOf(PathEscape);
    expect(await pathExists(join(dir, "..", "escape"))).toBe(false);
  });

  it("GATE materialize-saves: a snapshot claiming saves/level.dat fails loudly, never silently", async () => {
    const { dir, vcStore, sharedStore, empty, evil } = await scaffold();
    const level = join(dir, "saves", "level.dat");
    await put(level, "PRECIOUS-WORLD-BYTES");
    const snapshot: SnapshotObject = {
      type: "snapshot",
      manifest: empty,
      lock: empty,
      ignore: empty,
      carried: [],
      tracked: [{ path: "saves/level.dat", blob: evil }],
    };
    await expect(
      materializeSnapshot({ instanceDir: dir, snapshot, vcStore, sharedStore }),
    ).rejects.toBeInstanceOf(PathEscape);
    // Whatever it did, the world file is unchanged.
    expect(await readFile(level, "utf8")).toBe("PRECIOUS-WORLD-BYTES");
  });

  it("GATE materialize-saves: a PREVIOUS snapshot claiming saves/level.dat cannot delete it", async () => {
    const { dir, vcStore, sharedStore, empty, evil } = await scaffold();
    const level = join(dir, "saves", "level.dat");
    await put(level, "PRECIOUS-WORLD-BYTES");
    const previous: SnapshotObject = {
      type: "snapshot",
      manifest: empty,
      lock: empty,
      ignore: empty,
      carried: [],
      tracked: [{ path: "saves/level.dat", blob: evil }],
    };
    const target: SnapshotObject = { ...previous, tracked: [] };
    await expect(
      materializeSnapshot({ instanceDir: dir, snapshot: target, vcStore, sharedStore, previous }),
    ).rejects.toBeInstanceOf(PathEscape);
    expect(await readFile(level, "utf8")).toBe("PRECIOUS-WORLD-BYTES");
  });
});
