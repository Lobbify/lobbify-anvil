/**
 * The pure half of the working-tree walk (LB-705): `.anvilexclude` parsing, the
 * exclusion predicate, the build-owned path set derived from a lock, and the walk
 * itself over a real temp directory.
 *
 * These are the rules that decide whether an undeclared file reaches a commit at
 * all, so every case here asserts an exact value: a predicate that answered `true`
 * for everything would satisfy a truthiness check and quietly stop tracking.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Hash,
  type LockPackage,
  type Lockfile,
  type Placement,
  VcObjectStore,
  WorktreeExclusion,
  buildOwnedPaths,
  loadWorktreeExclusion,
  parseAnvilexclude,
  trackWorktree,
  walkWorktree,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const H = (c: string): Hash => ({ algo: "sha256", value: c.repeat(64) });

function pkgWith(placement: Placement, name = "p"): LockPackage {
  return { name, kind: "mod", source: "url", hash: H("a"), provenance: "copy", placement };
}

function lockOf(...packages: LockPackage[]): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: H("b"),
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "runtime-test-21",
    },
    resolved: packages,
  };
}

describe("worktree: .anvilexclude parsing", () => {
  it("drops comments and blanks, normalizes separators, and classifies globs vs prefixes", () => {
    const patterns = parseAnvilexclude(
      ["# a comment", "", "   ", "  notes/  ", "*.log", "./tmp\\cache/", "#not-a-pattern"].join(
        "\n",
      ),
    );
    expect(patterns).toEqual([
      { kind: "prefix", path: "notes" },
      { kind: "glob", parts: ["", ".log"] },
      { kind: "prefix", path: "tmp/cache" },
    ]);
  });

  it("folds patterns to lowercase at parse time and splits a multi-wildcard glob", () => {
    expect(parseAnvilexclude("NOTES/\n*.LOG\nBig*Mid*End\n")).toEqual([
      { kind: "prefix", path: "notes" },
      { kind: "glob", parts: ["", ".log"] },
      { kind: "glob", parts: ["big", "mid", "end"] },
    ]);
  });

  it("accepts CRLF line endings and ignores a line that normalizes to nothing", () => {
    expect(parseAnvilexclude("notes/\r\n./\r\n/\r\n")).toEqual([{ kind: "prefix", path: "notes" }]);
  });
});

describe("worktree: WorktreeExclusion.excludes", () => {
  const bare = new WorktreeExclusion();

  it("excludes the three snapshot slots, but only at the instance root", () => {
    expect(bare.excludes("anvil.toml")).toBe(true);
    expect(bare.excludes("anvil.lock")).toBe(true);
    expect(bare.excludes(".anvilignore")).toBe(true);
    // A same-named file one level down is an ordinary undeclared file.
    expect(bare.excludes("config/anvil.toml")).toBe(false);
    expect(bare.excludes("packs/anvil.lock")).toBe(false);
  });

  it("GATE saves-never-tracked: the protected tops are excluded, case-folded", () => {
    for (const p of [
      "saves/world/level.dat",
      "Saves/world/level.dat",
      "SAVES/world/level.dat",
      ".anvil/refs/heads/main",
      ".Anvil/objects/aa/bb",
    ]) {
      expect(bare.excludes(p)).toBe(true);
    }
  });

  it("excludes the game install by top-level segment", () => {
    for (const top of ["assets", "libraries", "versions", "natives", "runtime"]) {
      expect(bare.excludes(`${top}/deep/inside.bin`)).toBe(true);
      expect(bare.excludes(top)).toBe(true);
    }
    // A *stale* subtree an old lock left behind is still excluded — the rule is
    // hardcoded by segment, not derived from the current lock.
    expect(bare.excludes("versions/1.20.1/1.20.1.jar")).toBe(true);
    expect(bare.excludes("assets/objects/ab/abcdef")).toBe(true);
  });

  it("excludes the default churn and user-local tops", () => {
    for (const top of [
      "logs",
      "crash-reports",
      "screenshots",
      "backups",
      "debug",
      ".fabric",
      ".mixin.out",
      ".cache",
      "server-resource-packs",
      "usercache.json",
      "usernamecache.json",
      "realms_persistence.json",
    ]) {
      expect(bare.excludes(`${top}/x`)).toBe(true);
      expect(bare.excludes(top)).toBe(true);
    }
  });

  it("does NOT exclude ordinary undeclared files, .anvilexclude included", () => {
    // `.anvilexclude` is deliberately tracked: it must travel with clone/pull/push.
    expect(bare.excludes(".anvilexclude")).toBe(false);
    expect(bare.excludes("config/mymod.toml")).toBe(false);
    expect(bare.excludes("mods/dropped.jar")).toBe(false);
    expect(bare.excludes("options.txt")).toBe(false);
    // A near-miss on an excluded top is NOT excluded (prefix matching is by segment).
    expect(bare.excludes("logsmith/notes.txt")).toBe(false);
    expect(bare.excludes("assets-backup/x")).toBe(false);
  });

  it("treats the instance root itself as no candidate", () => {
    expect(bare.excludes("")).toBe(true);
    expect(bare.excludes(".")).toBe(true);
  });

  it("applies .anvilexclude prefixes and basename globs, case-insensitively", () => {
    const set = new WorktreeExclusion({
      patterns: parseAnvilexclude("NOTES/\n*.LOG\ntmp/cache\nshaderpacks/old.zip\n"),
    });
    // prefix: the path itself and everything under it
    expect(set.excludes("notes")).toBe(true);
    expect(set.excludes("notes/todo.txt")).toBe(true);
    expect(set.excludes("NOTES/Todo.txt")).toBe(true);
    expect(set.excludes("tmp/cache/blob")).toBe(true);
    expect(set.excludes("shaderpacks/old.zip")).toBe(true);
    // …but a mere string prefix of a segment is not a match
    expect(set.excludes("notesbook/todo.txt")).toBe(false);
    expect(set.excludes("tmp/cacheable")).toBe(false);
    expect(set.excludes("shaderpacks/old.zip.bak")).toBe(false);
    // basename glob: any depth, case-folded, `*` matches an empty run too
    expect(set.excludes("mods/debug.log")).toBe(true);
    expect(set.excludes("a/b/c/D.LOG")).toBe(true);
    expect(set.excludes(".log")).toBe(true);
    expect(set.excludes("mods/logfile")).toBe(false);
    // a glob is matched against the BASENAME, not the whole path
    expect(set.excludes("a.log/inner.txt")).toBe(false);
  });

  it("matches a multi-wildcard glob left-to-right without overlapping the parts", () => {
    const set = new WorktreeExclusion({ patterns: parseAnvilexclude("big*mid*end\n") });
    expect(set.excludes("config/bigXmidYend")).toBe(true);
    expect(set.excludes("config/bigmidend")).toBe(true);
    expect(set.excludes("config/bigend")).toBe(false); // "mid" is absent
    expect(set.excludes("config/bigmiden")).toBe(false); // wrong suffix
  });

  it("excludes exactly the build-owned files and subtrees it is given", () => {
    const set = new WorktreeExclusion({
      owned: buildOwnedPaths([
        lockOf(
          pkgWith({ method: "link", target: "mods/Declared-1.0.0.jar" }, "declared"),
          pkgWith({ method: "extract", targetDir: "natives-x" }, "natives"),
        ),
      ]),
    });
    expect(set.excludes("mods/Declared-1.0.0.jar")).toBe(true);
    expect(set.excludes("mods/declared-1.0.0.jar")).toBe(true); // folded
    expect(set.excludes("natives-x")).toBe(true);
    expect(set.excludes("natives-x/lwjgl.so")).toBe(true);
    // The undeclared sibling in the same directory stays trackable.
    expect(set.excludes("mods/dropped.jar")).toBe(false);
    expect(set.excludes("natives-xtra/other.so")).toBe(false);
  });
});

describe("worktree: buildOwnedPaths", () => {
  it("maps every placement method to the paths it owns", () => {
    const owned = buildOwnedPaths([
      lockOf(
        pkgWith({ method: "link", target: "mods/Sodium.jar" }, "sodium"),
        pkgWith({ method: "extract", targetDir: "Natives" }, "natives"),
        pkgWith({ method: "asset-tree", indexTarget: "assets/indexes/26.json" }, "assets"),
        pkgWith({ method: "runtime-tree", targetDir: "runtime/jre-21" }, "jre"),
        pkgWith(
          { method: "forge-build", outputs: ["versions/f/f.jar", "libraries/a/b.jar"] },
          "fg",
        ),
        pkgWith({ method: "store-only" }, "store"),
      ),
    ]);
    expect([...owned.files].sort()).toEqual([
      "libraries/a/b.jar",
      "mods/sodium.jar",
      "versions/f/f.jar",
    ]);
    // `asset-tree` owns the whole TOP segment: the objects it names fan out under
    // `assets/objects/**`, which the index target alone never mentions.
    expect(owned.trees).toEqual(["assets", "natives", "runtime/jre-21"]);
  });

  it("unions several locks and tolerates an absent (never-built) one", () => {
    const owned = buildOwnedPaths([
      lockOf(pkgWith({ method: "link", target: "mods/current.jar" }, "cur")),
      undefined,
      lockOf(pkgWith({ method: "link", target: "mods/built.jar" }, "built")),
    ]);
    expect([...owned.files].sort()).toEqual(["mods/built.jar", "mods/current.jar"]);
    expect(owned.trees).toEqual([]);
  });

  it("owns nothing for an empty lock set", () => {
    const owned = buildOwnedPaths([]);
    expect(owned.files.size).toBe(0);
    expect(owned.trees).toEqual([]);
  });
});

describe("worktree: the walk", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function instance(): Promise<string> {
    const dir = await mkTmp("walk-inst");
    dirs.push(dir);
    return dir;
  }

  it("returns instance-relative POSIX paths, sorted, pruning excluded subtrees", async () => {
    const dir = await instance();
    await mkdir(join(dir, "config", "sub"), { recursive: true });
    await mkdir(join(dir, "assets", "objects", "ab"), { recursive: true });
    await mkdir(join(dir, "logs"), { recursive: true });
    await mkdir(join(dir, "saves", "world"), { recursive: true });
    await writeFile(join(dir, "anvil.toml"), "x");
    await writeFile(join(dir, "options.txt"), "fov:70");
    await writeFile(join(dir, "config", "a.toml"), "a");
    await writeFile(join(dir, "config", "sub", "b.toml"), "b");
    await writeFile(join(dir, "assets", "objects", "ab", "abcdef"), "asset");
    await writeFile(join(dir, "logs", "latest.log"), "log");
    await writeFile(join(dir, "saves", "world", "level.dat"), "world");

    expect(await walkWorktree(dir, new WorktreeExclusion())).toEqual([
      "config/a.toml",
      "config/sub/b.toml",
      "options.txt",
    ]);
  });

  it("does not track symlinks (or what they point at)", async () => {
    const dir = await instance();
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config", "real.toml"), "real");
    await symlink(join(dir, "config", "real.toml"), join(dir, "alias.toml"));
    await symlink(join(dir, "config"), join(dir, "config-link"));

    // The real file IS tracked — without this the assertion below would pass on a
    // walk that returned nothing at all.
    expect(await walkWorktree(dir, new WorktreeExclusion())).toEqual(["config/real.toml"]);
  });

  it("loads .anvilexclude from the instance and combines it with the built-in defaults", async () => {
    const dir = await instance();
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, ".anvilexclude"), "notes/\n*.bak\n");
    const set = await loadWorktreeExclusion({
      instanceDir: dir,
      locks: [lockOf(pkgWith({ method: "link", target: "mods/declared.jar" }, "declared"))],
    });
    expect(set.excludes("notes/todo.txt")).toBe(true);
    expect(set.excludes("config/a.toml.bak")).toBe(true);
    expect(set.excludes("mods/declared.jar")).toBe(true);
    expect(set.excludes("logs/latest.log")).toBe(true); // built-in default
    expect(set.excludes("config/a.toml")).toBe(false);
  });

  it("falls back to the built-in defaults when there is no .anvilexclude", async () => {
    const dir = await instance();
    const set = await loadWorktreeExclusion({ instanceDir: dir });
    expect(set.excludes("logs/latest.log")).toBe(true);
    expect(set.excludes("notes/todo.txt")).toBe(false);
  });

  it("hashes candidates to stable blob ids and only stores them when asked", async () => {
    const dir = await instance();
    const anvilDir = join(dir, ".anvil");
    const vcStore = new VcObjectStore({ anvilDir });
    await writeFile(join(dir, "options.txt"), "fov:70");

    const exclude = new WorktreeExclusion();
    const readOnly = await trackWorktree({ instanceDir: dir, vcStore, exclude, store: false });
    expect(readOnly.map((t) => t.path)).toEqual(["options.txt"]);
    const blob = readOnly[0]?.blob;
    expect(blob).toBeDefined();
    if (!blob) {
      return;
    }
    // `store: false` is a pure read — `status` must never write history.
    expect(await vcStore.has(blob)).toBe(false);

    const stored = await trackWorktree({ instanceDir: dir, vcStore, exclude, store: true });
    expect(stored.map((t) => t.blob.value)).toEqual([blob.value]);
    expect(await vcStore.has(blob)).toBe(true);
    expect(new TextDecoder().decode(await vcStore.getBlobBytes(blob))).toBe("fov:70");
  });
});
