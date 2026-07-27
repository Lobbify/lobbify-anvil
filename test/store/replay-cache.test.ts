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

  // --- two hash domains (LB-708) --------------------------------------------
  //
  // BEHAVIOR CHANGE: this cache used to refuse any non-sha256 hash outright. It
  // now carries a sha1 domain, because a CurseForge *base pack* member is pinned
  // from catalogue metadata rather than from bytes, and sha1 is the strongest
  // hash the CurseForge API attests. See the module doc for the trade.

  it("keeps sha1 and sha256 in separate domains, with sha256 at the original path", async () => {
    const { cache, instanceDir } = await freshCache();
    const root = join(instanceDir, ".anvil", "replay-cache");
    // sha256 keeps `objects/` — an existing cache on disk stays addressable.
    expect(cache.objectPath({ algo: "sha256", value: "a".repeat(64) })).toContain(
      join(root, "objects"),
    );
    expect(cache.objectPath({ algo: "sha1", value: "b".repeat(40) })).toContain(
      join(root, "objects-sha1"),
    );
    // The two domains cannot collide, even for an identical hex value.
    const shared = "c".repeat(40);
    expect(cache.objectPath({ algo: "sha1", value: shared })).not.toBe(
      cache.objectPath({ algo: "sha256", value: shared }),
    );
  });

  it("admits and materializes a sha1-pinned object (a CurseForge base member)", async () => {
    const { cache, instanceDir } = await freshCache();
    const bytes = new Uint8Array([11, 22, 33, 44, 55]);
    const sha1 = hashOf(bytes, "sha1");
    expect(await cache.has(sha1)).toBe(false);
    expect((await cache.putBuffer(bytes, sha1)).deduped).toBe(false);
    expect(await cache.has(sha1)).toBe(true);
    const dest = join(instanceDir, "mods", "cf-member.jar");
    await cache.materialize(sha1, dest);
    expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
  });

  it("still verifies in the pin's OWN algorithm — a wrong sha1 never lands", async () => {
    const { cache } = await freshCache();
    const bytes = new Uint8Array([7, 7, 7, 7]);
    const wrongSha1 = hashOf(new Uint8Array([8, 8, 8, 8]), "sha1");
    await expect(cache.putBuffer(bytes, wrongSha1)).rejects.toBeInstanceOf(ShaMismatch);
    expect(await cache.has(wrongSha1)).toBe(false);
    expect(await cache.has(hashOf(bytes, "sha1"))).toBe(false);
    // A sha256-valued pin is NOT satisfied by bytes whose sha1 matches, and vice
    // versa: widening the domain must not have made the check algorithm-blind.
    await expect(cache.putBuffer(bytes, hashOf(bytes, "sha256"))).resolves.toBeTruthy();
    expect(await cache.has(hashOf(bytes, "sha1"))).toBe(false);
  });
});
