/**
 * The **styled-segment** model — the single source of truth for TUI content.
 *
 * A rendered piece of UI is an array of {@link Segment}s: each carries the
 * literal `text` plus purely-decorative styling hints (a semantic color, bold,
 * dim). Two backends consume the same segments:
 *   - the Ink components map each segment to a `<Text>` (colorful, interactive);
 *   - {@link plainText} joins the `.text` only (no ANSI — the CI/pipe fallback).
 *
 * Because every segment's `text` stands on its own, color is never load-bearing:
 * a badge's label reads `[mod]` whether or not color is applied. That is the
 * accessibility invariant — **no color-only signaling** — made structural.
 */

/** A semantic color name, mapped to a concrete Ink color by the theme. */
export type SemColor =
  | "modrinth"
  | "curseforge"
  | "url"
  | "local"
  | "mojang"
  | "mod"
  | "resourcepack"
  | "shaderpack"
  | "datapack"
  | "config"
  | "game"
  | "loader"
  | "library"
  | "java"
  | "copy"
  | "replay"
  | "added"
  | "removed"
  | "changed"
  | "high"
  | "normal"
  | "muted"
  | "accent"
  | "ok"
  | "warn"
  | "error"
  | "heading";

/** One styled run of text. `text` always carries the meaning; the rest is decor. */
export interface Segment {
  readonly text: string;
  readonly color?: SemColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  /** A background color (semantic) — used sparingly for pill-style badges. */
  readonly bg?: SemColor;
}

/** A single rendered line: an ordered list of segments. */
export type Line = readonly Segment[];

/** Convenience constructor for a styled segment. */
export function seg(text: string, opts: Omit<Segment, "text"> = {}): Segment {
  return { text, ...opts };
}

/** A plain (unstyled) spacer/text segment. */
export function plain(text: string): Segment {
  return { text };
}

/** Join a line's segments into a plain string — **no ANSI, ever**. */
export function plainText(line: Line): string {
  let out = "";
  for (const s of line) {
    out += s.text;
  }
  return out;
}

/** Join a block of lines into a plain multi-line string (no ANSI). */
export function plainBlock(lines: readonly Line[]): string {
  return lines.map(plainText).join("\n");
}
