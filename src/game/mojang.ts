/**
 * The Mojang installer walk: `version_manifest_v2.json` → the piston-meta version
 * profile → the client jar, libraries (+ per-OS/arch natives), the asset index,
 * and the per-platform pinned JRE.
 *
 * Pinning model (see the hashing decision in AGENT/Doc 2): every object Mojang
 * publishes is attested by **sha1**, so anvil pins those sha1s straight from the
 * metadata and fetches the bytes at **build** time — `anvil lock` stays a cheap
 * metadata pass and never downloads a single jar or asset. Determinism holds
 * because the sha1 is the content address; a Mojang re-roll changes it and the
 * drift is caught on admission.
 *
 * The JRE is pinned **per platform by its manifest sha1** — not just the component
 * id — so a silent re-roll under a stable component name (`java-runtime-epsilon`)
 * is detectable: the `all.json` entry points at a different manifest sha1, and our
 * pinned value no longer matches.
 */

import { type Rule, evaluateRules } from "../build/index.js";
import { UnsatisfiableTarget } from "../types/errors.js";
import type { Http, LockPackage, TargetTuple } from "../types/index.js";
import {
  jrePlatformTarget,
  mavenPath,
  nativesClassifierOf,
  nativesClassifierTarget,
} from "./platform.js";

// --- endpoints -------------------------------------------------------------

const DEFAULT_VERSION_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const DEFAULT_JAVA_RUNTIME_ALL =
  "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
/** Where the instance materializes extracted natives. */
export const NATIVES_DIR = "natives";
const MAX_META_BYTES = 64 * 1024 * 1024;

// --- Mojang metadata shapes (only the fields we read) ----------------------

interface VersionManifestEntry {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly sha1: string;
}
interface VersionManifest {
  readonly latest: { readonly release: string; readonly snapshot: string };
  readonly versions: readonly VersionManifestEntry[];
}

interface Download {
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
}
interface Artifact extends Download {
  readonly path: string;
}
export interface MojangLibrary {
  readonly name: string;
  readonly downloads?: { readonly artifact?: Artifact };
  readonly rules?: readonly Rule[];
}
export interface MojangProfile {
  readonly id: string;
  readonly type: string;
  readonly mainClass: string;
  readonly javaVersion?: { readonly component: string; readonly majorVersion: number };
  readonly assetIndex: {
    readonly id: string;
    readonly sha1: string;
    readonly size: number;
    readonly url: string;
  };
  readonly assets: string;
  readonly downloads: { readonly client: Download };
  readonly libraries: readonly MojangLibrary[];
  readonly arguments?: { readonly game?: readonly unknown[]; readonly jvm?: readonly unknown[] };
  readonly [k: string]: unknown;
}

interface JreEntry {
  readonly manifest: Download;
  readonly version: { readonly name: string };
}
type JavaRuntimeAll = Readonly<Record<string, Readonly<Record<string, readonly JreEntry[]>>>>;

// --- the API client --------------------------------------------------------

export interface MojangApiOptions {
  readonly versionManifestUrl?: string;
  readonly javaRuntimeAllUrl?: string;
}

function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export class MojangApi {
  readonly #http: Http;
  readonly #manifestUrl: string;
  readonly #jreAllUrl: string;

  constructor(http: Http, options: MojangApiOptions = {}) {
    this.#http = http;
    this.#manifestUrl = options.versionManifestUrl ?? DEFAULT_VERSION_MANIFEST;
    this.#jreAllUrl = options.javaRuntimeAllUrl ?? DEFAULT_JAVA_RUNTIME_ALL;
  }

  async versionManifest(): Promise<VersionManifest> {
    const res = await this.#http.get(this.#manifestUrl, { maxBytes: MAX_META_BYTES });
    return decodeJson<VersionManifest>(res.body);
  }

  async profile(entry: VersionManifestEntry): Promise<MojangProfile> {
    const res = await this.#http.get(entry.url, { maxBytes: MAX_META_BYTES });
    return decodeJson<MojangProfile>(res.body);
  }

  async javaRuntimeAll(): Promise<JavaRuntimeAll> {
    const res = await this.#http.get(this.#jreAllUrl, { maxBytes: MAX_META_BYTES });
    return decodeJson<JavaRuntimeAll>(res.body);
  }
}

// --- resolution ------------------------------------------------------------

const CANONICAL_OSES = ["linux", "osx", "windows"] as const;

/**
 * The platforms a plain (non-natives) library applies to, from its Mojang rules.
 * Returns `undefined` when it applies everywhere (universal — no `targets` needed).
 */
