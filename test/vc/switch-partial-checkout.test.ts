/**
 * LB-843 — a `switch` that fails part-way through must not leave the instance
 * claiming to be at a commit it is not at.
 *
 * The original defect: `switchTo` materializes the target snapshot BEFORE it
 * moves HEAD, and `materializeSnapshot` wrote `anvil.toml` / `anvil.lock` before
 * the tracked-file loop. A mid-loop I/O failure therefore left the manifest and
 * lock describing the TARGET commit while HEAD and the tracked tree were still at
 * the SOURCE one — and nothing reported it.
 *
 * Why nothing reported it, which is also why it survived review:
 *
 *   - `status().worktreeDirty` compared only the **tracked** set against HEAD, and
 *     `anvil.toml` / `anvil.lock` / `.anvilignore` are snapshot slots, listed in
 *     `SNAPSHOT_SLOTS` and excluded from the walk by construction. They could not
 *     make the tree read dirty.
 *   - The tracked loop is **ordered**, so any tracked file that differs and sorts
 *     BEFORE the failing one has already been written to the target's bytes, and
 *     the tree is then honestly dirty. The lie needed the failing file to be the
 *     **only** tracked difference — which is why the two-file fixture below is
 *     kept as a control rather than as the subject. It reported the truth before
 *     the fix and after it, so on its own it proves nothing.
 *   - Manifest and lock were rewritten together, so they still agreed with each
 *     other and `manifestDirty` stayed false too.
 *
 * The fix has two halves, and they answer two different questions:
 *
 *   1. `materializeSnapshot` writes the three source files **last**, so the
 *      narrow case leaves no partial state at all — the instance is simply still
 *      at its source commit. This is the half that makes the failure *recoverable*
 *      rather than merely *reported*.
 *   2. `status().worktreeDirty` compares the three slots as well as the tracked
 *      set, so any mixed state that a reorder cannot prevent (a process killed
 *      between materialize and the HEAD write) is still visible.
 *
 * NOTE ON THE ACCEPTANCE CRITERION. The ticket asks that a failed switch report
 * `worktreeDirty === true`. Half 1 makes that assertion **wrong** for the ticket's
 * own scenario: nothing was written, so the tree is genuinely clean at the source
 * commit and reporting it dirty would be a lie in the opposite direction. The
 * criterion encodes the assumption that a partial state is unavoidable and must
 * merely be admitted. It is avoidable here, so this file asserts the stronger
 * property — no divergence — and keeps `worktreeDirty === true` as the gate for
 * the mixed state that genuinely can still occur (the third test).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, type Manifest, type SnapshotObject, VcObjectStore } from "../../index.js";
import { Refs } from "../../src/vc/refs.js";
import { buildSnapshot, materializeSnapshot } from "../../src/vc/snapshot.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
  ]);
}

function objectsOf(dir: string): VcObjectStore {
  return new VcObjectStore({ anvilDir: join(dir, ".anvil") });
}

/** The commit HEAD currently names, or undefined on an unborn HEAD. */
async function headCommit(dir: string): Promise<string | undefined> {
  return (await new Refs(join(dir, ".anvil")).resolveHead())?.value;
}

async function snapshotOfHead(dir: string): Promise<SnapshotObject> {
  const objects = objectsOf(dir);
  const head = await headCommit(dir);
  if (!head) {
    throw new Error("unborn HEAD");
  }
  return objects.getSnapshot((await objects.getCommit({ algo: "sha256", value: head })).snapshot);
}

/** The manifest bytes HEAD's commit recorded — "what history says this tree is". */
async function manifestOfHead(dir: string): Promise<string> {
  return new TextDecoder().decode(
    await objectsOf(dir).getBlobBytes((await snapshotOfHead(dir)).manifest),
  );
}

