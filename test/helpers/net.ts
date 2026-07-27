/**
 * Offline network test scaffolding. Nothing here touches the real network:
 *
 *   - {@link FakeModrinth} implements the `Http` interface directly, replaying the
 *     real Modrinth v2 response shapes (project / version / batch / CDN bytes)
 *     from an in-memory dataset — the recorded-fixture replay, hermetic.
 *   - {@link makeScriptedHttp} wraps the *real* {@link RateLimitedHttp} around a
 *     scripted low-level fetch + injected DNS + a virtual clock, so the token
 *     bucket, backoff, redirect + SSRF-guard loop all run for real, offline.
 */

import { createHash } from "node:crypto";
import {
  CurseForgeSource,
  type FetchInitLike,
  type FetchResponseLike,
  type Http,
  type HttpGetOptions,
  type HttpResult,
  LocalSource,
  ModrinthSource,
  RateLimitedHttp,
  type SourceEntry,
  type SourceKind,
  type SourceRegistry,
  UrlSource,
} from "../../index.js";
import { makeZip } from "./zip.js";

/** A minimal Fabric mod jar (a zip carrying `fabric.mod.json`). */
export function fabricJar(id: string): Uint8Array {
  return new Uint8Array(
    makeZip([
      { name: "fabric.mod.json", data: JSON.stringify({ id }) },
      { name: `${id}/Main.class`, data: "CAFEBABE" },
    ]),
  );
}

/** Build a source registry wired to the given fake HTTP clients. */
export function registryWith(entries: {
  modrinth?: Http;
  url?: Http;
  modrinthBaseUrl?: string;
  curseforge?: Http;
}): SourceRegistry {
  const map = new Map<SourceKind, SourceEntry>();
  if (entries.modrinth) {
    map.set("modrinth", {
      source: new ModrinthSource(
        entries.modrinthBaseUrl ? { baseUrl: entries.modrinthBaseUrl } : {},
      ),
      http: entries.modrinth,
    });
  }
  if (entries.url) {
    map.set("url", { source: new UrlSource(), http: entries.url });
  }
  map.set("local", { source: new LocalSource() });
  map.set("curseforge", {
    source: new CurseForgeSource(),
    ...(entries.curseforge ? { http: entries.curseforge } : {}),
  });
  return map;
}

export function sha1hex(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}
export function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// --- FakeModrinth (implements Http directly) -------------------------------

export interface FakeModrinthVersion {
  readonly id: string;
  readonly projectId: string;
  readonly versionNumber: string;
  readonly datePublished: string;
  readonly loaders: readonly string[];
  readonly gameVersions: readonly string[];
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly dependencies?: ReadonlyArray<{
    project_id?: string;
    version_id?: string;
    dependency_type: string;
  }>;
}

export interface FakeModrinthProject {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly projectType: string;
  readonly versions: readonly FakeModrinthVersion[];
}

/**
 * The Modrinth CDN's canonical file URL. Exported because a `.mrpack` fixture has
 * to name its members by exactly this URL for base resolution to recover their
 * catalogue identity from it — the same recovery real packs rely on.
 */
export function modrinthFileUrl(v: FakeModrinthVersion): string {
  return `https://cdn.modrinth.com/data/${v.projectId}/versions/${v.id}/${encodeURIComponent(v.filename)}`;
}

function fileUrlOf(v: FakeModrinthVersion): string {
  return modrinthFileUrl(v);
}

function versionJson(v: FakeModrinthVersion): unknown {
  return {
    id: v.id,
    project_id: v.projectId,
    version_number: v.versionNumber,
    date_published: v.datePublished,
    loaders: v.loaders,
    game_versions: v.gameVersions,
    files: [
      {
        hashes: { sha1: sha1hex(v.bytes), sha512: "" },
        url: fileUrlOf(v),
        filename: v.filename,
        primary: true,
        size: v.bytes.byteLength,
      },
    ],
    dependencies: v.dependencies ?? [],
  };
}

export class FakeModrinth implements Http {
  readonly calls: string[] = [];
  readonly #projects = new Map<string, FakeModrinthProject>();
  readonly #versions = new Map<string, FakeModrinthVersion>();
  readonly #bytes = new Map<string, Uint8Array>();

  add(project: FakeModrinthProject): this {
    this.#projects.set(project.slug, project);
    this.#projects.set(project.id, project);
    for (const v of project.versions) {
      this.#versions.set(v.id, v);
      this.#bytes.set(fileUrlOf(v), v.bytes);
    }
    return this;
  }

