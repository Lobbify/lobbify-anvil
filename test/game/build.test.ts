import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  GameAcquirer,
  buildInstance,
  comparePackages,
  currentPlatform,
  nativesClassifierOf,
  packageAppliesToPlatform,
  resolveGame,
  serializeLock,
} from "../../index.js";
import type { LockPackage, Lockfile } from "../../index.js";
import { listFiles, mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import {
  COMPONENT,
  FABRIC_LOADER,
  MC,
  NATIVE_SO_BY_CLASSIFIER,
  loaderMetaBase,
  makeGameFixtures,
  mojangOptions,
  resourcesBase,
} from "../helpers/game.js";

const FABRIC_ID = `fabric-loader-${FABRIC_LOADER}-${MC}`;

/**
 * The single `runtime-tree` (JRE) package this HOST will get, resolved through
 * the exact `packageAppliesToPlatform` gate `buildInstance` itself uses — never a
 * hardcoded OS name. See LB-816: a hardcoded `linux/` segment here is what made
 * this suite fail on every macOS/Windows runner while ubuntu stayed green.
 */
function runtimeTargetDir(lock: Lockfile): string {
  const platform = currentPlatform();
  const applicable = lock.resolved.filter(
    (p): p is LockPackage & { placement: { method: "runtime-tree"; targetDir: string } } =>
      p.placement.method === "runtime-tree" && packageAppliesToPlatform(p, platform),
  );
  expect(applicable).toHaveLength(1);
  const [pkg] = applicable;
  if (!pkg) {
    throw new Error("unreachable — length checked above");
  }
  return pkg.placement.targetDir;
}

/**
 * The single natives library this HOST will get, resolved the same way — then
 * mapped to the fixture's filename for that classifier (host detection stays
 * production code; only "what did the fixture name the file" is test-owned).
 */
function nativeSoForHost(lock: Lockfile): string {
  const platform = currentPlatform();
  const applicable = lock.resolved.filter(
    (p) =>
      p.placement.method === "extract" &&
      nativesClassifierOf(p.name) !== undefined &&
      packageAppliesToPlatform(p, platform),
  );
  expect(applicable).toHaveLength(1);
  const [pkg] = applicable;
  if (!pkg) {
    throw new Error("unreachable — length checked above");
  }
  const classifier = nativesClassifierOf(pkg.name);
  const so = classifier ? NATIVE_SO_BY_CLASSIFIER[classifier] : undefined;
  if (!so) {
    throw new Error(`no fixture native filename recorded for classifier "${classifier}"`);
  }
  return so;
}

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
    const { dir, lock } = track(await resolveAndBuild());
    const files = await listFiles(dir);
    const runtimeDir = runtimeTargetDir(lock);
    const nativeSo = nativeSoForHost(lock);
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.jar`);
    expect(files).toContain(`versions/${FABRIC_ID}/${FABRIC_ID}.json`);
    expect(files).toContain("libraries/com/example/base/1.0/base-1.0.jar");
    expect(files).toContain("libraries/org/ow2/asm/asm/9.10.1/asm-9.10.1.jar");
    expect(files).toContain("libraries/net/fabricmc/fabric-loader/0.19.3/fabric-loader-0.19.3.jar");
    expect(files).toContain("assets/indexes/26.json");
    expect(files).toContain(`${runtimeDir}/bin/java`);
    expect(files).toContain(`${runtimeDir}/lib/x.txt`);
    expect(files).toContain(`natives/${nativeSo}`);
    expect(files.some((f) => f.includes("META-INF"))).toBe(false);
    // Only the host's OWN JRE tree is extracted — every other platform's runtime
    // dir under the same component is absent. Stronger than excluding one other
    // OS by name: this holds on whichever platform actually runs the suite.
    const runtimeFiles = files.filter((f) => f.startsWith(`runtime/${COMPONENT}/`));
    expect(runtimeFiles.every((f) => f.startsWith(`${runtimeDir}/`))).toBe(true);
    // Likewise: only the host's own native, nothing from another OS/arch.
    const nativesFiles = files.filter((f) => f.startsWith("natives/"));
    expect(nativesFiles).toEqual([`natives/${nativeSo}`]);
    // java-objc-bridge is osx-only per its Mojang rule — assert it against the
    // SAME production gate the build used, rather than assuming a host OS.
    const objcApplies = lock.resolved.some(
      (p) =>
        p.name === "ca.weblite:java-objc-bridge:1.1" &&
        packageAppliesToPlatform(p, currentPlatform()),
    );
    expect(files.some((f) => f.includes("java-objc-bridge"))).toBe(objcApplies);
  });

  it("preserves the JRE executable bit and the mac-bundle-style symlink", async () => {
    const { dir, lock } = track(await resolveAndBuild());
    const runtimeDir = runtimeTargetDir(lock);
    const javaBin = join(dir, runtimeDir, "bin/java");
    const plain = join(dir, runtimeDir, "lib/x.txt");
    const link = join(dir, runtimeDir, "bin/java-link");

    if (currentPlatform().os === "windows") {
      // Windows has no POSIX executable bit. Node/libuv derive `stat().mode`'s
      // exec bits from the file EXTENSION (.exe/.cmd/.bat/.com), never from
      // `chmod` — and `fs.chmod` on Windows only ever toggles the read-only
      // attribute, so RUNTIME_MODE_EXEC vs RUNTIME_MODE_PLAIN are indistinguishable
      // there. Asserting `mode & 0o111` here would assert a POSIX concept Windows
      // doesn't have. See LB-816 — flagged unverified locally; CI confirms this.
      expect((await stat(javaBin)).isFile()).toBe(true);
      expect((await stat(plain)).isFile()).toBe(true);
    } else {
      expect((await stat(javaBin)).mode & 0o111).not.toBe(0); // executable
      expect((await stat(plain)).mode & 0o111).toBe(0); // not executable
    }

    const linkStat = await lstat(link);
    expect(linkStat.isSymbolicLink()).toBe(true);
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
