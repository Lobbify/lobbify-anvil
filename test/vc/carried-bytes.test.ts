/**
 * LB-859 — a carried file holding another commit's bytes must not read as clean.
 *
 * The carried set is the one part of a snapshot that neither other comparison can
 * see, and the reason is structural rather than an oversight:
 *
 *   - Carried paths are lock-owned, so `buildOwnedPaths` excludes them from the
 *     tracked walk by construction.
 *   - `carryLocals` derives the recorded entry from the **lock** — reading bytes
 *     out of the shared store, never from the instance — so identical lock bytes
 *     produce an identical carried array and an identical **snapshot id** no matter
 *     what is actually sitting at those paths.
 *
 * So a carried file left holding another commit's bytes was invisible to `status`
 * AND to `switchTo`'s own full-snapshot-id guard. That second half is what makes
 * this worth a dedicated check: the id comparison people reach for as the
 * authoritative one is blind here too, so "the ids match" cannot stand in for it.
 *
 * The absent case is skipped on purpose. See `carriedBytesDiffer`'s header for
 * why that is sound rather than a concession — the short form is that a carried
 * file is re-derivable build product whose bytes live in the object store, both
 * `build` and `switch` place it, and the failure this exists for leaves the file
 * present by construction. The lifecycle that establishes it is asserted below
 * rather than assumed, because the whole design rests on it.
 */

import { execFile } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, type SnapshotObject, VcObjectStore } from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { buildSnapshot } from "../../src/vc/snapshot.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

/** Create a POSIX FIFO. No Node API exists for this, and no Windows equivalent. */
async function mkfifo(path: string): Promise<void> {
  await promisify(execFile)("mkfifo", [path]);
}

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
  ]);
}

function objectsOf(dir: string): VcObjectStore {
  return new VcObjectStore({ anvilDir: join(dir, ".anvil") });
}

/**
 * The full snapshot id of the working tree vs HEAD's — what `switchTo`'s dirty
 * guard compares. Carried entries come from the lock, so this is EXPECTED to stay
 * equal while a carried file on disk is wrong; asserting that keeps the blind spot
 * documented by measurement rather than by claim.
 */
async function snapshotIdMatchesHead(dir: string, storeDir: string): Promise<boolean> {
  const objects = objectsOf(dir);
  const head = await new (await import("../../src/vc/refs.js")).Refs(join(dir, ".anvil"))
    .resolveHead()
    .then((h) => h);
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
  return built.id.value === (await objects.getCommit(head)).snapshot.value;
}

interface Rig {
  readonly fx: Awaited<ReturnType<typeof makeVcFixture>>;
  readonly anvil: ReturnType<Awaited<ReturnType<typeof makeVcFixture>>["anvil"]>;
  /** Absolute path of the carried file this instance's lock names. */
  readonly carriedPath: string;
  /** The out-of-instance dir holding the local source jar, so it gets cleaned up. */
  readonly srcDir: string;
  readonly snapshot: SnapshotObject;
}

/** An instance with one `local`-source item — the only kind that becomes carried. */
async function localItemRig(bytes = "LOCAL-BYTES-V1"): Promise<Rig> {
  const fx = await makeVcFixture(world());
  const anvil = fx.anvil();
  const src = await mkTmp("lb859-src");
  const jar = join(src, "mine.jar");
  await writeFile(jar, bytes);
  // A `../`-relative ref with forward slashes, NOT `join(src, …)`. The manifest
  // round-trips through `formatRef`, which renders a local ref as its bare id —
  // so the written form has to be one `parseRef` accepts, and it accepts only
  // `./`, `../` and `/`. A Windows absolute path (`C:\…`) matches none of them,
  // and a POSIX one parsed here purely by accident of `startsWith("/")`.
  // (`path.relative` is no good either: it emits backslashes on Windows.)
  // The source stays OUTSIDE the instance dir on purpose — a jar sitting inside
  // it would join the tracked walk, and then the tracked comparison, not the
  // carried one, would be what catches the corruption below.
  const ref = `../${basename(src)}/mine.jar`;
  await fx.writeLockFor(manifest({ minecraft: "26.2", items: [`local:${ref}`] }));
  const c1 = await anvil.commit("c1: baseline");

  const objects = objectsOf(fx.dir);
  const snapshot = await objects.getSnapshot((await objects.getCommit(c1.id)).snapshot);
  expect(snapshot.carried.length).toBeGreaterThan(0); // the fixture must actually carry something
  const entry = snapshot.carried[0];
  if (!entry) {
    throw new Error("no carried entry");
  }
  return { fx, anvil, carriedPath: join(fx.dir, entry.path), srcDir: src, snapshot };
}

