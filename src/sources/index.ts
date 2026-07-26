/**
 * The `sources/` subsystem barrel — the `Source` implementations (Modrinth / URL
 * / local, plus the CurseForge stub), the per-source rate-limited HTTP client,
 * the SSRF guard, kind inference, placement, the source registry + default
 * `allowSource` policy, and the build-time network acquirer.
 */

export { NetworkAcquirer } from "./acquire.js";
export type { NetworkAcquirerOptions } from "./acquire.js";
export {
  CF_MINECRAFT_GAME_ID,
  CF_RELATION,
  CurseForgeApi,
  CurseForgeSource,
  curseforgeFingerprint,
  replayDownloadReason,
} from "./curseforge.js";
export type { CurseForgeSourceOptions } from "./curseforge.js";
export { RateLimitedHttp } from "./http.js";
export type {
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  RateLimitedHttpOptions,
} from "./http.js";
export { inferKind, placementDirForKind } from "./kind.js";
export type { KindInferenceInput } from "./kind.js";
export { LocalSource } from "./local.js";
export { ModrinthApi, ModrinthSource } from "./modrinth.js";
export type { ModrinthSourceOptions } from "./modrinth.js";
export { declaredPlacementTarget, safeBasename, singleFilePlacement } from "./place.js";
export type { LinkPlacement } from "./place.js";
export {
  allowOnly,
  buildRegistry,
  defaultAllowSource,
  USER_AGENT,
} from "./registry.js";
export type { BuildRegistryOptions, SourceEntry, SourceRegistry } from "./registry.js";
export { ReplayAcquirer } from "./replay-acquire.js";
export type { ReplayAcquirerOptions } from "./replay-acquire.js";
export { assertHttpScheme, guardHop, isBlockedIp } from "./ssrf.js";
export { UrlSource } from "./url.js";
export { listZipEntries, looksLikeZip } from "./zip-introspect.js";
