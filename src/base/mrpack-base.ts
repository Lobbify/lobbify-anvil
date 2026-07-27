/**
 * `game.from = "modrinth:<pack>@<version>"` — a Modrinth `.mrpack` as a base layer.
 *
 * Resolution flow, all of it at **lock time**:
 *
 *   1. select the pack version under the ref's spec + the frozen clock, using the
 *      same selector item refs use;
 *   2. download the `.mrpack`, cross-check Modrinth's attested sha1, and pin the
 *      **sha256** of the archive — that pin is what makes the base identifiable
 *      later without re-fetching it;
 *   3. recover each `files[]` entry's **catalogue identity** from its Modrinth CDN
 *      URL and two batched API calls, so a member arrives as a real
 *      `source: "modrinth"` row (slug as `name`, version number as `version`) —
 *      the axis an instance overrides a base mod on;
 *   4. download, verify, sha256-pin and store each member's bytes;
 *   5. extract `overrides/` (+ `client-overrides/`, which wins) through the
 *      hardened extractor into `.anvil/base/`, as tracked `local` rows.
 *
 * The build never sees any of this. It reads the lock, which by then holds
 * ordinary rows the ordinary sources can fetch and place. That is the whole point
 * of resolving a base at lock time: **`build` never re-fetches a pack**, so a
 * pack edited or withdrawn upstream cannot change an instance that already locked.
 *
 * ## The pack is untrusted input
 *
 * Everything a hostile pack could try is bounded here or in the machinery this
 * calls: archive size, member count, per-member download size, zip-slip and
 * symlink escapes (`safeExtract`), traversal and protected-path targets
 * (`isUnsafePackPath` + `declaredPlacementTarget`), SSRF and redirect pivots
 * (`allowSource` before any fetch, `guardHop` on every hop), and hash lying
 * (declared sha512/sha1 verified before the sha256 pin is computed). What a pack
 * *cannot* do at all is displace something the instance declared — that is the
 * overlay's rule, not a check here.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAX_FILE_BYTES,
  MAX_MRPACK_BYTES,
  MAX_PACK_FILES,
  loaderFromDeps,
  modrinthCdnIdentity,
  parseMrpackIndex,
  pickMirror,
  verifyMrpackHashes,
} from "../import/mrpack-index.js";
import type { MrFile } from "../import/mrpack-index.js";
import { importOverrideTree } from "../import/pack-common.js";
import { readZipEntry } from "../import/zip-read.js";
import { ensureDir, isProtectedTop } from "../internal/fs.js";
import { inferKind } from "../sources/kind.js";
import type { ModrinthProject, ModrinthVersion } from "../sources/modrinth.js";
import { ModrinthApi, primaryFile, selectVersion } from "../sources/modrinth.js";
import { declaredPlacementTarget, safeBasename } from "../sources/place.js";
import { guardHop } from "../sources/ssrf.js";
import { hashBuffer } from "../store/hash.js";
import {
  DecompressionBomb,
  ManifestError,
  ShaMismatch,
  SourceNotAllowed,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type { ItemKind, LockPackage, ResolvedRef } from "../types/index.js";
import type { BasePackSource, BaseResolveContext, ResolvedBasePack } from "./types.js";

/** Where a base's loose override files are tracked, under `.anvil/`. */
export const BASE_TRACKED_SUBDIR = "base";

/** The identity + metadata recovered for one Modrinth-hosted pack member. */
interface MemberIdentity {
  readonly slug: string;
  readonly projectType: string;
  readonly versionNumber: string;
  /** The version file's declared size, when Modrinth reports a sane one. */
  readonly size?: number;
}

export interface MrpackBaseSourceOptions {
  readonly baseUrl?: string;
}

export class MrpackBaseSource implements BasePackSource {
  readonly kind = "modrinth" as const;
  readonly #baseUrl?: string;

  constructor(options: MrpackBaseSourceOptions = {}) {
    this.#baseUrl = options.baseUrl;
  }

