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

describe("incremental diff — co-located extract dirs (natives)", () => {
  function extractPkg(name: string, value: string, targetDir: string): LockPackage {
    return {
      name,
      kind: "library",
      source: "mojang",
      hash: { algo: "sha1", value },
      provenance: "copy",
      placement: { method: "extract", targetDir },
      size: 1,
    };
  }
  const natA = extractPkg("lib-a:natives-linux", "a".repeat(40), "natives");
  const natB = extractPkg("lib-b:natives-linux", "b".repeat(40), "natives");

  it("re-stages the WHOLE shared dir when a sibling is dropped (no orphaned natives)", () => {
    // prev {A,B}→natives/, next {A}: A unchanged, B dropped. The swap replaces the
    // whole natives/ dir, so A must be re-staged to purge B's extracted files.
    const delta = diffLocks(lockOf(natA, natB), lockOf(natA));
    expect(delta.install.map((p) => p.name)).toEqual(["lib-a:natives-linux"]);
    expect(delta.installTargets).toEqual(["natives"]);
  });

  it("re-stages every co-located package when one changes", () => {
    const natBChanged = extractPkg("lib-b:natives-linux", "c".repeat(40), "natives");
    const delta = diffLocks(lockOf(natA, natB), lockOf(natA, natBChanged));
    expect(delta.install.map((p) => p.name).sort()).toEqual([
      "lib-a:natives-linux",
      "lib-b:natives-linux",
    ]);
  });

  it("stays a no-op when the dir membership is unchanged", () => {
    const delta = diffLocks(lockOf(natA, natB), lockOf(natA, natB));
    expect(delta.install).toEqual([]);
  });

  it("removes the dir entirely when every co-located package is dropped", () => {
    const delta = diffLocks(lockOf(natA, natB), lockOf());
    expect(delta.install).toEqual([]);
    expect(delta.removeTargets).toEqual(["natives"]);
  });
});
