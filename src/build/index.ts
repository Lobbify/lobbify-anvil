/**
 * The `build/` subsystem barrel — the offline build pipeline, its incremental
 * planner, the journaled atomic swap + crash recovery, acquisition, preflight,
 * `.anvilignore`, path resolution, and the built-ref JSON. The user-facing
 * `anvil.lock` I/O lives in `src/lock/` (canonical TOML) from Stage 2.
 */

export type { Acquirer } from "./acquire.js";
export { FixtureAcquirer, StoreOnlyAcquirer } from "./acquire.js";
export { IgnoreSet, loadIgnoreSet, parseAnvilignore } from "./anvilignore.js";
export type { DependencyGraph, WhyResult } from "./graph.js";
export { readGraph, whyChains, writeGraph } from "./graph.js";
export type { BuildDelta } from "./incremental.js";
export { diffLocks } from "./incremental.js";
export type { ResolvedPaths } from "./paths.js";
export { resolvePaths } from "./paths.js";
export type { Platform, Rule } from "./preflight.js";
export {
  assertNativesSatisfiable,
  checkDiskSpace,
  currentPlatform,
  evaluateRules,
  filterByRules,
  filterByTargets,
  packageAppliesToPlatform,
} from "./preflight.js";
export type { BuildEngineInput, BuildEngineResult } from "./pipeline.js";
export { buildInstance } from "./pipeline.js";
export { collectRoots, readBuiltLock, writeBuiltLock } from "./refs.js";
export { canonicalJson } from "./serialize.js";
export type { SwapPlan } from "./swap.js";
export { hasPendingSwap, journaledSwap, recoverSwap } from "./swap.js";
