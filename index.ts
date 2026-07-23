/**
 * `@lobbify/anvil` — public API.
 *
 * A reproducible, content-addressed build system for Minecraft instances
 * (git + docker + uv for `.minecraft`). Library-first: construct an {@link Anvil}
 * and call its methods; the CLI/TUI are thin skins over this surface.
 */

export { Anvil, ProgressBus } from "./src/anvil.js";
export type {
  AnvilEnv,
  BuildOptions,
  BuildResult,
  CloneOptions,
  CloneResult,
  ExportResult,
  FsckResult,
  GcResult,
  ImportSummary,
  InitSpec,
  LockDiff,
  LockDiffEntry,
  LockOptions,
  MergeOptions,
  MergeResult,
  PullResult,
  PushResult,
  RebaseOptions,
  RebaseResult,
  RevertResult,
  StatusResult,
  VerifyOptions,
  VerifyResult,
} from "./src/anvil.js";

export type {
  AnvilEvent,
  AnvilEventType,
  BuildPhase,
  LinkStrategy,
  ProgressListener,
} from "./src/events.js";

export * from "./src/types/index.js";

// Stage 1 — the content store + atomic build engine.
export * from "./src/store/index.js";
export * from "./src/build/index.js";

// Stage 2 — the manifest, sources, resolver, and canonical lock writer.
export * from "./src/manifest/index.js";
export * from "./src/sources/index.js";
export * from "./src/resolver/index.js";
export * from "./src/lock/index.js";

// Stage 3 — the full game installer (Mojang + Fabric/Quilt).
export * from "./src/game/index.js";

// Stage 4 — `.mrpack` import (the thin CLI ships as the `lobbify-anvil` bin).
export * from "./src/import/index.js";

// Stage 7 — remotes (clone/pull/push), `.mrpack` export, Prism import.
export * from "./src/remote/index.js";
export * from "./src/export/index.js";

// Stage 5 — the anvil-native version-control engine (commit/branch/merge/rebase).
export type {
  CarriedBlob,
  CommitObject,
  CommitOp,
  CommitRef,
  Conflict,
  ConflictKind,
  ConflictStrategy,
  ItemDelta,
  ItemEntry,
  ItemSet,
  LogEntry,
  MergeOutcome,
  OnConflict,
  RebaseOutcome,
  RebaseState,
  RelockFn,
  RelockRequest,
  Resolution,
  RevertOutcome,
  SnapshotObject,
  VcObject,
} from "./src/vc/index.js";
export {
  ancestors,
  describeConflict,
  diffItemSets,
  encodeObject,
  findLca,
  idOf,
  idOfEncoding,
  isAncestor,
  nextGeneration,
  Refs,
  VcObjectStore,
  VcRepo,
} from "./src/vc/index.js";
