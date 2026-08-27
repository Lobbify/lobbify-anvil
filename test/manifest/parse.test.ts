import { describe, expect, it } from "vitest";
import {
  ManifestError,
  parseManifest,
  parseRef,
  parseVersionSpec,
  serializeManifest,
} from "../../index.js";

const SAMPLE = `
[project]
name = "demo-pack"
version = "1.0.0"
summary = "a demo"

[game]
minecraft = "26.2"
loader = "fabric 0.19.1"
remove = ["modrinth:unwanted"]

items = [
  "modrinth:fabric-api",
  "modrinth:sodium@^0.5",
  "modrinth:lithium@0.11.1",
  "https://example.com/mods/extra.jar",
  "./overrides/options.txt",
  { path = "./config/mymod.toml", kind = "config" },
]
`;

describe("anvil.toml parser", () => {
  it("parses project, game (with remove), and a flat item list", () => {
    const m = parseManifest(SAMPLE);
    expect(m.project).toEqual({ name: "demo-pack", version: "1.0.0", summary: "a demo" });
    expect(m.game.minecraft).toBe("26.2");
    expect(m.game.loader).toBe("fabric 0.19.1");
    expect(m.game.remove).toEqual(["modrinth:unwanted"]);
    expect(m.items).toHaveLength(6);
    expect(m.items[0]?.ref).toMatchObject({ source: "modrinth", id: "fabric-api" });
    expect(m.items[3]?.ref).toMatchObject({ source: "url" });
    expect(m.items[4]?.ref).toMatchObject({ source: "local", id: "./overrides/options.txt" });
    expect(m.items[5]).toMatchObject({ path: "./config/mymod.toml", kind: "config" });
  });

  it("round-trips through the serializer", () => {
    const m = parseManifest(SAMPLE);
    const again = parseManifest(serializeManifest(m));
    expect(again.project).toEqual(m.project);
    expect(again.items).toHaveLength(m.items.length);
  });

  it("LB-719: a path item may declare a target, and it round-trips", () => {
    const m = parseManifest(`
[project]
name = "x"
version = "1"

[game]
minecraft = "26.2"
loader = "vanilla"

items = [
  { path = ".anvil/overrides/config/sodium.json", kind = "config", target = "config/sodium.json" },
  { path = ".anvil/overrides/options.txt", target = "options.txt" },
]
`);
    expect(m.items[0]).toEqual({
      path: ".anvil/overrides/config/sodium.json",
      kind: "config",
      target: "config/sodium.json",
    });
    // A target with no kind still forces the table form out of the serializer —
    // rendering it as a bare string would drop the placement silently.
    expect(m.items[1]).toEqual({ path: ".anvil/overrides/options.txt", target: "options.txt" });
    expect(parseManifest(serializeManifest(m)).items).toEqual(m.items);
  });

  it("LB-720: a ref item may declare a target, and it round-trips", () => {
    // Every source now places by a declared target (LB-720), so a `ref` item
    // no longer has to drop its subdirectory — it names identity via `ref` and
    // placement via `target`, the same split a tracked-copy `path` item uses.
    const m = parseManifest(`
[project]
name = "x"
version = "1"

[game]
minecraft = "26.2"
loader = "vanilla"

items = [
  { ref = "modrinth:sodium", target = "mods/nested/sodium.jar" },
]
`);
    expect(m.items[0]).toEqual({
      ref: { source: "modrinth", id: "sodium", versionSpec: { kind: "latest" } },
      target: "mods/nested/sodium.jar",
    });
    expect(parseManifest(serializeManifest(m)).items).toEqual(m.items);
  });

  it("rejects a missing [game] table and a malformed item", () => {
    expect(() => parseManifest("[project]\nname='x'\nversion='1'\n")).toThrow(ManifestError);
    expect(() =>
      parseManifest(
        "[project]\nname='x'\nversion='1'\n[game]\nminecraft='26.2'\nloader='vanilla'\nitems=[42]",
      ),
    ).toThrow(ManifestError);
  });
});

describe("version-spec grammar", () => {
  it("classifies pin / range / latest / omitted", () => {
    expect(parseVersionSpec("1.4.0")).toEqual({ kind: "pin", version: "1.4.0" });
    expect(parseVersionSpec("mc1.21-0.5.2")).toEqual({ kind: "pin", version: "mc1.21-0.5.2" });
    expect(parseVersionSpec("^1.4")).toEqual({ kind: "range", range: "^1.4" });
    expect(parseVersionSpec(">=1.2 <2")).toEqual({ kind: "range", range: ">=1.2 <2" });
    expect(parseVersionSpec("1.2.x")).toEqual({ kind: "range", range: "1.2.x" });
    expect(parseVersionSpec("latest")).toEqual({ kind: "latest" });
    expect(parseVersionSpec("*")).toEqual({ kind: "latest" });
    expect(parseVersionSpec(undefined)).toEqual({ kind: "latest" });
  });
});

describe("ref grammar", () => {
  it("parses source:id@ver, urls, and paths", () => {
    expect(parseRef("modrinth:sodium@0.5.8")).toEqual({
      source: "modrinth",
      id: "sodium",
      versionSpec: { kind: "pin", version: "0.5.8" },
    });
    expect(parseRef("modrinth:sodium")).toMatchObject({
      source: "modrinth",
      versionSpec: { kind: "latest" },
    });
    expect(parseRef("https://host/x.jar")).toMatchObject({
      source: "url",
      id: "https://host/x.jar",
    });
    expect(parseRef("./a/b.jar")).toMatchObject({ source: "local", id: "./a/b.jar" });
    // A url with an @ in it is not split on the version separator.
    expect(parseRef("https://host/x@1.jar").id).toBe("https://host/x@1.jar");
  });

  it("rejects a bare slug with no source prefix", () => {
    expect(() => parseRef("just-a-slug")).toThrow(ManifestError);
  });
});
