import { describe, expect, it } from "vitest";
import {
  type LockPackage,
  type Platform,
  PreflightFailed,
  type Rule,
  checkDiskSpace,
  currentPlatform,
  evaluateRules,
  filterByRules,
} from "../../index.js";
import { mkTmp } from "../helpers/fixtures.js";

const linux: Platform = { os: "linux", arch: "x64" };
const windows: Platform = { os: "windows", arch: "x64" };

function pkg(name: string): LockPackage {
  return {
    name,
    kind: "library",
    source: "mojang",
    hash: { algo: "sha256", value: "0".repeat(64) },
    provenance: "copy",
    placement: { method: "store-only" },
    size: 10,
  };
}

describe("preflight rules", () => {
  it("treats absent/empty rules as applicable", () => {
    expect(evaluateRules(undefined, linux)).toBe(true);
    expect(evaluateRules([], linux)).toBe(true);
  });

  it("applies Mojang allow/disallow semantics per OS", () => {
    const linuxOnly: Rule[] = [{ action: "disallow" }, { action: "allow", os: { name: "linux" } }];
    expect(evaluateRules(linuxOnly, linux)).toBe(true);
    expect(evaluateRules(linuxOnly, windows)).toBe(false);

    const notWindows: Rule[] = [
      { action: "allow" },
      { action: "disallow", os: { name: "windows" } },
    ];
    expect(evaluateRules(notWindows, linux)).toBe(true);
    expect(evaluateRules(notWindows, windows)).toBe(false);
  });

  it("filters a package set by a per-name rules map", () => {
    const rules = new Map<string, Rule[]>([
      ["win-natives", [{ action: "allow", os: { name: "windows" } }]],
    ]);
    const kept = filterByRules([pkg("mod"), pkg("win-natives")], linux, rules);
    expect(kept.map((p) => p.name)).toEqual(["mod"]);
  });

  it("currentPlatform reports a Mojang os name", () => {
    expect(["linux", "osx", "windows"]).toContain(currentPlatform().os);
  });
});

describe("preflight disk space", () => {
  it("passes when there is room and fails when the requirement is impossible", async () => {
    const dir = await mkTmp("disk");
    await expect(checkDiskSpace(dir, [pkg("small")], 0)).resolves.toBeUndefined();

    const huge: LockPackage = { ...pkg("huge"), size: Number.MAX_SAFE_INTEGER };
    await expect(checkDiskSpace(dir, [huge], 0)).rejects.toBeInstanceOf(PreflightFailed);
  });
});
