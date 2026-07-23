/**
 * Forge / NeoForge loader resolution (Stage 9) — the lock-time half.
 *
 * Mirrors the Fabric/Quilt {@link resolveLoader} shape but for the installer-driven
 * loaders: resolve a version (pin | latest | recommended | omitted) against the
 * maven metadata (+ the Forge promotions feed), fetch the installer jar, parse its
 * `install_profile.json` + `version.json`, pin **every** library and processor jar
 * by sha256, extract each processor's `Main-Class`, and emit a canonical, pinned
 * {@link ForgePlan} the build replays under the processor sandbox.
 *
 * All network I/O goes through the SSRF-guarded {@link Http} (guard on by default);
 * the installer jar is only ever read entry-by-entry in memory (never extracted to
 * disk), so a hostile installer cannot zip-slip at lock time.
 */

import { readZipEntry } from "../import/zip-read.js";
import { guardHop } from "../sources/index.js";
import { hashBuffer } from "../store/hash.js";
import { UnsatisfiableTarget, UnsupportedInstaller } from "../types/errors.js";
import type { AllowProcessor, Hash, Http, LockPackage, ObjectSink } from "../types/index.js";
import {
  type ForgeBinding,
  type ForgePlan,
  type ForgeProcessorPlan,
  type InstallLibrary,
  type InstallProfile,
  classifyBinding,
  parseInstallProfile,
  parseLauncherProfile,
  serializeForgePlan,
} from "./forge-install.js";
import { denyAllProcessors } from "./forge-processors.js";
import { mavenPath } from "./platform.js";
import type { LauncherProfile } from "./version-json.js";

export type ForgeFlavor = "forge" | "neoforge";

const MAX_META_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 128 * 1024 * 1024;
const MAX_JAR_BYTES = 128 * 1024 * 1024;

/** Default maven / promotions endpoints per flavor (overridable for tests/mirrors). */
export interface ForgeEndpoints {
  readonly metadataUrl: string;
  readonly promotionsUrl?: string;
  /** Base repo URL the installer + libraries are fetched from. */
  readonly repoBaseUrl: string;
}

const FORGE_DEFAULTS: ForgeEndpoints = {
  metadataUrl: "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
  promotionsUrl: "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
  repoBaseUrl: "https://maven.minecraftforge.net/",
};
const NEOFORGE_DEFAULTS: ForgeEndpoints = {
  metadataUrl: "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
  repoBaseUrl: "https://maven.neoforged.net/releases/",
};

export function defaultForgeEndpoints(flavor: ForgeFlavor): ForgeEndpoints {
  return flavor === "forge" ? FORGE_DEFAULTS : NEOFORGE_DEFAULTS;
}

// --- version metadata ------------------------------------------------------

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
function decodeJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decodeText(bytes)) as T;
}

/** Extract every `<version>…</version>` from a maven-metadata.xml (no XML dep). */
export function parseMavenMetadataVersions(xml: string): string[] {
  const out: string[] = [];
  const re = /<version>([^<]+)<\/version>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const v = (m[1] ?? "").trim();
    if (v.length > 0) {
      out.push(v);
    }
  }
  return out;
}

