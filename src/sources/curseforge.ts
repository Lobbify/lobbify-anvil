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

interface CfMod {
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

interface CfFile {
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

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
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

  /** `GET /v1/mods/{modId}` → the mod (classId, slug, name). */
  async getMod(modId: number): Promise<CfMod> {
    const doc = await this.#getJson<{ data: CfMod }>(`/v1/mods/${modId}`);
    return doc.data;
  }

  /** `GET /v1/mods/{modId}/files` filtered by game version + loader. */
  async getModFiles(
    modId: number,
    filters: { gameVersion?: string; modLoaderType?: number },
  ): Promise<CfFile[]> {
    const params = new URLSearchParams();
    if (filters.gameVersion) {
      params.set("gameVersion", filters.gameVersion);
    }
    if (filters.modLoaderType !== undefined) {
      params.set("modLoaderType", String(filters.modLoaderType));
    }
    params.set("pageSize", "50");
    const doc = await this.#getJson<{ data: CfFile[] }>(`/v1/mods/${modId}/files`, params);
    return doc.data ?? [];
  }

  /** `GET /v1/mods/{modId}/files/{fileId}` → one file's metadata. */
  async getModFile(modId: number, fileId: number): Promise<CfFile> {
    const doc = await this.#getJson<{ data: CfFile }>(`/v1/mods/${modId}/files/${fileId}`);
    return doc.data;
  }

  /**
   * `GET /v1/mods/{modId}/files/{fileId}/download-url`. Returns the keyed CDN URL,
   * or `null` when the author disabled third-party API downloads — the caller
   * turns a `null` into a {@link ReplayUnavailable} (never a copy-from-elsewhere).
   */
  async getDownloadUrl(modId: number, fileId: number): Promise<string | null> {
    const doc = await this.#getJson<{ data: string | null }>(
      `/v1/mods/${modId}/files/${fileId}/download-url`,
    );
    return doc.data ?? null;
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
    const pkg: LockPackage = {
      name: mod.slug || String(projectId),
      kind,
      source: "curseforge",
      version: file.displayName || file.fileName,
      hash,
      provenance: "replay",
      placement: singleFilePlacement(kind, filename),
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
