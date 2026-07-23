/**
 * The **progress model** — a pure reducer over the `Anvil` progress event bus,
 * plus the segment/bar renderers the live Ink view and the plain fallback share.
 *
 * The TUI is a pure consumer of the bus (no logic): it folds `AnvilEvent`s into a
 * {@link ProgressState} and paints bars from it. Bars always carry a numeric text
 * label (percent + counts) so progress is never signaled by color/fill alone.
 */

import type { AnvilEvent, BuildPhase } from "../events.js";
import type { Line, Segment } from "./segments.js";

/** The folded progress state driven by the event bus. */
export interface ProgressState {
  /** resolve:* — manifest → pinned lock. */
  readonly resolve?: { readonly done: number; readonly total: number };
  /** transfer:plan — the object transfer plan. */
  readonly plan?: { readonly objects: number; readonly bytes: number };
  /** object:* — content-store fetch / store / link tallies. */
  readonly objects: {
    readonly stored: number;
    readonly deduped: number;
    readonly linked: number;
  };
  /** replay:* — CurseForge per-client re-fetch. */
  readonly replay: { readonly done: number; readonly active?: string };
  /** build:* — the current build phase. */
  readonly phase?: BuildPhase;
  /** pull:* — content-addressed sync. */
  readonly pull?: { readonly done: number; readonly total: number };
  /** verify:* — instance ⇄ lock reconciliation. */
  readonly verify?: { readonly total: number; readonly done: number; readonly failed: number };
  readonly done: boolean;
  readonly builtDir?: string;
  readonly errors: readonly { readonly code: string; readonly message: string }[];
}

/** The empty starting state. */
export function initialProgress(): ProgressState {
  return {
    objects: { stored: 0, deduped: 0, linked: 0 },
    replay: { done: 0 },
    done: false,
    errors: [],
  };
}

/** Fold one event into the state (immutable — returns a fresh object). */
export function reduceProgress(state: ProgressState, event: AnvilEvent): ProgressState {
  switch (event.type) {
    case "resolve:start":
      return { ...state, resolve: { done: 0, total: event.items } };
    case "resolve:item":
      return { ...state, resolve: { done: event.index, total: event.total } };
    case "resolve:done":
      return {
        ...state,
        resolve: {
          done: state.resolve?.total ?? event.pinned,
          total: state.resolve?.total ?? event.pinned,
        },
      };
    case "transfer:plan":
      return { ...state, plan: { objects: event.objects, bytes: event.bytes } };
    case "object:store":
      return {
        ...state,
        objects: {
          ...state.objects,
          stored: state.objects.stored + (event.deduped ? 0 : 1),
          deduped: state.objects.deduped + (event.deduped ? 1 : 0),
        },
      };
    case "object:link":
      return { ...state, objects: { ...state.objects, linked: state.objects.linked + 1 } };
    case "replay:start":
      return { ...state, replay: { ...state.replay, active: event.name } };
    case "replay:done":
      return { ...state, replay: { done: state.replay.done + 1, active: undefined } };
    case "build:stage":
      return { ...state, phase: event.phase };
    case "build:done":
      return { ...state, done: true, builtDir: event.dir };
    case "pull:object":
      return { ...state, pull: { done: event.index, total: event.total } };
    case "pull:done":
      return { ...state, pull: { done: event.fastForwarded, total: event.fastForwarded } };
    case "verify:start":
      return { ...state, verify: { total: event.items, done: 0, failed: 0 } };
    case "verify:item": {
      const v = state.verify ?? { total: 0, done: 0, failed: 0 };
      return {
        ...state,
        verify: { total: v.total, done: v.done + 1, failed: v.failed + (event.ok ? 0 : 1) },
      };
    }
    case "verify:done":
      return state;
    case "error":
      return { ...state, errors: [...state.errors, { code: event.code, message: event.message }] };
    default:
      return state;
  }
}

/** Fold a whole event list (for offline/snapshot rendering + tests). */
export function reduceAll(events: readonly AnvilEvent[]): ProgressState {
  let state = initialProgress();
  for (const e of events) {
    state = reduceProgress(state, e);
  }
  return state;
}

