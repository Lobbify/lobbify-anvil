/**
 * The Modrinth source — keyless, rate-limited, batched.
 *
 * Resolution flow for one ref:
 *   1. fetch the project (its `project_type` drives kind inference);
 *   2. list the project's versions filtered by loader + Minecraft version, and
 *      select one under the version spec + the **frozen `ctx.now` clock** (so a
 *      `latest`/omitted spec is deterministic — the newest version published at
 *      or before the lock instant);
 *   3. download the primary file, cross-check Modrinth's attested sha1, and pin
 *      the **sha256** of the bytes (anvil's canonical domain) — admitting the
 *      bytes to the store so a following build performs zero network;
 *   4. surface the version's **required** dependencies (optional/embedded
 *      excluded), resolving version-pinned deps with a single batched
 *      `/versions` call — the batched transitive fan-out.
 *
 * All requests carry the descriptive User-Agent and pass through the per-source
 * token bucket in {@link RateLimitedHttp}.
 */

import * as semver from "semver";
import { hashBuffer } from "../store/hash.js";
import { HttpError, ShaMismatch, UnsatisfiableTarget } from "../types/errors.js";
import type {
  FetchPlan,
  Http,
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

const DEFAULT_BASE_URL = "https://api.modrinth.com/v2";
const MAX_FILE_BYTES = 512 * 1024 * 1024;

// --- Modrinth API shapes (only the fields we read) -------------------------

interface ModrinthProject {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly project_type: string;
}

interface ModrinthFile {
  readonly hashes: { readonly sha1?: string; readonly sha512?: string };
  readonly url: string;
  readonly filename: string;
  readonly primary: boolean;
  readonly size?: number;
}

interface ModrinthDependency {
  readonly project_id?: string;
  readonly version_id?: string;
  readonly dependency_type: string;
}

interface ModrinthVersion {
  readonly id: string;
  readonly project_id: string;
  readonly version_number: string;
  readonly date_published: string;
  readonly files: readonly ModrinthFile[];
  readonly dependencies?: readonly ModrinthDependency[];
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** The batched, rate-limited Modrinth v2 client. */
export class ModrinthApi {
  readonly #http: Http;
  readonly #base: string;

  constructor(http: Http, baseUrl: string = DEFAULT_BASE_URL) {
    this.#http = http;
    this.#base = baseUrl.replace(/\/$/, "");
  }

  async #getJson<T>(path: string, params?: URLSearchParams): Promise<T> {
    const qs = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
    const res = await this.#http.get(`${this.#base}${path}${qs}`, { maxBytes: MAX_FILE_BYTES });
    return decodeJson<T>(res.body);
  }

  getProject(idOrSlug: string): Promise<ModrinthProject> {
    return this.#getJson<ModrinthProject>(`/project/${encodeURIComponent(idOrSlug)}`);
  }

  getProjectVersions(
    idOrSlug: string,
    filters: { loaders?: readonly string[]; gameVersions?: readonly string[] },
  ): Promise<ModrinthVersion[]> {
    const params = new URLSearchParams();
    if (filters.loaders && filters.loaders.length > 0) {
      params.set("loaders", JSON.stringify(filters.loaders));
    }
    if (filters.gameVersions && filters.gameVersions.length > 0) {
      params.set("game_versions", JSON.stringify(filters.gameVersions));
    }
    return this.#getJson<ModrinthVersion[]>(
      `/project/${encodeURIComponent(idOrSlug)}/version`,
      params,
    );
  }

  /** Batch-fetch versions by id (the transitive-dependency fan-out). */
  getVersions(ids: readonly string[]): Promise<ModrinthVersion[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    const params = new URLSearchParams();
    params.set("ids", JSON.stringify(ids));
    return this.#getJson<ModrinthVersion[]>("/versions", params);
  }

  /**
   * `GET /version_file/{hash}?algorithm=sha1` — reverse-lookup the version a file
   * belongs to by its content hash. Used by the Prism importer to re-identify a
   * local jar as a Modrinth project. Returns `undefined` on a 404 (no match).
   */
  async getVersionFile(hash: string, algorithm = "sha1"): Promise<ModrinthVersion | undefined> {
    const params = new URLSearchParams();
    params.set("algorithm", algorithm);
    try {
      return await this.#getJson<ModrinthVersion>(
        `/version_file/${encodeURIComponent(hash)}`,
        params,
      );
    } catch (err) {
      // A 404 (unknown hash) is "no match", not a hard failure.
      if (err instanceof HttpError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }

  /** Batch-fetch projects by id. */
  getProjects(ids: readonly string[]): Promise<ModrinthProject[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }
    const params = new URLSearchParams();
    params.set("ids", JSON.stringify(ids));
    return this.#getJson<ModrinthProject[]>("/projects", params);
  }
}