  async get(url: string, _options?: HttpGetOptions): Promise<HttpResult> {
    this.calls.push(url);
    const bytes = this.#bytes.get(url);
    if (bytes) {
      return { status: 200, headers: {}, url, body: bytes };
    }
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v2/, "");
    const projectMatch = path.match(/^\/project\/([^/]+)$/);
    if (projectMatch) {
      const p = this.#projects.get(decodeURIComponent(projectMatch[1] as string));
      if (!p) {
        return { status: 404, headers: {}, url, body: encode({ error: "not found" }) };
      }
      return {
        status: 200,
        headers: {},
        url,
        body: encode({ id: p.id, slug: p.slug, title: p.title, project_type: p.projectType }),
      };
    }
    const versionsMatch = path.match(/^\/project\/([^/]+)\/version$/);
    if (versionsMatch) {
      const p = this.#projects.get(decodeURIComponent(versionsMatch[1] as string));
      if (!p) {
        return { status: 404, headers: {}, url, body: encode({ error: "not found" }) };
      }
      const loaders = parseArrayParam(u.searchParams.get("loaders"));
      const games = parseArrayParam(u.searchParams.get("game_versions"));
      const filtered = p.versions.filter(
        (v) =>
          (loaders === undefined || v.loaders.some((l) => loaders.includes(l))) &&
          (games === undefined || v.gameVersions.some((g) => games.includes(g))),
      );
      return { status: 200, headers: {}, url, body: encode(filtered.map(versionJson)) };
    }
    if (path === "/versions") {
      const ids = parseArrayParam(u.searchParams.get("ids")) ?? [];
      const out = ids
        .map((id) => this.#versions.get(id))
        .filter((v): v is FakeModrinthVersion => !!v);
      return { status: 200, headers: {}, url, body: encode(out.map(versionJson)) };
    }
    if (path === "/projects") {
      const ids = parseArrayParam(u.searchParams.get("ids")) ?? [];
      const out = ids
        .map((id) => this.#projects.get(id))
        .filter((p): p is FakeModrinthProject => !!p)
        .map((p) => ({ id: p.id, slug: p.slug, title: p.title, project_type: p.projectType }));
      return { status: 200, headers: {}, url, body: encode(out) };
    }
    return { status: 404, headers: {}, url, body: encode({ error: `unrouted ${path}` }) };
  }
}

function parseArrayParam(raw: string | null): string[] | undefined {
  if (raw === null) {
    return undefined;
  }
  return JSON.parse(raw) as string[];
}

// --- a plain byte server for the URL source (implements Http) --------------

/** An `Http` that serves fixed bytes per URL and invokes the SSRF guard benignly. */
export class FakeBytes implements Http {
  readonly calls: string[] = [];
  readonly #map = new Map<string, Uint8Array>();

  set(url: string, bytes: Uint8Array): this {
    this.#map.set(url, bytes);
    return this;
  }

  async get(url: string, options?: HttpGetOptions): Promise<HttpResult> {
    this.calls.push(url);
    // Exercise the guard with a benign public address so url-source tests pass it.
    await options?.guard?.({ url, host: new URL(url).hostname, addresses: ["93.184.216.34"] });
    const bytes = this.#map.get(url);
    if (!bytes) {
      throw new Error(`FakeBytes: no bytes for ${url}`);
    }
    return { status: 200, headers: {}, url, body: bytes };
  }
}

/** An `Http` spy that records calls and throws if used — for pre-network gates. */
export function throwingHttp(): { http: Http; calls: string[] } {
  const calls: string[] = [];
  const http: Http = {
    get(url: string): Promise<HttpResult> {
      calls.push(url);
      throw new Error(`network was reached for ${url} — expected no request`);
    },
  };
  return { http, calls };
}

// --- RateLimitedHttp over a scripted fetch + virtual clock -----------------

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export function fakeHeaders(rec: Record<string, string>): FetchResponseLike["headers"] {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    get: (name: string) => lower[name.toLowerCase()] ?? null,
    entries: () => Object.entries(lower)[Symbol.iterator](),
  };
}

export interface ScriptedResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: Uint8Array;
}

export interface ScriptedHttp {
  readonly http: RateLimitedHttp;
  readonly requests: RecordedRequest[];
  readonly sleeps: number[];
  now(): number;
}

/**
 * Build a real {@link RateLimitedHttp} over a scripted fetch. `handler` returns
 * the response for each request (by url + call index); DNS is injected via
 * `lookup`; the clock is virtual (sleeps advance it), so backoff/token-bucket
 * timing is deterministic and instant.
 */
export function makeScriptedHttp(opts: {
  handler: (url: string, init: FetchInitLike, call: number) => ScriptedResponse;
  lookup?: (host: string) => Promise<string[]>;
  rps?: number;
  burst?: number;
  maxRetries?: number;
  maxRedirects?: number;
}): ScriptedHttp {
  const requests: RecordedRequest[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let call = 0;
  const fetchImpl = async (url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    requests.push({ url, headers: { ...init.headers } });
    const res = opts.handler(url, init, call++);
    return {
      status: res.status,
      headers: fakeHeaders(res.headers ?? {}),
      arrayBuffer: async () => {
        const b = res.body ?? new Uint8Array();
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  const http = new RateLimitedHttp({
    userAgent: "lobbify-anvil/0.1.0 (+test)",
    fetchImpl,
    lookup: opts.lookup ?? (async () => ["93.184.216.34"]),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...(opts.rps !== undefined ? { rps: opts.rps } : {}),
    ...(opts.burst !== undefined ? { burst: opts.burst } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.maxRedirects !== undefined ? { maxRedirects: opts.maxRedirects } : {}),
  });
  return { http, requests, sleeps, now: () => clock };
}