/** Render a horizontal bar of `width` cells at `fraction` (0..1) full. */
export function renderBar(fraction: number, width: number, unicode = true): string {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const filledCount = Math.round(f * width);
  const full = unicode ? "█" : "#";
  const empty = unicode ? "░" : "-";
  return full.repeat(filledCount) + empty.repeat(Math.max(0, width - filledCount));
}

/** A labeled bar line: `label ████░░ 66% (2/3)`. The percent is clamped to 0–100. */
function barLine(
  label: string,
  done: number,
  total: number,
  color: Segment["color"],
  unicode: boolean,
): Line {
  const fraction = total > 0 ? done / total : 0;
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return [
    { text: label.padEnd(9), color: "muted" },
    { text: renderBar(fraction, 16, unicode), color },
    { text: ` ${pct}% `, color: "muted" },
    { text: `(${done}/${total})`, color: "muted" },
  ];
}

/** The build phases in order, for a bounded phase-progress bar. */
const BUILD_PHASES: readonly BuildPhase[] = ["preflight", "acquire", "stage", "verify", "swap"];

/**
 * Segments for the full progress panel. Shared by the Ink view (colored) and the
 * plain fallback (text only). Only phases that have started are shown.
 */
export function progressSegments(state: ProgressState, unicode = true): Line[] {
  const lines: Line[] = [];
  if (state.resolve) {
    lines.push(barLine("resolve", state.resolve.done, state.resolve.total, "accent", unicode));
  }
  if (state.plan) {
    // `plan.objects` is a PACKAGE count (delta.install); `object:store` fires per
    // content OBJECT (thousands during a game-asset acquire). They are different
    // units, so they are never paired into one ratio bar — the plan is an info
    // line and the acquire tally is an honest unbounded count.
    lines.push([
      { text: "install  ", color: "muted" },
      {
        text: `${state.plan.objects} package${state.plan.objects === 1 ? "" : "s"}`,
        color: "accent",
      },
      { text: ` · ${state.plan.bytes} bytes`, color: "muted" },
    ]);
    lines.push([
      { text: "objects  ", color: "muted" },
      { text: `${state.objects.stored} stored`, color: "ok" },
      {
        text: `, ${state.objects.deduped} deduped (skipped)`,
        color: "muted",
      },
    ]);
    if (state.objects.linked > 0) {
      lines.push([
        { text: "placed   ", color: "muted" },
        { text: `${state.objects.linked}`, color: "ok" },
      ]);
    }
  }
  if (state.pull) {
    lines.push(barLine("pull", state.pull.done, state.pull.total, "accent", unicode));
  }
  if (state.replay.active !== undefined || state.replay.done > 0) {
    const active = state.replay.active ? ` — fetching ${state.replay.active}` : "";
    lines.push([
      { text: "replay   ", color: "muted" },
      { text: `${state.replay.done} replayed`, color: "replay" },
      { text: active, color: "muted" },
    ]);
  }
  if (state.verify) {
    lines.push(
      barLine(
        "verify",
        state.verify.done,
        state.verify.total,
        state.verify.failed > 0 ? "error" : "ok",
        unicode,
      ),
    );
  }
  if (state.phase && !state.done) {
    // A bounded phase-step bar (preflight → acquire → stage → verify → swap),
    // which is monotonic and can never overflow, unlike an object-count ratio.
    const step = BUILD_PHASES.indexOf(state.phase) + 1;
    lines.push([
      { text: "build    ", color: "muted" },
      { text: renderBar(step / BUILD_PHASES.length, 16, unicode), color: "warn" },
      { text: ` ${state.phase} `, color: "warn", bold: true },
      { text: `(${step}/${BUILD_PHASES.length})`, color: "muted" },
    ]);
  }
  if (state.done) {
    lines.push([
      { text: "✓ ", color: "ok", bold: true },
      { text: "built ", color: "ok" },
      { text: state.builtDir ?? "", color: "muted" },
    ]);
  }
  for (const err of state.errors) {
    lines.push([
      { text: "✗ ", color: "error", bold: true },
      { text: `${err.code}: `, color: "error" },
      { text: err.message, color: "muted" },
    ]);
  }
  if (lines.length === 0) {
    lines.push([{ text: "starting…", color: "muted" }]);
  }
  return lines;
}