// --- version selection under the frozen clock ------------------------------

function publishedAtOrBefore(v: ModrinthVersion, now: number): boolean {
  const t = Date.parse(v.date_published);
  return Number.isNaN(t) || t <= now;
}

function coerced(version: string): semver.SemVer | null {
  return semver.coerce(version, { includePrerelease: true });
}

function pickLatest(
  versions: readonly ModrinthVersion[],
  now: number,
): ModrinthVersion | undefined {
  const eligible = versions.filter((v) => publishedAtOrBefore(v, now));
  let best: ModrinthVersion | undefined;
  for (const v of eligible) {
    if (best === undefined) {
      best = v;
      continue;
    }
    const cmp = Date.parse(v.date_published) - Date.parse(best.date_published);
    // Newest wins; a code-unit id tiebreak keeps selection deterministic across
    // Node/ICU versions (never `localeCompare`, whose collation is host-variant).
    if (cmp > 0 || (cmp === 0 && v.id > best.id)) {
      best = v;
    }
  }
  return best;
}

function pickRange(
  versions: readonly ModrinthVersion[],
  range: string,
  now: number,
): ModrinthVersion | undefined {
  const eligible = versions.filter((v) => {
    if (!publishedAtOrBefore(v, now)) {
      return false;
    }
    const c = coerced(v.version_number);
    return c !== null && semver.satisfies(c, range, { includePrerelease: true, loose: true });
  });
  let best: ModrinthVersion | undefined;
  let bestSem: semver.SemVer | null = null;
  for (const v of eligible) {
    const c = coerced(v.version_number);
    if (c === null) {
      continue;
    }
    if (bestSem === null || semver.compare(c, bestSem) > 0) {
      best = v;
      bestSem = c;
    }
  }
  return best;
}

function selectVersion(
  versions: readonly ModrinthVersion[],
  spec: VersionSpec,
  now: number,
  subject: string,
): ModrinthVersion {
  let chosen: ModrinthVersion | undefined;
  switch (spec.kind) {
    case "pin":
      chosen = versions.find((v) => v.version_number === spec.version || v.id === spec.version);
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, `no version pinned as "${spec.version}"`);
      }
      return chosen;
    case "range":
      chosen = pickRange(versions, spec.range, now);
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, `no version satisfies range "${spec.range}"`);
      }
      return chosen;
    case "latest":
      chosen = pickLatest(versions, now);
      if (!chosen) {
        throw new UnsatisfiableTarget(subject, "no versions published at or before the lock clock");
      }
      return chosen;
  }
}

function primaryFile(version: ModrinthVersion, subject: string): ModrinthFile {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  if (!file) {
    throw new UnsatisfiableTarget(subject, "the selected version has no downloadable file");
  }
  return file;
}

/** Derive the Modrinth loader name from a manifest loader string (`"fabric 0.19.1"`). */
function loaderName(loader: string | undefined): string | undefined {
  if (!loader) {
    return undefined;
  }
  const name = loader.trim().split(/\s+/)[0]?.toLowerCase();
  return name && name !== "vanilla" ? name : undefined;
}

export interface ModrinthSourceOptions {
  readonly baseUrl?: string;
}

export class ModrinthSource implements Source {
  readonly kind = "modrinth" as const;
  readonly #baseUrl?: string;

  constructor(options: ModrinthSourceOptions = {}) {
    this.#baseUrl = options.baseUrl;
  }

