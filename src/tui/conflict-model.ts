/**
 * The **conflict card** model — one card per merge/rebase conflict, ordered so
 * the high-severity `@game` cascades surface first, each carrying its blast
 * radius + re-lock preview and the styled base/ours/theirs values.
 *
 * Pure. It arranges library data ({@link Conflict}) into display cards; the
 * resolution decision + the real merge happen in the library (via the
 * controller). A card never mutates anything.
 */

import type { Conflict } from "../vc/index.js";
import { severityBadge } from "./badges.js";
import {
  type BlastRadius,
  type PackContext,
  type RelockPreview,
  computeBlastRadius,
  computeRelockPreview,
} from "./blast-radius.js";
import type { Line, Segment } from "./segments.js";
import { diffSegments } from "./semver-diff.js";

/** A conflict, decorated for the card UI. */
export interface ConflictCard {
  readonly conflict: Conflict;
  readonly blast: BlastRadius;
  readonly preview: RelockPreview;
}

/** The four choices a card offers (mapped to a `Resolution` by the controller). */
export const CHOICE_HINTS: readonly { readonly key: string; readonly label: string }[] = [
  { key: "o", label: "ours" },
  { key: "t", label: "theirs" },
  { key: "n", label: "newest" },
  { key: "s", label: "skip (leave unresolved)" },
];

function severityRank(c: Conflict): number {
  if (c.kind === "game" || c.key === "@game") {
    return 0;
  }
  if (c.severity === "high") {
    return 1;
  }
  return 2;
}

/**
 * Build the ordered card list from a set of conflicts + the current pack. Order:
 * `@game` cascades first, then other high-severity, then normal — each keyed for
 * a stable render.
 */
export function buildConflictCards(
  conflicts: readonly Conflict[],
  ctx: PackContext,
): ConflictCard[] {
  return [...conflicts]
    .sort(
      (a, b) => severityRank(a) - severityRank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    )
    .map((conflict) => ({
      conflict,
      blast: computeBlastRadius(conflict, ctx),
      preview: computeRelockPreview(conflict, ctx),
    }));
}

/** A `base / ours / theirs` value line, semver-tinted where both sides differ. */
function sidesLine(conflict: Conflict): Line {
  const out: Segment[] = [{ text: "  " }];
  const push = (label: string, value: string | undefined, color: Segment["color"]): void => {
    out.push({ text: `${label} `, color: "muted" });
    out.push(value === undefined ? { text: "∅", color: "muted" } : { text: value, color });
    out.push({ text: "   " });
  };
  push("base", conflict.base, "muted");
  push("ours", conflict.ours, "accent");
  push("theirs", conflict.theirs, "changed");
  return out;
}

/**
 * The full segment block for a card — used by the Ink card and the plain
 * fallback. Every consequence (blast radius, re-lock preview) is spelled out in
 * text so nothing rides on color.
 */
export function conflictCardSegments(card: ConflictCard, index: number, total: number): Line[] {
  const { conflict, blast, preview } = card;
  const header: Segment[] = [
    { text: `Conflict ${index + 1}/${total}  `, color: "muted" },
    severityBadge(conflict.severity),
    { text: " " },
    { text: `[${conflict.kind}]`, color: "heading" },
    { text: "  " },
    { text: conflict.key, bold: true },
  ];
  const lines: Line[] = [
    header,
    [{ text: `  ${conflict.message}`, color: "muted" }],
    sidesLine(conflict),
  ];

  // A version-style diff of ours vs theirs, when both are present.
  if (conflict.ours !== undefined && conflict.theirs !== undefined) {
    lines.push([
      { text: "  change  ", color: "muted" },
      ...diffSegments(conflict.ours, conflict.theirs),
    ]);
  }

  lines.push([
    { text: "  blast radius: ", color: "muted" },
    {
      text: `${blast.count} item${blast.count === 1 ? "" : "s"}`,
      color: blast.count > 0 ? "warn" : "muted",
      bold: true,
    },
    { text: ` — ${blast.note}`, color: "muted" },
  ]);
  if (blast.items.length > 0 && blast.items.length <= 8) {
    lines.push([
      { text: "    ", color: "muted" },
      { text: blast.items.join(", "), color: "muted", dim: true },
    ]);
  }
  lines.push([
    { text: "  re-lock preview: ", color: "muted" },
    { text: `${preview.keptPins} pin${preview.keptPins === 1 ? "" : "s"} kept`, color: "ok" },
    { text: ", ", color: "muted" },
    { text: `${preview.reResolved} re-resolved`, color: "warn" },
    { text: ` — ${preview.note}`, color: "muted", dim: true },
  ]);
  const choices: Segment[] = [{ text: "  choose: ", color: "muted" }];
  for (const c of CHOICE_HINTS) {
    choices.push(
      { text: `[${c.key}]`, color: "accent", bold: true },
      { text: ` ${c.label}   `, color: "muted" },
    );
  }
  lines.push(choices);
  return lines;
}
