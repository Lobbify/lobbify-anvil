import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayCache, ShaMismatch } from "../../index.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";

describe("ReplayCache", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function freshCache(): Promise<{ cache: ReplayCache; instanceDir: string }> {
    const instanceDir = await mkTmp("instance");
    dirs.push(instanceDir);
    return { cache: new ReplayCache({ instanceDir }), instanceDir };
  }

  it("lives under the instance .anvil/replay-cache — NEVER the shared store", async () => {
    const { cache, instanceDir } = await freshCache();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = hashOf(bytes, "sha256");
    // The object path is rooted at the per-instance .anvil/replay-cache/objects.
    const expectedRoot = join(instanceDir, ".anvil", "replay-cache", "objects");
    expect(cache.objectPath(hash).startsWith(expectedRoot)).toBe(true);
  });

  it("admits bytes verified against their sha256 pin, then reports has()", async () => {
    const { cache } = await freshCache();
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const hash = hashOf(bytes, "sha256");
    expect(await cache.has(hash)).toBe(false);
    const { deduped } = await cache.putBuffer(bytes, hash);
    expect(deduped).toBe(false);
    expect(await cache.has(hash)).toBe(true);
    // Second admit dedups.
    const again = await cache.putBuffer(bytes, hash);
    expect(again.deduped).toBe(true);
  });

  it("REJECTS bytes that do not match the pin (ShaMismatch) — never lands them", async () => {
    const { cache } = await freshCache();
    const bytes = new Uint8Array([1, 1, 1, 1]);
    const wrongPin = hashOf(new Uint8Array([2, 2, 2, 2]), "sha256");
    await expect(cache.putBuffer(bytes, wrongPin)).rejects.toBeInstanceOf(ShaMismatch);
    expect(await cache.has(wrongPin)).toBe(false);
    // And the (correct) hash was never admitted either.
    expect(await cache.has(hashOf(bytes, "sha256"))).toBe(false);
  });

  it("materializes a cached object into the instance tree byte-identically", async () => {
    const { cache, instanceDir } = await freshCache();
    const bytes = new Uint8Array([42, 43, 44, 45, 46, 47]);
    const hash = hashOf(bytes, "sha256");
    await cache.putBuffer(bytes, hash);
    const dest = join(instanceDir, "mods", "some-mod.jar");
    await cache.materialize(hash, dest);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("refuses a non-sha256 hash (the replay domain is sha256-only)", async () => {
    const { cache } = await freshCache();
    expect(() => cache.objectPath({ algo: "sha1", value: "deadbeef" })).toThrow(ShaMismatch);
  });
});
