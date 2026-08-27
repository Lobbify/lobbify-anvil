/**
 * LB-721 — two follow-ups to the LB-705 tracked-set work.
 *
 *  1. **The dirty check writes no object.** `#worktreeSnapshotId` builds a snapshot
 *     only to compare its id against HEAD's. `storeTracked: false` already stopped
 *     it admitting the tracked blobs; the snapshot object itself was still written,
 *     once per `switch` attempt including the refused ones, and nothing ever
 *     references it. `storeSnapshot: false` finishes the job — the id is the sha256
 *     of the canonical encoding, so it is computable without a store.
 *
 *  2. **Windows reserved device names are refused at decode.** `CON`, `NUL`,
 *     `PRN`, `AUX`, `COM1`–`COM9`, `LPT1`–`LPT9` are legal filenames on Linux and
 *     macOS and device handles on Windows — reserved case-insensitively and with
 *     any extension, so `con.txt` is the console but `console` is a file. A tracked
 *     set carrying one materializes fine here and fails from the middle of a
 *     checkout on Windows with a raw OS error. Refusing the object by name is the
 *     same trade `trackedPathCollision` already makes.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type Hash,
  LockParseError,
  type SnapshotObject,
  type TrackedFile,
  VcObjectStore,
  VcStateError,
  idOf,
} from "../../index.js";
import { isWindowsDeviceName } from "../../src/internal/fs.js";
import { trackedReservedDeviceName } from "../../src/vc/objects.js";
import { buildSnapshot } from "../../src/vc/snapshot.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FIXED_NOW, makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
  ]);
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

const blob = (c: string): Hash => ({ algo: "sha256", value: c.repeat(64) });
const tracked = (...paths: string[]): TrackedFile[] =>
  paths.map((path, i) => ({ path, blob: blob(String(i + 1)) }));

const snapshotWith = (files: readonly TrackedFile[]): SnapshotObject => ({
  type: "snapshot",
  manifest: blob("a"),
  lock: blob("b"),
  ignore: blob("c"),
  carried: [],
  tracked: [...files],
});

/**
 * Every reserved device name, written out here rather than imported from the set
 * the predicate consults — the LB-734 rule applied to this check too. A name
 * dropped from `WINDOWS_DEVICE_NAMES` must fail a test, not silently stop being
 * refused.
 */
const DEVICE_NAMES = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
] as const;

