import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  GameAcquirer,
  buildInstance,
  comparePackages,
  currentPlatform,
  resolveGame,
  serializeLock,
} from "../../index.js";
import type { Lockfile } from "../../index.js";
import { listFiles, mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import {
  COMPONENT,
  FABRIC_LOADER,
  MC,
  loaderMetaBase,
  makeGameFixtures,
  mojangOptions,
  resourcesBase,
} from "../helpers/game.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;

async function resolveAndBuild(): Promise<{ dir: string; lock: Lockfile }> {
  const storeDir = await mkTmp("store");
  const instanceDir = await mkTmp("inst");
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
  const lock: Lockfile = {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "00" },
      minecraft: MC,
      loader: game.loader,
      java: game.java,
    },
    resolved: [...game.packages].sort(comparePackages),
  };
  const acquire = new GameAcquirer({ store, http, resourcesBase });
  await buildInstance({ instanceDir, lock, store, acquire, platform: currentPlatform() });
  return { dir: instanceDir, lock, storeDir } as unknown as { dir: string; lock: Lockfile };
}

describe("game install — full build gate", () => {
  const dirs: string[] = [];
  const track = (r: { dir: string } & Record<string, unknown>) => {
    dirs.push(r.dir);
    if (typeof r.storeDir === "string") {
      dirs.push(r.storeDir);
    }
    return r as { dir: string; lock: Lockfile };
  };
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("materializes a launch-ready instance (client, libs, host natives, assets, JRE)", async () => {
    const { dir } = track(await resolveAndBuild());
    const files = await listFiles(dir);
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.jar`);
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.json`);
    expect(files).toContain("libraries/com/example/base/1.0/base-1.0.jar");
    expect(files).toContain("libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar");
    expect(files).toContain("libraries/net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar");
    expect(files).toContain("assets/indexes/26.json");
    expect(files).toContain(`runtime/${COMPONENT}/linux/bin/java`);
    expect(files).toContain(`runtime/${COMPONENT}/linux/lib/x.txt`);
    // host = linux/x64 → only linux natives extracted; META-INF excluded.
    expect(files).toContain("natives/liblwjgl.so");
    expect(files.some((f) => f.includes("liblwjgl.dylib"))).toBe(false);
    expect(files.some((f) => f.includes("META-INF"))).toBe(false);
    // A different-OS JRE and an osx-only library are filtered out on this host.
    expect(files.some((f) => f.startsWith(`runtime/${COMPONENT}/mac-os`))).toBe(false);
    expect(files.some((f) => f.includes("java-objc-bridge"))).toBe(false);
  });

  it("preserves the JRE executable bit and the mac-bundle-style symlink", async () => {
    const { dir } = track(await resolveAndBuild());
    const javaBin = join(dir, `runtime/${COMPONENT}/linux/bin/java`);
    expect((await stat(javaBin)).mode & 0o111).not.toBe(0); // executable
    const plain = join(dir, `runtime/${COMPONENT}/linux/lib/x.txt`);
    expect((await stat(plain)).mode & 0o111).toBe(0); // not executable
    const link = join(dir, `runtime/${COMPONENT}/linux/bin/java-link`);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe("java");
  });

  it("emits a self-contained, deduped version.json (no inheritsFrom, loader mainClass)", async () => {
    const { dir } = track(await resolveAndBuild());
    const vj = JSON.parse(
      await readFile(join(dir, `versions/${FABRIC_ID}/${FABRIC_ID}.json`), "utf8"),
    );
    expect(vj.inheritsFrom).toBeUndefined();
    expect(vj.mainClass).toBe("net.fabricmc.loader.impl.launch.knot.KnotClient");
    const asm = (vj.libraries as { name: string }[]).filter((l) =>
      l.name.startsWith("org.ow2.asm:asm:"),
    );
    expect(asm.map((l) => l.name)).toEqual(["org.ow2.asm:asm:9.10.1"]);
  });

  it("GATE — determinism: two independent resolve+build cycles → byte-identical tree AND lock", async () => {
    const a = track(await resolveAndBuild());
    const b = track(await resolveAndBuild());
    const [ma, mb] = await Promise.all([treeManifest(a.dir), treeManifest(b.dir)]);
    expect(ma).toBe(mb);
    expect(ma.length).toBeGreaterThan(0);
    // Generated-file determinism is covered too — version.json is in the tree.
    expect(ma).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.json`);
    expect(serializeLock(a.lock)).toBe(serializeLock(b.lock));
  });
});
