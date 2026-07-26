/**
 * Stage-7 gate — Prism/MultiMC import re-identifies jars.
 *
 * Each local jar is re-identified through the {@link IdentityResolver} seam: a
 * Modrinth-recognized jar becomes a **copy** item, a CurseForge-fingerprinted jar
 * becomes a **replay** item (no rehostable URL), and an unrecognized jar stays a
 * **local** override.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type IdentityResolver,
  curseforgeFingerprint,
  importPrism,
  pinsFromLock,
  readLock,
  resolveManifest,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith, sha1hex } from "../helpers/net.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

describe("Prism import", () => {
  it("matched Modrinth → copy, matched CurseForge → replay, unmatched → local", async () => {
    const prismDir = await mkTmp("prism");
    const instanceDir = await mkTmp("prism-inst");
    const storeDir = await mkTmp("prism-store");
    dirs.push(prismDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });

    await writeFile(
      join(prismDir, "mmc-pack.json"),
      JSON.stringify({
        formatVersion: 1,
        components: [
          { uid: "net.minecraft", version: "26.2" },
          { uid: "net.fabricmc.fabric-loader", version: "0.19.1" },
        ],
      }),
    );
    await mkdir(join(prismDir, ".minecraft", "mods"), { recursive: true });
    const alpha = fabricJar("alpha"); // → Modrinth
    const bravo = fabricJar("bravo"); // → CurseForge
    const charlie = fabricJar("charlie"); // → unmatched (local)
    await writeFile(join(prismDir, ".minecraft", "mods", "alpha.jar"), alpha);
    await writeFile(join(prismDir, ".minecraft", "mods", "bravo.jar"), bravo);
    await writeFile(join(prismDir, ".minecraft", "mods", "charlie.jar"), charlie);

    const alphaSha1 = sha1hex(alpha);
    const bravoFp = curseforgeFingerprint(bravo);
    const identify: IdentityResolver = {
      async matchModrinth(sha1) {
        return sha1 === alphaSha1
          ? { slug: "alpha", versionNumber: "1.2.3", url: "https://cdn.modrinth.com/a.jar" }
          : undefined;
      },
      async matchCurseForge(fp) {
        return fp === bravoFp ? { projectId: 111, fileId: 222, slug: "bravo" } : undefined;
      },
    };

    const result = await importPrism({
      prismDir,
      instanceDir,
      store,
      resolveGame: async () => ({ packages: [], java: "runtime-j", loader: "fabric 0.19.1" }),
      identify,
    });

    expect(result.modrinth).toBe(1);
    expect(result.curseforge).toBe(1);
    expect(result.local).toBe(1);

    const lock = await readLock(instanceDir);
    const alphaPkg = lock.resolved.find((p) => p.source === "modrinth");
    const bravoPkg = lock.resolved.find((p) => p.source === "curseforge");
    const charliePkg = lock.resolved.find((p) => p.source === "local");

    expect(alphaPkg?.provenance).toBe("copy");
    expect(alphaPkg?.url).toBe("https://cdn.modrinth.com/a.jar");

    // The CurseForge match is replay + carries NO rehostable url (ToS).
    expect(bravoPkg?.provenance).toBe("replay");
    expect(bravoPkg?.url).toBeUndefined();
    expect(bravoPkg?.project).toBe(111);
    expect(bravoPkg?.file).toBe(222);

    expect(charliePkg?.provenance).toBe("copy");
    expect(charliePkg?.source).toBe("local");
  });

  it("LB-706: an unmatched jar in a SUBDIRECTORY keeps its path across a re-lock", async () => {
    const prismDir = await mkTmp("prism");
    const instanceDir = await mkTmp("prism-inst");
    const storeDir = await mkTmp("prism-store");
    dirs.push(prismDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });

    await writeFile(
      join(prismDir, "mmc-pack.json"),
      JSON.stringify({
        formatVersion: 1,
        components: [
          { uid: "net.minecraft", version: "26.2" },
          { uid: "net.fabricmc.fabric-loader", version: "0.19.1" },
        ],
      }),
    );
    // Fabric's version-nested convention: mods/<mc-version>/<jar>.
    await mkdir(join(prismDir, ".minecraft", "mods", "26.2"), { recursive: true });
    const nested = fabricJar("nested");
    await writeFile(join(prismDir, ".minecraft", "mods", "26.2", "nested.jar"), nested);

    const identify: IdentityResolver = {
      async matchModrinth() {
        return undefined;
      },
      async matchCurseForge() {
        return undefined;
      },
    };

    const result = await importPrism({
      prismDir,
      instanceDir,
      store,
      resolveGame: async () => ({ packages: [], java: "runtime-j", loader: "fabric 0.19.1" }),
      identify,
    });

    expect(result.local).toBe(1);
    const imported = result.lock.resolved.find((p) => p.source === "local");
    expect(imported?.placement).toEqual({ method: "link", target: "mods/26.2/nested.jar" });
    expect(result.manifest.items).toContainEqual({ path: "mods/26.2/nested.jar", kind: "mod" });

    // What a build puts on disk, which is what a later `lock` re-reads.
    const built = join(instanceDir, "mods", "26.2", "nested.jar");
    await mkdir(dirname(built), { recursive: true });
    await writeFile(built, nested);

    // The round trip: re-resolving the manifest must reproduce the SAME target.
    // Before LB-706 the local source rebuilt it from kind + basename, so this
    // came back as "mods/nested.jar" and the next build moved the file.
    const relocked = await resolveManifest({
      manifest: result.manifest,
      registry: registryWith({}),
      allowSource: () => true,
      now: Date.now(),
      baseDir: instanceDir,
      store,
      lockedPins: pinsFromLock(result.lock),
    });
    expect(relocked.resolved.find((p) => p.source === "local")?.placement).toEqual({
      method: "link",
      target: "mods/26.2/nested.jar",
    });
  });

  it("LB-706: a RE-IDENTIFIED jar in a subdirectory is placed by kind, and says so", async () => {
    const prismDir = await mkTmp("prism");
    const instanceDir = await mkTmp("prism-inst");
    const storeDir = await mkTmp("prism-store");
    dirs.push(prismDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });

    await writeFile(
      join(prismDir, "mmc-pack.json"),
      JSON.stringify({
        formatVersion: 1,
        components: [
          { uid: "net.minecraft", version: "26.2" },
          { uid: "net.fabricmc.fabric-loader", version: "0.19.1" },
        ],
      }),
    );
    await mkdir(join(prismDir, ".minecraft", "mods", "26.2"), { recursive: true });
    const alpha = fabricJar("alpha");
    await writeFile(join(prismDir, ".minecraft", "mods", "26.2", "alpha.jar"), alpha);
    const alphaSha1 = sha1hex(alpha);

    const result = await importPrism({
      prismDir,
      instanceDir,
      store,
      resolveGame: async () => ({ packages: [], java: "runtime-j", loader: "fabric 0.19.1" }),
      identify: {
        async matchModrinth(sha1) {
          return sha1 === alphaSha1
            ? { slug: "alpha", versionNumber: "1.2.3", url: "https://cdn.modrinth.com/a.jar" }
            : undefined;
        },
        async matchCurseForge() {
          return undefined;
        },
      },
    });

    // A matched item is recorded as a bare `modrinth:alpha` ref, which carries no
    // path — so every `anvil lock` re-derives `mods/alpha.jar`. Preserving the
    // subdirectory only in the import lock would put the lock and every re-lock
    // into silent disagreement, which is the bug LB-706 is about. It is flattened
    // once, at import, and REPORTED rather than moved quietly.
    expect(result.lock.resolved.find((p) => p.source === "modrinth")?.placement).toEqual({
      method: "link",
      target: "mods/alpha.jar",
    });
    expect(result.warnings.join("\n")).toContain("mods/26.2/alpha.jar");
    expect(result.warnings.join("\n")).toContain("mods/alpha.jar");
  });
});
