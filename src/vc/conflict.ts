/**
 * The conflict / resolution vocabulary for merge and rebase.
 *
 * A conflict is a decision the 3-way item-set merge (phase 1) or the constrained
 * re-lock (phase 2) cannot make on its own. Non-interactive strategies
 * (`--ours` / `--theirs` / `--newest` / `--manual`) and an `onConflict` callback
 * resolve them; anything left unresolved aborts the operation without committing.
 */

import type { ManifestItem } from "../types/index.js";

/**
 * The kind of conflict:
 *   - `item`   — both sides changed the same manifest item to different values.
 *   - `game`   — both sides changed `@game` differently (high-severity cascade).
 *   - `no-compatible-version` — a phase-2 secondary: an item has no version
 *     compatible with the merged game (e.g. a Minecraft bump orphaned a mod).
 *   - `dependency` — a phase-2 secondary: a transitive dependency conflict.
 */
export type ConflictKind = "item" | "game" | "no-compatible-version" | "dependency";

/** A conflict the merge/rebase surfaced. */
export interface Conflict {
  /** The stable identity key (`modrinth:sodium`, `@game`, `local:config/x.toml`). */
  readonly key: string;
  readonly kind: ConflictKind;
  /** `high` for `@game` cascades and phase-2 secondaries; `normal` otherwise. */
  readonly severity: "normal" | "high";
  /** Display value on the base (merge base / previous commit). */
  readonly base?: string;
  /** Display value on our side (HEAD / rebased tip). */
  readonly ours?: string;
  /** Display value on their side (the merged-in / replayed commit). */
  readonly theirs?: string;
  readonly message: string;
}

/** A resolution for one conflict. */
export type Resolution =
  | { readonly choose: "ours" | "theirs" | "newest" }
  /** Replace the item outright (an absent value drops it). */
  | { readonly manual: ManifestItem | undefined };

/** The non-interactive strategy applied to every conflict when set. */
export type ConflictStrategy = "ours" | "theirs" | "newest" | "manual";

/**
 * A host-app resolution hook: given a conflict, return a resolution (or
 * `undefined` to leave it unresolved). Takes precedence over a bare strategy.
 */
export type OnConflict = (
  conflict: Conflict,
) => Resolution | undefined | Promise<Resolution | undefined>;

/** Render a conflict as a one-line human string (for the plain result/log). */
export function describeConflict(c: Conflict): string {
  const sev = c.severity === "high" ? "!! " : "";
  return `${sev}${c.key} (${c.kind}): base=${c.base ?? "∅"} ours=${c.ours ?? "∅"} theirs=${c.theirs ?? "∅"}`;
}
