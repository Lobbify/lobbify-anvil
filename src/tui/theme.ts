/**
 * The color theme — maps a semantic {@link SemColor} to a concrete Ink color
 * (a named ANSI color or a truecolor hex the terminal downshifts as needed).
 *
 * This is the ONE place colors are chosen, so the palette stays coherent across
 * badges, semver diffs, progress bars, and conflict cards. Colors are purely
 * decorative — the segment `text` always carries the meaning (see segments.ts).
 */

import type { SemColor } from "./segments.js";

/** An Ink text color: a named ANSI color or a `#rrggbb` truecolor value. */
export type InkColor = string;

const PALETTE: Record<SemColor, InkColor> = {
  // sources — brand-ish hues where a terminal has truecolor.
  modrinth: "green",
  curseforge: "#f16436",
  url: "cyan",
  local: "gray",
  mojang: "yellow",
  // item kinds.
  mod: "cyan",
  resourcepack: "magenta",
  shaderpack: "blue",
  datapack: "green",
  config: "gray",
  game: "yellow",
  loader: "yellow",
  library: "gray",
  java: "red",
  // provenance.
  copy: "green",
  replay: "magenta",
  // change markers / semver bump levels.
  added: "green",
  removed: "red",
  changed: "yellow",
  // conflict severities.
  high: "red",
  normal: "yellow",
  // structural.
  muted: "gray",
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  error: "red",
  heading: "cyan",
};

/** The concrete Ink color for a semantic color. */
export function inkColor(sem: SemColor): InkColor {
  return PALETTE[sem];
}
