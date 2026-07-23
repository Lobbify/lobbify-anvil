/**
 * `resolveGame` — the top-level game-install resolution invoked at lock time.
 *
 * It walks Mojang for the vanilla install, optionally installs a Fabric/Quilt
 * loader, generates the canonical merged `version.json`, and returns the complete
 * set of game lock packages plus the `meta.java` component and resolved loader
 * label to fold into the lock. The one object it admits to the store at lock time
 * is the **generated** `version.json` (it exists nowhere to fetch); Quilt loader
 * jars are also admitted, since they must be downloaded to pin their sha256.
 */

import { hashBuffer } from "../store/index.js";
import { UnsatisfiableTarget } from "../types/errors.js";
import type { Http, LockPackage, ObjectSink } from "../types/index.js";
import { LoaderApi, type LoaderName, parseLoaderSpec, resolveLoader } from "./loader.js";
import { MojangApi, type MojangApiOptions, resolveMojang } from "./mojang.js";
import { type LauncherProfile, serializeVersionJson } from "./version-json.js";

/**
 * Whether a lock package belongs to the game install (as opposed to a manifest
 * item). Game kinds — `game` / `loader` / `library` / `java` — are produced only
 * by {@link resolveGame}; manifest items are `mod` / `resourcepack` / … So this
 * cleanly routes acquisition (game bytes → the Mojang/loader CDNs) and lets an
 * offline re-lock carry the prior game pins forward untouched.
 */
export function isGamePackage(pkg: LockPackage): boolean {
  return (
    pkg.kind === "game" || pkg.kind === "loader" || pkg.kind === "library" || pkg.kind === "java"
  );
}

export interface ResolveGameInput {
  readonly minecraft: string;
  /** The raw manifest loader string (`"fabric 0.19.3"`, `"vanilla"`, …). */
  readonly loader?: string;
  /** HTTP client for Mojang endpoints (keyless). */
  readonly mojangHttp: Http;
  /** HTTP client for loader meta + (unhashed) loader jar downloads. */
  readonly loaderHttp?: Http;
  /** Store sink for the generated `version.json` and any downloaded loader jars. */
  readonly store?: ObjectSink;
  /** Endpoint overrides (tests point these at recorded fixtures). */
  readonly mojangOptions?: MojangApiOptions;
  readonly loaderMetaBase?: string;
  /**
   * The concrete loader version to reuse when the manifest loader is unpinned
   * (`"fabric"` with no version) and this is a constrained re-lock — so a plain
   * `anvil lock` never silently bumps the loader (and its libs + version.json)
   * to the newest release without an `upgrade`. An explicit manifest pin wins.
   */
  readonly reuseLoaderVersion?: string;
}

export interface GameResolution {
  readonly packages: readonly LockPackage[];
  /** The pinned JRE component id → `meta.java`. */
  readonly java: string;
  /** The resolved loader label → `meta.loader` (`"fabric 0.19.3"` | `"vanilla"`). */
  readonly loader: string;
  /** The launch-profile id the instance is built under. */
  readonly profileId: string;
}

/** Resolve the full game install (vanilla + optional loader) for a manifest. */
export async function resolveGame(input: ResolveGameInput): Promise<GameResolution> {
  const parsed = parseLoaderSpec(input.loader);
  if (parsed.name === "neoforge" || parsed.name === "forge") {
    throw new UnsatisfiableTarget(
      `loader ${parsed.name}`,
      "NeoForge/Forge (installer processors are sandboxed) land in Stage 9",
    );
  }

  const mojangApi = new MojangApi(input.mojangHttp, input.mojangOptions ?? {});

  // Resolve the loader first (if any) so the client jar + version.json sit under
  // the flattened loader profile id.
  let loaderProfile: LauncherProfile | undefined;
  let loaderPackages: readonly LockPackage[] = [];
  let profileId = input.minecraft;
  let loaderLabel = "vanilla";
  if (parsed.name === "fabric" || parsed.name === "quilt") {
    const http = input.loaderHttp ?? input.mojangHttp;
    const api = new LoaderApi(http, parsed.name as LoaderName, input.loaderMetaBase);
    // Manifest pin wins; else reuse the prior lock's version (pin stability); else
    // resolve the newest stable.
    const loaderVersion = parsed.version ?? input.reuseLoaderVersion;
    const resolved = await resolveLoader({
      loader: parsed.name as LoaderName,
      ...(loaderVersion ? { loaderVersion } : {}),
      minecraft: input.minecraft,
      api,
      http,
      ...(input.store ? { store: input.store } : {}),
    });
    loaderProfile = resolved.profile;
    loaderPackages = resolved.packages;
    profileId = resolved.loaderId;
    loaderLabel = resolved.loaderLabel;
  }

  const mojang = await resolveMojang({ minecraft: input.minecraft, profileId, api: mojangApi });

  // Generate + pin the canonical merged version.json.
  const versionJson = serializeVersionJson({
    vanilla: mojang.profile as unknown as LauncherProfile,
    ...(loaderProfile ? { loader: loaderProfile } : {}),
    id: profileId,
  });
  const versionBytes = new TextEncoder().encode(versionJson);
  const versionHash = hashBuffer(versionBytes, "sha256");
  if (input.store) {
    await input.store.putBuffer(versionBytes, "sha256", versionHash);
  }
  const versionPkg: LockPackage = {
    name: "minecraft-version-json",
    kind: "game",
    source: "mojang",
    version: profileId,
    hash: versionHash,
    provenance: "copy",
    placement: { method: "link", target: `versions/${profileId}/${profileId}.json` },
    size: versionBytes.byteLength,
  };

  // Combine + dedup by name (a coordinate shared by vanilla and the loader — the
  // dup-ASM class — collapses to one lock entry; the loader's wins).
  const byName = new Map<string, LockPackage>();
  for (const pkg of [...mojang.packages, ...loaderPackages, versionPkg]) {
    byName.set(pkg.name, pkg);
  }

  return {
    packages: [...byName.values()],
    java: mojang.javaComponent,
    loader: loaderLabel,
    profileId,
  };
}
