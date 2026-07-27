/**
 * The base-pack registry: source kind → the {@link BasePackSource} that resolves
 * a `game.from` ref of that kind.
 *
 * One entry today (Modrinth `.mrpack`). CurseForge is LB-708 and slots in beside
 * it without touching the resolver, which knows only "look up the ref's source
 * kind and ask it".
 */

import { RateLimitedHttp } from "../sources/http.js";
import { USER_AGENT } from "../sources/registry.js";
import type { SourceKind } from "../types/index.js";
import { MrpackBaseSource } from "./mrpack-base.js";
import type { BasePackSource, BaseRegistry } from "./types.js";

export interface BuildBaseRegistryOptions {
  /** Modrinth API base-URL override (a mirror, or an offline fixture in tests). */
  readonly modrinthBaseUrl?: string;
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
  return map;
}
