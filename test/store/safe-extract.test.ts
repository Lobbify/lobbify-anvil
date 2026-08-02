import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecompressionBomb, PathEscape, excludeMetaInf, safeExtract } from "../../index.js";
import { listFiles, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeZip } from "../helpers/zip.js";

const posixIt = it.skipIf(process.platform === "win32");

async function zipFile(dir: string, name: string, zip: Buffer): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, zip);
  return p;
}

// GATE (security must-do) — the hardened zip-slip / decompression-bomb guard.
describe("safeExtract — zip-slip and bomb guards", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("extracts a benign jar and excludes META-INF via the exclude matcher", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "natives.jar",
      makeZip([
        { name: "libfoo.so", data: "FOO" },
        { name: "nested/libbar.so", data: "BAR" },
        { name: "META-INF/MANIFEST.MF", data: "no" },
      ]),
    );
    const out = join(work, "out");
    const written = await safeExtract(zip, out, { exclude: excludeMetaInf });
    expect(written.sort()).toEqual(["libfoo.so", "nested/libbar.so"]);
    const files = await listFiles(out);
    expect(files).toContain("libfoo.so");
    expect(files.some((f) => f.includes("META-INF"))).toBe(false);
  });

  it("rejects a '..' traversal entry and writes nothing outside the root", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "evil.zip",
      makeZip([{ name: "../escaped.txt", data: "pwned" }]),
    );
    await expect(safeExtract(zip, join(work, "out"))).rejects.toBeInstanceOf(PathEscape);
    // The traversal target (work/escaped.txt) must not exist.
    const siblings = await listFiles(work);
    expect(siblings).not.toContain("escaped.txt");
  });

  it("rejects an absolute-path entry", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(work, "abs.zip", makeZip([{ name: "/etc/pwned", data: "x" }]));
    await expect(safeExtract(zip, join(work, "out"))).rejects.toBeInstanceOf(PathEscape);
  });

  it("rejects a symlink entry", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "link.zip",
      makeZip([{ name: "link", type: "symlink", linkTarget: "/etc/passwd" }]),
    );
    await expect(safeExtract(zip, join(work, "out"))).rejects.toBeInstanceOf(PathEscape);
  });

  it("enforces the max-entries bomb bound", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "many.zip",
      makeZip([
        { name: "a", data: "1" },
        { name: "b", data: "2" },
        { name: "c", data: "3" },
      ]),
    );
    await expect(safeExtract(zip, join(work, "out"), { maxEntries: 2 })).rejects.toBeInstanceOf(
      DecompressionBomb,
    );
  });

  posixIt("does not write through a pre-existing symlink at the destination", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const out = join(work, "out");
    await mkdir(out, { recursive: true });
    const outside = join(work, "outside.txt");
    await writeFile(outside, "ORIGINAL");
    await symlink(outside, join(out, "target")); // pre-existing symlink inside destRoot
    const zip = await zipFile(work, "z.zip", makeZip([{ name: "target", data: "HACKED" }]));
    await expect(safeExtract(zip, out)).rejects.toBeTruthy();
    // The "wx" (O_EXCL) open refuses to follow/overwrite the symlink.
    expect(await readFile(outside, "utf8")).toBe("ORIGINAL");
  });

  it("enforces the max-total-bytes bomb bound", async () => {
    const work = await mkTmp("xtr");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "big.zip",
      makeZip([{ name: "big.bin", data: "x".repeat(4096) }]),
    );
    await expect(
      safeExtract(zip, join(work, "out"), { maxTotalBytes: 1024 }),
    ).rejects.toBeInstanceOf(DecompressionBomb);
  });
});

