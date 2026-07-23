/**
 * The **conflict-resolution controller** — the bridge between the conflict cards
 * and the library's real merge. It is a thin orchestrator: it calls `Anvil.merge`
 * to *probe* for conflicts (a manual, no-op merge that collects them without
 * committing), presents a card per conflict for a decision, then runs the **real**
 * merge with those decisions wired into the library's `onConflict` hook.
 *
 * All merge behavior — the 3-way item-set merge, the constrained re-lock, the
 * commit — stays in the library. The TUI only *presents* and *collects*.
 */

import type { Anvil, MergeResult } from "../anvil.js";
import { readLockIfPresent } from "../lock/index.js";
import type { Resolution } from "../vc/index.js";
import { packContextFromLock } from "./blast-radius.js";
import { type ConflictCard, buildConflictCards } from "./conflict-model.js";

/**
 * Present one card and return the user's resolution, or `undefined` to leave it
 * unresolved (which aborts the merge — nothing is committed).
 */
export type ResolveCard = (
  card: ConflictCard,
  index: number,
  total: number,
) => Promise<Resolution | undefined> | Resolution | undefined;

/** The outcome of a card-driven merge. */
export interface ConflictMergeResult {
  /** The final library merge outcome (committed, or still-conflicted). */
  readonly outcome: MergeResult;
  /** The cards presented (empty for a clean / fast-forward / up-to-date merge). */
  readonly cards: readonly ConflictCard[];
  /** The resolutions collected, keyed by conflict key. */
  readonly resolutions: ReadonlyMap<string, Resolution>;
}

/**
 * Drive a branch merge through the conflict cards.
 *
 * 1. **Probe** with `strategy: "manual"` (no callback): a clean / fast-forward /
 *    up-to-date merge just commits and returns; a conflicted merge aborts and
 *    returns the full conflict list without touching history.
 * 2. Build a card per conflict (blast radius + re-lock preview from the current
 *    lock) and collect a decision for each via `resolveCard`.
 * 3. Run the **real** merge with an `onConflict` that replays those decisions.
 */
export async function runConflictMerge(
  anvil: Anvil,
  branch: string,
  resolveCard: ResolveCard,
): Promise<ConflictMergeResult> {
  const probe = await anvil.merge(branch, { strategy: "manual" });
  if (probe.conflicts.length === 0) {
    // Clean 3-way, fast-forward, or already up to date — the probe did the merge.
    return { outcome: probe, cards: [], resolutions: new Map() };
  }

  const ctx = packContextFromLock(await readLockIfPresent(anvil.dir));
  const cards = buildConflictCards(probe.conflicts, ctx);

  const resolutions = new Map<string, Resolution>();
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card) {
      continue;
    }
    const resolution = await resolveCard(card, i, cards.length);
    if (resolution !== undefined) {
      resolutions.set(card.conflict.key, resolution);
    }
  }

  const outcome = await anvil.merge(branch, {
    onConflict: (conflict) => resolutions.get(conflict.key),
  });
  return { outcome, cards, resolutions };
}
