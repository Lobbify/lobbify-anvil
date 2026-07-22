import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, OBJECT_MODE, linkOrCopy } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

// POSIX filesystem semantics (0444 + hardlink inodes). Windows models read-only
// as a file attribute with different errno/inode behavior, so these run on
// Linux/macOS (where the invariant is validated); the property is inherently POSIX.
const posixIt = it.skipIf(process.platform === "win32");

// GATE — immutability: a linked object cannot be edited in place, and a hardlink
// shared across two instances stays consistent (one immutable inode).
describe("immutability gate", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  posixIt("stores objects 0444 and refuses an in-place edit of a hardlinked object", async () => {
    const storeDir = await mkTmp("store");
    const instDir = await mkTmp("inst");
    dirs.push(storeDir, instDir);
    const store = new ContentStore({ root: storeDir });

    const { hash } = await store.putBuffer(Buffer.from("immutable-bytes"), "sha256");
    const objStat = await stat(store.objectPath(hash));
    expect(objStat.mode & 0o777).toBe(OBJECT_MODE);

    const dest = join(instDir, "mods", "a.jar");
    const strategy = await linkOrCopy(store.objectPath(hash), dest, { order: ["hardlink"] });
    expect(strategy).toBe("hardlink");

    // A hardlink shares the immutable (0444) inode: opening it for write fails.
    await expect(open(dest, "w")).rejects.toMatchObject({ code: "EACCES" });
  });

  posixIt("keeps a hardlink shared across two instances consistent (same inode)", async () => {
    const storeDir = await mkTmp("store");
    const instA = await mkTmp("instA");
    const instB = await mkTmp("instB");
    dirs.push(storeDir, instA, instB);
    const store = new ContentStore({ root: storeDir });

    const { hash } = await store.putBuffer(Buffer.from("shared-payload"), "sha256");
    const destA = join(instA, "mods", "shared.jar");
    const destB = join(instB, "mods", "shared.jar");
    expect(await linkOrCopy(store.objectPath(hash), destA, { order: ["hardlink"] })).toBe(
      "hardlink",
    );
    expect(await linkOrCopy(store.objectPath(hash), destB, { order: ["hardlink"] })).toBe(
      "hardlink",
    );

    const [sa, sb, so] = await Promise.all([
      stat(destA),
      stat(destB),
      stat(store.objectPath(hash)),
    ]);
    expect(sa.ino).toBe(so.ino);
    expect(sb.ino).toBe(so.ino);
    expect(await readFile(destA, "utf8")).toBe("shared-payload");
    expect(await readFile(destB, "utf8")).toBe("shared-payload");
  });
});