describe("LB-721: Windows reserved device names in a tracked path", () => {
  it("matches every reserved name, case-insensitively and with any extension", () => {
    for (const name of DEVICE_NAMES) {
      expect(isWindowsDeviceName(name), name).toBe(true);
      expect(isWindowsDeviceName(name.toLowerCase()), name).toBe(true);
      expect(isWindowsDeviceName(`${name}.txt`), name).toBe(true);
      expect(isWindowsDeviceName(`${name.toLowerCase()}.tar.gz`), name).toBe(true);
    }
  });

  it("does NOT match a name that merely starts with one — the other side of the boundary", () => {
    // The rule is the stem before the first dot, matched WHOLE. A prefix match
    // would reject `console.log`; a whole-segment match would miss `con.txt`.
    for (const ok of [
      "console",
      "CONSOLE",
      "console.txt",
      "con2",
      "com0",
      "com10",
      "lpt0",
      "lpt10",
      "mycon",
      "con-fig",
      "auxiliary.json",
      "nullable.ts",
      "prnt.txt",
      "options.txt",
    ]) {
      expect(isWindowsDeviceName(ok), ok).toBe(false);
    }
  });

  it("names the offending segment and path, at any depth", () => {
    expect(trackedReservedDeviceName(tracked("config/con.txt"))).toContain("config/con.txt");
    expect(trackedReservedDeviceName(tracked("config/con.txt"))).toContain('"con.txt"');
    // A reserved DIRECTORY segment is exactly as unwritable on Windows.
    expect(trackedReservedDeviceName(tracked("nul/deep/file.json"))).toContain('"nul"');
    // Clean sets pass, including the near-misses above.
    expect(trackedReservedDeviceName(tracked("config/console.txt", "mods/a.jar"))).toBeUndefined();
    expect(trackedReservedDeviceName([])).toBeUndefined();
  });

  it("REFUSES a snapshot arriving with such a path, on decode (the remote case)", async () => {
    const anvilDir = await mkTmp("lb721-objects");
    dirs.push(anvilDir);
    const store = new VcObjectStore({ anvilDir });

    for (const name of DEVICE_NAMES) {
      // `put` encodes and writes without inspecting — this stands in for the bytes
      // a `pull` receives from a remote that never ran our checks.
      const hostile = snapshotWith(tracked(`config/${name.toLowerCase()}.cfg`));
      const id = await store.put(hostile);
      await expect(store.getSnapshot(id), name).rejects.toBeInstanceOf(LockParseError);
    }

    // A snapshot whose paths merely resemble the device names still decodes.
    const fine = snapshotWith(tracked("config/console.cfg", "mods/con-fig.jar"));
    const fineId = await store.put(fine);
    await expect(store.getSnapshot(fineId)).resolves.toMatchObject({ type: "snapshot" });
  });

  it("REFUSES one at build time too, so anvil never writes history it cannot read back", async () => {
    // Decode-only would be a trap: a Linux user could commit `mods/con.txt`
    // successfully and then be unable to read their own history, since
    // `getSnapshot` decodes local objects through the same path a remote's
    // arrive on. Both ends refuse, exactly as `trackedPathCollision` does.
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(join(fx.dir, "config", "keep.txt"), "ok\n");
    // `aux` is the console-adjacent device; `aux.json` is unwritable on Windows.
    await writeFile(join(fx.dir, "config", "aux.json"), "{}\n");

    await expect(
      buildSnapshot({
        instanceDir: fx.dir,
        vcStore: new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") }),
        sharedStore: new ContentStore({ root: fx.storeDir }),
        requireLockFresh: false,
      }),
    ).rejects.toBeInstanceOf(VcStateError);
  });
});

describe("LB-721: the dirty check admits no snapshot object", () => {
  it("storeSnapshot:false returns the SAME id without writing it, and true writes it", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }), FIXED_NOW);
    await writeFile(join(fx.dir, "options.txt"), "fov:80\n");

    const anvilDir = join(fx.dir, ".anvil");
    const vcStore = new VcObjectStore({ anvilDir });
    const common = {
      instanceDir: fx.dir,
      vcStore,
      sharedStore: new ContentStore({ root: fx.storeDir }),
      requireLockFresh: false,
    } as const;

    const checked = await buildSnapshot({ ...common, storeTracked: false, storeSnapshot: false });
    // The whole point: the id is real and usable, and the object is NOT in the store.
    expect(await vcStore.has(checked.id)).toBe(false);
    // And it is the id the encoding hashes to — not something the store invented.
    expect(idOf(checked.snapshot).value).toBe(checked.id.value);

    // The default path still stores it, and agrees on the id. Same tree, so if
    // skipping the put had changed the id, these two would differ.
    const stored = await buildSnapshot(common);
    expect(stored.id.value).toBe(checked.id.value);
    expect(await vcStore.has(stored.id)).toBe(true);
  });

  it("a REFUSED switch leaves the object store exactly as it found it", async () => {
    // The end-to-end shape the ticket describes: `switchTo`'s dirty guard runs on
    // every attempt, and a refused attempt used to leave one unreachable snapshot
    // behind each time.
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }), FIXED_NOW);
    const anvil = fx.anvil();
    await anvil.commit("c1: baseline");
    await anvil.branch("other");

    const objectsDir = join(fx.dir, ".anvil", "objects");
    const countObjects = async (): Promise<number> => {
      let n = 0;
      for (const shard of await readdir(objectsDir)) {
        n += (await readdir(join(objectsDir, shard))).length;
      }
      return n;
    };

    // Dirty the tree so the switch is refused rather than performed.
    await writeFile(join(fx.dir, "options.txt"), "fov:90\n");
    const before = await countObjects();
    await expect(anvil.switch("other")).rejects.toBeTruthy();
    expect(await countObjects()).toBe(before);
    // Sanity: the working tree really was dirty, i.e. the guard is what refused.
    expect(await readFile(join(fx.dir, "options.txt"), "utf8")).toBe("fov:90\n");
  });
});