  async resolveBase(ref: ResolvedRef, ctx: BaseResolveContext): Promise<ResolvedBasePack> {
    if (!ctx.http) {
      throw new UnsatisfiableTarget(`modrinth:${ref.id}`, "no HTTP client configured");
    }
    const subject = `game.from modrinth:${ref.id}`;
    const api = new ModrinthApi(ctx.http, this.#baseUrl);

    // 1. Select the pack version under the ref spec + the frozen clock.
    const project = await api.getProject(ref.id);
    const versions = await api.getProjectVersions(ref.id, {});
    if (versions.length === 0) {
      throw new UnsatisfiableTarget(subject, "the pack has no published versions");
    }
    const version = selectVersion(versions, ref.versionSpec, ctx.now, subject);
    const archiveFile = primaryFile(version, subject);

    // 2. Fetch + pin the archive itself.
    const res = await ctx.http.get(archiveFile.url, {
      guard: guardHop,
      maxBytes: MAX_MRPACK_BYTES,
    });
    const archiveBytes = res.body;
    if (archiveBytes.byteLength > MAX_MRPACK_BYTES) {
      throw new DecompressionBomb(
        `base pack "${ref.id}" is ${archiveBytes.byteLength} bytes, over the ${MAX_MRPACK_BYTES} limit`,
      );
    }
    if (archiveFile.hashes.sha1) {
      const actual = hashBuffer(archiveBytes, "sha1");
      if (actual.value !== archiveFile.hashes.sha1) {
        throw new ShaMismatch(subject, { algo: "sha1", value: archiveFile.hashes.sha1 }, actual);
      }
    }
    const archive = hashBuffer(archiveBytes, "sha256");

    const indexBytes = await readZipEntry(archiveBytes, "modrinth.index.json");
    if (!indexBytes) {
      throw new ManifestError(
        `base pack "${ref.id}@${version.version_number}" is not a valid .mrpack (no modrinth.index.json)`,
      );
    }
    const index = parseMrpackIndex(indexBytes);
    const files = index.files ?? [];
    if (files.length > MAX_PACK_FILES) {
      throw new DecompressionBomb(
        `base pack "${ref.id}" lists ${files.length} files, over the ${MAX_PACK_FILES} limit`,
      );
    }
    const deps = index.dependencies ?? {};
    const minecraft = deps.minecraft;
    if (!minecraft) {
      throw new ManifestError(`base pack "${ref.id}" declares no Minecraft version`);
    }

    const warnings: string[] = [];
    const members: LockPackage[] = [];
    const emit = ctx.emit;

    // 3. Recover catalogue identity for every CDN-hosted member, in two batched
    //    calls for the whole pack rather than one per member.
    const client = filterClientFiles(files, warnings);
    const identities = await identifyMembers(client, api);

    // 4. Fetch, verify, pin, and store each member.
    let i = 0;
    for (const file of client) {
      const target = placementTargetFor(file, warnings);
      if (target === undefined) {
        continue;
      }
      const mirror = pickMirror(file.downloads, file.path);
      const identity = identities.get(mirror);
      // The policy gate sees the member's REAL identity where we recovered one,
      // so an embedder's "Modrinth is allowed, arbitrary URLs are not" policy
      // reads a base's mods the same way it reads a manifest's. It runs before
      // any byte is fetched, as everywhere else.
      const memberRef: ResolvedRef = identity
        ? {
            source: "modrinth",
            id: identity.slug,
            versionSpec: { kind: "pin", version: identity.versionNumber },
          }
        : { source: "url", id: mirror, versionSpec: { kind: "latest" } };
      if (!ctx.allowSource(memberRef)) {
        throw new SourceNotAllowed(memberRef.source, memberRef.id);
      }
      const bytes = (await ctx.http.get(mirror, { guard: guardHop, maxBytes: MAX_FILE_BYTES }))
        .body;
      verifyMrpackHashes(bytes, file);
      const hash = hashBuffer(bytes, "sha256");
      await ctx.store?.putBuffer(bytes, "sha256", hash);
      const kind: ItemKind = await inferKind({
        subject: `${subject}: ${file.path}`,
        ...(identity ? { projectType: identity.projectType } : {}),
        filename: file.path,
        bytes,
      });
      const size = sizeFor(file, identity, bytes.byteLength);
      members.push({
        name: identity ? identity.slug : safeBasename(file.path, ".jar"),
        kind,
        source: identity ? "modrinth" : "url",
        ...(identity ? { version: identity.versionNumber } : {}),
        hash,
        provenance: "copy",
        placement: { method: "link", target },
        size,
        // The URL we actually fetched and hashed — never a mirror we did not use.
        url: mirror,
      });
      emit?.({ type: "resolve:item", name: file.path, index: i++, total: client.length });
    }

    // 5. `overrides/` → tracked local rows under `.anvil/base/`.
    const overrides = await this.#extractOverrides(archiveBytes, ctx, warnings);
    members.push(...overrides);

    return {
      source: "modrinth",
      id: project.slug,
      version: version.version_number,
      archive,
      game: { minecraft, loader: loaderFromDeps(deps) },
      members,
      warnings,
    };
  }

  /**
   * Stage the archive to a throwaway file and run the pack's override prefixes
   * through the shared hardened extractor. The bytes have to reach the filesystem
   * for `safeExtract`, so they land under `.anvil/` — never in the instance tree,
   * where a half-extracted hostile pack would be a build input.
   */
  async #extractOverrides(
    archiveBytes: Uint8Array,
    ctx: BaseResolveContext,
    warnings: string[],
  ): Promise<LockPackage[]> {
    const anvilDir = join(ctx.instanceDir, ".anvil");
    await ensureDir(anvilDir);
    const stagedArchive = join(anvilDir, `base-archive-${process.pid}.mrpack`);
    const placeable = new Map<string, LockPackage>();
    try {
      await writeFile(stagedArchive, archiveBytes);
      // A re-resolved base must not inherit the previous base's files: wipe the
      // tracked root first, or switching `game.from` leaves orphans on disk that
      // the next commit would carry as if they were still part of the base.
      await rm(join(anvilDir, BASE_TRACKED_SUBDIR), { recursive: true, force: true });
      await importOverrideTree({
        archivePath: stagedArchive,
        instanceDir: ctx.instanceDir,
        store: sinkFor(ctx),
        prefixes: ["overrides", "client-overrides"],
        placeable,
        warnings,
        trackedSubdir: BASE_TRACKED_SUBDIR,
        onStored: (hash) => ctx.emit?.({ type: "object:store", hash, deduped: false }),
      });
    } finally {
      await rm(stagedArchive, { force: true });
    }
    return [...placeable.values()];
  }
}

