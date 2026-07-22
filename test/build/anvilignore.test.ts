import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IgnoreSet, loadIgnoreSet, parseAnvilignore } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

describe(".anvilignore", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("parses comments, blanks, and top-level segments", () => {
    const tops = parseAnvilignore("# comment\n\nsaves/\noptions.txt\nfoo/bar\n");
    expect(tops).toEqual(["saves", "options.txt", "foo"]);
  });

  it("always protects saves, .anvil, and .anvilignore", () => {
    const set = new IgnoreSet([]);
    expect(set.ignores("saves/world/level.dat")).toBe(true);
    expect(set.ignores(".anvil/refs/built")).toBe(true);
    expect(set.ignores(".anvilignore")).toBe(true);
    expect(set.ignores("mods/a.jar")).toBe(false);
  });

  it("protects user-listed entries", () => {
    const set = new IgnoreSet(["config", "options.txt"]);
    expect(set.ignores("config/foo.toml")).toBe(true);
    expect(set.ignores("options.txt")).toBe(true);
    expect(set.ignores("mods/a.jar")).toBe(false);
  });

  it("protects case-insensitively (Windows/macOS case-folding)", () => {
    const set = new IgnoreSet([]);
    expect(set.ignores("Saves/world")).toBe(true);
    expect(set.ignores("SAVES/world")).toBe(true);
    expect(set.ignores(".Anvil/refs")).toBe(true);
  });

  it("loads an instance's .anvilignore file", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    await writeFile(join(dir, ".anvilignore"), "resourcepacks/\n");
    const set = await loadIgnoreSet(dir);
    expect(set.ignores("resourcepacks/pack.zip")).toBe(true);
    expect(set.ignores("saves/world")).toBe(true);
  });
});
