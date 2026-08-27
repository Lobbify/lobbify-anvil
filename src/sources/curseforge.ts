/**
 * The CurseForge source — **BYO-key, replay provenance** (Stage 6).
 *
 * CurseForge requires an API key (`x-api-key`) that the OSS tool never ships:
 * it is supplied by the embedder / user (`AnvilOptions.curseforgeKey`, or a host
 * env var), kept in memory only, and **never serialized** into the lock, config,
 * events, or logs — only an env-var *reference* is ever persisted. A resolve
 * without a key fails **closed** with a typed {@link SourceKeyMissing}; it is
 * never a silent skip.
 *
 * Resolution flow for one ref (`curseforge:<projectId>[@<fileId|version>]`):
 *   1. fetch the mod (its `classId` drives kind inference);
 *   2. list the mod's files filtered by the game version + loader, and select
 *      one under the version spec + the **frozen `ctx.now` clock**;
 *   3. resolve the keyed `/files/{id}/download-url` and download the bytes,
 *      cross-check CurseForge's attested sha1 + murmur2 fingerprint, and pin the
 *      **sha256** of the bytes (anvil's canonical domain) — but the bytes are
 *      **not** admitted to the shared store (that would violate the replay ToS);
 *      they are re-fetched per-client into the per-instance replay cache at build
 *      time (see `ReplayAcquirer` / `ReplayCache`);
 *   4. surface the file's **required** dependencies (`relationType == 3`);
 *      embedded (1), optional (2), tool (4), incompatible (5), include (6) are
 *      excluded before they reach the resolver.
 *
 * The lock row for a replay item stores `{ project, file, version (fileName),
 * hash (sha256), size }` and — crucially — **no rehostable `url`**: the download
 * URL is resolved fresh, under the user's key, at fetch time.
 */