function libraryTargets(rules: readonly Rule[] | undefined): TargetTuple[] | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }
  const oses = CANONICAL_OSES.filter((os) => evaluateRules(rules, { os, arch: "x64" }));
  if (oses.length === CANONICAL_OSES.length) {
    return undefined; // applies to every OS → universal
  }
  return oses.map((os) => ({ os }));
}

export interface MojangResolution {
  /** The raw vanilla profile, for the loader `version.json` merge. */
  readonly profile: MojangProfile;
  /** The game/library/natives/asset/JRE lock packages (no `version.json`). */
  readonly packages: readonly LockPackage[];
  /** The pinned JRE component id (e.g. `java-runtime-epsilon`). */
  readonly javaComponent: string;
  readonly javaMajorVersion: number;
}

export interface ResolveMojangInput {
  readonly minecraft: string;
  /** The profile id the client jar sits beside (loader id, or the mc version). */
  readonly profileId: string;
  readonly api: MojangApi;
}

/** Resolve the full vanilla Mojang install for one Minecraft version. */
export async function resolveMojang(input: ResolveMojangInput): Promise<MojangResolution> {
  const { minecraft, profileId, api } = input;
  const manifest = await api.versionManifest();
  const entry = manifest.versions.find((v) => v.id === minecraft);
  if (!entry) {
    throw new UnsatisfiableTarget(
      `minecraft ${minecraft}`,
      "no such version in the Mojang manifest",
    );
  }
  const profile = await api.profile(entry);
  const packages: LockPackage[] = [];

  // The client jar — placed beside its (possibly loader-flattened) profile.
  packages.push({
    name: "minecraft-client",
    kind: "game",
    source: "mojang",
    version: minecraft,
    hash: { algo: "sha1", value: profile.downloads.client.sha1 },
    provenance: "copy",
    placement: { method: "link", target: `versions/${profileId}/${profileId}.jar` },
    size: profile.downloads.client.size,
    url: profile.downloads.client.url,
  });

  // Libraries: plain jars (link into libraries/) and per-OS/arch natives (extract).
  for (const lib of profile.libraries) {
    const artifact = lib.downloads?.artifact;
    if (!artifact) {
      continue; // no downloadable artifact (e.g. a rules-only marker) — skip
    }
    const classifier = nativesClassifierOf(lib.name);
    if (classifier) {
      const target = nativesClassifierTarget(classifier);
      if (!target) {
        continue; // an arch/OS we don't map — never guess a wrong native
      }
      packages.push({
        name: lib.name,
        kind: "library",
        source: "mojang",
        hash: { algo: "sha1", value: artifact.sha1 },
        provenance: "copy",
        placement: { method: "extract", targetDir: NATIVES_DIR },
        targets: [target],
        size: artifact.size,
        url: artifact.url,
      });
    } else {
      const targets = libraryTargets(lib.rules);
      packages.push({
        name: lib.name,
        kind: "library",
        source: "mojang",
        hash: { algo: "sha1", value: artifact.sha1 },
        provenance: "copy",
        placement: { method: "link", target: `libraries/${artifact.path}` },
        ...(targets ? { targets } : {}),
        size: artifact.size,
        url: artifact.url,
      });
    }
  }

  // The asset index — pinned by sha1; its objects fan out at build time.
  packages.push({
    name: `assets-${profile.assets}`,
    kind: "game",
    source: "mojang",
    version: minecraft,
    hash: { algo: "sha1", value: profile.assetIndex.sha1 },
    provenance: "copy",
    placement: { method: "asset-tree", indexTarget: `assets/indexes/${profile.assets}.json` },
    size: profile.assetIndex.size,
    url: profile.assetIndex.url,
  });

  // The per-platform pinned JRE.
  const component = profile.javaVersion?.component ?? "java-runtime-gamma";
  const major = profile.javaVersion?.majorVersion ?? 21;
  const all = await api.javaRuntimeAll();
  for (const [platformKey, components] of Object.entries(all)) {
    const target = jrePlatformTarget(platformKey);
    if (!target) {
      continue; // gamecore / unmapped
    }
    const list = components[component];
    const jre = list?.[0];
    if (!jre) {
      continue; // this component is not published for this platform
    }
    packages.push({
      name: `java-runtime:${component}:${platformKey}`,
      kind: "java",
      source: "mojang",
      version: jre.version.name,
      hash: { algo: "sha1", value: jre.manifest.sha1 },
      provenance: "copy",
      placement: { method: "runtime-tree", targetDir: `runtime/${component}/${platformKey}` },
      targets: [target],
      size: jre.manifest.size,
      url: jre.manifest.url,
    });
  }

  return { profile, packages, javaComponent: component, javaMajorVersion: major };
}