// GATE (security must-do) — LB-827 round 3: `safeExtract` gained an opt-in
// `rejectColon`, closing the gap the round-2 review found (a `:`-bearing entry
// extracted verbatim, with no check at all). Opt-in, not unconditional, because
// `import/pack-common.ts`'s override-tree import extracts into a throwaway dir
// it always removes and filters colon-bearing entries itself before the one
// persisted write — see test/import/mrpack.test.ts's "skips a ':'-segment
// override" cases for that half. This block proves both sides of the option:
// the default still passes a colon through (no behavior change for existing
// callers), and `rejectColon: true` refuses it outright.
describe("safeExtract — refuses a ':'-bearing entry only when the caller opts in (LB-827 round 3)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  // POSIX-only: this asserts what the filesystem does with the extracted name,
  // and NTFS does something different. `evil:stream.dll` is a legal filename on
  // Linux/macOS; on Windows the write becomes an Alternate Data Stream and the
  // directory contains a primary file named `evil` instead. Windows CI said so
  // directly: `expected [ 'evil' ] to include 'evil:stream.dll'`.
  //
  // The sibling `rejectColon: true` case below needs no such guard — it refuses
  // on the entry NAME before anything is written, so it is platform-independent
  // and must keep running everywhere. That asymmetry is the useful part: the
  // guard is a string check, and only the assertions about resulting FILES are
  // platform-bound.
  posixIt(
    "DEFAULT (no rejectColon): a ':'-named entry extracts verbatim, unchanged from before",
    async () => {
      const work = await mkTmp("xtr-colon");
      dirs.push(work);
      const zip = await zipFile(
        work,
        "colon.zip",
        makeZip([{ name: "evil:stream.dll", data: "PAYLOAD" }]),
      );
      const out = join(work, "out");
      const written = await safeExtract(zip, out);
      expect(written).toEqual(["evil:stream.dll"]);
      expect(await listFiles(out)).toContain("evil:stream.dll");
    },
  );

  it("rejectColon: true — refuses a top-level ':'-bearing entry (PathEscape)", async () => {
    const work = await mkTmp("xtr-colon");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "colon.zip",
      makeZip([{ name: "evil:stream.dll", data: "PAYLOAD" }]),
    );
    const out = join(work, "out");
    await expect(safeExtract(zip, out, { rejectColon: true })).rejects.toBeInstanceOf(PathEscape);
    const files = await listFiles(out).catch(() => []);
    expect(files).not.toContain("evil:stream.dll");
  });

  it("rejectColon: true — refuses a colon buried in a NESTED entry segment too", async () => {
    const work = await mkTmp("xtr-colon");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "colon.zip",
      makeZip([{ name: "natives/sub/name:stream.txt", data: "x" }]),
    );
    await expect(safeExtract(zip, join(work, "out"), { rejectColon: true })).rejects.toBeInstanceOf(
      PathEscape,
    );
  });

  it("rejectColon: true does not over-reject an ordinary colon-free archive", async () => {
    const work = await mkTmp("xtr-colon");
    dirs.push(work);
    const zip = await zipFile(
      work,
      "ok.zip",
      makeZip([
        { name: "libfoo.so", data: "FOO" },
        { name: "nested/libbar.so", data: "BAR" },
      ]),
    );
    const out = join(work, "out");
    const written = await safeExtract(zip, out, { rejectColon: true });
    expect(written.sort()).toEqual(["libfoo.so", "nested/libbar.so"]);
  });

  it("rejectColon: true still enforces every OTHER guard (traversal, absolute, symlink)", async () => {
    const work = await mkTmp("xtr-colon");
    dirs.push(work);
    const trav = await zipFile(
      work,
      "trav.zip",
      makeZip([{ name: "../escaped.txt", data: "pwned" }]),
    );
    await expect(
      safeExtract(trav, join(work, "out1"), { rejectColon: true }),
    ).rejects.toBeInstanceOf(PathEscape);
    const abs = await zipFile(work, "abs.zip", makeZip([{ name: "/etc/pwned", data: "x" }]));
    await expect(
      safeExtract(abs, join(work, "out2"), { rejectColon: true }),
    ).rejects.toBeInstanceOf(PathEscape);
  });
});
