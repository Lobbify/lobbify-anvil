/**
 * The `import/` subsystem barrel — adopting a foreign pack format into a native
 * anvil instance. Stage 4 lands `.mrpack` (Modrinth modpack) import; CurseForge
 * zip and Prism import arrive in Stages 6–7.
 */

export type {
  ImportCfZipInput,
  ImportCfZipResult,
} from "./cfzip.js";
export { importCurseForgeZip } from "./cfzip.js";
export type {
  GamePinsForImport,
  ImportMrpackInput,
  ImportMrpackResult,
} from "./mrpack.js";
export { importMrpack } from "./mrpack.js";
export type { ImportOverrideTreeInput } from "./pack-common.js";
export { importOverrideTree, isUnsafePackPath, kindForPackPath } from "./pack-common.js";
export { readZipEntry } from "./zip-read.js";
