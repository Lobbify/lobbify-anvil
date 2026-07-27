/**
 * `game.from = "curseforge:<projectId>[@<fileId>]"` — a CurseForge modpack as a
 * base layer.
 *
 * ## The pack is a list of identities, so resolution needs no bytes
 *
 * This is the whole design, and it is *not* the `.mrpack` design wearing a
 * CurseForge hat. A `.mrpack` index names each member by URL + hash: to know
 * what a member *is* you must fetch it (or reverse the CDN URL), and to trust it
 * you must hash it. A CurseForge `manifest.json` names each member by
 * `(projectID, fileID)` — a stable catalogue identity — and states nothing else.
 * So:
 *
 *   - **No member byte is downloaded at lock time.** Every authoritative fact
 *     (filename, size, class, attested sha1) is read from the CurseForge API for
 *     that `(projectID, fileID)`. A 482-member pack locks in metadata calls
 *     rather than ~15 GB of jars that would be discarded and re-fetched at build
 *     time anyway.
 *   - **The lock pins `(projectID, fileID)` + CurseForge's attested sha1.** The
 *     identity pair is the primary pin (a CurseForge file id is immutable and
 *     names one uploaded artifact forever); the sha1 is the tamper-evidence the
 *     build verifies the downloaded bytes against.
 *   - **Two pack versions diff as a set difference** over those pairs, with no
 *     hashing and no filename matching — see {@link diffMemberSets}. This is a
 *     cleaner diff primitive than a `.mrpack`, which needs hashes precisely
 *     because it carries no identities.
 *
 * ## Replay, never rehosted
 *
 * Every member is emitted as `provenance: "replay"` with `project`/`file` and
 * **no `url`**, which is the same row shape a direct `curseforge:` item produces.
 * That single property is what routes it, structurally, away from every shared
 * surface: the shared store refuses it ({@link NetworkAcquirer}), GC does not
 * root it, push/sync skip it, `.mrpack` export omits it, and the placement
 * executor materializes it from the per-instance replay cache. Nothing in this
 * file has to enforce the ToS boundary, because nothing in this file ever holds
 * a member's bytes to begin with.
 *
 * The pack *archive* is fetched (its `manifest.json` has to be read) and its
 * `overrides/` tree is materialized — see {@link CurseForgeBaseSource.resolveBase}
 * for what that does and does not admit.
 *
 * ## The pack is untrusted input
 *
 * A CurseForge pack is attacker-influenced data like any other, but it has a
 * strictly smaller lying surface than a `.mrpack`: **it cannot misstate a
 * member's bytes, because it never states them.** It can still claim any number
 * of members, name projects the host policy would refuse, point at files whose
 * metadata contradicts the pack, and ship a hostile `overrides/` tree. Each of
 * those is bounded here or in the machinery this calls — archive size,
 * {@link MAX_CF_PACK_FILES}, `allowSource` before any member I/O, a
 * project/file cross-check against the API's own answer, zip-slip and symlink
 * guards in `safeExtract`, and protected-path refusal in `importOverrideTree`.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_CF_PACK_FILES, parseCfManifest } from "../import/cf-manifest.js";
import type { CfManifestFile } from "../import/cf-manifest.js";
import { importOverrideTree } from "../import/pack-common.js";
import { readZipEntry } from "../import/zip-read.js";
import { ensureDir } from "../internal/fs.js";
import { CurseForgeApi, replayDownloadReason } from "../sources/curseforge.js";
import type { CfFileMetadata, CfModMetadata } from "../sources/curseforge.js";
import { inferKind } from "../sources/kind.js";
import { safeBasename, singleFilePlacement } from "../sources/place.js";
import { guardHop } from "../sources/ssrf.js";
import { hashBuffer } from "../store/hash.js";
import {
  DecompressionBomb,
  ManifestError,
  ReplayUnavailable,
  ShaMismatch,
  SourceKeyMissing,
  SourceNotAllowed,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type { ItemKind, LockPackage, ResolvedRef } from "../types/index.js";
import type { BasePackSource, BaseResolveContext, ResolvedBasePack } from "./types.js";

/** Where a base's loose override files are tracked, under `.anvil/`. */
export const BASE_TRACKED_SUBDIR = "base";

