import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, ShaMismatch, hashBuffer } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

describe("ContentStore", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function freshStore(): Promise<ContentStore> {
    const root = await mkTmp("store");
    dirs.push(root);
    return new ContentStore({ root });
  }

  it("domain-partitions by algorithm and shards by the first two hex chars", async () => {
    const store = await freshStore();
    const sha256 = await store.putBuffer(Buffer.from("a"), "sha256");
    const sha1 = await store.putBuffer(Buffer.from("a"), "sha1");
    expect(store.objectPath(sha256.hash)).toContain(join("blobs", "objects"));
    expect(store.objectPath(sha1.hash)).toContain(join("assets", "objects"));
    expect(store.objectPath(sha256.hash)).toContain(
      join(sha256.hash.value.slice(0, 2), sha256.hash.value),
    );
  });

  it("dedups an identical object on a second put", async () => {
    const store = await freshStore();
    const first = await store.putBuffer(Buffer.from("payload"), "sha256");
    const second = await store.putBuffer(Buffer.from("payload"), "sha256");
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.hash.value).toBe(first.hash.value);
    expect(await store.has(first.hash)).toBe(true);
  });

  it("rejects bytes that do not match an expected hash", async () => {
    const store = await freshStore();
    const wrong = hashBuffer(Buffer.from("something-else"), "sha256");
    await expect(store.putBuffer(Buffer.from("payload"), "sha256", wrong)).rejects.toBeInstanceOf(
      ShaMismatch,
    );
  });

  it("materializes an object and reaps orphan temp files", async () => {
    const store = await freshStore();
    const { hash } = await store.putBuffer(Buffer.from("materialize-me"), "sha256");
    const dest = join(await mkTmp("inst"), "mods", "m.jar");
    dirs.push(dest);
    await store.materialize(hash, dest);
    expect(await readFile(dest, "utf8")).toBe("materialize-me");

    await writeFile(join(store.tmpDir, "orphan.tmp"), "leftover");
    expect(await store.sweepTmp()).toBe(1);
  });

  it("fsck passes on a clean store and flags a corrupted object", async () => {
    const store = await freshStore();
    const { hash } = await store.putBuffer(Buffer.from("good"), "sha256");
    expect((await store.fsck()).ok).toBe(true);

    // Corrupt the object in place (defeating 0444) to simulate bit-rot.
    const objPath = store.objectPath(hash);
    await chmod(objPath, 0o644);
    await writeFile(objPath, "tampered");
    const result = await store.fsck();
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes(hash.value))).toBe(true);
  });

  it("gc mark-sweeps unrooted objects and respects the grace window", async () => {
    const store = await freshStore();
    const keep = await store.putBuffer(Buffer.from("rooted"), "sha256");
    const drop = await store.putBuffer(Buffer.from("garbage"), "sha256");

    // Grace window protects a recent object even when unrooted.
    const protectedPass = await store.gc([keep.hash], { graceMs: 60_000 });
    expect(protectedPass.removed).toBe(0);
    expect(await store.has(drop.hash)).toBe(true);

    const result = await store.gc([keep.hash], { graceMs: 0 });
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(await store.has(keep.hash)).toBe(true);
    expect(await store.has(drop.hash)).toBe(false);
  });

  it("never enumerates a foreign dir outside the store root during gc", async () => {
    const store = await freshStore();
    const foreign = await mkTmp("foreign-minecraft");
    dirs.push(foreign);
    await writeFile(join(foreign, "important.dat"), "not-ours");
    const { hash } = await store.putBuffer(Buffer.from("obj"), "sha256");
    // gc with empty roots would delete the store object, but must never touch `foreign`.
    await store.gc([], { graceMs: 0 });
    expect(await store.has(hash)).toBe(false);
    expect(await readFile(join(foreign, "important.dat"), "utf8")).toBe("not-ours");
  });
});
