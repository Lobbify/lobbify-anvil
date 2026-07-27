/**
 * The typed progress-event taxonomy emitted on the `Anvil` progress bus.
 *
 * Every event is a discriminated union member keyed by `type`. The CLI and TUI
 * are pure consumers of this bus — they contain no logic, only rendering. Group
 * prefixes (`resolve:`, `transfer:`, `object:`, `replay:`, `build:`, `pull:`,
 * `verify:`, `error`) let a consumer filter by phase.
 */

import type { Hash, Placement } from "./types/index.js";

/** The link strategy the store chose for an object (best → worst). */
export type LinkStrategy = "reflink" | "hardlink" | "symlink" | "copy";

// --- resolve:* — manifest → fully-pinned lock -----------------------------

export interface ResolveStartEvent {
  readonly type: "resolve:start";
  readonly items: number;
}
export interface ResolveItemEvent {
  readonly type: "resolve:item";
  readonly name: string;
  readonly index: number;
  readonly total: number;
}
export interface ResolveDoneEvent {
  readonly type: "resolve:done";
  readonly pinned: number;
}

// --- transfer:plan — the object transfer plan for a build/pull ------------

export interface TransferPlanEvent {
  readonly type: "transfer:plan";
  /** Objects that must be obtained (store misses). */
  readonly objects: number;
  /** Total bytes to transfer, when known. */
  readonly bytes: number;
}

// --- object:* — content-store fetch / store / link ------------------------

export interface ObjectFetchEvent {
  readonly type: "object:fetch";
  readonly hash: Hash;
  readonly received: number;
  readonly total?: number;
}
export interface ObjectStoreEvent {
  readonly type: "object:store";
  readonly hash: Hash;
  /** True when the object already existed (dedup on collision). */
  readonly deduped: boolean;
}
export interface ObjectLinkEvent {
  readonly type: "object:link";
  readonly hash: Hash;
  readonly placement: Placement;
  readonly strategy: LinkStrategy;
}

// --- replay:* — CurseForge per-client re-fetch (never re-hosted) ----------

export interface ReplayStartEvent {
  readonly type: "replay:start";
  readonly name: string;
}
export interface ReplayFetchEvent {
  readonly type: "replay:fetch";
  readonly name: string;
  readonly received: number;
  readonly total?: number;
}
export interface ReplayDoneEvent {
  readonly type: "replay:done";
  readonly name: string;
}

// --- build:* — preflight → acquire → stage → verify → atomic swap ---------

export type BuildPhase = "preflight" | "acquire" | "stage" | "verify" | "swap";

export interface BuildStartEvent {
  readonly type: "build:start";
  readonly stageId: string;
}
export interface BuildStageEvent {
  readonly type: "build:stage";
  readonly phase: BuildPhase;
}
export interface BuildSwapEvent {
  readonly type: "build:swap";
  readonly stageId: string;
}
export interface BuildDoneEvent {
  readonly type: "build:done";
  readonly dir: string;
}

// --- pull:* — content-addressed fast-forward sync -------------------------

export interface PullStartEvent {
  readonly type: "pull:start";
  readonly remote: string;
}
export interface PullObjectEvent {
  readonly type: "pull:object";
  readonly hash: Hash;
  readonly index: number;
  readonly total: number;
}
export interface PullDoneEvent {
  readonly type: "pull:done";
  readonly fastForwarded: number;
}

// --- verify:* — instance ⇄ lock reconciliation ---------------------------

export interface VerifyStartEvent {
  readonly type: "verify:start";
  readonly items: number;
}
export interface VerifyItemEvent {
  readonly type: "verify:item";
  readonly name: string;
  readonly ok: boolean;
}
export interface VerifyDoneEvent {
  readonly type: "verify:done";
  readonly ok: boolean;
  readonly mismatches: number;
}

// --- warning — something was skipped, and you should know ----------------

/**
 * A non-fatal skip the run decided on its own: a base pack member targeting
 * `saves/`, a server-only file, an unusable path. The operation continues, but
 * the instance is not quite what the input asked for, so it is never silent.
 */
export interface WarningEvent {
  readonly type: "warning";
  readonly message: string;
}

// --- error — a surfaced failure (mirrors the error taxonomy `code`) -------

export interface ErrorEvent {
  readonly type: "error";
  /** The `AnvilError.code` of the surfaced failure. */
  readonly code: string;
  readonly message: string;
}

/** The full discriminated union of everything the progress bus can emit. */
export type AnvilEvent =
  | ResolveStartEvent
  | ResolveItemEvent
  | ResolveDoneEvent
  | TransferPlanEvent
  | ObjectFetchEvent
  | ObjectStoreEvent
  | ObjectLinkEvent
  | ReplayStartEvent
  | ReplayFetchEvent
  | ReplayDoneEvent
  | BuildStartEvent
  | BuildStageEvent
  | BuildSwapEvent
  | BuildDoneEvent
  | PullStartEvent
  | PullObjectEvent
  | PullDoneEvent
  | VerifyStartEvent
  | VerifyItemEvent
  | VerifyDoneEvent
  | WarningEvent
  | ErrorEvent;

/** The set of all event discriminants (`"resolve:start" | …`). */
export type AnvilEventType = AnvilEvent["type"];

/** A progress-bus listener. */
export type ProgressListener = (event: AnvilEvent) => void;