/** Cap on the pack archive itself. A modpack zip is configs, not content. */
const MAX_CF_PACK_BYTES = 128 * 1024 * 1024;

/** CurseForge Minecraft class ids → anvil {@link ItemKind} (placeable subset). */
const CF_CLASS_KIND: ReadonlyMap<number, ItemKind> = new Map<number, ItemKind>([
  [6, "mod"],
  [12, "resourcepack"],
  [6552, "shaderpack"],
  [6945, "datapack"],
]);

/** CurseForge file-hash `algo` codes: 1 = sha1, 2 = md5. sha1 is the strongest. */
const CF_HASH_SHA1 = 1;

export interface CurseForgeBaseSourceOptions {
  readonly baseUrl?: string;
}

/** The per-member facts recovered from the API, none of them from the pack. */
interface MemberFacts {
  readonly file: CfFileMetadata;
  readonly mod?: CfModMetadata;
}

export class CurseForgeBaseSource implements BasePackSource {
  readonly kind = "curseforge" as const;
  readonly #baseUrl?: string;

  constructor(options: CurseForgeBaseSourceOptions = {}) {
    this.#baseUrl = options.baseUrl;
  }

  async resolveBase(ref: ResolvedRef, ctx: BaseResolveContext): Promise<ResolvedBasePack> {
    // Fail CLOSED without a key — never a silent skip, never an empty pack.
    if (!ctx.curseforgeKey) {
      throw new SourceKeyMissing(
        "curseforge",
        'resolving a CurseForge base pack ("game.from") needs an API key. ' +
          "anvil ships no key; supply your own and retry.",
      );
    }
    if (!ctx.http) {
      throw new UnsatisfiableTarget(`curseforge:${ref.id}`, "no HTTP client configured");
    }
    const projectId = packProjectId(ref);
    const subject = `game.from curseforge:${projectId}`;
    const api = new CurseForgeApi(ctx.http, ctx.curseforgeKey, this.#baseUrl);

    // 1. Select the pack file under the ref spec + the frozen clock.
    const packFile = await selectPackFile(api, projectId, ref, ctx.now, subject);

    // 2. Fetch the pack archive and pin it. These are the only CurseForge bytes
    //    this resolve ever downloads.
    const archiveBytes = await downloadPackArchive(api, ctx, projectId, packFile, subject);
    const archive = hashBuffer(archiveBytes, "sha256");

    const manifestBytes = await readZipEntry(archiveBytes, "manifest.json");
    if (!manifestBytes) {
      throw new ManifestError(
        `base pack "curseforge:${projectId}@${packFile.id}" is not a CurseForge modpack (no manifest.json)`,
      );
    }
    const cf = parseCfManifest(manifestBytes);
    if (cf.files.length > MAX_CF_PACK_FILES) {
      throw new DecompressionBomb(
        `base pack "curseforge:${projectId}" lists ${cf.files.length} files, ` +
          `over the ${MAX_CF_PACK_FILES} limit`,
      );
    }

    const warnings: string[] = [];
    const members: LockPackage[] = [];

    // 3. Members: metadata only. `(projectID, fileID)` is already the identity,
    //    so there is nothing to recover and nothing to download.
    const facts = await gatherMemberFacts(api, ctx, cf.files, subject);
    let index = 0;
    for (const entry of cf.files) {
      const member = await memberRowFor(entry, facts.get(memberKey(entry)), subject, warnings);
      if (member) {
        members.push(member);
        ctx.emit?.({
          type: "resolve:item",
          name: member.name,
          index: index++,
          total: cf.files.length,
        });
      }
    }

    // 4. `overrides/` → tracked local rows under `.anvil/base/`.
    members.push(...(await this.#extractOverrides(archiveBytes, cf.overrides, ctx, warnings)));

    return {
      source: "curseforge",
      id: String(projectId),
      version: String(packFile.id),
      archive,
      game: { minecraft: cf.minecraft, loader: cf.loader },
      members,
      warnings,
    };
  }

  /**
   * Stage the archive and run its override prefix through the shared hardened
   * extractor, exactly as the `.mrpack` base does.
   *
   * **These bytes are the one part of a CurseForge pack that does enter the
   * shared store** (as `local`/`copy` rows), because the build materializes a
   * copy row from the store and there is no third route. That matches the line
   * `anvil import` already draws for a CurseForge zip — the replay boundary is
   * about *project files*, the mod jars named in `files[]`, which this path
   * never touches. It is a real residual exposure and it is documented in
   * SECURITY.md rather than papered over: an instance built on a CurseForge base
   * can push its pack-authored config tree to a remote.
   */
  async #extractOverrides(
    archiveBytes: Uint8Array,
    prefix: string,
    ctx: BaseResolveContext,
    warnings: string[],
  ): Promise<LockPackage[]> {
    const anvilDir = join(ctx.instanceDir, ".anvil");
    await ensureDir(anvilDir);
    const staged = join(anvilDir, `base-archive-${process.pid}.cfzip`);
    const placeable = new Map<string, LockPackage>();
    try {
      await writeFile(staged, archiveBytes);
      // A re-resolved base must not inherit the previous base's files, or
      // switching `game.from` leaves orphans the next commit would carry.
      await rm(join(anvilDir, BASE_TRACKED_SUBDIR), { recursive: true, force: true });
      await importOverrideTree({
        archivePath: staged,
        instanceDir: ctx.instanceDir,
        store: sinkFor(ctx),
        prefixes: [prefix],
        placeable,
        warnings,
        trackedSubdir: BASE_TRACKED_SUBDIR,
        onStored: (hash) => ctx.emit?.({ type: "object:store", hash, deduped: false }),
      });
    } finally {
      await rm(staged, { force: true });
    }
    return [...placeable.values()];
  }
}

/**
 * A base override has to be somewhere on disk for the build to link it, so its
 * bytes are always written to `.anvil/base/`. With no store configured the
 * admission is dropped rather than failing — same posture as the `.mrpack` base.
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

/** `curseforge:<numeric project id>` — the pack's own project. */
function packProjectId(ref: ResolvedRef): number {
  const id = Number(ref.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new UnsatisfiableTarget(
      `game.from curseforge:${ref.id}`,
      "a CurseForge base reference must be a numeric project id " +
        '(e.g. game.from = "curseforge:715572")',
    );
  }
  return id;
}

/** A stable key for one `files[]` entry. */
function memberKey(entry: CfManifestFile): string {
  return `${entry.projectID}:${entry.fileID}`;
}

/**
 * Select the pack's own file (its published version) under the ref's spec and
 * the frozen clock. A pinned spec names a `fileID` directly, which is the form
 * a reproducible `game.from` should use.
 */
async function selectPackFile(
  api: CurseForgeApi,
  projectId: number,
  ref: ResolvedRef,
  now: number,
  subject: string,
): Promise<CfFileMetadata> {
  if (ref.versionSpec.kind === "pin") {
    const wanted = Number(ref.versionSpec.version);
    if (Number.isSafeInteger(wanted) && wanted > 0) {
      // A pinned fileId resolves in one call, without listing the project.
      const file = await api.getModFile(projectId, wanted);
      if (file.id !== wanted || file.modId !== projectId) {
        throw new UnsatisfiableTarget(
          subject,
          `CurseForge returned file ${file.id} of project ${file.modId} for the pinned ` +
            `${projectId}/${wanted}`,
        );
      }
      return file;
    }
  }
  // No loader/gameVersion filter: a modpack's own files are not loader-tagged
  // the way a mod's are, and filtering here would silently empty the list.
  const files = await api.getModFiles(projectId, {});
  if (files.length === 0) {
    throw new UnsatisfiableTarget(subject, "the pack has no published files");
  }
  if (ref.versionSpec.kind === "pin") {
    const wanted = ref.versionSpec.version;
    const chosen = files.find((f) => f.displayName === wanted || f.fileName === wanted);
    if (!chosen) {
      throw new UnsatisfiableTarget(subject, `no pack file pinned as "${wanted}"`);
    }
    return chosen;
  }
  const eligible = files.filter((f) => {
    const t = Date.parse(f.fileDate);
    return Number.isNaN(t) || t <= now;
  });
  let best: CfFileMetadata | undefined;
  for (const f of eligible) {
    if (!best) {
      best = f;
      continue;
    }
    const cmp = Date.parse(f.fileDate) - Date.parse(best.fileDate);
    if (cmp > 0 || (cmp === 0 && f.id > best.id)) {
      best = f;
    }
  }
  if (!best) {
    throw new UnsatisfiableTarget(subject, "no pack file published at or before the lock clock");
  }
  return best;
}

/**
 * Download the pack archive under the user's key, bounded and hash-checked. The
 * resolved CDN URL never reaches an error message, an event, or a log.
 */
async function downloadPackArchive(
  api: CurseForgeApi,
  ctx: BaseResolveContext,
  projectId: number,
  packFile: CfFileMetadata,
  subject: string,
): Promise<Uint8Array> {
  const http = ctx.http;
  if (!http) {
    throw new UnsatisfiableTarget(subject, "no HTTP client configured");
  }
  const url = await api.getDownloadUrl(projectId, packFile.id);
  if (!url) {
    throw new ReplayUnavailable(
      subject,
      "the author disabled third-party API downloads for this pack",
    );
  }
  let bytes: Uint8Array;
  try {
    const res = await http.get(url, { guard: guardHop, maxBytes: MAX_CF_PACK_BYTES });
    bytes = res.body;
  } catch (err) {
    throw new ReplayUnavailable(subject, replayDownloadReason(err));
  }
  if (bytes.byteLength > MAX_CF_PACK_BYTES) {
    throw new DecompressionBomb(
      `base pack "curseforge:${projectId}" is ${bytes.byteLength} bytes, ` +
        `over the ${MAX_CF_PACK_BYTES} limit`,
    );
  }
  const sha1 = packFile.hashes?.find((h) => h.algo === CF_HASH_SHA1)?.value;
  if (sha1) {
    const actual = hashBuffer(bytes, "sha1");
    if (actual.value !== sha1.toLowerCase()) {
      throw new ShaMismatch(subject, { algo: "sha1", value: sha1.toLowerCase() }, actual);
    }
  }
  return bytes;
}

/**
 * Fetch the API's own answer for every `(projectID, fileID)` the pack names.
 *
 * Two calls per member (the file, then its mod for `classId` + `slug`), with the
 * mod call cached per project so a project listed twice costs one. CurseForge's
 * batch endpoints (`POST /v1/mods`, `POST /v1/mods/files`) would collapse this to
 * a handful of round-trips; they are deliberately not used here because they are
 * unverified against the live API, and a base resolve must not depend on an
 * endpoint whose behavior we have not confirmed.
 *
 * `allowSource` runs for each member **before its first request**, so an
 * embedder's policy can refuse a project before a byte moves — matching the gate
 * the resolver already applied to the `game.from` ref itself.
 */
async function gatherMemberFacts(
  api: CurseForgeApi,
  ctx: BaseResolveContext,
  entries: readonly CfManifestFile[],
  subject: string,
): Promise<Map<string, MemberFacts>> {
  const out = new Map<string, MemberFacts>();
  const mods = new Map<number, CfModMetadata | undefined>();
  for (const entry of entries) {
    const memberRef: ResolvedRef = {
      source: "curseforge",
      id: String(entry.projectID),
      versionSpec: { kind: "pin", version: String(entry.fileID) },
    };
    if (!ctx.allowSource(memberRef)) {
      throw new SourceNotAllowed("curseforge", String(entry.projectID));
    }
    // A member the catalogue does not publish (delisted, withdrawn, or simply
    // invented by the pack) leaves no facts, and `memberRowFor` turns that into
    // a warned skip. A 404 here is a property of one member, not a reason to
    // fail the pack — but it must not be a crash either, so the response shape
    // is checked rather than trusted.
    const file = await api.getModFile(entry.projectID, entry.fileID).catch(() => undefined);
    if (!file || typeof file.id !== "number" || typeof file.modId !== "number") {
      continue;
    }
    // The pack does not get to decide what a file is: cross-check that the API
    // answered about the pair the pack actually named. A mismatch means the pack
    // (or the response) is pointing somewhere else.
    if (file.id !== entry.fileID || file.modId !== entry.projectID) {
      throw new ShaMismatch(
        `${subject}: member ${entry.projectID}/${entry.fileID}`,
        { algo: "sha1", value: `${entry.projectID}/${entry.fileID}` },
        { algo: "sha1", value: `${file.modId}/${file.id}` },
      );
    }
    if (!mods.has(entry.projectID)) {
      // Identity is an optimization, not a requirement: losing it costs override
      // precision by name, it does not make the pack unusable.
      mods.set(entry.projectID, await api.getMod(entry.projectID).catch(() => undefined));
    }
    const mod = mods.get(entry.projectID);
    out.set(memberKey(entry), { file, ...(mod ? { mod } : {}) });
  }
  return out;
}

/**
 * One `files[]` entry → a pinned replay lock row, or `undefined` (with a
 * warning) when it cannot be pinned.
 *
 * A member CurseForge attests no sha1 for is **skipped, loudly**. Emitting an
 * unverifiable row would put a package in the lock whose bytes nothing could
 * check at build time, quietly trading the determinism invariant for one mod.
 * A member whose kind cannot be decided without bytes is skipped the same way —
 * one unclassifiable member must not fail the whole pack, and guessing a folder
 * for it would silently mis-place it.
 */
async function memberRowFor(
  entry: CfManifestFile,
  facts: MemberFacts | undefined,
  subject: string,
  warnings: string[],
): Promise<LockPackage | undefined> {
  if (!facts) {
    warnings.push(
      `base pack: skipped member ${entry.projectID}/${entry.fileID} (no CurseForge metadata)`,
    );
    return undefined;
  }
  const { file, mod } = facts;
  const sha1 = file.hashes?.find((h) => h.algo === CF_HASH_SHA1)?.value;
  if (!sha1 || !/^[0-9a-fA-F]{40}$/.test(sha1)) {
    warnings.push(
      `base pack: skipped member ${entry.projectID}/${entry.fileID} ` +
        `("${file.fileName}") — CurseForge attests no sha1, so it cannot be pinned`,
    );
    return undefined;
  }
  // classId is the authoritative signal and needs no bytes; the filename
  // fallback covers a project whose mod lookup failed. There are no bytes here
  // to introspect, by design, so an ambiguous `.zip` is a skip.
  let kind: ItemKind;
  try {
    kind =
      (mod?.classId !== undefined ? CF_CLASS_KIND.get(mod.classId) : undefined) ??
      (await inferKind({ subject: `${subject}: ${file.fileName}`, filename: file.fileName }));
  } catch {
    warnings.push(
      `base pack: skipped member ${entry.projectID}/${entry.fileID} ` +
        `("${file.fileName}") — its kind cannot be determined from CurseForge metadata`,
    );
    return undefined;
  }
  const filename = safeBasename(file.fileName, ".jar");
  const size =
    typeof file.fileLength === "number" &&
    Number.isSafeInteger(file.fileLength) &&
    file.fileLength >= 0
      ? file.fileLength
      : undefined;
  return {
    name: mod?.slug || String(entry.projectID),
    kind,
    source: "curseforge",
    version: file.displayName || file.fileName,
    // The pin CurseForge actually attests. sha1 is the strongest hash the API
    // offers (algo 1 = sha1, 2 = md5); the immutable (projectID, fileID) pair is
    // the primary identity pin and this is the tamper-evidence over it.
    hash: { algo: "sha1", value: sha1.toLowerCase() },
    provenance: "replay",
    placement: singleFilePlacement(kind, filename),
    ...(size !== undefined ? { size } : {}),
    project: entry.projectID,
    file: entry.fileID,
    // NOTE: no `url` — a replay item is never pinned to a rehostable URL.
  };
}
