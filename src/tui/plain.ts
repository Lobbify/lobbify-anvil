/**
 * The **plain fallback renderer** — no Ink, no React, **no ANSI**. This is what
 * runs when stdout is not a TTY or `NO_COLOR` is set, so pipes and CI still get a
 * useful, greppable dashboard. It builds the exact same {@link Line} segments the
 * Ink components do, then flattens them with {@link plainText} (text only).
 *
 * Keeping the plain path a separate, Ink-free renderer is what makes the "no ANSI
 * escapes under NO_COLOR / non-TTY" invariant provable and dependency-light.
 */

import type { StatusResult } from "../anvil.js";
import type { Lockfile } from "../types/index.js";
import type { ConflictCard } from "./conflict-model.js";
import { conflictCardSegments } from "./conflict-model.js";
import { type ItemRow, gameSummary, itemRowSegments } from "./item-list.js";
import type { ProgressState } from "./progress-model.js";
import { progressSegments } from "./progress-model.js";
import { type Line, plainText } from "./segments.js";

/** Everything the dashboard shows for an instance. */
export interface DashboardData {
  readonly status: StatusResult;
  readonly lock?: Lockfile;
  readonly rows: readonly ItemRow[];
}

const HEADING = "lobbify-anvil";
const RULE = "─".repeat(HEADING.length);

/** The dashboard as plain, ANSI-free text. */
export function renderPlainDashboard(data: DashboardData): string {
  const lines: string[] = [];
  lines.push(HEADING, RULE);
  lines.push(data.status.summary);
  if (data.lock) {
    lines.push(plainText(gameSummary(data.lock)));
  }
  lines.push("");
  if (data.rows.length === 0) {
    lines.push("no items yet — `lobbify-anvil add <source:id>` then `lock`");
  } else {
    lines.push(`items (${data.rows.length}):`);
    for (const row of data.rows) {
      lines.push(plainText(itemRowSegments(row)));
    }
  }
  return lines.join("\n");
}

/** The progress panel as plain text (used for the non-interactive build path). */
export function renderPlainProgress(state: ProgressState, unicode = false): string {
  return progressSegments(state, unicode)
    .map((line: Line) => plainText(line))
    .join("\n");
}

/** The conflict cards as plain text. */
export function renderPlainConflictCards(cards: readonly ConflictCard[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card) {
      continue;
    }
    blocks.push(conflictCardSegments(card, i, cards.length).map(plainText).join("\n"));
  }
  return blocks.join("\n\n");
}
