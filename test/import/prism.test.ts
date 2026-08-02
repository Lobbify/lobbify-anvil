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
    // The item reads from the tracked copy and declares its placement (LB-719).
    expect(result.manifest.items).toContainEqual({
      path: ".anvil/overrides/mods/26.2/nested.jar",
      kind: "mod",
      target: "mods/26.2/nested.jar",
    });

    // Nothing is written to `mods/26.2/nested.jar` here: since LB-719 the
    // manifest reads from the tracked copy, so the re-lock below needs no build
    // to have run first.

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

  // POSIX-only: the fixture writes a real `mypack:v2.zip` on disk, which is a
  // legal filename on Linux/macOS and is not a filename at all on NTFS. There
  // the write is redirected into an Alternate Data Stream and leaves a PRIMARY
  // file named `mypack` behind — no colon in it — so the importer's walk finds
  // an ordinary file, `isUnsafePackPath` has nothing to match, and it imports.
  // Windows CI showed exactly that: `expected 1 to be +0`.
  //
  // ⚠️ That side effect is a real (minor, zero-length, Windows-only) gap in its
  // own right and is filed as LB-844 — the guard inspects the string it was
  // handed and the filesystem hands the next stage a different one. It is NOT
  // what this test is for: this one guards the regression where a user's own
  // colon-named file produced a permanently unlockable instance, which cannot
  // happen on Windows because the file cannot exist there to begin with.
  it.skipIf(process.platform === "win32")(
    "LB-827: an unmatched file with a ':'-bearing path is skipped, not turned into an unlockable instance",
    async () => {
      // Regression for a round-3 finding: importPrism's unmatched-local case wrote
      // packRel straight into the manifest item's `target` — untouched by
      // isUnsafePackPath/declaredPlacementTarget — so import "succeeded" with
      // warnings: [] while quietly writing a manifest that declaredPlacementTarget
      // refuses UNCONDITIONALLY at lock time. Every later `anvil lock` (and every
      // build, which locks internally) then threw PathEscape forever. The Prism
      // instance itself is trusted content (the user's own install, not a hostile
      // pack) — the fix is not "distrust Prism", it's "don't emit a manifest
      // target the importer's own lock-time gate will refuse".
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
      await mkdir(join(prismDir, ".minecraft", "resourcepacks"), { recursive: true });
      // An ordinary POSIX filename — legal on the user's real disk, exactly the
      // shape LB-827 is about: a colon inside a single segment, no traversal.
      await writeFile(
        join(prismDir, ".minecraft", "resourcepacks", "mypack:v2.zip"),
        fabricJar("mypack"),
      );

      const identify: IdentityResolver = {
        async matchModrinth() {
          return undefined; // unmatched, on purpose — exercises the local-file branch
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

      // Import succeeds outright (LB-827: "successfully imports with warnings: []"
      // is exactly the bug — assert that path is now correctly NOT taken silently:
      // it succeeds, but says so and carries nothing for the bad file).
      expect(result.local).toBe(0);
      expect(result.warnings.join("\n")).toContain("mypack:v2.zip");
      expect(result.manifest.items).toEqual([]);
      expect(result.lock.resolved.filter((p) => p.source === "local")).toEqual([]);

      // The assertion that actually makes this a regression test rather than a
      // spot check: the resulting instance LOCKS. Before the fix this threw
      // PathEscape — the exact "every later anvil lock refuses" failure mode.
      const relocked = await resolveManifest({
        manifest: result.manifest,
        registry: registryWith({}),
        allowSource: () => true,
        now: Date.now(),
        baseDir: instanceDir,
        store,
        lockedPins: pinsFromLock(result.lock),
      });
      expect(relocked.resolved.filter((p) => p.source === "local")).toEqual([]);
    },
  );
});
