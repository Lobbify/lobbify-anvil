/**
 * The `game/` subsystem barrel — the Mojang installer walk, the Fabric/Quilt
 * loader install, the canonical merged `version.json` generator, the top-level
 * `resolveGame` (invoked at lock time), and the build-time `GameAcquirer`.
 */

export { GameAcquirer } from "./acquire.js";
export type { GameAcquirerOptions } from "./acquire.js";
export { runForgeProcessors } from "./forge-build.js";
export type { RunForgeProcessorsInput } from "./forge-build.js";
export {
  classifyBinding,
  coordOfToken,
  isCoordToken,
  outputPathForCoord,
  parseForgePlan,
  parseInstallProfile,
  parseLauncherProfile,
  serializeForgePlan,
} from "./forge-install.js";
export type {
  ForgeBinding,
  ForgePlan,
  ForgeProcessorPlan,
  InstallLibrary,
  InstallProcessor,
  InstallProfile,
} from "./forge-install.js";
export {
  admitProcessor,
  assertPathWithinRoots,
  assertSandboxPolicy,
  buildExecSpec,
  DEFAULT_SANDBOX_LIMITS,
  denyAllProcessors,
  isOfficialProcessor,
  SandboxedJvmRunner,
  TRUSTED_MAVEN_HOSTS,
  TRUSTED_PROCESSOR_GROUPS,
} from "./forge-processors.js";
export type {
  BuildExecSpecInput,
  ProcessorAdmissionInput,
  ProcessorExecSpec,
  ProcessorRunner,
  ProcessorRunResult,
  SandboxedJvmRunnerOptions,
  SandboxLimits,
  SandboxSpawn,
  SandboxStrategy,
} from "./forge-processors.js";
export {
  compareForgeVersions,
  defaultForgeEndpoints,
  parseMavenMetadataVersions,
  resolveForge,
  selectForgeVersion,
} from "./forge.js";
export type {
  ForgeEndpoints,
  ForgeFlavor,
  ForgeResolution,
  ResolveForgeInput,
} from "./forge.js";
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
