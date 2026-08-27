/**
 * `importOverrideTree`'s two path guards, unit-tested directly (LB-922).
 *
 * `destRel` (the pack-relative path *inside* the tree) already had a home for
 * this kind of test — the mrpack/cfzip import suites drive a hostile archive
 * end to end. `subdir` (the `.anvil/` directory the tree is tracked under)
 * has no such home: it is never populated from an archive or the CLI, only
 * from a literal one of this file's own callers chose, so the only way to
 * exercise it is to call `importOverrideTree` directly with a bad one.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_TRACKED_SUBDIR,
  ContentStore,
  type LockPackage,
  PathEscape,
  REPLAY_CACHE_DIRNAME,
  importOverrideTree,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeZip } from "../helpers/zip.js";

function overridesZip(): Buffer {
  return makeZip([{ name: "overrides/config/ok.txt", data: "fine\n" }]);
}

describe("importOverrideTree — trackedSubdir guard", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function tmp(prefix: string): Promise<string> {
    const d = await mkTmp(prefix);
    dirs.push(d);
    return d;
  }

  // The guard must fire before the (possibly nonexistent) archive is ever
  // touched, so the refusal cases below point at a path nothing writes —
  // reaching `safeExtract` on it would throw ENOENT, not PathEscape, and that
  // would be the wrong failure for these tests to pass on.
  async function callWith(trackedSubdir: string | undefined) {
    const instanceDir = await tmp("inst");
    const archivePath = join(instanceDir, "..", "never-read.zip");
    const store = new ContentStore({ root: await tmp("store") });
    const placeable = new Map<string, LockPackage>();
    const warnings: string[] = [];
    const count = await importOverrideTree({
      archivePath,
      instanceDir,
      store,
      prefixes: ["overrides"],
      placeable,
      warnings,
      onStored: () => {},
      ...(trackedSubdir === undefined ? {} : { trackedSubdir }),
    });
    return { count, instanceDir, placeable, warnings };
  }

  // For the legitimate-caller cases the guard must NOT fire, so the run has
  // to actually reach `safeExtract` — build the fixture archive for real.
  async function callWithRealArchive(trackedSubdir: string | undefined) {
    const instanceDir = await tmp("inst");
    const archivePath = join(instanceDir, "..", "real-pack.zip");
    await writeFile(archivePath, overridesZip());
    const store = new ContentStore({ root: await tmp("store") });
    const placeable = new Map<string, LockPackage>();
    const warnings: string[] = [];
    const count = await importOverrideTree({
      archivePath,
      instanceDir,
      store,
      prefixes: ["overrides"],
      placeable,
      warnings,
      onStored: () => {},
      ...(trackedSubdir === undefined ? {} : { trackedSubdir }),
    });
    return { count, instanceDir, placeable, warnings };
  }

  it("GUARD FIRES: refuses a subdir naming the replay cache, before touching the archive", async () => {
    // The realistic variant LB-922 flags: a caller passing the replay cache's
    // own directory name (or constant) as trackedSubdir would let pack-
    // controlled bytes land inside `.anvil/replay-cache/`.
    await expect(callWith(REPLAY_CACHE_DIRNAME)).rejects.toThrow(PathEscape);
    await expect(callWith("replay-cache")).rejects.toThrow(PathEscape);
  });

  it("GUARD FIRES: refuses the empty-string subdir named in the ticket", async () => {
    await expect(callWith("")).rejects.toThrow(PathEscape);
  });

  it("GUARD FIRES: refuses a traversal or absolute subdir", async () => {
    await expect(callWith("../../etc")).rejects.toThrow(PathEscape);
    await expect(callWith("/etc")).rejects.toThrow(PathEscape);
  });

  it("GUARD FIRES: refuses an arbitrary unlisted subdir", async () => {
    await expect(callWith("objects")).rejects.toThrow(PathEscape);
    await expect(callWith("overrides-evil")).rejects.toThrow(PathEscape);
  });

  it("the refusal names the subdir and never reaches the filesystem", async () => {
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      importOverrideTree({
        archivePath: join(instanceDir, "..", "never-read.zip"),
        instanceDir,
        store,
        prefixes: ["overrides"],
        placeable: new Map(),
        warnings: [],
        onStored: () => {},
        trackedSubdir: "replay-cache",
      }),
    ).rejects.toThrow(/replay-cache/);
    // Refused before `ensureDir(stageDir)` / `safeExtract` ever ran — no
    // `.anvil/` directory of any kind was created.
    expect(await pathExists(join(instanceDir, ".anvil"))).toBe(false);
  });

  it("legitimate caller values still pass: the default 'overrides' subdir", async () => {
    const { count, placeable, warnings } = await callWithRealArchive(undefined);
    expect(warnings).toEqual([]);
    expect(count).toBe(1);
    expect(placeable.has("config/ok.txt")).toBe(true);
  });

  it("legitimate caller values still pass: base resolution's 'base' subdir", async () => {
    const { count, instanceDir, warnings } = await callWithRealArchive(BASE_TRACKED_SUBDIR);
    expect(warnings).toEqual([]);
    expect(count).toBe(1);
    expect(await pathExists(join(instanceDir, ".anvil", "base", "config", "ok.txt"))).toBe(true);
  });

  it("pin: BASE_TRACKED_SUBDIR is still 'base' — pack-common.ts hardcodes this literal to avoid an import cycle", () => {
    // mrpack-base.ts (which defines BASE_TRACKED_SUBDIR) imports
    // importOverrideTree FROM pack-common.ts, so pack-common.ts's own
    // allowlist cannot import the constant back without cycling. If this
    // constant is ever renamed, that hardcoded literal silently stops
    // matching it and legitimate base resolution starts throwing — this pin
    // makes that drift loud instead of silent.
    expect(BASE_TRACKED_SUBDIR).toBe("base");
  });
});