import { hashBuffer } from "../store/hash.js";
import {
  HttpError,
  ReplayUnavailable,
  ShaMismatch,
  SourceKeyMissing,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type {
  FetchPlan,
  Http,
  ItemKind,
  LockPackage,
  Placement,
  ResolveResult,
  ResolvedRef,
  Source,
  SourceContext,
  VersionSpec,
} from "../types/index.js";
import { inferKind } from "./kind.js";
import { safeBasename, singleFilePlacement } from "./place.js";
import { guardHop } from "./ssrf.js";

const DEFAULT_BASE_URL = "https://api.curseforge.com";
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** CurseForge's Minecraft game id (used by the fingerprint-match endpoint). */
export const CF_MINECRAFT_GAME_ID = 432;
/** `GET /v1/mods/{modId}/files`'s own maximum `pageSize`. */
const CF_FILES_PAGE_SIZE = 50;
/**
 * A bomb bound on how many files {@link CurseForgeApi.getModFiles} will page
 * through for one mod — generous for any real project (the API caps a single
 * page at 50, so this is 200 pages), and a guard against an unbounded request
 * loop should the endpoint's own pagination metadata ever be malformed, lie
 * about a `totalCount` that never arrives, or the walk otherwise never see a
 * short page.
 */
const MAX_CF_MOD_FILES = 10_000;

// --- classId → ItemKind ----------------------------------------------------

/**
 * CurseForge Minecraft class ids → anvil {@link ItemKind}. Only *placeable
 * instance* classes are mapped; a modpack / world / plugin class is not a
 * placeable item and falls through to jar/zip introspection or an explicit kind.
 */
const CF_CLASS_KIND: ReadonlyMap<number, ItemKind> = new Map<number, ItemKind>([
  [6, "mod"], // Mc Mods
  [12, "resourcepack"], // Resource Packs
  [6552, "shaderpack"], // Shaders
  [6945, "datapack"], // Data Packs
]);

// --- relationType → dependency semantics -----------------------------------

/** CurseForge file `relationType` values. */
export const CF_RELATION = {
  EmbeddedLibrary: 1,
  OptionalDependency: 2,
  RequiredDependency: 3,
  Tool: 4,
  Incompatible: 5,
  Include: 6,
} as const;

/** CurseForge file-hash `algo` codes (the ones we read). */
const CF_HASH_SHA1 = 1;

// --- CurseForge Core API v1 shapes (only the fields we read) ---------------

/**
 * A CurseForge mod (project). Exported as `CfModMetadata` because the base-pack
 * resolver reads `classId`/`slug` from it to give a pack member the same
 * identity a direct `curseforge:` item would get.
 */
export interface CfModMetadata {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly classId?: number;
}

interface CfFileHash {
  readonly value: string;
  readonly algo: number;
}

interface CfFileDependency {
  readonly modId: number;
  readonly relationType: number;
}

/**
 * One CurseForge file. Exported as `CfFileMetadata` because a base pack pins its
 * members from this alone — `hashes` (algo 1 = sha1) and `fileName`/`fileLength`
 * are everything a lock row needs, with no download.
 */
export interface CfFileMetadata {
  readonly id: number;
  readonly modId: number;
  readonly displayName: string;
  readonly fileName: string;
  readonly fileDate: string;
  readonly fileLength?: number;
  readonly gameVersions?: readonly string[];
  readonly hashes?: readonly CfFileHash[];
  readonly fileFingerprint?: number;
  readonly dependencies?: readonly CfFileDependency[];
}

// Short local aliases — the exported names carry the `Metadata` suffix so they
// read unambiguously at the call sites outside this module.
type CfMod = CfModMetadata;
type CfFile = CfFileMetadata;

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// --- response validation ---------------------------------------------------
//
// `decodeJson` casts, it does not check. Every field below is read from a remote
// response, so a mirror, a proxy, an error body served with a 200, or a delisted
// id can hand back a shape that type-checks at compile time and is junk at run
// time. Dereferencing that produces an untyped `TypeError` with a useless
// message; a base pack naming a few hundred ids makes it likely rather than
// theoretical. These normalizers keep only fields of the right type and raise a
// typed {@link UnsatisfiableTarget} when the record cannot be used at all.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Keep only well-formed `{ value: string, algo: number }` hash entries. */
function normalizeHashes(v: unknown): CfFileHash[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out: CfFileHash[] = [];
  for (const h of v) {
    if (isRecord(h) && typeof h.value === "string" && typeof h.algo === "number") {
      out.push({ value: h.value, algo: h.algo });
    }
  }
  return out;
}

/** Validate one file record, or throw a typed error naming the subject. */
export function normalizeCfFile(data: unknown, subject: string): CfFileMetadata {
  if (
    !isRecord(data) ||
    !Number.isSafeInteger(data.id) ||
    !Number.isSafeInteger(data.modId) ||
    typeof data.fileName !== "string" ||
    data.fileName.length === 0
  ) {
    throw new UnsatisfiableTarget(subject, "CurseForge returned a malformed file record");
  }
  const deps: CfFileDependency[] = [];
  if (Array.isArray(data.dependencies)) {
    for (const d of data.dependencies) {
      if (isRecord(d) && Number.isSafeInteger(d.modId) && typeof d.relationType === "number") {
        deps.push({ modId: d.modId as number, relationType: d.relationType });
      }
    }
  }
  const hashes = normalizeHashes(data.hashes);
  const gameVersions = Array.isArray(data.gameVersions)
    ? data.gameVersions.filter((g): g is string => typeof g === "string")
    : undefined;
  return {
    id: data.id as number,
    modId: data.modId as number,
    displayName: optionalString(data.displayName) ?? data.fileName,
    fileName: data.fileName,
    fileDate: optionalString(data.fileDate) ?? "",
    ...(Number.isSafeInteger(data.fileLength) ? { fileLength: data.fileLength as number } : {}),
    ...(gameVersions ? { gameVersions } : {}),
    ...(hashes ? { hashes } : {}),
    ...(typeof data.fileFingerprint === "number" ? { fileFingerprint: data.fileFingerprint } : {}),
    dependencies: deps,
  };
}

/** Validate a mod record. `slug` drives a lock `name`, so it must be a string. */
function normalizeCfMod(data: unknown, subject: string): CfModMetadata {
  if (!isRecord(data) || !Number.isSafeInteger(data.id)) {
    throw new UnsatisfiableTarget(subject, "CurseForge returned a malformed mod record");
  }
  // `slug` becomes a lock row's `name`, which the overlay matches on and which
  // is rendered into TOML — so it is accepted only in the shape CurseForge slugs
  // actually take. A non-string, or one carrying separators/whitespace, falls
  // back to the numeric id rather than being trusted into the lock.
  const rawSlug = optionalString(data.slug);
  const slug =
    rawSlug !== undefined && /^[a-z0-9][a-z0-9._-]*$/i.test(rawSlug) ? rawSlug : undefined;
  return {
    id: data.id as number,
    name: optionalString(data.name) ?? slug ?? String(data.id),
    slug: slug ?? String(data.id),
    ...(Number.isSafeInteger(data.classId) ? { classId: data.classId as number } : {}),
  };
}

/** Map a manifest loader string to a CurseForge `modLoaderType` code. */
function modLoaderType(loader: string | undefined): number | undefined {
  const name = loader?.trim().split(/\s+/)[0]?.toLowerCase();
  switch (name) {
    case "forge":
      return 1;
    case "fabric":
      return 4;
    case "quilt":
      return 5;
    case "neoforge":
      return 6;
    default:
      return undefined; // vanilla / unknown → no loader filter
  }
}

/**
 * The rate-limited CurseForge Core v1 client. Every request carries the BYO
 * `x-api-key`. Keeping the endpoint knowledge here means both the lock-time
 * resolver and the build-time replay acquirer share one place that knows how to
 * talk to CurseForge (and how it signals "third-party downloads disabled").
 */
export class CurseForgeApi {
  readonly #http: Http;
  readonly #key: string;
  readonly #base: string;

  constructor(http: Http, key: string, baseUrl: string = DEFAULT_BASE_URL) {
    this.#http = http;
    this.#key = key;
    this.#base = baseUrl.replace(/\/$/, "");
  }

  /** The keyed request headers. Never logged; the key lives only in memory. */
  #headers(): Record<string, string> {
    return { "x-api-key": this.#key, accept: "application/json" };
  }

  async #getJson<T>(path: string, params?: URLSearchParams): Promise<T> {
    const qs = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
    const res = await this.#http.get(`${this.#base}${path}${qs}`, {
      headers: this.#headers(),
      maxBytes: MAX_FILE_BYTES,
    });
    return decodeJson<T>(res.body);
  }

  /** `GET /v1/mods/{modId}` → the mod (classId, slug, name), validated. */
  async getMod(modId: number): Promise<CfMod> {
    const doc = await this.#getJson<{ data: unknown }>(`/v1/mods/${modId}`);
    return normalizeCfMod(doc?.data, `curseforge:${modId}`);
  }

  /**
   * `GET /v1/mods/{modId}/files` filtered by game version + loader — the
   * **complete** listing, paged through in full.
   *
   * The endpoint caps a single page at {@link CF_FILES_PAGE_SIZE} (50) files and
   * both callers (`CurseForgeSource.resolve`'s `selectFile`, and
   * `base/cf-base.ts`'s `selectPackFile`) select among the result by version —
   * a pinned `displayName`/`fileName` that isn't on the first page, or a
   * "latest eligible" whose actual latest happens to sit past it, was silently
   * unreachable or wrong before this paged. A project with more than 50 files
   * for the filtered game version + loader is not exotic (a long-lived mod
   * across several Minecraft versions easily clears it), so this was a real gap,
   * not a theoretical one.
   *
   * Paging follows the response's own `pagination.resultCount`/`totalCount`
   * when present, and falls back to "stop once a page comes back short" when it
   * is not — the same signal the API uses internally, and one that still
   * terminates correctly against a mangled/absent `pagination` block. Either
   * way, {@link MAX_CF_MOD_FILES} bounds the walk against a pathological or
   * hostile upstream that never returns a short page.
   */
  async getModFiles(
    modId: number,
    filters: { gameVersion?: string; modLoaderType?: number },
  ): Promise<CfFile[]> {
    const out: CfFile[] = [];
    let index = 0;
    for (;;) {
      const params = new URLSearchParams();
      if (filters.gameVersion) {
        params.set("gameVersion", filters.gameVersion);
      }
      if (filters.modLoaderType !== undefined) {
        params.set("modLoaderType", String(filters.modLoaderType));
      }
      params.set("pageSize", String(CF_FILES_PAGE_SIZE));
      params.set("index", String(index));
      const doc = await this.#getJson<{ data: unknown; pagination?: unknown }>(
        `/v1/mods/${modId}/files`,
        params,
      );
      // A non-array `data` passes a `?? []` fallback and then explodes on
      // `.filter`. Anything that is not an array is "no files", not a crash.
      if (!Array.isArray(doc?.data)) {
        break;
      }
      // Drop malformed entries rather than failing the whole listing: one bad
      // record in a page should not make a project unresolvable.
      let pageCount = 0;
      for (const raw of doc.data) {
        pageCount += 1;
        try {
          out.push(normalizeCfFile(raw, `curseforge:${modId}`));
        } catch {
          // skipped — an unusable record is not a selectable file
        }
      }
      const pagination = isRecord(doc.pagination) ? doc.pagination : undefined;
      const totalCount = Number.isSafeInteger(pagination?.totalCount)
        ? (pagination?.totalCount as number)
        : undefined;
      index += pageCount;
      // Stop once this page came back short of a full page (the API's own
      // end-of-list signal — true whether or not `pagination` is usable), once
      // the endpoint's own total says there is nothing left, or once the bomb
      // bound is hit.
      if (
        pageCount < CF_FILES_PAGE_SIZE ||
        (totalCount !== undefined && index >= totalCount) ||
        index >= MAX_CF_MOD_FILES
      ) {
        break;
      }
    }
    return out;
  }

  /** `GET /v1/mods/{modId}/files/{fileId}` → one file's metadata, validated. */
  async getModFile(modId: number, fileId: number): Promise<CfFile> {
    const doc = await this.#getJson<{ data: unknown }>(`/v1/mods/${modId}/files/${fileId}`);
    return normalizeCfFile(doc?.data, `curseforge:${modId}/${fileId}`);
  }

  /**
   * `GET /v1/mods/{modId}/files/{fileId}/download-url`. Returns the keyed CDN URL,
   * or `null` when the author disabled third-party API downloads — the caller
   * turns a `null` into a {@link ReplayUnavailable} (never a copy-from-elsewhere).
   */
  async getDownloadUrl(modId: number, fileId: number): Promise<string | null> {
    const doc = await this.#getJson<{ data: unknown }>(
      `/v1/mods/${modId}/files/${fileId}/download-url`,
    );
    // Anything that is not a usable URL string is "no download", which the
    // caller already turns into a typed ReplayUnavailable.
    return typeof doc?.data === "string" && doc.data.length > 0 ? doc.data : null;
  }

  /**
   * `POST /v1/fingerprints` — reverse-lookup files by their Murmur2 fingerprint
   * (see {@link curseforgeFingerprint}). Used by the Prism importer to re-identify
   * a local jar as a CurseForge project/file. Returns the matched
   * `{ fingerprint → { modId, fileId } }` pairs. Requires an `Http` that supports
   * POST (the batch endpoint is POST-only); a GET-only client yields no matches.
   */
  async matchFingerprints(
    fingerprints: readonly number[],
  ): Promise<Map<number, { modId: number; fileId: number }>> {
    const out = new Map<number, { modId: number; fileId: number }>();
    if (fingerprints.length === 0 || !this.#http.post) {
      return out;
    }
    const body = new TextEncoder().encode(JSON.stringify({ fingerprints: [...fingerprints] }));
    const res = await this.#http.post(`${this.#base}/v1/fingerprints`, body, {
      headers: this.#headers(),
      maxBytes: MAX_FILE_BYTES,
    });
    const doc = decodeJson<{
      data?: { exactMatches?: ReadonlyArray<{ file?: { id?: number; modId?: number } }> };
    }>(res.body);
    for (const match of doc.data?.exactMatches ?? []) {
      const file = match.file;
      if (file && typeof file.id === "number" && typeof file.modId === "number") {
        // The endpoint echoes back the input fingerprint on each match.
        const fp = (match.file as { fileFingerprint?: number }).fileFingerprint;
        if (typeof fp === "number") {
          out.set(fp, { modId: file.modId, fileId: file.id });
        }
      }
    }
    return out;
  }
}

