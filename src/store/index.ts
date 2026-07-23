/**
 * The `store/` subsystem barrel — the content-addressed object store, its
 * hashing/atomic-write/linking primitives, the placement executor, and the
 * hardened archive extractor.
 */

export { OBJECT_MODE, fsyncDir, sweepTmp, writeTemp } from "./atomic.js";
export {
  hashBuffer,
  hashEquals,
  hashFile,
  hashKey,
  hashStream,
  hashingTap,
  shardOf,
} from "./hash.js";
export type { LinkOptions } from "./linking.js";
export { DEFAULT_LINK_ORDER, linkOrCopy, sameVolume } from "./linking.js";
export type {
  AssetIndex,
  PlacementContext,
  PlacementOutcome,
  RuntimeFile,
  RuntimeManifest,
} from "./placement.js";
export {
  assetHashes,
  executePlacement,
  readAssetIndex,
  readRuntimeManifest,
  runtimeLeafHashes,
  targetsOf,
  treeLeaves,
} from "./placement.js";
export type { SafeExtractOptions } from "./safe-extract.js";
export { excludeMetaInf, safeExtract } from "./safe-extract.js";
export type {
  ContentStoreOptions,
  PutResult,
  StoreFsckResult,
  StoreGcOptions,
  StoreGcResult,
} from "./store.js";
export { ContentStore } from "./store.js";
