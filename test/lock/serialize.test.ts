import { describe, expect, it } from "vitest";
import type { LockPackage, Lockfile } from "../../index.js";
import { parseLock, serializeLock } from "../../index.js";

const modA: LockPackage = {
  name: "sodium",
  kind: "mod",
  source: "modrinth",
  version: "0.5.8",
  hash: { algo: "sha256", value: "aa".repeat(32) },
  provenance: "copy",
  placement: { method: "link", target: "mods/sodium.jar" },
  size: 123456,
  url: "https://cdn.modrinth.com/data/AABBCCDD/versions/x/sodium.jar",
};

const modB: LockPackage = {
  name: "fabric-api",
  kind: "mod",
  source: "modrinth",
  version: "0.100.0",
  hash: { algo: "sha256", value: "bb".repeat(32) },
  provenance: "copy",
  placement: { method: "link", target: "mods/fabric-api.jar" },
  size: 42,
};

const localItem: LockPackage = {
  name: "options.txt",
  kind: "config",
  source: "local",
  hash: { algo: "sha256", value: "cc".repeat(32) },
  provenance: "copy",
  placement: { method: "link", target: "config/options.txt" },
  size: 7,
  url: "file:///home/user/options.txt",
};

function lockOf(resolved: LockPackage[]): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "ee".repeat(32) },
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "pending:game-install",
    },
    resolved,
  };
}

describe("canonical lock serializer", () => {
  it("round-trips serialize → parse → serialize byte-identically", () => {
    const lock = lockOf([modA, modB, localItem]);
    const text = serializeLock(lock);
    const back = parseLock(text);
    expect(serializeLock(back)).toBe(text);
    // The parsed object reconstructs every field.
    const parsedA = back.resolved.find((p) => p.name === "sodium");
    expect(parsedA).toMatchObject({
      name: "sodium",
      version: "0.5.8",
      size: 123456,
      url: modA.url,
      hash: { algo: "sha256", value: "aa".repeat(32) },
      placement: { method: "link", target: "mods/sodium.jar" },
    });
  });

  it("is independent of resolution order (packages are sorted)", () => {
    const a = serializeLock(lockOf([modA, modB, localItem]));
    const b = serializeLock(lockOf([localItem, modB, modA]));
    expect(a).toBe(b);
  });

  it("forces POSIX `/` separators in serialized paths", () => {
    const windowsish: LockPackage = {
      ...modA,
      placement: { method: "link", target: "mods\\nested\\sodium.jar" },
    };
    const text = serializeLock(lockOf([windowsish]));
    expect(text).toContain('target = "mods/nested/sodium.jar"');
    expect(text).not.toContain("\\");
  });

  it("emits sizes as bare integers, omits absent optional fields, ends in one newline", () => {
    const text = serializeLock(lockOf([modB]));
    expect(text).toContain("size = 42");
    expect(text).not.toContain("42.0");
    // modB has no url/project/file → those keys are absent.
    expect(text).not.toContain("url =");
    expect(text).not.toContain("project =");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.startsWith("# anvil.lock")).toBe(true);
  });

  it("rejects an unsupported schema version", () => {
    const good = serializeLock(lockOf([modB]));
    const bad = good.replace("version = 1", "version = 2");
    expect(() => parseLock(bad)).toThrow(/unsupported lock schema/);
  });

  it("escapes special characters in strings stably", () => {
    const weird: LockPackage = { ...modB, name: 'weird"name\twith\\stuff' };
    const text = serializeLock(lockOf([weird]));
    expect(serializeLock(parseLock(text))).toBe(text);
  });
});
