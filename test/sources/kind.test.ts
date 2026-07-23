import { describe, expect, it } from "vitest";
import { KindInferenceFailed, inferKind } from "../../index.js";
import { makeZip } from "../helpers/zip.js";

const jarWithFabric = () =>
  new Uint8Array(
    makeZip([
      { name: "fabric.mod.json", data: '{"id":"x"}' },
      { name: "x/Y.class", data: "" },
    ]),
  );
const resourcepack = () =>
  new Uint8Array(
    makeZip([
      { name: "pack.mcmeta", data: "{}" },
      { name: "assets/minecraft/x.png", data: "p" },
    ]),
  );
const datapack = () =>
  new Uint8Array(
    makeZip([
      { name: "pack.mcmeta", data: "{}" },
      { name: "data/ns/fn.json", data: "d" },
    ]),
  );
const shaders = () =>
  new Uint8Array(
    makeZip([
      { name: "shaders/world.fsh", data: "s" },
      { name: "shaders/x.vsh", data: "v" },
    ]),
  );
const ambiguous = () =>
  new Uint8Array(
    makeZip([
      { name: "pack.mcmeta", data: "{}" },
      { name: "assets/x", data: "a" },
      { name: "data/y", data: "b" },
    ]),
  );

describe("kind inference", () => {
  it("prefers an explicit kind above all", async () => {
    expect(await inferKind({ subject: "x", explicit: "shaderpack", bytes: jarWithFabric() })).toBe(
      "shaderpack",
    );
  });

  it("maps Modrinth project types", async () => {
    expect(await inferKind({ subject: "x", projectType: "mod" })).toBe("mod");
    expect(await inferKind({ subject: "x", projectType: "resourcepack" })).toBe("resourcepack");
    expect(await inferKind({ subject: "x", projectType: "shader" })).toBe("shaderpack");
    expect(await inferKind({ subject: "x", projectType: "datapack" })).toBe("datapack");
    await expect(inferKind({ subject: "x", projectType: "modpack" })).rejects.toBeInstanceOf(
      KindInferenceFailed,
    );
  });

  it("introspects jar/zip archives", async () => {
    expect(await inferKind({ subject: "x", filename: "x.jar", bytes: jarWithFabric() })).toBe(
      "mod",
    );
    expect(await inferKind({ subject: "x", filename: "rp.zip", bytes: resourcepack() })).toBe(
      "resourcepack",
    );
    expect(await inferKind({ subject: "x", filename: "dp.zip", bytes: datapack() })).toBe(
      "datapack",
    );
    expect(await inferKind({ subject: "x", filename: "sh.zip", bytes: shaders() })).toBe(
      "shaderpack",
    );
  });

  it("refuses to guess a genuinely ambiguous pack.mcmeta zip", async () => {
    await expect(
      inferKind({ subject: "mystery.zip", filename: "mystery.zip", bytes: ambiguous() }),
    ).rejects.toBeInstanceOf(KindInferenceFailed);
  });

  it("falls back to the extension, refusing unknown ones", async () => {
    expect(await inferKind({ subject: "x", filename: "a.jar" })).toBe("mod");
    await expect(inferKind({ subject: "x", filename: "a.bin" })).rejects.toBeInstanceOf(
      KindInferenceFailed,
    );
  });
});