/**
 * A SECOND, independent witness that the tree matches HEAD: the full snapshot id
 * of the working tree, which is what `switchTo`'s own dirty guard compares.
 *
 * `status().worktreeDirty` is the thing under test, so it cannot also be the only
 * evidence that its own answer is honest — a `false` from a comparator that looks
 * at too little is exactly the bug. This asks the wider question instead.
 */
async function worktreeMatchesHead(dir: string, storeDir: string): Promise<boolean> {
  const objects = objectsOf(dir);
  const head = await headCommit(dir);
  if (!head) {
    throw new Error("unborn HEAD");
  }
  const built = await buildSnapshot({
    instanceDir: dir,
    vcStore: objects,
    sharedStore: new ContentStore({ root: storeDir }),
    requireLockFresh: false,
    storeTracked: false,
  });
  const commit = await objects.getCommit({ algo: "sha256", value: head });
  return built.id.value === commit.snapshot.value;
}

interface Rig {
  readonly fx: Awaited<ReturnType<typeof makeVcFixture>>;
  readonly anvil: ReturnType<Awaited<ReturnType<typeof makeVcFixture>>["anvil"]>;
}

/**
 * Two branches (`main`, `variant`) whose manifests differ and whose tracked files
 * differ in exactly `trackedDiffs` paths, left checked out on `main`, tree clean.
 *
 * The tracked names are chosen so their order is known: `config/a.toml` is
 * materialized before `config/b.toml`, which is what lets a caller decide whether
 * the failing write is the first difference or a later one.
 */
async function twoBranchRig(trackedDiffs: number): Promise<Rig> {
  const fx = await makeVcFixture(world());
  const anvil = fx.anvil();
  const names = ["config/a.toml", "config/b.toml"].slice(0, trackedDiffs);

  const base: Manifest = manifest({ minecraft: "26.2", items: ["modrinth:alpha"] });
  await fx.writeLockFor(base);
  await mkdir(join(fx.dir, "config"), { recursive: true });
  for (const n of names) {
    await writeFile(join(fx.dir, ...n.split("/")), "level = 1");
  }
  await anvil.commit("c1: baseline");
  await anvil.branch("variant");

  // The variant differs in BOTH the manifest and the tracked files, so the source
  // files at the top of materialize have real work to do — a fixture where they
  // happened to be identical could not detect the ordering bug at all.
  await anvil.switch("variant");
  await fx.writeLockFor(
    manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
  );
  for (const n of names) {
    await writeFile(join(fx.dir, ...n.split("/")), "level = 2");
  }
  await anvil.commit("c2: variant");

  await anvil.switch("main");
  return { fx, anvil };
}

