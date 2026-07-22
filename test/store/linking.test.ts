import { readFile, readlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LINK_ORDER, linkOrCopy, sameVolume } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

// Inode/symlink assertions are POSIX; Windows reports unreliable inodes and needs
// privilege for symlinks. The OS-agnostic behavior (order, cross-volume) runs
// everywhere; these run on Linux/macOS.
const posixIt = it.skipIf(process.platform === "win32");

describe("linking chain", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function srcFile(content = "src-bytes"): Promise<string> {
    const dir = await mkTmp("src");
    dirs.push(dir);
    const p = join(dir, "object");
    await writeFile(p, content);
    return p;
  }

  it("default order prefers shared bytes and never symlinks", () => {
    expect(DEFAULT_LINK_ORDER).toEqual(["reflink", "hardlink", "copy"]);
    expect(DEFAULT_LINK_ORDER).not.toContain("symlink");
  });

  posixIt("hardlinks share an inode with the source", async () => {
    const src = await srcFile();
    const destDir = await mkTmp("dest");
    dirs.push(destDir);
    const dest = join(destDir, "a", "b.jar");
    expect(await linkOrCopy(src, dest, { order: ["hardlink"] })).toBe("hardlink");
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    expect(ds.ino).toBe(ss.ino);
  });

  posixIt("copy produces an independent file", async () => {
    const src = await srcFile("copy-me");
    const destDir = await mkTmp("dest");
    dirs.push(destDir);
    const dest = join(destDir, "copy.jar");
    expect(await linkOrCopy(src, dest, { order: ["copy"] })).toBe("copy");
    const [ss, ds] = await Promise.all([stat(src), stat(dest)]);
    expect(ds.ino).not.toBe(ss.ino);
    expect(await readFile(dest, "utf8")).toBe("copy-me");
  });

  posixIt("creates a symlink only when explicitly requested (non-Windows)", async () => {
    const src = await srcFile("link-target");
    const destDir = await mkTmp("dest");
    dirs.push(destDir);
    const dest = join(destDir, "link.jar");
    expect(await linkOrCopy(src, dest, { order: ["symlink"] })).toBe("symlink");
    expect(await readlink(dest)).toBe(src);
  });

  it("detects a cross-volume destination via an injected dev probe", async () => {
    const src = await srcFile();
    const destDir = await mkTmp("dest");
    dirs.push(destDir);
    const statDev = async (p: string) => (p.startsWith(src) ? 1 : 2);
    expect(await sameVolume(src, destDir, statDev)).toBe(false);
  });

  it("falls back to a copy with a warning across volumes", async () => {
    const src = await srcFile("cross-vol");
    const destDir = await mkTmp("dest");
    dirs.push(destDir);
    const dest = join(destDir, "x.jar");
    const warnings: string[] = [];
    const strategy = await linkOrCopy(src, dest, {
      order: ["reflink", "hardlink", "copy"],
      statDev: async (p) => (p.startsWith(src) ? 1 : 2),
      onWarn: (m) => warnings.push(m),
    });
    expect(strategy).toBe("copy");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("different volumes");
    expect(await readFile(dest, "utf8")).toBe("cross-vol");
  });
});