/**
 * A base override has to be *somewhere* on disk for the build to link it, so its
 * bytes are always admitted. When the caller supplies no store the writes are
 * dropped on the floor rather than failing — the tracked `file://` copy under
 * `.anvil/base/` is still written, and that is what `plan()` reads.
 */
function sinkFor(ctx: BaseResolveContext): NonNullable<BaseResolveContext["store"]> {
  return (
    ctx.store ?? {
      has: async () => false,
      putBuffer: async (data: Uint8Array) => ({
        hash: hashBuffer(data, "sha256"),
        deduped: false,
      }),
      putFile: async () => {
        throw new UnsatisfiableTarget("base overrides", "no content store configured");
      },
    }
  );
}

/** Drop the server-only members: anvil builds a client instance. */
function filterClientFiles(files: readonly MrFile[], warnings: string[]): MrFile[] {
  const out: MrFile[] = [];
  for (const file of files) {
    if (file.env?.client === "unsupported") {
      warnings.push(`base pack: skipped server-only file ${file.path}`);
      continue;
    }
    out.push(file);
  }
  return out;
}

/**
 * The placement a pack member declares, or `undefined` (with a warning) when the
 * pack names somewhere anvil will not write. A member targeting `saves/` is
 * skipped rather than relocated: silently moving a world file into `config/` is
 * worse than not installing it, and `saves/` is never touched, by invariant.
 */
function placementTargetFor(file: MrFile, warnings: string[]): string | undefined {
  const top = file.path.split(/[/\\]/)[0] ?? "";
  if (isProtectedTop(top)) {
    warnings.push(`base pack: skipped file targeting a protected path: ${file.path}`);
    return undefined;
  }
  let target: string | undefined;
  try {
    target = declaredPlacementTarget(file.path);
  } catch {
    target = undefined;
  }
  if (target === undefined) {
    warnings.push(`base pack: skipped file with an unusable path: ${file.path}`);
  }
  return target;
}

/**
 * Prefer the catalogue's declared size (so a base member's row matches the row a
 * direct `modrinth:` listing would produce), then the pack's, then our own byte
 * count. A declared size is metadata for transfer planning, never a trust
 * boundary — the hash is.
 */
function sizeFor(file: MrFile, identity: MemberIdentity | undefined, actual: number): number {
  const declared = identity?.size ?? file.fileSize;
  return typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0
    ? declared
    : actual;
}

/**
 * Recover the Modrinth identity of every CDN-hosted member: two batched calls for
 * the whole pack (versions by id, then projects by id), keyed by the download URL
 * the member will be fetched from.
 *
 * A member whose mirror is not the Modrinth CDN simply has no entry. That is not
 * a failure — it becomes a `url` row, overridable by placement path but not by
 * name. An API call that fails is also not fatal here for the same reason: losing
 * identity degrades override precision, it does not make the pack unusable.
 */
async function identifyMembers(
  files: readonly MrFile[],
  api: ModrinthApi,
): Promise<Map<string, MemberIdentity>> {
  const byMirror = new Map<string, { projectId: string; versionId: string }>();
  for (const file of files) {
    if (file.downloads.length === 0) {
      continue;
    }
    const mirror = pickMirror(file.downloads, file.path);
    const cdn = modrinthCdnIdentity(mirror);
    if (cdn) {
      byMirror.set(mirror, cdn);
    }
  }
  const out = new Map<string, MemberIdentity>();
  if (byMirror.size === 0) {
    return out;
  }
  const versionIds = [...new Set([...byMirror.values()].map((v) => v.versionId))].sort();
  let versions: ModrinthVersion[];
  let projects: ModrinthProject[];
  try {
    versions = await api.getVersions(versionIds);
    const projectIds = [...new Set(versions.map((v) => v.project_id))].sort();
    projects = await api.getProjects(projectIds);
  } catch {
    return out; // identity is an optimization, not a requirement
  }
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const projectById = new Map(projects.map((p) => [p.id, p]));
  for (const [mirror, cdn] of byMirror) {
    const version = versionById.get(cdn.versionId);
    const project = projectById.get(version?.project_id ?? cdn.projectId);
    if (!version || !project) {
      continue;
    }
    const size = version.files.find((f) => f.url === mirror)?.size;
    out.set(mirror, {
      slug: project.slug,
      projectType: project.project_type,
      versionNumber: version.version_number,
      ...(size !== undefined ? { size } : {}),
    });
  }
  return out;
}
