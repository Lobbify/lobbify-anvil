/**
 * A `game.from` base-pack world: a {@link FakeModrinth} carrying real mod
 * projects plus a *modpack* project whose version file is a `.mrpack` naming
 * those mods by their canonical CDN URLs.
 *
 * Built this way on purpose. A pack fixture whose members point at arbitrary URLs
 * would exercise only the `url`-identity fallback and would quietly never test
 * the identity recovery every override rule depends on.
 */

import type { Manifest, ResolvedBasePack } from "../../index.js";
import { MrpackBaseSource } from "../../index.js";
import { buildMrpack } from "./mrpack.js";
import type { MrpackFileSpec, MrpackSpec } from "./mrpack.js";
import { FakeModrinth, fabricJar, modrinthFileUrl } from "./net.js";

export const PACK_MC = "26.2";
export const PACK_LOADER = "fabric 0.19.1";

interface ModSpec {
  readonly slug: string;
  readonly projectId: string;
  readonly version: string;
  /** Vary the bytes to make two members genuinely distinct. */
  readonly body?: string;
}

function modVersion(spec: ModSpec) {
  return {
    id: `${spec.projectId}-v-${spec.version}`,
    projectId: spec.projectId,
    versionNumber: spec.version,
    datePublished: "2026-06-01T00:00:00Z",
    loaders: ["fabric"],
    gameVersions: [PACK_MC],
    filename: `${spec.projectId}-${spec.version}.jar`,
    bytes: fabricJar(spec.body ?? `${spec.projectId}-${spec.version}`),
  };
}

export interface BaseWorld {
  readonly http: FakeModrinth;
  /** The `game.from` string for the pack. */
  readonly from: string;
  /** Placement targets the pack's `files[]` land at, in declaration order. */
  readonly memberTargets: readonly string[];
  /**
   * The member versions as published, by project id. A test adding a *newer*
   * version of a base mod must re-register the project with these included: the
   * pack pinned their bytes, and re-registering without them makes the CDN serve
   * content the pack's own sha512 rejects.
   */
  readonly memberVersions: ReadonlyMap<string, ReturnType<typeof modVersion>>;
}

export interface BaseWorldSpec {
  readonly mods: readonly ModSpec[];
  /** Loose `overrides/` files the pack ships. */
  readonly overrides?: readonly { readonly path: string; readonly data: string }[];
  /** Extra raw `files[]` entries (a hostile path, a non-CDN mirror, …). */
  readonly extraFiles?: readonly MrpackFileSpec[];
  /** Raw zip entries appended verbatim — zip-slip / symlink attack cases. */
  readonly malicious?: MrpackSpec["malicious"];
  readonly packVersion?: string;
  readonly minecraft?: string;
}

/** Build the fake Modrinth world + the pack that references it. */
export function baseWorld(spec: BaseWorldSpec): BaseWorld {
  const http = new FakeModrinth();
  const files: MrpackFileSpec[] = [];
  const memberTargets: string[] = [];
  const memberVersions = new Map<string, ReturnType<typeof modVersion>>();
  for (const mod of spec.mods) {
    const version = modVersion(mod);
    memberVersions.set(mod.projectId, version);
    http.add({
      id: mod.projectId,
      slug: mod.slug,
      title: mod.slug,
      projectType: "mod",
      versions: [version],
    });
    const target = `mods/${version.filename}`;
    memberTargets.push(target);
    files.push({ path: target, bytes: version.bytes, mirror: modrinthFileUrl(version) });
  }
  for (const extra of spec.extraFiles ?? []) {
    files.push(extra);
  }
  const packVersion = spec.packVersion ?? "1.0.0";
  const archive = buildMrpack({
    name: "Test Pack",
    versionId: packVersion,
    minecraft: spec.minecraft ?? PACK_MC,
    loader: { name: "fabric-loader", version: "0.19.1" },
    files,
    ...(spec.overrides ? { overrides: spec.overrides } : {}),
    ...(spec.malicious ? { malicious: spec.malicious } : {}),
  });
  http.add({
    id: "PACKID",
    slug: "testpack",
    title: "Test Pack",
    projectType: "modpack",
    versions: [
      {
        id: `pack-v-${packVersion}`,
        projectId: "PACKID",
        versionNumber: packVersion,
        datePublished: "2026-06-10T00:00:00Z",
        loaders: ["fabric"],
        gameVersions: [spec.minecraft ?? PACK_MC],
        filename: `testpack-${packVersion}.mrpack`,
        bytes: new Uint8Array(archive),
      },
    ],
  });
  return { http, from: `modrinth:testpack@${packVersion}`, memberTargets, memberVersions };
}

/** A manifest declaring the pack as its base. */
export function baseManifest(from: string, extra: Partial<Manifest["game"]> = {}): Manifest {
  return {
    project: { name: "p", version: "1" },
    game: { minecraft: PACK_MC, loader: PACK_LOADER, from, ...extra },
    items: [],
  };
}

/** A `resolveBase` callback wired to a world's fake HTTP. */
export function baseResolverFor(
  world: BaseWorld,
  instanceDir: string,
  opts: {
    now: number;
    store?: ResolveBaseStore;
    allowSource?: (ref: Parameters<NonNullable<AllowSourceFn>>[0]) => boolean;
  },
): (ref: Parameters<MrpackBaseSource["resolveBase"]>[0]) => Promise<ResolvedBasePack> {
  const source = new MrpackBaseSource();
  return (ref) =>
    source.resolveBase(ref, {
      http: world.http,
      now: opts.now,
      allowSource: opts.allowSource ?? (() => true),
      ...(opts.store ? { store: opts.store } : {}),
      instanceDir,
    });
}

type ResolveBaseStore = NonNullable<Parameters<MrpackBaseSource["resolveBase"]>[1]["store"]>;
type AllowSourceFn = Parameters<MrpackBaseSource["resolveBase"]>[1]["allowSource"];
