/**
 * The `base/` subsystem barrel — `game.from`: resolving a base pack to a pinned
 * member set (`mrpack-base.ts`), and layering the instance's own items on top of
 * it (`overlay.ts`, which owns the precedence rules).
 */

export {
  BASE_CACHE_FILENAME,
  baseCacheDocument,
  readBaseCache,
  writeBaseCache,
} from "./cache.js";
export type { CachedBase } from "./cache.js";
export { BASE_TRACKED_SUBDIR, MrpackBaseSource } from "./mrpack-base.js";
export type { MrpackBaseSourceOptions } from "./mrpack-base.js";
export { baseSetDigest, linkTargetOf, overlayBase } from "./overlay.js";
export type {
  MatchAxis,
  OverlayInput,
  OverlayResult,
  OverrideRecord,
  RemovalRecord,
} from "./overlay.js";
export { buildBaseRegistry } from "./registry.js";
export type {
  BasePackSource,
  BaseRegistry,
  BaseResolveContext,
  ResolvedBasePack,
} from "./types.js";
