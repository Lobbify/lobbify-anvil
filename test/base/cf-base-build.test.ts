/**
 * The sha1 pin a CurseForge base member carries has to survive the whole way
 * down: lock serialization, the replay acquirer, the replay cache, and the
 * placement executor.
 *
 * This is the integration risk the pin choice creates. A member is pinned from
 * catalogue metadata (CurseForge attests sha1, never sha256), so every consumer
 * of `LockPackage.hash` on the replay path now sees an algorithm it previously
 * never saw. Asserting the pieces in isolation would not catch a consumer that
 * silently assumes 64 hex characters — so this builds a real instance from a
 * real CurseForge-base lock and checks the bytes that land.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  ReplayAcquirer,
  ReplayCache,
  ShaMismatch,
  buildInstance,
  currentPlatform,
  parseLock,
  serializeLock,
} from "../../index.js";
import type { Lockfile } from "../../index.js";
import { cfBaseResolverFor, cfPackWorld } from "../helpers/cf-pack.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const MEMBERS = [{ projectID: 238222, fileID: 5000, slug: "jei" }];

describe("a sha1-pinned CurseForge base member, end to end", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function tmp(prefix: string): Promise<string> {
    const d = await mkTmp(prefix);
    dirs.push(d);
    return d;
  }

  async function resolvePack(instanceDir: string, store: ContentStore) {
    const world = cfPackWorld({ members: MEMBERS });
    const pack = await cfBaseResolverFor(world, instanceDir, { now: NOW, store })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
    return { world, pack };
  }

  function lockOf(resolved: Lockfile["resolved"]): Lockfile {
    return {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved,
    };
  }

  it("round-trips the sha1 pin through lock serialize → parse", async () => {
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const { pack } = await resolvePack(instanceDir, store);
    const member = pack.members.find((p) => p.source === "curseforge");
    expect(member?.hash.algo).toBe("sha1");

    const text = serializeLock(lockOf([...pack.members]));
    const parsed = parseLock(text);
    const back = parsed.resolved.find((p) => p.source === "curseforge");
    expect(back?.hash).toEqual(member?.hash);
    expect(back?.project).toBe(238222);
    expect(back?.file).toBe(5000);
    expect(back?.provenance).toBe("replay");
    expect(back?.url).toBeUndefined();
  });

  it("builds: the acquirer fetches, the cache verifies the sha1, the file lands", async () => {
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const { world, pack } = await resolvePack(instanceDir, store);
    const member = pack.members.find((p) => p.source === "curseforge");
    expect(member).toBeDefined();

    const replayCache = new ReplayCache({ instanceDir });
    const replay = new ReplayAcquirer({
      replayCache,
      http: world.http,
      curseforgeKey: "TEST-CF-KEY",
    });

    await buildInstance({
      instanceDir,
      lock: lockOf([member as never]),
      store,
      acquire: { ensure: (p) => replay.ensure(p) },
      replayCache,
      platform: currentPlatform(),
    });

    // The jar is in the instance, and its bytes really do hash to the pin.
    const target = (member as never as { placement: { target: string } }).placement.target;
    const placed = new Uint8Array(await readFile(join(instanceDir, target)));
    expect(hashOf(placed, "sha1")).toEqual(member?.hash);

    // It lives in the per-instance replay cache, NOT the shared store.
    expect(await replayCache.has(member?.hash as never)).toBe(true);
    expect(await store.has(member?.hash as never)).toBe(false);

    // A second build reuses the cached object instead of re-fetching.
    const before = world.http.calls.length;
    await replay.ensure(member as never);
    expect(world.http.calls.length).toBe(before);
  });

  it("refuses bytes that do not match the sha1 pin — a tampered CDN cannot land", async () => {
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    const { pack } = await resolvePack(instanceDir, store);
    const member = pack.members.find((p) => p.source === "curseforge");

    // The tampered world must be identical to the honest one EXCEPT for the
    // substituted CDN bytes. An earlier version of this test also changed the
    // indexed bytes, so the pin disagreed with the metadata too and it passed
    // with `cdnBytes` deleted — i.e. it passed in both conditions and proved
    // nothing about CDN tampering.
    const honestBytes = fabricJar("238222-5000");
    const substituted = new TextEncoder().encode("SUBSTITUTED PAYLOAD");
    const tampered = cfPackWorld({ members: MEMBERS });
    tampered.http.add({
      modId: 238222,
      slug: "jei",
      classId: 6,
      files: [
        {
          id: 5000,
          fileName: "jei-5000.jar",
          displayName: "jei-5000.jar",
          gameVersions: ["26.2"],
          bytes: honestBytes, // metadata still attests the honest sha1…
          cdnBytes: substituted, // …but the CDN hands back something else.
        },
      ],
    });
    // Precondition: the lock's pin IS the honest sha1, so the only thing wrong
    // at fetch time is the bytes.
    expect(member?.hash).toEqual(hashOf(honestBytes, "sha1"));

    const replayCache = new ReplayCache({ instanceDir });
    const replay = new ReplayAcquirer({
      replayCache,
      http: tampered.http,
      curseforgeKey: "TEST-CF-KEY",
    });
    const err = await replay.ensure(member as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShaMismatch);
    // It rejected because the SUBSTITUTED bytes hash differently — assert both
    // sides, or the test cannot tell this failure from any other ShaMismatch.
    const mismatch = err as ShaMismatch & { expected: unknown; actual: unknown };
    expect(mismatch.expected).toEqual(hashOf(honestBytes, "sha1"));
    expect(mismatch.actual).toEqual(hashOf(substituted, "sha1"));
    expect(await replayCache.has(member?.hash as never)).toBe(false);
  });
});
