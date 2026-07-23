/**
 * Parsing of the modern Forge/NeoForge installer, and the canonical **install plan**
 * anvil pins in the lock and replays at build time.
 *
 * A modern installer (Forge ≥ 1.13, all NeoForge) is a jar carrying:
 *   - `install_profile.json` — the processor DAG (`processors`), the `data` bindings
 *     they consume, and the installer-side `libraries` (the processor toolchain);
 *   - `version.json` — the launch profile (inheritsFrom vanilla, mainClass, the game
 *     `libraries`, arguments), merged with vanilla exactly like a Fabric loader.
 *
 * We refuse (with a typed {@link UnsupportedInstaller}) a legacy pre-profile
 * installer or one whose `spec`/layout we do not implement, rather than half-build.
 *
 * The {@link ForgePlan} is the normalized, host-independent replay of that installer:
 * every input is named by content hash, every `data` binding is classified into a
 * concrete kind, and the produced outputs are the instance-relative library paths
 * the processors write. It is serialized canonically (so it is byte-stable
 * and pins like any object) and read back by the build-time executor.
 */

import { canonicalJson } from "../build/serialize.js";
import { UnsupportedInstaller } from "../types/errors.js";
import type { Hash } from "../types/index.js";
import { mavenPath } from "./platform.js";
import type { LauncherProfile } from "./version-json.js";

// --- install_profile.json shapes (only the fields we read) -----------------

/** A `data` value's per-side entries (we build client instances → read `client`). */
export interface InstallDataEntry {
  readonly client?: string;
  readonly server?: string;
}

export interface InstallProcessor {
  /** The processor jar's maven coordinate. */
  readonly jar: string;
  /** Additional classpath coordinates (the jar itself is implied). */
  readonly classpath?: readonly string[];
  /** Program arguments (carry `{DATA}` / `[coord]` / `{MINECRAFT_JAR}` tokens). */
  readonly args?: readonly string[];
  /** Sides this processor runs on (absent → both). We keep client-side ones. */
  readonly sides?: readonly string[];
  /** Declared outputs (`{DATA_KEY}` → expected sha). */
  readonly outputs?: Readonly<Record<string, string>>;
}

export interface InstallLibrary {
  readonly name: string;
  readonly downloads?: {
    readonly artifact?: {
      readonly path?: string;
      readonly url?: string;
      readonly sha1?: string;
      readonly size?: number;
    };
  };
}

export interface InstallProfile {
  readonly spec?: number;
  readonly profile?: string;
  readonly version?: string;
  readonly minecraft?: string;
  readonly data?: Readonly<Record<string, InstallDataEntry>>;
  readonly processors?: readonly InstallProcessor[];
  readonly libraries?: readonly InstallLibrary[];
}

function decodeJson<T>(bytes: Uint8Array, subject: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (err) {
    throw new UnsupportedInstaller(
      subject,
      `${subject} is not valid JSON (${(err as Error).message})`,
    );
  }
}

/** Parse + validate an `install_profile.json`, refusing an unsupported layout. */
export function parseInstallProfile(bytes: Uint8Array): InstallProfile {
  const profile = decodeJson<InstallProfile>(bytes, "install_profile.json");
  if (profile.spec !== undefined && profile.spec !== 0 && profile.spec !== 1) {
    throw new UnsupportedInstaller(
      "install_profile.json",
      `unsupported install-profile spec ${profile.spec} (only spec 0/1 modern installers are supported)`,
    );
  }
  if (!Array.isArray(profile.processors) || !Array.isArray(profile.libraries)) {
    throw new UnsupportedInstaller(
      "install_profile.json",
      "missing `processors`/`libraries` — this looks like a legacy (pre-1.13) installer, which is not supported",
    );
  }
  return profile;
}

/** Parse the bundled `version.json` launch profile. */
export function parseLauncherProfile(bytes: Uint8Array): LauncherProfile {
  return decodeJson<LauncherProfile>(bytes, "version.json");
}

// --- the normalized, pinned install plan -----------------------------------

/** How a `data` binding (or arg token) resolves at build time. */
export type ForgeBinding =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "installerFile"; readonly entry: string }
  | { readonly kind: "library"; readonly coord: string }
  | { readonly kind: "output"; readonly path: string };

