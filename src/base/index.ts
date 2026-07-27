/**
 * The `base/` subsystem barrel — `game.from`: resolving a base pack to a pinned
 * member set (`mrpack-base.ts` for Modrinth, `cf-base.ts` for CurseForge),
 * layering the instance's own items on top of it (`overlay.ts`, which owns the
 * precedence rules), and diffing two resolved sets (`diff.ts`).
 */

export {
  BASE_CACHE_FILENAME,
  baseCacheDocument,
  readBaseCache,
  writeBaseCache,
} from "./cache.js";
export type { CachedBase } from "./cache.js";
export { CurseForgeBaseSource } from "./cf-base.js";
export type { CurseForgeBaseSourceOptions } from "./cf-base.js";
export { diffMemberSets } from "./diff.js";
export type { MemberDelta, UpdatedMember } from "./diff.js";
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