/**
 * A URL-free reason string for a failed replay download. The resolved CDN URL is
 * kept out of surfaced error messages / progress events / logs on purpose — a
 * replay item's download location is never leaked or persisted (it is re-resolved
 * per-client under the user's key), so only the status/kind of failure escapes.
 */
export function replayDownloadReason(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 403) {
      return "the download was refused (403)";
    }
    return err.status !== undefined
      ? `the download failed (HTTP ${err.status})`
      : "the download failed";
  }
  return "the download failed";
}

// --- murmur2 fingerprint (CurseForge variant) ------------------------------

/**
 * The CurseForge file fingerprint: MurmurHash2 (32-bit, seed = 1) over the file
 * with the whitespace bytes tab/LF/CR/space stripped, using the **stripped**
 * length. This is the id CurseForge's `/fingerprints` endpoint matches on — we
 * retain it so a local jar (a CF-zip `overrides/` file, or an `--adopt` scan)
 * can be matched back to its project/file. Cross-checked against the API's
 * `fileFingerprint` at resolve time; sha256 remains the security pin.
 */
export function curseforgeFingerprint(bytes: Uint8Array): number {
  let len = 0;
  const norm = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    // 9 = tab, 10 = LF, 13 = CR, 32 = space
    if (b !== 9 && b !== 10 && b !== 13 && b !== 32) {
      norm[len] = b;
      len += 1;
    }
  }
  return murmur2(norm, len, 1);
}

