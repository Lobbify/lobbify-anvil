import { describe, expect, it } from "vitest";
import { parseLock, serializeLock } from "../../index.js";
import type { LockPackage, Lockfile } from "../../index.js";

const jre: LockPackage = {
  name: "java-runtime:java-runtime-epsilon:mac-os-arm64",
  kind: "java",
  source: "mojang",
  version: "25.0.1",
  hash: { algo: "sha1", value: "a".repeat(40) },
  provenance: "copy",
  placement: { method: "runtime-tree", targetDir: "runtime/java-runtime-epsilon/mac-os-arm64" },
  targets: [{ os: "osx", arch: "arm64" }],
  size: 88214,
  url: "https://piston-meta.mojang.com/manifest.json",
};
const natives: LockPackage = {
  name: "org.lwjgl:lwjgl:3.4.1:natives-linux",
  kind: "library",
  source: "mojang",
  hash: { algo: "sha1", value: "b".repeat(40) },
  provenance: "copy",
  placement: { method: "extract", targetDir: "natives" },
  targets: [{ os: "linux", arch: "x64" }],
};
const universal: LockPackage = {
  name: "com.example:base:1.0",
  kind: "library",
  source: "mojang",
  hash: { algo: "sha1", value: "c".repeat(40) },
  provenance: "copy",
  placement: { method: "link", target: "libraries/com/example/base/1.0/base-1.0.jar" },
};

const lock: Lockfile = {
  meta: {
    version: 1,
    manifestHash: { algo: "sha256", value: "d".repeat(64) },
    minecraft: "26.2",
    loader: "fabric 0.19.3",
    java: "java-runtime-epsilon",
  },
  resolved: [jre, natives, universal],
};

describe("lock schema — targets + runtime-tree placement", () => {
  it("round-trips targets and the runtime-tree placement through parse", () => {
    const parsed = parseLock(serializeLock(lock));
    const back = parsed.resolved.find((p) => p.kind === "java") as LockPackage;
    expect(back.placement).toEqual({
      method: "runtime-tree",
      targetDir: "runtime/java-runtime-epsilon/mac-os-arm64",
    });
    expect(back.targets).toEqual([{ os: "osx", arch: "arm64" }]);
    const nat = parsed.resolved.find((p) => p.name.endsWith(":natives-linux")) as LockPackage;
    expect(nat.targets).toEqual([{ os: "linux", arch: "x64" }]);
    const uni = parsed.resolved.find((p) => p.name === "com.example:base:1.0") as LockPackage;
    expect(uni.targets).toBeUndefined(); // universal packages carry no targets
  });

  it("serialization is idempotent and byte-stable (canonical)", () => {
    const once = serializeLock(lock);
    const twice = serializeLock(parseLock(once));
    expect(twice).toBe(once);
  });

  it("targets are canonically sorted regardless of input order", () => {
    const shuffled: Lockfile = {
      ...lock,
      resolved: [
        {
          ...jre,
          targets: [
            { os: "windows", arch: "arm64" },
            { os: "osx", arch: "arm64" },
            { os: "linux" },
          ],
        },
      ],
    };
    const text = serializeLock(shuffled);
    // linux < osx < windows by os, so the emitted order is fixed.
    const line = text.split("\n").find((l) => l.startsWith("targets ="));
    expect(line).toBe(
      'targets = [{ os = "linux" }, { os = "osx", arch = "arm64" }, { os = "windows", arch = "arm64" }]',
    );
  });
});
