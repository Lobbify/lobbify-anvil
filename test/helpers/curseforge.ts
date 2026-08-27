/**
 * Offline CurseForge test scaffolding. Nothing here touches the real network or
 * a real API key: {@link FakeCurseForge} implements the `Http` interface directly
 * and replays the CurseForge Core v1 response shapes (mod / files / file /
 * download-url + CDN bytes) from an in-memory dataset — the recorded-fixture
 * replay, hermetic. It also models the two failure surfaces the ToS path must
 * handle: a `null` download-url (author disabled third-party downloads) and a
 * `403` from the CDN.
 */

import { curseforgeFingerprint } from "../../index.js";
import { HttpError } from "../../index.js";
import type { Http, HttpGetOptions, HttpResult } from "../../index.js";
import { sha1hex } from "./net.js";

export interface FakeCfFileSpec {
  readonly id: number;
  readonly displayName?: string;
  readonly fileName: string;
  readonly fileDate?: string;
  /** Game versions + loader names the file lists (e.g. `["26.2", "Fabric"]`). */
  readonly gameVersions?: readonly string[];
  readonly bytes: Uint8Array;
  readonly dependencies?: ReadonlyArray<{ modId: number; relationType: number }>;
  readonly fileLength?: number;
  /** `download-url` returns `null` (author disabled third-party downloads). */
  readonly downloadDisabled?: boolean;
  /** The CDN GET answers `403`. */
  readonly cdn403?: boolean;
  /**
   * `GET /v1/mods/{modId}/files/{fileId}` throws an {@link HttpError} carrying
   * this status instead of answering — models a transient 429/5xx from the
   * file-metadata endpoint itself (distinct from `cdn403`, which is the
   * download/CDN leg). Mirrors what `RateLimitedHttp` actually does after its
   * own retries are exhausted: throw, never return the status silently.
   */
  readonly getFileStatus?: number;
  /** Omit `fileFingerprint` from the file JSON. */
  readonly omitFingerprint?: boolean;
  /** Force a wrong `fileFingerprint` (to exercise the cross-check). */
  readonly badFingerprint?: number;
  /** Force a wrong attested sha1 (to exercise the tamper guard). */
  readonly badSha1?: string;
  /** Serve different bytes at the CDN than were indexed (tamper simulation). */
  readonly cdnBytes?: Uint8Array;
  /**
   * Route normally, but answer with a body claiming a different `(modId, id)`
   * than was asked for. Models a response that points at some other artifact —
   * the thing a caller pinning by `(projectID, fileID)` must cross-check.
   */
  readonly lieAboutIdentity?: { readonly modId?: number; readonly id?: number };
}

export interface FakeCfModSpec {
  readonly modId: number;
  readonly slug: string;
  readonly name?: string;
  readonly classId?: number;
  readonly files: readonly FakeCfFileSpec[];
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function cdnUrl(modId: number, file: FakeCfFileSpec): string {
  return `https://edge.forgecdn.net/files/${file.id}/${modId}/${encodeURIComponent(file.fileName)}`;
}

function fileJson(modId: number, f: FakeCfFileSpec): unknown {
  const sha1 = f.badSha1 ?? sha1hex(f.bytes);
  const fp = f.badFingerprint ?? curseforgeFingerprint(f.bytes);
  return {
    id: f.lieAboutIdentity?.id ?? f.id,
    modId: f.lieAboutIdentity?.modId ?? modId,
    displayName: f.displayName ?? f.fileName,
    fileName: f.fileName,
    fileDate: f.fileDate ?? "2026-06-01T00:00:00Z",
    fileLength: f.fileLength ?? f.bytes.byteLength,
    gameVersions: f.gameVersions ?? [],
    hashes: [{ value: sha1, algo: 1 }],
    ...(f.omitFingerprint ? {} : { fileFingerprint: fp }),
    dependencies: f.dependencies ?? [],
  };
}

/**
 * Rewrite an API response body before it is returned. The argument is the parsed
 * `{ data: … }` envelope; whatever comes back is re-encoded verbatim.
 *
 * This exists to model a hostile or broken *upstream* rather than a hostile
 * pack: a mirror, a proxy, an error page served with a 200, or a delisted id can
 * all hand back JSON that type-checks at compile time and is junk at run time.
 * anvil's typed decoders cast rather than validate, so this is the only way to
 * reach the code that dereferences those fields.
 */
export type CfMangle = (path: string, body: unknown) => unknown;

/** An in-memory CurseForge Core v1 API + CDN, implementing the `Http` interface. */
export class FakeCurseForge implements Http {
  readonly calls: string[] = [];
  readonly apiKeys: string[] = [];
  readonly #mods = new Map<number, FakeCfModSpec>();
  readonly #files = new Map<string, { modId: number; file: FakeCfFileSpec }>();
  readonly #cdn = new Map<string, FakeCfFileSpec>();
  #mangle?: CfMangle;

