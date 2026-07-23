/**
 * The Fabric / Quilt loader install.
 *
 * Fetch the loader profile (`meta.fabricmc.net` / `meta.quiltmc.org`), pin **every
 * loader library** as a lock package, and hand the profile back so the caller can
 * flatten it into a self-contained, canonical merged `version.json`.
 *
 * Loader-library pinning: Fabric attests **sha256** in its metadata, so those pin
 * with no download. Quilt attests no hash, so anvil downloads the jar at lock time
 * and pins the **sha256** it computes (cross-checking any maven-side sha1 it can).
 * Either way the pin is a concrete content hash — a re-published loader jar is
 * caught on admission.
 */

import { guardHop } from "../sources/index.js";
import { hashBuffer } from "../store/index.js";
import { ShaMismatch, UnsatisfiableTarget } from "../types/errors.js";
import type { Http, ItemKind, LockPackage, ObjectSink } from "../types/index.js";
import { mavenPath } from "./platform.js";
import type { LauncherProfile } from "./version-json.js";

const FABRIC_META = "https://meta.fabricmc.net/v2";
const QUILT_META = "https://meta.quiltmc.org/v3";
const MAX_META_BYTES = 32 * 1024 * 1024;
const MAX_JAR_BYTES = 64 * 1024 * 1024;

/** The loaders this stage installs. NeoForge/Forge (processor-sandboxed) are Stage 9. */
export type LoaderName = "fabric" | "quilt";

export interface ParsedLoader {
  readonly name: LoaderName | "vanilla" | "neoforge" | "forge";
  readonly version?: string;
}

/** Parse a manifest loader string (`"fabric 0.19.3"`, `"quilt"`, `"vanilla"`). */
export function parseLoaderSpec(loader: string | undefined): ParsedLoader {
  const parts = (loader ?? "vanilla").trim().split(/\s+/);
  const name = (parts[0] ?? "vanilla").toLowerCase();
  const version = parts[1];
  if (
    name === "fabric" ||
    name === "quilt" ||
    name === "vanilla" ||
    name === "neoforge" ||
    name === "forge"
  ) {
    return version ? { name, version } : { name };
  }
  throw new UnsatisfiableTarget(`loader ${loader}`, `unknown loader "${name}"`);
}

interface LoaderListEntry {
  readonly version: string;
  readonly stable?: boolean;
}
interface FabricLibrary {
  readonly name: string;
  readonly url?: string;
  readonly sha1?: string;
  readonly sha256?: string;
  readonly size?: number;
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function metaBase(name: LoaderName): string {
  return name === "fabric" ? FABRIC_META : QUILT_META;
}

/** Join a maven base URL and a maven path with exactly one separating slash. */
export function joinMavenUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function isLoaderJar(coordinate: string): boolean {
  return (
    coordinate.startsWith("net.fabricmc:fabric-loader:") ||
    coordinate.startsWith("org.quiltmc:quilt-loader:")
  );
}

export class LoaderApi {
  readonly #http: Http;
  readonly #base: string;
  constructor(http: Http, name: LoaderName, baseOverride?: string) {
    this.#http = http;
    this.#base = baseOverride ?? metaBase(name);
  }

  async loaderVersions(): Promise<LoaderListEntry[]> {
    const res = await this.#http.get(`${this.#base}/versions/loader`, { maxBytes: MAX_META_BYTES });
    return decodeJson<LoaderListEntry[]>(res.body);
  }

  async profile(minecraft: string, loaderVersion: string): Promise<LauncherProfile> {
    const url = `${this.#base}/versions/loader/${encodeURIComponent(minecraft)}/${encodeURIComponent(loaderVersion)}/profile/json`;
    const res = await this.#http.get(url, { maxBytes: MAX_META_BYTES });
    return decodeJson<LauncherProfile>(res.body);
  }
}

/** Pick the concrete loader version: an explicit pin, else the newest stable. */
function selectLoaderVersion(list: readonly LoaderListEntry[], want: string | undefined): string {
  if (want) {
    const hit = list.find((e) => e.version === want);
    if (!hit) {
      throw new UnsatisfiableTarget(`loader ${want}`, "no such loader version");
    }
    return hit.version;
  }
  const stable = list.find((e) => e.stable);
  const chosen = stable ?? list[0];
  if (!chosen) {
    throw new UnsatisfiableTarget("loader latest", "the loader list is empty");
  }
  return chosen.version;
}

export interface ResolveLoaderInput {
  readonly loader: LoaderName;
  readonly loaderVersion?: string;
  readonly minecraft: string;
  readonly api: LoaderApi;
  /** Fetches Quilt (unhashed) loader jars at lock time to pin their sha256. */
  readonly http: Http;
  readonly store?: ObjectSink;
}

export interface LoaderResolution {
  readonly profile: LauncherProfile;
  readonly packages: readonly LockPackage[];
  /** The loader profile id (`fabric-loader-0.19.3-26.2`) — the merged profile id. */
  readonly loaderId: string;
  /** The human loader label for `meta.loader` (`"fabric 0.19.3"`). */
  readonly loaderLabel: string;
}

/** Resolve a Fabric/Quilt loader: pin its libraries and return its profile. */
export async function resolveLoader(input: ResolveLoaderInput): Promise<LoaderResolution> {
  const { loader, minecraft, api, http, store } = input;
  const list = await api.loaderVersions();
  const version = selectLoaderVersion(list, input.loaderVersion);
  const profile = await api.profile(minecraft, version);
  const loaderId = profile.id ?? `${loader}-loader-${version}-${minecraft}`;

  const packages: LockPackage[] = [];
  for (const lib of (profile.libraries ?? []) as unknown as FabricLibrary[]) {
    if (!lib.name) {
      continue;
    }
    const path = mavenPath(lib.name);
    const base = lib.url ?? (loader === "fabric" ? "https://maven.fabricmc.net/" : "");
    if (!base) {
      throw new UnsatisfiableTarget(lib.name, "loader library has no maven repository url");
    }
    const jarUrl = joinMavenUrl(base, path);
    const kind: ItemKind = isLoaderJar(lib.name) ? "loader" : "library";

    let hashValue = lib.sha256;
    let size = lib.size;
    if (!hashValue) {
      // Unhashed (Quilt): download now and pin the computed sha256. The jar URL
      // comes from the (untrusted) loader-meta response, so the SSRF guard vets
      // it just like any other `url`-source fetch — no internal/metadata targets.
      const res = await http.get(jarUrl, { maxBytes: MAX_JAR_BYTES, guard: guardHop });
      const bytes = res.body;
      if (lib.sha1) {
        const actualSha1 = hashBuffer(bytes, "sha1");
        if (actualSha1.value !== lib.sha1) {
          throw new ShaMismatch(lib.name, { algo: "sha1", value: lib.sha1 }, actualSha1);
        }
      }
      const computed = hashBuffer(bytes, "sha256");
      hashValue = computed.value;
      size = bytes.byteLength;
      if (store) {
        await store.putBuffer(bytes, "sha256", computed);
      }
    }

    packages.push({
      name: lib.name,
      kind,
      source: "url",
      hash: { algo: "sha256", value: hashValue },
      provenance: "copy",
      placement: { method: "link", target: `libraries/${path}` },
      ...(size !== undefined ? { size } : {}),
      url: jarUrl,
    });
  }

  return { profile, packages, loaderId, loaderLabel: `${loader} ${version}` };
}