  async resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult> {
    if (!ctx.http) {
      throw new UnsatisfiableTarget(`modrinth:${ref.id}`, "no HTTP client configured");
    }
    const subject = `modrinth:${ref.id}`;
    const api = new ModrinthApi(ctx.http, this.#baseUrl);
    const project = await api.getProject(ref.id);

    const loader = loaderName(ctx.game?.loader);
    const filters = {
      ...(project.project_type === "mod" && loader ? { loaders: [loader] } : {}),
      ...(ctx.game?.minecraft ? { gameVersions: [ctx.game.minecraft] } : {}),
    };
    const versions = await api.getProjectVersions(ref.id, filters);
    if (versions.length === 0) {
      throw new UnsatisfiableTarget(
        subject,
        `no versions for ${loader ?? "any loader"} on Minecraft ${ctx.game?.minecraft ?? "any"}`,
      );
    }
    const version = selectVersion(versions, ref.versionSpec, ctx.now, subject);
    const file = primaryFile(version, subject);

    // Download the bytes: pin sha256 (store key) + cross-check Modrinth's sha1.
    // The SSRF guard applies here as it does for url/curseforge — a base-URL
    // override to a hostile mirror (or a mirror-supplied `file.url`) cannot pivot
    // to an internal host. (The client also guards by default; passing it makes
    // the intent explicit and covers a non-default `Http`.)
    const res = await ctx.http.get(file.url, { guard: guardHop, maxBytes: MAX_FILE_BYTES });
    const bytes = res.body;
    if (file.hashes.sha1) {
      const actual = hashBuffer(bytes, "sha1");
      if (actual.value !== file.hashes.sha1) {
        throw new ShaMismatch(subject, { algo: "sha1", value: file.hashes.sha1 }, actual);
      }
    }
    const hash = hashBuffer(bytes, "sha256");
    const itemKind = await inferKind({
      subject,
      explicit: ref.kind,
      projectType: project.project_type,
      filename: file.filename,
      bytes,
    });
    if (ctx.store) {
      await ctx.store.putBuffer(bytes, "sha256", hash);
    }
    const filename = safeBasename(file.filename, ".jar");
    // Trust our own byte count over an attacker-influenceable declared size.
    const declared = file.size;
    const size =
      typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0
        ? declared
        : bytes.byteLength;
    const pkg: LockPackage = {
      name: project.slug,
      kind: itemKind,
      source: "modrinth",
      version: version.version_number,
      hash,
      provenance: "copy",
      placement: singleFilePlacement(itemKind, filename),
      size,
      url: file.url,
    };

    const dependencies = await this.#dependencies(version, api);
    return { pkg, ...(dependencies.length > 0 ? { dependencies } : {}) };
  }

  /** Required deps only; version-pinned deps resolved with one batched call. */
  async #dependencies(version: ModrinthVersion, api: ModrinthApi): Promise<ResolvedRef[]> {
    const required = (version.dependencies ?? []).filter((d) => d.dependency_type === "required");
    const versionIds: string[] = [];
    const projectIds: string[] = [];
    for (const d of required) {
      if (d.version_id) {
        versionIds.push(d.version_id);
      } else if (d.project_id) {
        projectIds.push(d.project_id);
      }
    }
    const deps: ResolvedRef[] = [];
    if (versionIds.length > 0) {
      const depVersions = await api.getVersions(versionIds);
      for (const dv of depVersions) {
        deps.push({
          source: "modrinth",
          id: dv.project_id,
          versionSpec: { kind: "pin", version: dv.version_number },
        });
      }
    }
    for (const pid of projectIds) {
      deps.push({ source: "modrinth", id: pid, versionSpec: { kind: "latest" } });
    }
    return deps;
  }

  plan(pkg: LockPackage, _ctx: SourceContext): FetchPlan {
    if (!pkg.url) {
      throw new UnsatisfiableTarget(pkg.name, "modrinth package has no download URL");
    }
    return {
      url: pkg.url,
      expected: pkg.hash,
      provenance: "copy",
      ...(pkg.size !== undefined ? { size: pkg.size } : {}),
    };
  }
}
