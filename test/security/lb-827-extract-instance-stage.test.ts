/**
 * LB-827 round 3 — `executePlacement`'s `extract` placement (a natives jar's own
 * contents) unpacks straight onto the build's instance stage — NOT a throwaway
 * directory. That distinguishes it from `import/pack-common.ts`'s override-tree
 * import, which is what made leaving `safeExtract` ungated there defensible: this
 * extraction lands somewhere real, so an unguarded colon-bearing entry inside the
 * archive would too.
 *
 * `safeJoin`'s `rejectColon: true` on `destDir` (already in place since round 2)
 * only protects the EXTRACT DIRECTORY's own name — it says nothing about what is
 * *inside* the archive `safeExtract` then unpacks into it. This file proves the
 * second half is closed too, end to end through the real placement executor
 * (`buildInstance` → `executePlacement` → `safeExtract`), not just at the
 * `safeExtract` unit level covered in test/store/safe-extract.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  FixtureAcquirer,
  type LockPackage,
  type Lockfile,
  PathEscape,
  buildInstance,
  currentPlatform,
} from "../../index.js";
import { hashOf, listFiles, mkTmp, rmTmp, writeFixture } from "../helpers/fixtures.js";
import { makeZip } from "../helpers/zip.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

function lockOf(pkg: LockPackage): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: hashOf(Buffer.from("manifest"), "sha256"),
      minecraft: "26.2",
      loader: "vanilla",
      java: "runtime-gamma-21",
    },
    resolved: [pkg],
  };
}

// natives-shaped package: kind "library" + `extract` placement, matching
// test/helpers/scenario.ts's convention. The name deliberately does NOT match
// `:natives-<classifier>` so `assertNativesSatisfiable`'s per-arch gap check
// (unrelated to this ticket) does not fire and mask the assertion under test.
function extractPkg(hash: LockPackage["hash"], size: number): LockPackage {
  return {
    name: "natives",
    kind: "library",
    source: "mojang",
    hash,
    provenance: "copy",
    placement: { method: "extract", targetDir: "natives" },
    size,
  };
}

describe("buildInstance → executePlacement (extract) — a ':'-bearing archive entry is refused (LB-827 round 3)", () => {
  it("refuses a natives jar carrying a ':'-named entry, and nothing reaches the live instance tree", async () => {
    const poolDir = await mkTmp("pool");
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });

    const nativesZip = makeZip([
      { name: "libfoo.so", data: "FINE" },
      // The NTFS ADS trigger, LB-827: this string is a legal (if unusual) POSIX
      // filename inside a real natives jar an attacker fully controls (a hostile
      // `url`-source library, or a compromised upstream artifact) — never the
      // pinned Mojang natives themselves, but the placement executor cannot
      // assume that, and must not trust archive contents either way.
      { name: "evil:stream.dll", data: "ADS-PAYLOAD" },
    ]);
    const hash = await writeFixture(poolDir, nativesZip, "sha256");

    await expect(
      buildInstance({
        instanceDir,
        lock: lockOf(extractPkg(hash, nativesZip.length)),
        store,
        acquire: new FixtureAcquirer(store, poolDir),
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(PathEscape);

    // The failure is mid-stage, before the atomic swap — so the LIVE instance
    // tree (everything but `.anvil/`, which may hold a half-written, reaped-on-
    // next-build stage) must carry nothing from this natives jar at all.
    const files = await listFiles(instanceDir);
    const visible = files.filter((f) => !f.startsWith(".anvil/"));
    expect(visible).toEqual([]);
  });

  it("negative control: the identical natives jar WITHOUT a colon entry builds and extracts normally", async () => {
    const poolDir = await mkTmp("pool");
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(poolDir, instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir });

    const nativesZip = makeZip([
      { name: "libfoo.so", data: "FINE" },
      { name: "sub/libbar.so", data: "ALSO-FINE" },
    ]);
    const hash = await writeFixture(poolDir, nativesZip, "sha256");

    await buildInstance({
      instanceDir,
      lock: lockOf(extractPkg(hash, nativesZip.length)),
      store,
      acquire: new FixtureAcquirer(store, poolDir),
      platform: currentPlatform(),
    });

    const files = await listFiles(instanceDir);
    expect(files).toContain("natives/libfoo.so");
    expect(files).toContain("natives/sub/libbar.so");
  });
});
