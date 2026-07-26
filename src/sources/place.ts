/**
 * Where an item lands in the instance tree.
 *
 * Two rules, in precedence order:
 *
 *  1. **A path-carrying item keeps its path.** An item authored as a path
 *     (`"config/sodium/mixins.json"`, `"options.txt"`) names both where its bytes
 *     come from and where they belong. {@link declaredPlacementTarget} normalizes
 *     that path into the placement target verbatim, so a nested config
 *     round-trips and a root-level override stays at the root.
 *  2. **Everything else is placed by kind.** A Modrinth/CurseForge/URL item — or
 *     a local file that lives outside the instance — carries no path of its own,
 *     so {@link singleFilePlacement} puts it in the folder its {@link ItemKind}
 *     implies (mods/, resourcepacks/, shaderpacks/, datapacks/, config/).
 *
 * The complete placement table lives here so every source places consistently.
 */

import { posix } from "node:path";
import { isProtectedTop } from "../internal/fs.js";
import { PathEscape } from "../types/errors.js";
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

/** Characters that are illegal in a filename on Windows (NTFS) → replaced with `_`. */
const WINDOWS_ILLEGAL = /[<>:"|?*]/g;

/** Reduce any path to a safe, single-segment basename usable cross-OS. */
export function safeBasename(raw: string, fallbackExt: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = stripControlChars(base).replace(WINDOWS_ILLEGAL, "_").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return `unnamed${fallbackExt}`;
  }
  const stem = cleaned.split(".")[0]?.toLowerCase() ?? "";
  if (WINDOWS_RESERVED.has(stem)) {
    return `_${cleaned}`;
  }
  return cleaned;
}

/** A single-file `link` placement — narrowed, so callers can read `.target`. */
export type LinkPlacement = Extract<Placement, { method: "link" }>;

/** A single-file link placement for a placeable item kind. */
export function singleFilePlacement(kind: ItemKind, filename: string): LinkPlacement {
  const dir = placementDirForKind(kind);
  return { method: "link", target: posix.join(dir, filename) };
}

/**
 * Split a declared path on either separator, dropping empty and `.` segments and
 * folding each `..` against the segments before it.
 *
 * Returns `undefined` — meaning "this names nothing inside the instance" — for an
 * absolute path, a Windows drive-letter path, a `..` that walks past the root, and
 * a path that normalizes away to nothing. Those are not *rejected*; they are simply
 * not instance placements (a manifest may legitimately point at a file outside the
 * instance, e.g. `"../shared/mods/foo.jar"`), so the caller falls back to the kind
 * directory. Nothing outside the instance can ever become a placement target.
 */
function normalizeDeclaredSegments(raw: string): string[] | undefined {
  if (/^[/\\]/.test(raw) || /^[a-zA-Z]:/.test(raw)) {
    return undefined; // absolute, UNC, or drive-letter — outside by construction
  }
  const out: string[] = [];
  for (const segment of raw.split(/[/\\]/)) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        return undefined; // walks out of the instance root
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * The instance-relative placement target a manifest-declared path names, or
 * `undefined` when it names nothing inside the instance (see
 * {@link normalizeDeclaredSegments}) and the item should be placed by kind.
 *
 * The returned path is POSIX-normalized and provably inside the instance: every
 * `.`/`..` is folded here, so the result contains no traversal segment for
 * `safeJoin` to catch later. Segments are otherwise honored **verbatim** — this
 * derives a placement, so silently rewriting a segment would relocate the file,
 * which is the bug this exists to prevent.
 *
 * Throws {@link PathEscape} for the two cases that are genuinely malformed rather
 * than merely external: a NUL byte, and a target under a protected top-level entry
 * (`saves/`, `.anvil/`, `.anvilignore`). Refusing at lock time is deliberate — the
 * kind-directory fallback would quietly place `saves/level.dat` at
 * `config/level.dat`, turning an illegal placement into a silent relocation.
 */
export function declaredPlacementTarget(rawPath: string): string | undefined {
  if (rawPath.includes("\0")) {
    throw new PathEscape(rawPath, "path contains a NUL byte");
  }
  const segments = normalizeDeclaredSegments(rawPath);
  if (!segments) {
    return undefined;
  }
  const top = segments[0] ?? "";
  if (isProtectedTop(top)) {
    throw new PathEscape(rawPath, `targets protected path "${top}"`);
  }
  return segments.join("/");
}
