/**
 * The `export/` subsystem barrel — `.mrpack` export (Stage 7). A built anvil
 * instance is written back out as a portable Modrinth modpack: copy items become
 * `files[]`, local items become `overrides/`, and CurseForge replay items are
 * omitted with a clear warning (the CF ToS forbids re-hosting their bytes). Reads
 * go through `yauzl`; this subsystem owns the (dependency-free, deterministic) zip
 * *writer*.
 */

export type { ExportMrpackInput, ExportMrpackResult } from "./mrpack-export.js";
export { exportMrpack } from "./mrpack-export.js";
export type { ZipEntry } from "./zip-write.js";
export { writeZip } from "./zip-write.js";