describe("LB-843: a switch that fails part-way must not lie about where the instance is", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      for (const n of ["a.toml", "b.toml"]) {
        await chmod(join(d, "config", n), 0o644).catch(() => undefined);
      }
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE: a failed switch leaves the instance wholly at its source commit", async () => {
    const rig = await twoBranchRig(1);
    dirs.push(rig.fx.dir, rig.fx.storeDir);
    const config = join(rig.fx.dir, "config", "a.toml");

    // Preconditions, asserted rather than assumed. Without the first, the throw
    // below could be the DirtyWorkingTree guard rather than the I/O failure under
    // test — a switch that never started would pass every assertion that follows.
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
    const manifestBefore = await readFile(join(rig.fx.dir, "anvil.toml"), "utf8");
    const headBefore = await headCommit(rig.fx.dir);
    expect(manifestBefore).toBe(await manifestOfHead(rig.fx.dir));

    // The single differing tracked file is made unwritable: its content still
    // matches HEAD (so the tree is clean and the guard admits the switch) and the
    // write inside materialize fails.
    await chmod(config, 0o444);
    await expect(rig.anvil.switch("variant")).rejects.toThrow();

    // HEAD did not move...
    expect(await headCommit(rig.fx.dir)).toBe(headBefore);
    // ...and neither did the instance's own claim about which commit it holds.
    // This is the assertion that fails on the unfixed code, where the manifest and
    // lock had already been rewritten to the target's before the tracked loop ran.
    const manifestAfter = await readFile(join(rig.fx.dir, "anvil.toml"), "utf8");
    expect(manifestAfter).toBe(manifestBefore);
    expect(manifestAfter).toBe(await manifestOfHead(rig.fx.dir));
    expect(await readFile(config, "utf8")).toBe("level = 1");

    // Two independent witnesses that "clean" is the truth and not a blind spot:
    // the full snapshot id (what `switchTo`'s own guard compares) and `status`.
    expect(await worktreeMatchesHead(rig.fx.dir, rig.fx.storeDir)).toBe(true);
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);

    // And the failure is recoverable, which reporting alone would not give: undo
    // the cause and the same switch completes.
    await chmod(config, 0o644);
    await rig.anvil.switch("variant");
    expect(await readFile(config, "utf8")).toBe("level = 2");
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
  });

  it("CONTROL: a second differing tracked file was already reported honestly", async () => {
    // The fixture that looks like a pass for the wrong reason. `config/a.toml`
    // sorts first and is written successfully; the failure lands on `config/b.toml`,
    // leaving a genuine tracked difference the pre-fix `status` already saw. It
    // reports dirty with or without the fix, so it discriminates nothing on its
    // own — its job is to stay green while the GATE above changes meaning.
    const rig = await twoBranchRig(2);
    dirs.push(rig.fx.dir, rig.fx.storeDir);

    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
    await chmod(join(rig.fx.dir, "config", "b.toml"), 0o444);
    await expect(rig.anvil.switch("variant")).rejects.toThrow();

    expect(await readFile(join(rig.fx.dir, "config", "a.toml"), "utf8")).toBe("level = 2");
    expect((await rig.anvil.status()).worktreeDirty).toBe(true);
  });

  it("GATE: a mixed tree the reorder cannot prevent still reports worktreeDirty === true", async () => {
    // Writing the source files last narrows the window; it does not close it. A
    // process killed between `materializeSnapshot` returning and `switchTo` writing
    // HEAD leaves the source files at the target while HEAD is still at the source
    // — and when the two commits have IDENTICAL tracked sets, a tracked-only
    // comparison sees nothing at all. That is the residue this half of the fix
    // exists for, so it is built here directly rather than assumed unreachable.
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(join(fx.dir, "config", "a.toml"), "level = 1");
    await anvil.commit("c1: baseline");
    await anvil.branch("variant");

    // The variant differs ONLY in the manifest — same tracked file, same bytes.
    await anvil.switch("variant");
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    const c2 = await anvil.commit("c2: manifest-only variant");
    await anvil.switch("main");
    expect((await anvil.status()).worktreeDirty).toBe(false);

    // Exactly what a switch does, stopped short of the HEAD write.
    const objects = objectsOf(fx.dir);
    const target = await objects.getSnapshot((await objects.getCommit(c2.id)).snapshot);
    await materializeSnapshot({
      instanceDir: fx.dir,
      snapshot: target,
      vcStore: objects,
      sharedStore: new ContentStore({ root: fx.storeDir }),
      previous: await snapshotOfHead(fx.dir),
    });

    // The tracked set is byte-for-byte what HEAD recorded, so a tracked-only
    // comparison reports clean here. The slots are the only witness.
    expect(await worktreeMatchesHead(fx.dir, fx.storeDir)).toBe(false);
    expect((await anvil.status()).worktreeDirty).toBe(true);
  });

  it("does not over-report: an ordinary successful switch leaves the tree clean", async () => {
    // The other direction. Comparing the slots must not make every switch look
    // dirty — a detector that always fires is not a detector.
    const rig = await twoBranchRig(1);
    dirs.push(rig.fx.dir, rig.fx.storeDir);

    await rig.anvil.switch("variant");
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
    await rig.anvil.switch("main");
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
  });
});