  add(mod: FakeCfModSpec): this {
    this.#mods.set(mod.modId, mod);
    for (const file of mod.files) {
      this.#files.set(`${mod.modId}:${file.id}`, { modId: mod.modId, file });
      this.#cdn.set(cdnUrl(mod.modId, file), file);
    }
    return this;
  }

  /** Install a response mangler (see {@link CfMangle}). */
  mangle(fn: CfMangle): this {
    this.#mangle = fn;
    return this;
  }

  async get(url: string, options?: HttpGetOptions): Promise<HttpResult> {
    this.calls.push(url);
    const key = options?.headers?.["x-api-key"];
    if (key) {
      this.apiKeys.push(key);
    }

    // Exercise any provided SSRF guard with a benign public address.
    await options?.guard?.({ url, host: safeHost(url), addresses: ["104.18.0.1"] });

    // CDN byte fetch.
    const cdnFile = this.#cdn.get(url);
    if (cdnFile) {
      if (cdnFile.cdn403) {
        throw new HttpError(url, "unexpected status 403", 403);
      }
      return { status: 200, headers: {}, url, body: cdnFile.cdnBytes ?? cdnFile.bytes };
    }

    const u = new URL(url);
    const path = u.pathname;

    // Every JSON route below goes through the mangler when one is installed.
    const reply = (body: unknown): HttpResult => ({
      status: 200,
      headers: {},
      url,
      body: encode(this.#mangle ? this.#mangle(path, body) : body),
    });

    const dl = path.match(/^\/v1\/mods\/(\d+)\/files\/(\d+)\/download-url$/);
    if (dl) {
      const entry = this.#files.get(`${dl[1]}:${dl[2]}`);
      if (!entry) {
        return { status: 200, headers: {}, url, body: encode({ data: null }) };
      }
      const data = entry.file.downloadDisabled ? null : cdnUrl(entry.modId, entry.file);
      return reply({ data });
    }

    const oneFile = path.match(/^\/v1\/mods\/(\d+)\/files\/(\d+)$/);
    if (oneFile) {
      const entry = this.#files.get(`${oneFile[1]}:${oneFile[2]}`);
      if (!entry) {
        // Mirrors RateLimitedHttp: a real not-found is thrown, not handed back
        // as a raw status — every caller (including this fake's own callers)
        // reads the status off a thrown HttpError, never off HttpResult.status.
        throw new HttpError(url, "unexpected status 404", 404);
      }
      if (entry.file.getFileStatus !== undefined) {
        throw new HttpError(
          url,
          `unexpected status ${entry.file.getFileStatus}`,
          entry.file.getFileStatus,
        );
      }
      return reply({ data: fileJson(entry.modId, entry.file) });
    }

    const filesList = path.match(/^\/v1\/mods\/(\d+)\/files$/);
    if (filesList) {
      const mod = this.#mods.get(Number(filesList[1]));
      if (!mod) {
        return { status: 404, headers: {}, url, body: encode({ error: "not found" }) };
      }
      const gameVersion = u.searchParams.get("gameVersion");
      const filtered = mod.files.filter(
        (f) => gameVersion === null || (f.gameVersions ?? []).includes(gameVersion),
      );
      // Real CurseForge pagination: `pageSize` (capped at 50 upstream, but this
      // fake honors whatever the caller asks — the client under test is what
      // enforces 50) and `index` (offset), with a `pagination` envelope
      // describing the slice. Ignoring these — as this fake used to — hides
      // the exact bug LB-723 is about: a client that never sends `index` and
      // never reads `pagination` cannot tell a truncated listing from a
      // complete one.
      const pageSize = Number(u.searchParams.get("pageSize") ?? filtered.length);
      const index = Number(u.searchParams.get("index") ?? 0);
      const page = filtered.slice(index, index + pageSize);
      return reply({
        data: page.map((f) => fileJson(mod.modId, f)),
        pagination: {
          index,
          pageSize,
          resultCount: page.length,
          totalCount: filtered.length,
        },
      });
    }

    const modMatch = path.match(/^\/v1\/mods\/(\d+)$/);
    if (modMatch) {
      const mod = this.#mods.get(Number(modMatch[1]));
      if (!mod) {
        return { status: 404, headers: {}, url, body: encode({ error: "not found" }) };
      }
      return reply({
        data: {
          id: mod.modId,
          name: mod.name ?? mod.slug,
          slug: mod.slug,
          ...(mod.classId !== undefined ? { classId: mod.classId } : {}),
        },
      });
    }

    return { status: 404, headers: {}, url, body: encode({ error: `unrouted ${path}` }) };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "example.com";
  }
}
