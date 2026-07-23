/**
 * Source / kind / provenance / severity **badges** — the colorful, text-carrying
 * chips in the item list and conflict cards.
 *
 * Each badge is a {@link Segment} whose `text` is a bracketed label (`[mod]`,
 * `[modrinth]`, `[replay]`). The bracketed label is the accessibility contract:
 * the badge is legible with color stripped, so nothing is signaled by color
 * alone. Color is layered on top for the interactive terminal.
 */

import type { ItemKind, Provenance, SourceKind } from "../types/index.js";
import type { Segment } from "./segments.js";

/** Human labels for item kinds (the badge text). */
const KIND_LABEL: Record<ItemKind, string> = {
  game: "game",
  loader: "loader",
  library: "library",
  java: "java",
  mod: "mod",
  resourcepack: "resourcepack",
  shaderpack: "shaderpack",
  datapack: "datapack",
  config: "config",
};

/** Human labels for sources (the badge text). */
const SOURCE_LABEL: Record<SourceKind, string> = {
  mojang: "mojang",
  modrinth: "modrinth",
  curseforge: "curseforge",
  url: "url",
  local: "local",
};

/** A kind badge, e.g. `[mod]` (colored by kind). */
export function kindBadge(kind: ItemKind): Segment {
  return { text: `[${KIND_LABEL[kind]}]`, color: kind, bold: true };
}

/** A source badge, e.g. `[modrinth]` (colored by source). */
export function sourceBadge(source: SourceKind): Segment {
  return { text: `[${SOURCE_LABEL[source]}]`, color: source };
}

/**
 * A provenance badge — only `replay` is surfaced (a CurseForge, per-client,
 * never-rehosted item), so the user can see which items carry the ToS boundary.
 * `copy` items get no badge to keep the list quiet.
 */
export function provenanceBadge(provenance: Provenance): Segment | undefined {
  if (provenance === "replay") {
    return { text: "[replay]", color: "replay", bold: true };
  }
  return undefined;
}

/** A conflict-severity badge — `[HIGH]` (red) or `[conflict]` (amber). */
export function severityBadge(severity: "normal" | "high"): Segment {
  return severity === "high"
    ? { text: "[HIGH]", color: "high", bold: true }
    : { text: "[conflict]", color: "normal", bold: true };
}
