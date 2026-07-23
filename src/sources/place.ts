/**
 * Turning an inferred kind + filename into a single-file {@link Placement}. The
 * complete placement table for placeable items (mods/, resourcepacks/,
 * shaderpacks/, datapacks/, config/) lives here so every source places
 * consistently.
 */

import { posix } from "node:path";
import type { ItemKind, Placement } from "../types/index.js";
import { placementDirForKind } from "./kind.js";

const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Drop control characters (U+0000–U+001F and DEL) without a regex. */
function stripControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      out += ch;
    }
  }
  return out;
}

/** Reduce any path to a safe, single-segment basename usable cross-OS. */
export function safeBasename(raw: string, fallbackExt: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = stripControlChars(base).trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return `unnamed${fallbackExt}`;
  }
  const stem = cleaned.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED.has(stem)) {
    return `_${cleaned}`;
  }
  return cleaned;
}

/** A single-file link placement for a placeable item kind. */
export function singleFilePlacement(kind: ItemKind, filename: string): Placement {
  const dir = placementDirForKind(kind);
  return { method: "link", target: posix.join(dir, filename) };
}
