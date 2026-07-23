/**
 * The `game/` subsystem barrel — the Mojang installer walk, the Fabric/Quilt
 * loader install, the canonical merged `version.json` generator, the top-level
 * `resolveGame` (invoked at lock time), and the build-time `GameAcquirer`.
 */

export { GameAcquirer } from "./acquire.js";
export type { GameAcquirerOptions } from "./acquire.js";
export {
  joinMavenUrl,
  LoaderApi,
  type LoaderName,
  type LoaderResolution,
  parseLoaderSpec,
  type ParsedLoader,
  resolveLoader,
  type ResolveLoaderInput,
} from "./loader.js";
export {
  MojangApi,
  type MojangApiOptions,
  type MojangLibrary,
  type MojangProfile,
  type MojangResolution,
  NATIVES_DIR,
  resolveMojang,
  type ResolveMojangInput,
} from "./mojang.js";
export {
  currentTarget,
  jrePlatformTarget,
  mavenGroupArtifact,
  mavenPath,
  nativesClassifierOf,
  nativesClassifierTarget,
} from "./platform.js";
export {
  type GameResolution,
  isGamePackage,
  resolveGame,
  type ResolveGameInput,
} from "./resolve-game.js";
export {
  buildVersionProfile,
  type BuildVersionJsonInput,
  type LauncherProfile,
  mergeLibraries,
  type ProfileLibrary,
  serializeVersionJson,
} from "./version-json.js";