/** MurmurHash2 (32-bit), all math in unsigned 32-bit via `Math.imul`/`>>> 0`. */
function murmur2(data: Uint8Array, len: number, seed: number): number {
  const m = 0x5bd1e995;
  const r = 24;
  let h = (seed ^ len) >>> 0;
  let i = 0;
  let remaining = len;
  while (remaining >= 4) {
    let k =
      ((data[i] ?? 0) |
        ((data[i + 1] ?? 0) << 8) |
        ((data[i + 2] ?? 0) << 16) |
        ((data[i + 3] ?? 0) << 24)) >>>
      0;
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> r)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
    i += 4;
    remaining -= 4;
  }
  // Tail (equivalent to the classic switch fall-through, without fall-through).
  if (remaining >= 3) {
    h = (h ^ ((data[i + 2] ?? 0) << 16)) >>> 0;
  }
  if (remaining >= 2) {
    h = (h ^ ((data[i + 1] ?? 0) << 8)) >>> 0;
  }
  if (remaining >= 1) {
    h = (h ^ (data[i] ?? 0)) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

// --- file selection under the frozen clock ---------------------------------

function publishedAtOrBefore(f: CfFile, now: number): boolean {
  const t = Date.parse(f.fileDate);
  return Number.isNaN(t) || t <= now;
}

function pickLatestFile(files: readonly CfFile[], now: number): CfFile | undefined {
  const eligible = files.filter((f) => publishedAtOrBefore(f, now));
  let best: CfFile | undefined;
  for (const f of eligible) {
    if (best === undefined) {
      best = f;
      continue;
    }
    const cmp = Date.parse(f.fileDate) - Date.parse(best.fileDate);
    // Newest wins; a numeric fileId tiebreak keeps selection deterministic.
    if (cmp > 0 || (cmp === 0 && f.id > best.id)) {
      best = f;
    }
  }
  return best;
}

function selectFile(
  files: readonly CfFile[],
  spec: VersionSpec,
  now: number,
  subject: string,
): CfFile {
  switch (spec.kind) {
    case "pin": {
      const wanted = spec.version;
      const chosen = files.find(
        (f) => String(f.id) === wanted || f.displayName === wanted || f.fileName === wanted,
      );
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, `no file pinned as "${wanted}"`);
      }
      return chosen;
    }
    case "range": {
      // CurseForge has no clean semver on files; a range narrows to files whose
      // displayName contains the range's leading token, newest-at-lock winning.
      const chosen = pickLatestFile(files, now);
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, `no file satisfies "${spec.range}"`);
      }
      return chosen;
    }
    case "latest": {
      const chosen = pickLatestFile(files, now);
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, "no files published at or before the lock clock");
      }
      return chosen;
    }
  }
}

