import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Manifest, parseRef, readLock, serializeLock } from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function cleanWorld(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
    { slug: "gamma", id: "GAMMA", versions: [version("GAMMA", "3.0.0", ["26.2"])] },
  ]);
}

/**
 * Build the merge scenario end to end and return the merged lock text + the base
 * alpha pin, so the test can assert determinism and byte-identical carry-over.
 */
async function runCleanMerge(): Promise<{
  mergedLockText: string;
  baseAlpha: unknown;
  mergedAlpha: unknown;
  committed: boolean;
  items: number;
}> {
  const fx = await makeVcFixture(cleanWorld());
  const anvil = fx.anvil();

  const baseLock = await fx.writeLockFor(
    manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }),
  );
  await anvil.commit("base: alpha");
  await anvil.branch("theirs");

  // ours: add beta.
  await fx.writeLockFor(
    manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
  );
  await anvil.commit("ours: add beta");

  // theirs: add gamma (a different, non-conflicting item).
  await anvil.switch("theirs");
  await fx.writeLockFor(
    manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:gamma"] }),
  );
  await anvil.commit("theirs: add gamma");

  // Merge theirs into ours.
  await anvil.switch("main");
  const result = await anvil.merge("theirs");
  const mergedLock = await readLock(fx.dir);

  await rmTmp(fx.dir);
  await rmTmp(fx.storeDir);

  return {
    mergedLockText: serializeLock(mergedLock),
    baseAlpha: baseLock.resolved.find((p) => p.name === "alpha"),
    mergedAlpha: mergedLock.resolved.find((p) => p.name === "alpha"),
    committed: result.committed !== undefined,
    items: mergedLock.resolved.filter((p) => p.source === "modrinth").length,
  };
}

describe("vc merge: item-set 3-way + constrained re-lock", () => {
  it("GATE determinism: a clean merge is byte-identical across runs, unchanged pins carried verbatim", async () => {
    const a = await runCleanMerge();
    const b = await runCleanMerge();

    expect(a.committed).toBe(true);
    // Merged manifest carries all three non-conflicting mods.
    expect(a.items).toBe(3);
    // Every unchanged item keeps a byte-identical pin (alpha was touched by neither side).
    expect(a.mergedAlpha).toEqual(a.baseAlpha);
    // Same inputs → byte-identical merged lock across two independent runs.
    expect(a.mergedLockText).toBe(b.mergedLockText);
  });

  it("GATE phase-2: a phase-1-clean merge whose @game bump orphans a mod surfaces no-compatible-version and does NOT commit", async () => {
    // orphan only exists for 26.2; the merged game bumps to 26.3.
    const fx = await makeVcFixture(
      modWorld([
        { slug: "orphan", id: "ORPHAN", versions: [version("ORPHAN", "1.0.0", ["26.2"])] },
      ]),
    );
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: [] }));
    await anvil.commit("base");
    await anvil.branch("theirs");

    // ours: add the (26.2-only) orphan mod — locks fine under 26.2.
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:orphan"] }));
    const ours = await anvil.commit("ours: add orphan");

    // theirs: bump the game to 26.3 (no items) — locks fine.
    await anvil.switch("theirs");
    await fx.writeLockFor(manifest({ minecraft: "26.3", items: [] }));
    await anvil.commit("theirs: bump to 26.3");

    // Merge: phase 1 is clean (orphan added by ours, game bumped by theirs), but the
    // re-lock under 26.3 cannot satisfy orphan → phase-2 no-compatible-version.
    await anvil.switch("main");
    const result = await anvil.merge("theirs");

    expect(result.committed).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("no-compatible-version");
    expect(result.conflicts[0]?.severity).toBe("high");

    // HEAD did not move; no merge commit was recorded; MERGE_HEAD was cleared.
    const log = await anvil.log();
    expect(log[0]?.id.value).toBe(ours.id.value);
    expect(log).toHaveLength(2);
    expect(await pathExists(join(fx.dir, ".anvil", "MERGE_HEAD"))).toBe(false);

    await rmTmp(fx.dir);
    await rmTmp(fx.storeDir);
  });

  it("3-way merge materializes a merged carried local file so the working tree matches the commit", async () => {
    const fx = await makeVcFixture(
      modWorld([
        { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
        { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
      ]),
    );
    const localManifest = (mods: string[]): Manifest => ({
      project: { name: "vc-pack", version: "1.0.0" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [...mods.map((r) => ({ ref: parseRef(r) })), { ref: parseRef("./patch.jar") }],
    });
    const anvil = fx.anvil();

    // base: local patch.jar = "V0" (carried to mods/patch.jar).
    await writeFile(join(fx.dir, "patch.jar"), "V0");
    await fx.writeLockFor(localManifest(["modrinth:alpha"]));
    await anvil.commit("base");
    await anvil.branch("theirs");

    // ours diverges by ADDING beta (patch left at V0) → not a fast-forward.
    await fx.writeLockFor(localManifest(["modrinth:alpha", "modrinth:beta"]));
    await anvil.commit("ours: add beta");

    // theirs edits the local file to "V2".
    await anvil.switch("theirs");
    await writeFile(join(fx.dir, "patch.jar"), "V2");
    await fx.writeLockFor(localManifest(["modrinth:alpha"]));
    await anvil.commit("theirs: local V2");

    // A true 3-way merge: ours added beta, theirs changed the local file → clean.
    await anvil.switch("main");
    const result = await anvil.merge("theirs");
    expect(result.fastForward).toBe(false);
    expect(result.committed).toBeDefined();
    // The merged working tree carries theirs' V2 (the winning side), on disk.
    expect(await readFile(join(fx.dir, "mods", "patch.jar"), "utf8")).toBe("V2");

    await rmTmp(fx.dir);
    await rmTmp(fx.storeDir);
  });

  it("takes a one-sided change and drops nothing (fast classification table)", async () => {
    const fx = await makeVcFixture(cleanWorld());
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("theirs");
    // Only theirs changes (adds beta); ours stays put → fast-forward-free clean merge.
    await anvil.switch("theirs");
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("theirs: add beta");
    await anvil.switch("main");
    // main === base (ancestor of theirs) → this is actually a fast-forward.
    const result = await anvil.merge("theirs");
    expect(result.fastForward).toBe(true);
    const merged = await readLock(fx.dir);
    expect(merged.resolved.filter((p) => p.source === "modrinth")).toHaveLength(2);

    await rmTmp(fx.dir);
    await rmTmp(fx.storeDir);
  });
});
