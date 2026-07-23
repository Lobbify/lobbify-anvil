/**
 * The `manifest/` subsystem barrel — the `anvil.toml` parser/serializer and the
 * reference + version-spec grammar the resolver consumes.
 */

export { MANIFEST_FILENAME, parseManifest, readManifest } from "./parse.js";
export { formatVersionSpec, parseRef, parseVersionSpec, refForItem, refKey } from "./ref.js";
export { formatRef, serializeManifest, writeManifest } from "./serialize.js";
