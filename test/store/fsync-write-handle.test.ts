import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContentStore,
  type Lockfile,
  OBJECT_MODE,
  readReplayPaths,
  recordReplayPaths,
} from "../../index.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";

// Records every fsync the store issues, and the access mode of the handle it was
// issued on. Hoisted so the `vi.mock` factory below can reach it.
const fsyncs = vi.hoisted(() => ({ calls: [] as { flags: string; writable: boolean }[] }));

/** A POSIX-style open flag grants write access iff it has `w`, `a`, or `+`. */
function isWritable(flags: string | number): boolean {
  return typeof flags === "string" && /[wa+]/.test(flags);
}

// THE NEGATIVE CONTROL.
//
// Windows implements `fsync` as `FlushFileBuffers`, which requires a handle with
// WRITE access; a read-only handle returns ERROR_ACCESS_DENIED, which Node surfaces
// as EPERM/errno -4048. Linux happily fsyncs a read-only fd, which is exactly why
// LB-821 was invisible on every lane except Windows.
//
// This mock imposes the Windows rule on Linux and macOS: a handle opened without
// write access throws the real CI error when synced. It makes the platform bug
// reproducible everywhere, so the fix is pinned by a test that runs on every lane
// rather than only by a green Windows run.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (path, flags = "r", mode?) => {
    const handle = await actual.open(path, flags, mode);
    const writable = isWritable(flags);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      fsyncs.calls.push({ flags: String(flags), writable });
      if (!writable) {
        throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
          errno: -4048,
          code: "EPERM",
          syscall: "fsync",
        });
      }
      await realSync();
    };
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

describe("object writes fsync through a write handle (LB-821)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
    fsyncs.calls.length = 0;
  });

  it("lands an object under Windows fsync semantics, synced on a writable handle", async () => {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });

    // On the unfixed code this rejects with EPERM/-4048 — the exact CI failure.
    const { hash } = await store.putBuffer(Buffer.from("windows-bytes"), "sha256");

    // The bytes are real, so the write cannot have been skipped.
    expect(await readFile(store.objectPath(hash), "utf8")).toBe("windows-bytes");

    // The data fsync actually happened, on a handle that had write access. Without
    // this, quietly dropping the fsync (or swallowing EPERM) would still pass.
    expect(fsyncs.calls.some((c) => c.writable)).toBe(true);

    // ...and no fsync was attempted on a read-only handle. `fsyncDir` opens the
    // directory "r" and swallows the rejection by design, so only the *data* sync
    // is asserted here: it must never be issued read-only.
    expect(fsyncs.calls.filter((c) => !c.writable).every((c) => c.flags === "r")).toBe(true);
  });

  it("still lands the object read-only (0444), so immutability is not traded away", async () => {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });

    const { hash } = await store.putBuffer(Buffer.from("still-immutable"), "sha256");
    const objStat = await stat(store.objectPath(hash));
    expect(objStat.mode & 0o777).toBe(OBJECT_MODE);
  });

  it("rejects a mismatched hash without leaving the object behind", async () => {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });

    // Asserted on the SHA_MISMATCH code, not on "it threw": before the fix this
    // rejected with EPERM, which a bare `.rejects.toThrow()` would have accepted.
    const wrong = { algo: "sha256" as const, value: "0".repeat(64) };
    await expect(store.putBuffer(Buffer.from("payload"), "sha256", wrong)).rejects.toMatchObject({
      code: "SHA_MISMATCH",
    });
    expect(await store.has(wrong)).toBe(false);
  });
});

// The sibling site: `recordReplayPaths` (replay-provenance.ts) has the same defect
// — `writeFile(tmp)` then reopen "r" to `fsync`, which is genuine EPERM under the
// same Windows fsync semantics the mock above imposes. Reached on every build via
// `pipeline.ts` and twice from `remote/sync.ts`, so it is live on the hot path, not
// a theoretical duplicate.
describe("the replay-path ledger fsyncs through a write handle (LB-821 sibling)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
    fsyncs.calls.length = 0;
  });

  function lockWithReplayTarget(target: string): Lockfile {
    return {
      meta: {
        version: 1,
        manifestHash: hashOf(new Uint8Array([1]), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [
        {
          name: "jei",
          kind: "mod",
          source: "curseforge",
          hash: hashOf(Buffer.from("replay-bytes"), "sha256"),
          provenance: "replay",
          placement: { method: "link", target },
          project: 1,
          file: 1,
        },
      ],
    };
  }

  it("writes the ledger under Windows fsync semantics, synced on a writable handle", async () => {
    const dir = await mkTmp("replay-ledger");
    dirs.push(dir);

    // On the unfixed code this rejects with EPERM/-4048 — the exact CI failure.
    await recordReplayPaths(dir, [lockWithReplayTarget("mods/jei.jar")]);

    // The claim landed, so the write cannot have been skipped.
    expect(await readReplayPaths(dir)).toContain("mods/jei.jar");

    // The ledger fsync actually happened, on a handle that had write access.
    // Without this, quietly dropping the fsync (or swallowing EPERM) would still
    // pass.
    expect(fsyncs.calls.some((c) => c.writable)).toBe(true);
  });
});
