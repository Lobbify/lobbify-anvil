/**
 * The base-pack registry: source kind → the {@link BasePackSource} that resolves
 * a `game.from` ref of that kind.
 *
 * Two entries: Modrinth (`.mrpack`) and CurseForge (a pack zip). The resolver
 * knows only "look up the ref's source kind and ask it", so the two formats share
 * no code path beyond the {@link BasePackSource} contract — which is the point,
 * since they pin members in genuinely different ways (a `.mrpack` by URL + hash,
 * a CurseForge pack by `(projectID, fileID)` identity).
 */

import { RateLimitedHttp } from "../sources/http.js";
import { USER_AGENT } from "../sources/registry.js";
import type { SourceKind } from "../types/index.js";
import { CurseForgeBaseSource } from "./cf-base.js";
import { MrpackBaseSource } from "./mrpack-base.js";
import type { BasePackSource, BaseRegistry } from "./types.js";

export interface BuildBaseRegistryOptions {
  /** Modrinth API base-URL override (a mirror, or an offline fixture in tests). */
  readonly modrinthBaseUrl?: string;
  /** CurseForge API base-URL override (a mirror, or an offline fixture in tests). */
  readonly curseforgeBaseUrl?: string;
}

/** The default base-pack registry. */
export function buildBaseRegistry(options: BuildBaseRegistryOptions = {}): BaseRegistry {
  const map = new Map<SourceKind, { source: BasePackSource; http?: RateLimitedHttp }>();
  map.set("modrinth", {
    source: new MrpackBaseSource(
      options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {},
    ),
    http: new RateLimitedHttp({ userAgent: USER_AGENT }),
  });
  map.set("curseforge", {
    source: new CurseForgeBaseSource(
      options.curseforgeBaseUrl ? { baseUrl: options.curseforgeBaseUrl } : {},
    ),
    http: new RateLimitedHttp({ userAgent: USER_AGENT }),
  });
  return map;
}
