/**
 * The `build/` subsystem barrel — the offline build pipeline, its incremental
 * planner, the journaled atomic swap + crash recovery, acquisition, preflight,
 * `.anvilignore`, path resolution, and the interim lock I/O.
 */

export type { Acquirer } from "./acquire.js";
export { FixtureAcquirer, StoreOnlyAcquirer } from "./acquire.js";
export { IgnoreSet, loadIgnoreSet, parseAnvilignore } from "./anvilignore.js";
export type { BuildDelta } from "./incremental.js";
export { diffLocks } from "./incremental.js";
export { LOCK_FILENAME, readInputLock, writeInputLock } from "./lock-io.js";
export type { ResolvedPaths } from "./paths.js";
export { resolvePaths } from "./paths.js";
export type { Platform, Rule } from "./preflight.js";
export { checkDiskSpace, currentPlatform, evaluateRules, filterByRules } from "./preflight.js";
export type { BuildEngineInput, BuildEngineResult } from "./pipeline.js";
export { buildInstance } from "./pipeline.js";
export { collectRoots, readBuiltLock, writeBuiltLock } from "./refs.js";
export { canonicalJson, deserializeLock, serializeLock } from "./serialize.js";
export type { SwapPlan } from "./swap.js";
export { hasPendingSwap, journaledSwap, recoverSwap } from "./swap.js";