describe("LB-859: a carried file's bytes on disk are part of being clean", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE: a carried file holding the wrong bytes reports dirty", async () => {
    const rig = await localItemRig();
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);

    // Place it the way a switch does, then corrupt it. Placing first matters: the
    // absent case is a different state with a different (correct) answer, and a
    // fixture that skipped this step would be testing that one instead.
    await mkdir(join(rig.carriedPath, ".."), { recursive: true });
    await writeFile(rig.carriedPath, "LOCAL-BYTES-V1");
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);

    await writeFile(rig.carriedPath, "SOMEONE-ELSES-BYTES");
    expect((await rig.anvil.status()).worktreeDirty).toBe(true);

    // The blind spot this closes, asserted rather than described: the full
    // snapshot id — the comparison `switchTo` trusts — is STILL equal here,
    // because the carried entry is derived from the lock and the lock is
    // untouched. So the id cannot stand in for this check.
    expect(await snapshotIdMatchesHead(rig.fx.dir, rig.fx.storeDir)).toBe(true);
  });

  it("CONTROL absent: a carried file that was never placed reports clean", async () => {
    // The over-report this design had to avoid. After init + lock + commit with no
    // build and no switch, nothing has placed the file — treating that as a
    // difference would report every unbuilt instance permanently dirty.
    const rig = await localItemRig();
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);

    expect(await pathExists(rig.carriedPath)).toBe(false);
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
  });

  it("CONTROL deleted: deleting a placed carried file also reports clean", async () => {
    // Deliberate, and the part most worth arguing with. A deleted carried file is
    // indistinguishable on disk from a never-placed one, and both are repaired by
    // the next `build` or `switch` from bytes still held in the object store. The
    // usual objection to absence-gated skips (a presence check that gates skipping
    // a verification trusts whatever crash left the gap) applies when the skipped
    // state is user data with no repair path. This is re-derivable build product.
    const rig = await localItemRig();
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);

    await mkdir(join(rig.carriedPath, ".."), { recursive: true });
    await writeFile(rig.carriedPath, "LOCAL-BYTES-V1");
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);

    await rm(rig.carriedPath);
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
  });

  it("the lifecycle the absent-skip depends on: switch places carried bytes", async () => {
    // The design rests on "absent means never placed, and both build and switch
    // place it". `build` is out of reach here (offline, no game install), so this
    // asserts the half that the app's path actually uses — and it is the half that
    // matters, since an embedder that never calls build() still switches.
    const rig = await localItemRig();
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);
    const anvil = rig.anvil;

    expect(await pathExists(rig.carriedPath)).toBe(false);

    await mkdir(join(rig.fx.dir, "config"), { recursive: true });
    await writeFile(join(rig.fx.dir, "config", "x.toml"), "a = 1");
    await anvil.commit("c2: a tracked file, so there is somewhere to switch");
    await anvil.switch("main");

    expect(await pathExists(rig.carriedPath)).toBe(true);
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);
  });

  it("does not over-report on a large carried file (the streaming branch)", async () => {
    // Carried files are real jars and land on both sides of the 8 MiB streaming
    // threshold, so the branch that hashes without loading the file gets its own
    // case — an unexercised branch is where a hash mismatch hides.
    const big = "x".repeat(9 * 1024 * 1024);
    const rig = await localItemRig(big);
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);

    await mkdir(join(rig.carriedPath, ".."), { recursive: true });
    await writeFile(rig.carriedPath, big);
    expect((await stat(rig.carriedPath)).size).toBeGreaterThan(8 * 1024 * 1024);
    expect((await rig.anvil.status()).worktreeDirty).toBe(false);

    await writeFile(rig.carriedPath, `${big.slice(0, big.length - 1)}y`);
    expect((await rig.anvil.status()).worktreeDirty).toBe(true);
  });

  it("a non-regular file at a carried path neither crashes nor hangs status()", async () => {
    // Raised by adversarial review of the first cut, which stat'd the path and
    // then read it unconditionally. Both failure modes were measured on this box:
    // `readFile` on a directory throws EISDIR, and on a FIFO it **blocks
    // forever** — the second is the bad one, because it would turn every later
    // `status()` call into a hang rather than an error.
    //
    // `trackOne` has skipped non-regular entries all along; this function simply
    // failed to mirror it. Before the guard, `status()` here threw where it
    // previously returned — a regression introduced by a detector, on a state it
    // was never asked to judge.
    const rig = await localItemRig();
    dirs.push(rig.fx.dir, rig.fx.storeDir, rig.srcDir);

    await mkdir(rig.carriedPath, { recursive: true }); // a DIRECTORY where the jar goes
    expect((await stat(rig.carriedPath)).isDirectory()).toBe(true);
    await expect(rig.anvil.status()).resolves.toBeDefined();

    await rm(rig.carriedPath, { recursive: true });

    // The FIFO half is POSIX-only, and that is a real platform difference rather
    // than a fault that fails to inject: Windows has no `mkfifo`, so the state
    // being guarded against cannot arise there. The distinction matters — the
    // LB-843 harness bug was a fault that silently did nothing on Windows while
    // looking like a subject difference — so this asserts the fixture landed
    // wherever it CAN land, instead of skipping on a failure it never checked.
    if (process.platform !== "win32") {
      await mkfifo(rig.carriedPath);
      expect((await stat(rig.carriedPath)).isFIFO()).toBe(true);
      // The real assertion is that this RETURNS AT ALL. A hang has no error to
      // catch, so the test fails by timing out rather than by asserting.
      await expect(rig.anvil.status()).resolves.toBeDefined();
      await rm(rig.carriedPath);
    }
  });
});
