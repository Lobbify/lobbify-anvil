/**
 * `normalizeRelPath` / `foldPath` — the comparison form every path-keyed
 * protection uses.
 *
 * These are not cosmetics. `safeJoin` and the filesystem resolve `mods/x.jar`,
 * `mods//x.jar`, `./mods/x.jar` and `mods\x.jar` to one file. Anything that keys
 * a protection on the raw string — the working-tree exclusion set, the replay
 * ledger, the push gate — answers differently per spelling unless this function
 * collapses them first, and "differently" means a bypass you reach by typing an
 * extra slash.
 */

import { describe, expect, it } from "vitest";
import { foldPath, normalizeRelPath } from "../../src/internal/fs.js";
import { WorktreeExclusion } from "../../index.js";

describe("instance-relative path canonicalization", () => {
  it("collapses every spelling of one path to one string", () => {
    const spellings = [
      "mods/jei-1.19.2.jar",
      "mods//jei-1.19.2.jar",
      "mods///jei-1.19.2.jar",
      "./mods/jei-1.19.2.jar",
      "././mods/jei-1.19.2.jar",
      "mods/./jei-1.19.2.jar",
      "mods\\jei-1.19.2.jar",
      "./mods\\\\jei-1.19.2.jar",
    ];
    for (const spelling of spellings) {
      expect(normalizeRelPath(spelling), spelling).toBe("mods/jei-1.19.2.jar");
      expect(foldPath(spelling), spelling).toBe("mods/jei-1.19.2.jar");
    }
  });

  it("drops a trailing separator and folds case", () => {
    expect(normalizeRelPath("config/")).toBe("config");
    expect(normalizeRelPath("config///")).toBe("config");
    expect(foldPath("Mods/JEI.jar")).toBe("mods/jei.jar");
    expect(foldPath("./MODS//JEI.JAR/")).toBe("mods/jei.jar");
  });

  it("keeps `..` rather than folding it — that is a rejection, not a normalization", () => {
    // `safeJoin` refuses a `..` segment outright. Folding it here would let a
    // caller that never reaches `safeJoin` compare an escaping path as if it
    // were an inner one.
    expect(normalizeRelPath("mods/../saves/level.dat")).toBe("mods/../saves/level.dat");
  });

  it("the empty and dot-only paths normalize away entirely", () => {
    expect(normalizeRelPath("")).toBe("");
    expect(normalizeRelPath(".")).toBe("");
    expect(normalizeRelPath("./")).toBe("");
  });

  it("GATE spelling-bypass: an exclusion answers the same for every spelling", () => {
    // The regression this pins: `excludes` used to fold with a rule list that
    // stripped one leading `./` and no repeated separators, so a lock-owned path
    // spelled `mods//sodium.jar` read as un-owned and was version-controlled.
    const exclude = new WorktreeExclusion({
      owned: { files: new Set([foldPath("mods/sodium.jar")]), trees: [] },
    });
    for (const spelling of [
      "mods/sodium.jar",
      "mods//sodium.jar",
      "./mods/sodium.jar",
      "././mods/sodium.jar",
      "mods\\sodium.jar",
      "MODS//Sodium.jar",
    ]) {
      expect(exclude.excludes(spelling), spelling).toBe(true);
    }
    expect(exclude.excludes("mods/other.jar")).toBe(false);
  });
});
