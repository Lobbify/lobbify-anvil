/**
 * A malformed CurseForge **response** — as distinct from a malicious pack.
 *
 * The pack is not the only untrusted input on this path. A base resolve makes
 * two API calls per member, and anvil's decoders `JSON.parse(...) as T`: they
 * cast, they do not validate. A mirror, a caching proxy, an error page served
 * with a 200, or a delisted id can all return JSON that type-checks at compile
 * time and is junk at run time — and dereferencing that yields an untyped
 * `TypeError` with a useless message, which the ticket's "never a crash, never a
 * silently empty pack" constraint forbids.
 *
 * Every case here was a real crash or a real silent-empty before it was fixed.
 * The rule they encode: **a bad response is a typed error or a warned skip, and
 * a base that lists members never resolves to zero of them.**
 */

import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, ManifestError, UnsatisfiableTarget } from "../../index.js";
import type { ResolvedBasePack } from "../../index.js";
import { CF_PACK_MC, cfBaseResolverFor, cfPackWorld } from "../helpers/cf-pack.js";
import type { CfMangle } from "../helpers/curseforge.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const MEMBERS = [{ projectID: 238222, fileID: 5000, slug: "jei" }];

describe("a malformed CurseForge response", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  /** Resolve the standard pack with `mangle` applied to every JSON response. */
  async function resolveWith(
    mangle: CfMangle,
    opts: { members?: typeof MEMBERS; rawManifest?: string } = {},
  ): Promise<ResolvedBasePack> {
    const instanceDir = await mkTmp("inst");
    const storeRoot = await mkTmp("store");
    dirs.push(instanceDir, storeRoot);
    const world = cfPackWorld({
      members: opts.members ?? MEMBERS,
      ...(opts.rawManifest ? { rawManifest: opts.rawManifest } : {}),
    });
    world.http.mangle(mangle);
    return cfBaseResolverFor(world, instanceDir, {
      now: NOW,
      store: new ContentStore({ root: storeRoot }),
    })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
  }

  /** Replace the `data` of whichever route matches `pattern`. */
  const dataFor = (pattern: RegExp, data: unknown): CfMangle => {
    return (path, body) => (pattern.test(path) ? { data } : body);
  };

  // --- the pack's own file record -------------------------------------------

  it("a null pack-file record is a typed error, not a TypeError", async () => {
    await expect(
      resolveWith(dataFor(/^\/v1\/mods\/715572\/files\/\d+$/, null)),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  it("a pack-file record missing fileName is a typed error", async () => {
    await expect(
      resolveWith(dataFor(/^\/v1\/mods\/715572\/files\/\d+$/, { id: 8323938, modId: 715572 })),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  /** Resolve with `latest`, which is the path that lists a project's files. */
  async function resolveLatestWith(mangle: CfMangle): Promise<ResolvedBasePack> {
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    const world = cfPackWorld({ members: MEMBERS });
    world.http.mangle(mangle);
    return cfBaseResolverFor(world, instanceDir, { now: NOW })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "latest" },
    });
  }

  it("a non-iterable file listing is not a crash", async () => {
    // Deliberately a non-iterable OBJECT, not a string. A string `data` is
    // iterable, so `for…of` walks its characters and the per-entry validator
    // rejects each one — the outer Array.isArray guard would look redundant and
    // a test using a string passes with that guard deleted. An object discriminates.
    await expect(
      resolveLatestWith(dataFor(/^\/v1\/mods\/715572\/files$/, { oops: true })),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  it("a string file listing is not a crash either", async () => {
    await expect(
      resolveLatestWith(dataFor(/^\/v1\/mods\/715572\/files$/, "notanarray")),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  it("an unparseable fileDate never wins 'latest' selection", async () => {
    // A NaN date makes every later comparison NaN, so a naive scan can never
    // replace its first candidate — one junk date on the first listed file would
    // silently pin an old pack version, reproducibly and forever. The junk entry
    // must be dropped, leaving the genuinely newest file to win.
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    const world = cfPackWorld({ members: MEMBERS });
    world.http.mangle((path, body) => {
      if (!/^\/v1\/mods\/715572\/files$/.test(path)) {
        return body;
      }
      const b = body as { data: Record<string, unknown>[] };
      const real = b.data[0] as Record<string, unknown>;
      return {
        // The junk-dated decoy is listed FIRST, so a naive scan latches onto it
        // and can never move off it. Only the real entry is actually downloadable.
        data: [{ ...real, id: 1, fileDate: "not-a-date" }, real],
      };
    });
    const pack = await cfBaseResolverFor(world, instanceDir, {
      now: NOW,
      store: new ContentStore({ root: await mkTmp("store") }),
    })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "latest" },
    });
    expect(pack.version).toBe(String(world.packFileId));
  });

  it("a file listing full of nulls is not a crash", async () => {
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    const world = cfPackWorld({ members: MEMBERS });
    world.http.mangle(dataFor(/^\/v1\/mods\/715572\/files$/, [null, null]));
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "latest" },
      }),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  // --- hash fields ----------------------------------------------------------

  it("a hashes array of nulls does not crash the archive check", async () => {
    // The archive still downloads; it simply has no attested sha1 to check.
    const pack = await resolveWith((path, body) => {
      if (/^\/v1\/mods\/715572\/files\/\d+$/.test(path)) {
        const b = body as { data: Record<string, unknown> };
        return { data: { ...b.data, hashes: [null, 7, "x"] } };
      }
      return body;
    });
    expect(pack.members.length).toBeGreaterThan(0);
  });

  it("a non-string hash value does not crash — it is treated as no sha1", async () => {
    // On a MEMBER this means the row cannot be pinned, so the member drops; the
    // pack then has no pinnable members at all and fails loudly rather than
    // resolving to an empty base.
    await expect(
      resolveWith((path, body) => {
        if (/^\/v1\/mods\/238222\/files\/\d+$/.test(path)) {
          const b = body as { data: Record<string, unknown> };
          return { data: { ...b.data, hashes: [{ algo: 1, value: 12345 }] } };
        }
        return body;
      }),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  it("a well-formed-string-but-not-a-digest sha1 is refused as a pin", async () => {
    // Distinct from "no sha1 at all": this is a 40-ish character string that is
    // not hex. Accepting it would put a pin in the lock that no bytes can ever
    // satisfy, so every build of that instance would fail at admission instead
    // of at lock time.
    await expect(
      resolveWith((path, body) => {
        if (/^\/v1\/mods\/238222\/files\/\d+$/.test(path)) {
          const b = body as { data: Record<string, unknown> };
          return { data: { ...b.data, hashes: [{ algo: 1, value: "z".repeat(40) }] } };
        }
        return body;
      }),
    ).rejects.toThrow(/none could be pinned/);
  });

  it("a numeric member fileName does not reach the placement code", async () => {
    await expect(
      resolveWith((path, body) => {
        if (/^\/v1\/mods\/238222\/files\/\d+$/.test(path)) {
          const b = body as { data: Record<string, unknown> };
          return { data: { ...b.data, fileName: 12345 } };
        }
        return body;
      }),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  // --- the mod record -------------------------------------------------------

  it("a null mod record fails the resolve rather than silently degrading it", async () => {
    // The mod record carries classId (the only source of a member's kind, since
    // no bytes are fetched) and slug (the row's name). Losing it must not
    // quietly change what the pack resolves to.
    await expect(resolveWith(dataFor(/^\/v1\/mods\/238222$/, null))).rejects.toBeInstanceOf(
      UnsatisfiableTarget,
    );
  });

  it("a hostile slug never reaches the lock verbatim", async () => {
    const pack = await resolveWith((path, body) => {
      if (/^\/v1\/mods\/238222$/.test(path)) {
        const b = body as { data: Record<string, unknown> };
        return { data: { ...b.data, slug: "../../etc/passwd" } };
      }
      return body;
    });
    const member = pack.members.find((p) => p.project === 238222);
    expect(member?.name).toBe("238222"); // fell back to the project id
    expect(member?.name).not.toContain("..");
    // And placement was never derived from the slug in the first place.
    expect(member?.placement.method === "link" && member.placement.target).toBe(
      "mods/jei-5000.jar",
    );
  });

  it("a non-string slug does not put a non-string name in the lock", async () => {
    const pack = await resolveWith((path, body) => {
      if (/^\/v1\/mods\/238222$/.test(path)) {
        const b = body as { data: Record<string, unknown> };
        return { data: { ...b.data, slug: 12345 } };
      }
      return body;
    });
    expect(typeof pack.members.find((p) => p.project === 238222)?.name).toBe("string");
  });

  // --- download-url ---------------------------------------------------------

  it("a non-string download-url is 'no download', not a crash", async () => {
    await expect(resolveWith(dataFor(/download-url$/, { nope: true }))).rejects.toThrow(
      /disabled third-party API downloads/,
    );
  });

  // --- the silent empty pack ------------------------------------------------

  it("a non-array manifest files[] is an error, never an empty pack", async () => {
    // Every other field failure in the manifest parser is a typed ManifestError;
    // `files` used to be the one that fell back to `[]`, producing a base that
    // installs nothing, reports nothing, and fails nothing downstream.
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    const world = cfPackWorld({
      members: [],
      rawManifest: JSON.stringify({
        manifestType: "minecraftModpack",
        minecraft: { version: CF_PACK_MC, modLoaders: [{ id: "fabric-0.19.1", primary: true }] },
        files: "notanarray",
      }),
    });
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "pin", version: String(world.packFileId) },
      }),
    ).rejects.toBeInstanceOf(ManifestError);
  });

  it("a pack whose every member drops out fails loudly instead of resolving empty", async () => {
    // All members 404 → all skipped → members: []. Silently returning that would
    // build an instance missing every mod the pack asked for.
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    const world = cfPackWorld({
      members: [
        { projectID: 111, fileID: 1, unpublished: true },
        { projectID: 222, fileID: 2, unpublished: true },
      ],
    });
    await expect(
      cfBaseResolverFor(world, instanceDir, { now: NOW })({
        source: "curseforge",
        id: "715572",
        versionSpec: { kind: "pin", version: String(world.packFileId) },
      }),
    ).rejects.toThrow(/none could be pinned/);
  });

  it("a pack with no members at all still resolves (overrides-only packs exist)", async () => {
    const instanceDir = await mkTmp("inst");
    const storeRoot = await mkTmp("store");
    dirs.push(instanceDir, storeRoot);
    const world = cfPackWorld({
      members: [],
      overrides: [{ path: "config/a.toml", data: "x\n" }],
    });
    const pack = await cfBaseResolverFor(world, instanceDir, {
      now: NOW,
      store: new ContentStore({ root: storeRoot }),
    })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
    expect(pack.members).toHaveLength(1);
    expect(pack.members[0]?.source).toBe("local");
  });

  // --- duplicate members ----------------------------------------------------

  it("dedups a repeated (projectID, fileID) instead of billing the user for it", async () => {
    const instanceDir = await mkTmp("inst");
    const storeRoot = await mkTmp("store");
    dirs.push(instanceDir, storeRoot);
    const world = cfPackWorld({
      members: MEMBERS,
      rawFiles: Array.from({ length: 50 }, () => ({
        projectID: 238222,
        fileID: 5000,
        required: true,
      })),
    });
    const pack = await cfBaseResolverFor(world, instanceDir, {
      now: NOW,
      store: new ContentStore({ root: storeRoot }),
    })({
      source: "curseforge",
      id: "715572",
      versionSpec: { kind: "pin", version: String(world.packFileId) },
    });
    // One row, and one metadata call — not 51 of each.
    expect(pack.members.filter((p) => p.project === 238222)).toHaveLength(1);
    expect(world.http.calls.filter((u) => u.endsWith("/v1/mods/238222/files/5000"))).toHaveLength(
      1,
    );
  });
});
