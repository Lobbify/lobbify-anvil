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
