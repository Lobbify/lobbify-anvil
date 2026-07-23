/**
 * The `vc/` subsystem barrel — anvil's native version-control engine (Stage 5).
 *
 * A `.anvil/` object model (sha256-addressed blob / snapshot / commit objects,
 * zlib-compressed on disk but **hashed uncompressed** so commit ids are identical
 * across Node/OS), a ref database (HEAD / branches / tags / remotes / reflog /
 * packed-refs), generation-number ordering + LCA, and the item-set 3-way merge +
 * per-commit rebase — all driven through the {@link VcRepo}.
 */

export type {
  BlobObject,
  CarriedBlob,
  CommitObject,
  CommitOp,
  SnapshotObject,
  VcObject,
  VcObjectStoreOptions,
  VcObjectType,
} from "./objects.js";
export { encodeObject, idOf, idOfEncoding, VcObjectStore } from "./objects.js";
export type { HeadState, ReflogEntry } from "./refs.js";
export { Refs } from "./refs.js";
export type { LcaResult, LoadedCommit } from "./graph.js";
export { ancestors, findLca, isAncestor, nextGeneration } from "./graph.js";
export type { GameValue, ItemDelta, ItemEntry, ItemSet } from "./itemset.js";
export { buildItemSet, diffItemSets, gameValue, identityKeyOf } from "./itemset.js";
export type {
  Conflict,
  ConflictKind,
  ConflictStrategy,
  OnConflict,
  Resolution,
} from "./conflict.js";
export { describeConflict } from "./conflict.js";
export type { ResolutionPolicy, ThreeWayInput, ThreeWayResult } from "./merge.js";
export { threeWayMerge } from "./merge.js";
export type { BuildSnapshotInput, BuiltSnapshot, MaterializeInput } from "./snapshot.js";
export { buildSnapshot, materializeSnapshot } from "./snapshot.js";
export type { RebaseState } from "./rebase.js";
export {
  clearRebaseState,
  readRebaseState,
  rebaseInProgress,
  rebaseStateHashes,
  writeRebaseState,
} from "./rebase.js";
export type { VcReachability } from "./gc.js";
export { vcReachability } from "./gc.js";
export type {
  CommitRef,
  LogEntry,
  MergeOutcome,
  RebaseOutcome,
  RelockFn,
  RelockRequest,
  RevertOutcome,
  VcRepoOptions,
} from "./repo.js";
export { VcRepo } from "./repo.js";
