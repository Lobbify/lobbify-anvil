/**
 * Stage-7 gate — Prism/MultiMC import re-identifies jars.
 *
 * Each local jar is re-identified through the {@link IdentityResolver} seam: a
 * Modrinth-recognized jar becomes a **copy** item, a CurseForge-fingerprinted jar
 * becomes a **replay** item (no rehostable URL), and an unrecognized jar stays a
 * **local** override.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type IdentityResolver,
  curseforgeFingerprint,
  importPrism,
  readLock,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, sha1hex } from "../helpers/net.js";

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
});
