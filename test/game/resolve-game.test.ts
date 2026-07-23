import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, resolveGame } from "../../index.js";
import type { LockPackage } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  COMPONENT,
  FABRIC_LOADER,
  MC,
  loaderMetaBase,
  makeGameFixtures,
  mojangOptions,
} from "../helpers/game.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;

describe("resolveGame — Fabric install produces the full pinned game", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function resolve() {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });
    const { http } = makeGameFixtures();
    const game = await resolveGame({
      minecraft: MC,
      loader: `fabric ${FABRIC_LOADER}`,
      mojangHttp: http,
      loaderHttp: http,
      store,
      mojangOptions,
      loaderMetaBase,
    });
    const byName = new Map(game.packages.map((p) => [p.name, p] as const));
    return { game, store, byName };
  }

  it("sets meta.java (component) and the resolved loader label", async () => {
    const { game } = await resolve();
    expect(game.java).toBe(COMPONENT);
    expect(game.loader).toBe(`fabric ${FABRIC_LOADER}`);
    expect(game.profileId).toBe(FABRIC_ID);
  });

  it("pins the client jar (sha1) beside the flattened loader profile", async () => {
    const { byName } = await resolve();
    const client = byName.get("minecraft-client") as LockPackage;
    expect(client.kind).toBe("game");
    expect(client.hash.algo).toBe("sha1");
    expect(client.placement).toEqual({
      method: "link",
      target: `versions/${FABRIC_ID}/${FABRIC_ID}.jar`,
    });
  });

  it("generates + pins the merged version.json (sha256, no url) and admits it to the store", async () => {
    const { byName, store } = await resolve();
    const vj = byName.get("minecraft-version-json") as LockPackage;
    expect(vj.hash.algo).toBe("sha256");
    expect(vj.url).toBeUndefined();
    expect(vj.placement).toEqual({
      method: "link",
      target: `versions/${FABRIC_ID}/${FABRIC_ID}.json`,
    });
    expect(await store.has(vj.hash)).toBe(true); // generated → admitted at lock
  });

  it("pins the asset index (sha1, asset-tree) and the per-platform JRE (runtime-tree, targeted)", async () => {
    const { byName } = await resolve();
    const assets = byName.get("assets-26") as LockPackage;
    expect(assets.placement).toEqual({
      method: "asset-tree",
      indexTarget: "assets/indexes/26.json",
    });

    const jreLinux = byName.get(`java-runtime:${COMPONENT}:linux`) as LockPackage;
    expect(jreLinux.kind).toBe("java");
    expect(jreLinux.hash.algo).toBe("sha1"); // pinned by the manifest sha1, not just the component
    expect(jreLinux.placement).toEqual({
      method: "runtime-tree",
      targetDir: `runtime/${COMPONENT}/linux`,
    });
    expect(jreLinux.targets).toEqual([{ os: "linux", arch: "x64" }]);
    // Every mapped platform is pinned so a build on any host finds its JRE.
    expect(byName.has(`java-runtime:${COMPONENT}:mac-os-arm64`)).toBe(true);
    expect(byName.has(`java-runtime:${COMPONENT}:windows-x64`)).toBe(true);
  });

  it("targets per-OS natives by classifier arch and gates an osx-only library", async () => {
    const { byName } = await resolve();
    const natLinux = byName.get("org.lwjgl:lwjgl:3.4.1:natives-linux") as LockPackage;
    expect(natLinux.placement).toEqual({ method: "extract", targetDir: "natives" });
    expect(natLinux.targets).toEqual([{ os: "linux", arch: "x64" }]);
    expect(
      (byName.get("org.lwjgl:lwjgl:3.4.1:natives-macos-arm64") as LockPackage).targets,
    ).toEqual([{ os: "osx", arch: "arm64" }]);
    // A rules-gated (osx-only) plain library carries os-only targets (any arch).
    expect((byName.get("ca.weblite:java-objc-bridge:1.1") as LockPackage).targets).toEqual([
      { os: "osx" },
    ]);
    // A universal library carries no targets.
    expect((byName.get("com.example:base:1.0") as LockPackage).targets).toBeUndefined();
  });

  it("pins Fabric loader libraries by sha256 from metadata (no lock download) and admits nothing extra to fetch", async () => {
    const { byName, store } = await resolve();
    const asm = byName.get("org.ow2.asm:asm:9.10.1") as LockPackage;
    expect(asm.kind).toBe("library");
    expect(asm.source).toBe("url");
    expect(asm.hash.algo).toBe("sha256");
    const loader = byName.get("net.fabricmc:fabric-loader:0.19.3") as LockPackage;
    expect(loader.kind).toBe("loader");
    // Fabric libs pin from metadata but their bytes are fetched at build — the
    // store need not hold them after lock (only the generated version.json must).
    expect(await store.has(asm.hash)).toBe(false);
    // The vanilla asm 9.7 and the loader asm 9.10.1 coexist as distinct pins.
    expect(byName.has("org.ow2.asm:asm:9.7")).toBe(true);
  });

  it("an unpinned loader resolves to newest-stable, but a re-lock reuses the prior version", async () => {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });
    const { http } = makeGameFixtures();
    const common = {
      minecraft: MC,
      loader: "fabric",
      mojangHttp: http,
      loaderHttp: http,
      store,
      mojangOptions,
      loaderMetaBase,
    };

    // First lock (unpinned) → newest stable (0.19.3).
    const fresh = await resolveGame(common);
    expect(fresh.loader).toBe(`fabric ${FABRIC_LOADER}`);
    expect(fresh.profileId).toBe(FABRIC_ID);

    // A re-lock that reuses the prior version stays on 0.19.2 (no silent bump).
    const relock = await resolveGame({ ...common, reuseLoaderVersion: "0.19.2" });
    expect(relock.loader).toBe("fabric 0.19.2");
    expect(relock.profileId).toBe(`fabric-loader-0.19.2-${MC}`);
  });
});