/** One processor, fully normalized for deterministic replay. */
export interface ForgeProcessorPlan {
  readonly coordinate: string;
  /** The maven host the jar was resolved from (part of the trust decision). */
  readonly repo?: string;
  /** The processor jar's sha256 pin. */
  readonly jar: Hash;
  /** `Main-Class` extracted from the jar manifest at lock time. */
  readonly mainClass: string;
  /** Classpath coordinates (each present in {@link ForgePlan.libraries}). */
  readonly classpath: readonly string[];
  /** Program args with tokens intact (resolved against `bindings` at build). */
  readonly args: readonly string[];
  /** Instance-relative library paths this processor produces (⊆ plan outputs). */
  readonly outputs: readonly string[];
}

/**
 * The complete, canonical, host-independent replay of a Forge/NeoForge installer.
 * Every input is content-addressed; the outputs are declared so the atomic swap and
 * incremental delta treat the produced files as ordinary targets.
 */
export interface ForgePlan {
  readonly flavor: "forge" | "neoforge";
  readonly minecraft: string;
  readonly profileId: string;
  /** The pinned per-platform JRE component (processors reuse its `java`). */
  readonly jreComponent: string;
  /** The vanilla client jar (sha1) — processors read it as `{MINECRAFT_JAR}`. */
  readonly clientInput: Hash;
  /** The installer jar (sha256) — embedded `/data/*` files are extracted from it. */
  readonly installer: Hash;
  /** Installer entries (`data/…`) referenced by an `installerFile` binding. */
  readonly installerEntries: readonly string[];
  /** coord → { sha256 pin, instance-relative `libraries/…` path }. */
  readonly libraries: Readonly<Record<string, { readonly hash: Hash; readonly path: string }>>;
  /** `data` key → its classified binding (client side). */
  readonly bindings: Readonly<Record<string, ForgeBinding>>;
  readonly processors: readonly ForgeProcessorPlan[];
  /** Every instance-relative path the processors produce (== placement outputs). */
  readonly outputs: readonly string[];
}

/** Serialize an install plan to its canonical, byte-stable JSON form. */
export function serializeForgePlan(plan: ForgePlan): string {
  return canonicalJson(plan);
}

/** Parse an install plan blob back into a {@link ForgePlan}. */
export function parseForgePlan(bytes: Uint8Array): ForgePlan {
  return JSON.parse(new TextDecoder().decode(bytes)) as ForgePlan;
}

// --- binding / token classification (shared by lock + build) ---------------

/** Strip a Forge data literal's single quotes (`'x'` → `x`); leave others intact. */
function stripQuotes(value: string): string | undefined {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return undefined;
}

/** True when a token is a `[maven:coordinate]` reference. */
export function isCoordToken(token: string): boolean {
  return token.startsWith("[") && token.endsWith("]");
}

/** The coordinate inside a `[maven:coordinate]` token (drops any `@ext`). */
export function coordOfToken(token: string): string {
  const inner = token.slice(1, -1);
  const at = inner.indexOf("@");
  return at === -1 ? inner : inner.slice(0, at);
}

/**
 * The instance-relative `libraries/…` path a produced-output coordinate lands at.
 * Honors a `@ext` on a `[coord@ext]` token (e.g. `@txt` mappings) but defaults to
 * a `.jar`.
 */
export function outputPathForCoord(coordToken: string): string {
  const inner = coordToken.startsWith("[") ? coordToken.slice(1, -1) : coordToken;
  const at = inner.indexOf("@");
  const coord = at === -1 ? inner : inner.slice(0, at);
  const ext = at === -1 ? "jar" : inner.slice(at + 1);
  const base = mavenPath(coord);
  return `libraries/${ext === "jar" ? base : base.replace(/\.jar$/, `.${ext}`)}`;
}

/**
 * Classify one `data` client value into a {@link ForgeBinding}. `outputs` is the set
 * of coordinates the processors produce (so a `[coord]` that names a produced lib is
 * an `output`, not an input `library`). `hasLibrary` reports whether a coordinate is
 * a fetched/pinned library. Anything else is an installer-embedded file or a literal.
 */
export function classifyBinding(
  value: string,
  outputs: ReadonlySet<string>,
  hasLibrary: (coord: string) => boolean,
): ForgeBinding {
  const literal = stripQuotes(value);
  if (literal !== undefined) {
    return { kind: "literal", value: literal };
  }
  if (isCoordToken(value)) {
    const coord = coordOfToken(value);
    if (outputs.has(coord)) {
      return { kind: "output", path: outputPathForCoord(value) };
    }
    if (hasLibrary(coord)) {
      return { kind: "library", coord };
    }
    throw new UnsupportedInstaller(
      "install_profile.json",
      `data binding "[${coord}]" names neither a pinned library nor a produced output`,
    );
  }
  if (value.startsWith("/")) {
    return { kind: "installerFile", entry: value.replace(/^\/+/, "") };
  }
  return { kind: "literal", value };
}
