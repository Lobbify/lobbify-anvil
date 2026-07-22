import { describe, expect, it } from "vitest";
import { type LockPackage, type Lockfile, diffLocks } from "../../index.js";

function linkPkg(name: string, value: string, target: string): LockPackage {
  return {
    name,
    kind: "mod",
    source: "modrinth",
    hash: { algo: "sha256", value },
    provenance: "copy",
    placement: { method: "link", target },
    size: 1,
  };
}

function lockOf(...pkgs: LockPackage[]): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "0".repeat(64) },
      minecraft: "26.2",
      loader: "vanilla",
      java: "runtime-gamma-21",
    },
    resolved: pkgs,
  };
}

describe("incremental diff", () => {
  const a = linkPkg("a", "a".repeat(64), "mods/a.jar");
  const b = linkPkg("b", "b".repeat(64), "mods/b.jar");

  it("installs everything and removes nothing on a first build", () => {
    const delta = diffLocks(undefined, lockOf(a, b));
    expect(delta.install.map((p) => p.name)).toEqual(["a", "b"]);
    expect(delta.removeTargets).toEqual([]);
    expect([...delta.installTargets].sort()).toEqual(["mods/a.jar", "mods/b.jar"]);
  });

  it("installs only the changed package (same target path)", () => {
    const bChanged = linkPkg("b", "c".repeat(64), "mods/b.jar");
    const delta = diffLocks(lockOf(a, b), lockOf(a, bChanged));
    expect(delta.install.map((p) => p.name)).toEqual(["b"]);
    expect(delta.installTargets).toEqual(["mods/b.jar"]);
    expect(delta.removeTargets).toEqual([]);
  });

  it("removes the target of a dropped package", () => {
    const delta = diffLocks(lockOf(a, b), lockOf(a));
    expect(delta.install).toEqual([]);
    expect(delta.removeTargets).toEqual(["mods/b.jar"]);
  });

  it("installs a newly added package", () => {
    const delta = diffLocks(lockOf(a), lockOf(a, b));
    expect(delta.install.map((p) => p.name)).toEqual(["b"]);
    expect(delta.removeTargets).toEqual([]);
  });

  it("is a no-op when nothing changed", () => {
    const delta = diffLocks(lockOf(a, b), lockOf(a, b));
    expect(delta.install).toEqual([]);
    expect(delta.installTargets).toEqual([]);
    expect(delta.removeTargets).toEqual([]);
  });
});
