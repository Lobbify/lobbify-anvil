/**
 * `@lobbify/anvil` — public API.
 *
 * A reproducible, content-addressed build system for Minecraft instances
 * (git + docker + uv for `.minecraft`). Library-first: construct an {@link Anvil}
 * and call its methods; the CLI/TUI are thin skins over this surface.
 */

export { Anvil, ProgressBus } from "./src/anvil.js";
export type {
  BuildOptions,
  BuildResult,
  CommitRef,
  DiffResult,
  FsckResult,
  GcResult,
  LockOptions,
  MergeResult,
  PullResult,
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
