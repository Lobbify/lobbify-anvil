import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, LocalSource, UrlSource } from "../../index.js";
import type { Http, SourceContext } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeBytes, fabricJar } from "../helpers/net.js";
import { makeZip } from "../helpers/zip.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

function ctx(http: Http | undefined, store: ContentStore): SourceContext {
  return {
    ...(http ? { http } : {}),
    offline: false,
    now: NOW,
    allowSource: () => true,
    store,
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
  };
}

describe("LocalSource", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("hashes a local jar, infers its kind, and admits it to the store", async () => {
    const work = await mkTmp("local");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(work, store.root);
    const jarPath = join(work, "cool-mod.jar");
    await writeFile(jarPath, Buffer.from(fabricJar("cool")));

    const { pkg } = await new LocalSource().resolve(
      { source: "local", id: jarPath, versionSpec: { kind: "latest" } },
      ctx(undefined, store),
    );
    expect(pkg.kind).toBe("mod");
    expect(pkg.source).toBe("local");
    expect(pkg.placement).toEqual({ method: "link", target: "mods/cool-mod.jar" });
    expect(pkg.url).toBe(pathToFileURL(jarPath).toString());
    expect(pkg.hash.algo).toBe("sha256");
    expect(await store.has(pkg.hash)).toBe(true);
  });

  it("LB-706: honors the placement target the ref declares, nesting and all", async () => {
    const work = await mkTmp("local");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(work, store.root);
    const cfgPath = join(work, "mixins.json");
    await writeFile(cfgPath, '{"nested":true}');

    const { pkg } = await new LocalSource().resolve(
      {
        source: "local",
        id: cfgPath,
        versionSpec: { kind: "latest" },
        kind: "config",
        target: "config/sodium/mixins.json",
      },
      ctx(undefined, store),
    );
    // Not `config/mixins.json` — the declared path is the placement, verbatim.
    expect(pkg.placement).toEqual({ method: "link", target: "config/sodium/mixins.json" });
  });

  it("LB-706: still places by KIND when the ref declares no target", async () => {
    const work = await mkTmp("local");
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(work, store.root);
    const jarPath = join(work, "outside.jar");
    await writeFile(jarPath, Buffer.from(fabricJar("outside")));

    const { pkg } = await new LocalSource().resolve(
      { source: "local", id: jarPath, versionSpec: { kind: "latest" } },
      ctx(undefined, store),
    );
    expect(pkg.placement).toEqual({ method: "link", target: "mods/outside.jar" });
  });
});

describe("UrlSource", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("downloads, hashes, and places a jar as a mod", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const url = "https://files.example.com/downloads/mymod.jar";
    const http = new FakeBytes().set(url, fabricJar("mymod"));
    const { pkg } = await new UrlSource().resolve(
      { source: "url", id: url, versionSpec: { kind: "latest" } },
      ctx(http, store),
    );
    expect(pkg.kind).toBe("mod");
    expect(pkg.placement).toEqual({ method: "link", target: "mods/mymod.jar" });
    expect(pkg.url).toBe(url);
    expect(await store.has(pkg.hash)).toBe(true);
  });

  it("infers a resourcepack from a pack.mcmeta zip and places it under resourcepacks/", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const url = "https://files.example.com/packs/shiny.zip";
    const zip = new Uint8Array(
      makeZip([
        { name: "pack.mcmeta", data: "{}" },
        { name: "assets/minecraft/x.png", data: "p" },
      ]),
    );
    const http = new FakeBytes().set(url, zip);
    const { pkg } = await new UrlSource().resolve(
      { source: "url", id: url, versionSpec: { kind: "latest" } },
      ctx(http, store),
    );
    expect(pkg.kind).toBe("resourcepack");
    expect(pkg.placement).toEqual({ method: "link", target: "resourcepacks/shiny.zip" });
  });
});
