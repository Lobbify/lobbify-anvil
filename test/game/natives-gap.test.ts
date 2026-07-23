import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  StoreOnlyAcquirer,
  UnsatisfiableTarget,
  assertNativesSatisfiable,
  buildInstance,
} from "../../index.js";
import type { LockPackage, Lockfile, Platform } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

/** A natives extract package for one lwjgl classifier + target. */
function nativesPkg(
  classifier: string,
  target: { os: "linux" | "osx" | "windows"; arch?: string },
): LockPackage {
  return {
    name: `org.lwjgl:lwjgl:3.4.1:natives-${classifier}`,
    kind: "library",
    source: "mojang",
    hash: { algo: "sha1", value: classifier.padEnd(40, "0") },
    provenance: "copy",
    placement: { method: "extract", targetDir: "natives" },
    targets: [target],
  };
}

const ARM64_MAC: Platform = { os: "osx", arch: "arm64" };
const X64_MAC: Platform = { os: "osx", arch: "x64" };
const X64_LINUX: Platform = { os: "linux", arch: "x64" };

describe("natives gap — macOS-arm64 (and windows-arm64) never gets wrong-arch natives", () => {
  it("throws UnsatisfiableTarget when a library ships osx natives but none for arm64", () => {
    const pkgs = [nativesPkg("macos", { os: "osx", arch: "x64" })];
    expect(() => assertNativesSatisfiable(pkgs, ARM64_MAC)).toThrow(UnsatisfiableTarget);
    expect(() => assertNativesSatisfiable(pkgs, ARM64_MAC)).toThrow(/osx-arm64/);
  });

  it("is satisfied on osx-arm64 once the arm64 native is present", () => {
    const pkgs = [
      nativesPkg("macos", { os: "osx", arch: "x64" }),
      nativesPkg("macos-arm64", { os: "osx", arch: "arm64" }),
    ];
    expect(() => assertNativesSatisfiable(pkgs, ARM64_MAC)).not.toThrow();
  });

  it("does not flag a host OS the library ships no native for", () => {
    // Only osx natives → nothing needed on linux; no gap.
    const pkgs = [nativesPkg("macos", { os: "osx", arch: "x64" })];
    expect(() => assertNativesSatisfiable(pkgs, X64_LINUX)).not.toThrow();
    expect(() => assertNativesSatisfiable(pkgs, X64_MAC)).not.toThrow();
  });

  it("windows-arm64 gap is caught the same way", () => {
    const pkgs = [nativesPkg("windows", { os: "windows", arch: "x64" })];
    expect(() => assertNativesSatisfiable(pkgs, { os: "windows", arch: "arm64" })).toThrow(
      UnsatisfiableTarget,
    );
  });
});

describe("natives gap — enforced by the build preflight", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("a build on osx-arm64 rejects a lock with only x64 osx natives (before any fetch)", async () => {
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: { algo: "sha256", value: "00" },
        minecraft: "26.2",
        loader: "vanilla",
        java: "java-runtime-epsilon",
      },
      resolved: [nativesPkg("macos", { os: "osx", arch: "x64" })],
    };
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: new StoreOnlyAcquirer(store),
        platform: ARM64_MAC,
      }),
    ).rejects.toThrow(UnsatisfiableTarget);
  });
});