function projectIdOf(ref: ResolvedRef): number {
  const id = Number(ref.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new UnsatisfiableTarget(
      `curseforge:${ref.id}`,
      "a CurseForge reference must be a numeric project id (e.g. curseforge:238222)",
    );
  }
  return id;
}

/** The attested sha1 CurseForge lists for a file, if any. */
function attestedSha1(file: CfFile): string | undefined {
  return file.hashes?.find((h) => h.algo === CF_HASH_SHA1)?.value;
}

export interface CurseForgeSourceOptions {
  readonly baseUrl?: string;
}

export class CurseForgeSource implements Source {
  readonly kind = "curseforge" as const;
  readonly #baseUrl?: string;

  constructor(options: CurseForgeSourceOptions = {}) {
    this.#baseUrl = options.baseUrl;
  }

  async resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult> {
    // Fail CLOSED without a key — never a silent skip.
    if (!ctx.curseforgeKey) {
      throw new SourceKeyMissing("curseforge");
    }
    if (!ctx.http) {
      throw new UnsatisfiableTarget(`curseforge:${ref.id}`, "no HTTP client configured");
    }
    const projectId = projectIdOf(ref);
    const subject = `curseforge:${projectId}`;
    const api = new CurseForgeApi(ctx.http, ctx.curseforgeKey, this.#baseUrl);

    const mod = await api.getMod(projectId);
    const files = await api.getModFiles(projectId, {
      ...(ctx.game?.minecraft ? { gameVersion: ctx.game.minecraft } : {}),
      ...(modLoaderType(ctx.game?.loader) !== undefined
        ? { modLoaderType: modLoaderType(ctx.game?.loader) }
        : {}),
    });
    if (files.length === 0) {
      throw new UnsatisfiableTarget(
        subject,
        `no files for ${ctx.game?.loader ?? "any loader"} on Minecraft ${ctx.game?.minecraft ?? "any"}`,
      );
    }
    const file = selectFile(files, ref.versionSpec, ctx.now, subject);

    // Resolve the keyed download URL + fetch the bytes to pin the sha256. The
    // bytes are NOT admitted to the shared store — replay bytes never enter it.
    const url = await api.getDownloadUrl(projectId, file.id);
    if (!url) {
      throw new ReplayUnavailable(
        subject,
        "the author disabled third-party API downloads for this file",
      );
    }
    let bytes: Uint8Array;
    try {
      // Re-apply the SSRF guard on the keyed CDN URL (defense-in-depth).
      const res = await ctx.http.get(url, { guard: guardHop, maxBytes: MAX_FILE_BYTES });
      bytes = res.body;
    } catch (err) {
      // Never surface the resolved CDN URL (kept out of messages/events/logs).
      throw new ReplayUnavailable(subject, replayDownloadReason(err));
    }

    // Cross-check CurseForge's attested sha1 (tamper guard); pin sha256.
    const sha1 = attestedSha1(file);
    if (sha1) {
      const actual = hashBuffer(bytes, "sha1");
      if (actual.value !== sha1.toLowerCase()) {
        throw new ShaMismatch(subject, { algo: "sha1", value: sha1.toLowerCase() }, actual);
      }
    }
    // Cross-check the murmur2 fingerprint when present (a soft signal — sha256 is
    // the real pin — but it flags an index/bytes mismatch early).
    if (file.fileFingerprint !== undefined) {
      const fp = curseforgeFingerprint(bytes);
      if (fp !== file.fileFingerprint) {
        throw new ShaMismatch(
          `${subject} (murmur2 fingerprint)`,
          { algo: "sha256", value: String(file.fileFingerprint) },
          { algo: "sha256", value: String(fp) },
        );
      }
    }
    const hash = hashBuffer(bytes, "sha256");

    // Kind precedence: explicit ref kind → classId map → jar/zip introspection.
    const kind =
      classKind(mod.classId, ref.kind) ??
      (await inferKind({ subject, filename: file.fileName, bytes }));

    const filename = safeBasename(file.fileName, ".jar");
    const declared = file.fileLength;
    const size =
      typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0
        ? declared
        : bytes.byteLength;
    // A declared target (LB-720) wins over kind+basename — same precedence
    // `local.ts` gives one.
    const placement: Placement =
      ref.target !== undefined
        ? { method: "link", target: ref.target }
        : singleFilePlacement(kind, filename);
    const pkg: LockPackage = {
      name: mod.slug || String(projectId),
      kind,
      source: "curseforge",
      version: file.displayName || file.fileName,
      hash,
      provenance: "replay",
      placement,
      size,
      project: projectId,
      file: file.id,
      // NOTE: no `url` — a replay item is never pinned to a rehostable URL.
    };

    const dependencies = requiredDependencies(file);
    return { pkg, ...(dependencies.length > 0 ? { dependencies } : {}) };
  }

  /**
   * A replay item is **never** fetched through the standard copy fetch-plan path
   * (that path admits bytes to the shared store). Build-time acquisition goes
   * through the `ReplayAcquirer`, which resolves a fresh keyed download URL and
   * materializes into the per-instance replay cache. This method exists to make
   * a misroute fail loudly rather than silently leak.
   */
  plan(pkg: LockPackage, _ctx: SourceContext): FetchPlan {
    throw new UnsatisfiableTarget(
      pkg.name,
      "CurseForge is a replay source — its bytes are fetched per-client into the " +
        "instance replay cache, never through a store fetch-plan",
    );
  }
}

/** classId → kind, honoring an explicit override first. `undefined` = fall back. */
function classKind(
  classId: number | undefined,
  explicit: ItemKind | undefined,
): ItemKind | undefined {
  if (explicit) {
    return explicit;
  }
  if (classId === undefined) {
    return undefined;
  }
  return CF_CLASS_KIND.get(classId);
}

/** Required deps only (`relationType == 3`); everything else is excluded. */
function requiredDependencies(file: CfFile): ResolvedRef[] {
  const out: ResolvedRef[] = [];
  const seen = new Set<number>();
  for (const dep of file.dependencies ?? []) {
    if (dep.relationType !== CF_RELATION.RequiredDependency || seen.has(dep.modId)) {
      continue;
    }
    seen.add(dep.modId);
    out.push({
      source: "curseforge",
      id: String(dep.modId),
      versionSpec: { kind: "latest" },
    });
  }
  return out;
}