/** A crude but stable numeric-segment version comparator (no semver assumptions). */
export function compareForgeVersions(a: string, b: string): number {
  const seg = (s: string): number[] => s.split(/[.\-+]/).map((p) => Number.parseInt(p, 10) || 0);
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The NeoForge version prefix a Minecraft version maps to (`1.21.1` → `21.1`). */
function neoforgeMcPrefix(mc: string): string {
  return mc.startsWith("1.") ? mc.slice(2) : mc;
}

/** Whether a raw metadata version belongs to the requested Minecraft version. */
function versionMatchesMc(flavor: ForgeFlavor, version: string, mc: string): boolean {
  if (flavor === "forge") {
    return version.startsWith(`${mc}-`);
  }
  const prefix = neoforgeMcPrefix(mc);
  return version === prefix || version.startsWith(`${prefix}.`);
}

/**
 * Resolve the concrete loader version for a spec (`pin | latest | recommended |
 * omitted`), filtered to the requested Minecraft version.
 */
export async function selectForgeVersion(
  flavor: ForgeFlavor,
  minecraft: string,
  spec: string | undefined,
  endpoints: ForgeEndpoints,
  http: Http,
): Promise<string> {
  const metaXml = decodeText(
    (await http.get(endpoints.metadataUrl, { maxBytes: MAX_META_BYTES })).body,
  );
  const all = parseMavenMetadataVersions(metaXml);
  const matching = all.filter((v) => versionMatchesMc(flavor, v, minecraft));

  // An explicit concrete pin (not a channel keyword).
  if (spec !== undefined && spec !== "latest" && spec !== "recommended") {
    if (!all.includes(spec)) {
      throw new UnsatisfiableTarget(`${flavor} ${spec}`, "no such version in the maven metadata");
    }
    if (!versionMatchesMc(flavor, spec, minecraft)) {
      throw new UnsatisfiableTarget(
        `${flavor} ${spec}`,
        `version ${spec} is not a build for Minecraft ${minecraft}`,
      );
    }
    return spec;
  }

  const channel = spec ?? "recommended";
  if (matching.length === 0) {
    throw new UnsatisfiableTarget(
      `${flavor} ${channel}`,
      `no ${flavor} build is published for Minecraft ${minecraft}`,
    );
  }

  // Forge: the promotions feed is authoritative for latest/recommended.
  if (flavor === "forge" && endpoints.promotionsUrl) {
    const promos = decodeJson<{ promos?: Record<string, string> }>(
      (await http.get(endpoints.promotionsUrl, { maxBytes: MAX_META_BYTES })).body,
    ).promos;
    const promo = promos?.[`${minecraft}-${channel}`] ?? promos?.[`${minecraft}-latest`];
    if (promo) {
      const full = `${minecraft}-${promo}`;
      if (all.includes(full)) {
        return full;
      }
    }
    // fall through to metadata-newest if the feed lacks this MC
  }

  const sorted = [...matching].sort(compareForgeVersions);
  if (channel === "recommended") {
    // "recommended" ≈ newest stable (skip -beta pre-releases when a stable exists).
    const stable = sorted.filter((v) => !/beta/i.test(v));
    const pick = (stable.length > 0 ? stable : sorted).at(-1);
    if (pick) {
      return pick;
    }
  }
  const newest = sorted.at(-1);
  if (!newest) {
    throw new UnsatisfiableTarget(`${flavor} ${channel}`, "the version list is empty");
  }
  return newest;
}

// --- installer parsing + pinning -------------------------------------------

/** The installer jar maven path for a resolved version. */
function installerPath(flavor: ForgeFlavor, version: string): string {
  return flavor === "forge"
    ? `net/minecraftforge/forge/${version}/forge-${version}-installer.jar`
    : `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
}

/** Join a base repo URL and a maven path with exactly one separating slash. */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/** Read `Main-Class` from a jar's manifest, or throw if it is not runnable. */
async function mainClassOf(jarBytes: Uint8Array, coordinate: string): Promise<string> {
  const mf = await readZipEntry(jarBytes, "META-INF/MANIFEST.MF");
  if (!mf) {
    throw new UnsupportedInstaller(coordinate, "processor jar has no META-INF/MANIFEST.MF");
  }
  const text = decodeText(mf).replace(/\r\n/g, "\n").replace(/\n /g, "");
  const m = text.match(/^Main-Class:\s*(\S+)\s*$/m);
  if (!m || !m[1]) {
    throw new UnsupportedInstaller(coordinate, "processor jar manifest declares no Main-Class");
  }
  return m[1];
}

interface PinnedLibrary {
  readonly coord: string;
  readonly hash: Hash;
  readonly path: string;
  readonly url?: string;
  readonly repo?: string;
}

/** Download a maven library and pin its sha256 (cross-checking any declared sha1). */
async function pinLibrary(
  lib: InstallLibrary,
  repoBaseUrl: string,
  http: Http,
  store: ObjectSink | undefined,
): Promise<PinnedLibrary> {
  const artifact = lib.downloads?.artifact;
  const path = artifact?.path ?? mavenPath(lib.name);
  const url = artifact?.url && artifact.url.length > 0 ? artifact.url : joinUrl(repoBaseUrl, path);
  const res = await http.get(url, { maxBytes: MAX_JAR_BYTES, guard: guardHop });
  const bytes = res.body;
  if (artifact?.sha1) {
    const actualSha1 = hashBuffer(bytes, "sha1");
    if (actualSha1.value !== artifact.sha1) {
      throw new UnsupportedInstaller(
        lib.name,
        `library sha1 mismatch (declared ${artifact.sha1}, got ${actualSha1.value})`,
      );
    }
  }
  const hash = hashBuffer(bytes, "sha256");
  if (store) {
    await store.putBuffer(bytes, "sha256", hash);
  }
  return {
    coord: lib.name,
    hash,
    path,
    url,
    ...(hostOf(url) ? { repo: hostOf(url) } : {}),
  };
}

export interface ResolveForgeInput {
  readonly flavor: ForgeFlavor;
  /** `pin` | `latest` | `recommended` | undefined (→ recommended). */
  readonly loaderVersion?: string;
  readonly minecraft: string;
  readonly http: Http;
  readonly store?: ObjectSink;
  readonly endpoints?: ForgeEndpoints;
  /** Host-app consent for non-allowlisted processors (default deny). */
  readonly allowProcessor?: AllowProcessor;
}

export interface ForgeResolution {
  /** The launch profile id the instance is built under. */
  readonly profileId: string;
  /** The human loader label (`"neoforge 21.1.66"`). */
  readonly loaderLabel: string;
  /** The Forge/NeoForge launch profile (merged with vanilla by the caller). */
  readonly profile: LauncherProfile;
  /** The installer, toolchain, and game-library lock packages (no plan yet). */
  readonly packages: readonly LockPackage[];
  /**
   * Finalize the pinned install plan once the caller knows the vanilla client hash
   * and JRE component (resolved via Mojang under this profile id). Returns the
   * `forge-build` lock package (its object is the canonical plan blob).
   */
  finalizePlan(clientInput: Hash, jreComponent: string): Promise<LockPackage>;
}

/** Resolve a Forge/NeoForge loader: pin its installer/libraries/processors + plan. */
export async function resolveForge(input: ResolveForgeInput): Promise<ForgeResolution> {
  const { flavor, minecraft, http, store } = input;
  const endpoints = input.endpoints ?? defaultForgeEndpoints(flavor);
  const consent = input.allowProcessor ?? denyAllProcessors;

  const version = await selectForgeVersion(flavor, minecraft, input.loaderVersion, endpoints, http);

  // Fetch + pin the installer jar; read its two profile entries in memory.
  const installerUrl = joinUrl(endpoints.repoBaseUrl, installerPath(flavor, version));
  const installerBytes = (await http.get(installerUrl, { maxBytes: MAX_INSTALLER_BYTES })).body;
  const installerHash = hashBuffer(installerBytes, "sha256");
  if (store) {
    await store.putBuffer(installerBytes, "sha256", installerHash);
  }
  const installProfileBytes = await readZipEntry(installerBytes, "install_profile.json");
  const versionJsonBytes = await readZipEntry(installerBytes, "version.json");
  if (!installProfileBytes || !versionJsonBytes) {
    throw new UnsupportedInstaller(
      `${flavor} ${version}`,
      "installer is missing install_profile.json / version.json",
    );
  }
  const install: InstallProfile = parseInstallProfile(installProfileBytes);
  const launcher: LauncherProfile = parseLauncherProfile(versionJsonBytes);
  const profileId = launcher.id ?? `${flavor}-${version}`;

  // Pin the installer-side toolchain libraries (the processor classpath).
  const toolchain = new Map<string, PinnedLibrary>();
  for (const lib of install.libraries ?? []) {
    if (!lib.name || toolchain.has(lib.name)) {
      continue;
    }
    toolchain.set(lib.name, await pinLibrary(lib, endpoints.repoBaseUrl, http, store));
  }

  // The game libraries from version.json: those WITH a download url are fetched +
  // pinned (link placement); those without are the processor-produced outputs.
  const gameLibs: PinnedLibrary[] = [];
  const outputCoords = new Set<string>();
  const outputPaths = new Set<string>();
  for (const lib of (launcher.libraries ?? []) as unknown as InstallLibrary[]) {
    if (!lib.name) {
      continue;
    }
    const url = lib.downloads?.artifact?.url;
    if (url && url.length > 0) {
      gameLibs.push(await pinLibrary(lib, endpoints.repoBaseUrl, http, store));
    } else {
      outputCoords.add(lib.name);
      outputPaths.add(`libraries/${mavenPath(lib.name)}`);
    }
  }

  // Normalize the data bindings (client side).
  const hasLibrary = (coord: string): boolean =>
    toolchain.has(coord) || gameLibs.some((l) => l.coord === coord);
  const bindings: Record<string, ForgeBinding> = {};
  const installerEntries = new Set<string>();
  for (const [key, entry] of Object.entries(install.data ?? {})) {
    const value = entry.client;
    if (value === undefined) {
      continue; // no client-side value → not needed for a client build
    }
    const binding = classifyBinding(value, outputCoords, hasLibrary);
    bindings[key] = binding;
    if (binding.kind === "installerFile") {
      installerEntries.add(binding.entry);
    }
    if (binding.kind === "output") {
      outputPaths.add(binding.path);
    }
  }

  // Normalize the client-side processors, pinning + trust-recording each jar.
  const processors: ForgeProcessorPlan[] = [];
  for (const proc of install.processors ?? []) {
    if (proc.sides && !proc.sides.includes("client")) {
      continue; // server-only processor — not part of a client build
    }
    const toolLib = toolchain.get(proc.jar);
    if (!toolLib) {
      throw new UnsupportedInstaller(
        proc.jar,
        "processor jar is not among the installer libraries (cannot pin it)",
      );
    }
    // Re-fetch the (already store-admitted) processor jar bytes to read Main-Class.
    const jarBytes = (
      await http.get(toolLib.url ?? joinUrl(endpoints.repoBaseUrl, toolLib.path), {
        maxBytes: MAX_JAR_BYTES,
        guard: guardHop,
      })
    ).body;
    const mainClass = await mainClassOf(jarBytes, proc.jar);
    const outs = outputsOfProcessor(proc, bindings);
    processors.push({
      coordinate: proc.jar,
      ...(toolLib.repo ? { repo: toolLib.repo } : {}),
      jar: toolLib.hash,
      mainClass,
      classpath: proc.classpath ?? [],
      args: proc.args ?? [],
      outputs: outs,
    });
  }

  const librariesMap: Record<string, { hash: Hash; path: string }> = {};
  for (const lib of [...toolchain.values(), ...gameLibs]) {
    librariesMap[lib.coord] = { hash: lib.hash, path: lib.path };
  }

  // The lock packages resolveForge itself contributes (the plan lands in finalize).
  const packages: LockPackage[] = [];
  packages.push({
    name: `${flavor}-installer-${version}`,
    kind: "loader",
    source: "url",
    version,
    hash: installerHash,
    provenance: "copy",
    placement: { method: "store-only" },
    size: installerBytes.byteLength,
    url: installerUrl,
  });
  for (const lib of toolchain.values()) {
    packages.push({
      name: lib.coord,
      kind: "library",
      source: "url",
      hash: lib.hash,
      provenance: "copy",
      placement: { method: "store-only" },
      ...(lib.url ? { url: lib.url } : {}),
    });
  }
  for (const lib of gameLibs) {
    packages.push({
      name: lib.coord,
      kind: isLoaderJar(flavor, lib.coord) ? "loader" : "library",
      source: "url",
      hash: lib.hash,
      provenance: "copy",
      placement: { method: "link", target: `libraries/${lib.path}` },
      ...(lib.url ? { url: lib.url } : {}),
    });
  }

  const sortedOutputs = [...outputPaths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const finalizePlan = async (clientInput: Hash, jreComponent: string): Promise<LockPackage> => {
    const plan: ForgePlan = {
      flavor,
      minecraft,
      profileId,
      jreComponent,
      clientInput,
      installer: installerHash,
      installerEntries: [...installerEntries].sort(),
      libraries: librariesMap,
      bindings,
      processors,
      outputs: sortedOutputs,
    };
    const planBytes = new TextEncoder().encode(serializeForgePlan(plan));
    const planHash = hashBuffer(planBytes, "sha256");
    if (store) {
      await store.putBuffer(planBytes, "sha256", planHash);
    }
    return {
      name: `${flavor}-install-plan-${version}`,
      kind: "loader",
      source: "url",
      version,
      hash: planHash,
      provenance: "copy",
      placement: { method: "forge-build", outputs: sortedOutputs },
      size: planBytes.byteLength,
    };
  };

  return {
    profileId,
    loaderLabel: `${flavor} ${version}`,
    profile: launcher,
    packages,
    finalizePlan,
  };
}

function isLoaderJar(flavor: ForgeFlavor, coord: string): boolean {
  return flavor === "forge"
    ? coord.startsWith("net.minecraftforge:forge:")
    : coord.startsWith("net.neoforged:neoforge:");
}

/** The instance-relative output paths a processor writes (from its args' data tokens). */
function outputsOfProcessor(
  proc: { readonly args?: readonly string[]; readonly outputs?: Readonly<Record<string, string>> },
  bindings: Readonly<Record<string, ForgeBinding>>,
): string[] {
  const out = new Set<string>();
  const tokens = [...(proc.args ?? []), ...Object.keys(proc.outputs ?? {})];
  for (const token of tokens) {
    if (token.startsWith("{") && token.endsWith("}")) {
      const binding = bindings[token.slice(1, -1)];
      if (binding?.kind === "output") {
        out.add(binding.path);
      }
    }
  }
  return [...out].sort();
}
