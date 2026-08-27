/**
 * Where an item lands in the instance tree.
 *
 * Three rules, in precedence order:
 *
 *  1. **An explicit target wins, for any source (LB-720).** A `ManifestItem`
 *     may declare `target` separately from identity — the read location for a
 *     `path` item, or the `source:id` for a `ref` item. Either way it is
 *     honored verbatim, run through {@link declaredPlacementTarget}'s guards.
 *     This is the only way a Modrinth/CurseForge/URL item, or a local file
 *     re-identified against one of them, can name a placement of its own — a
 *     bare ref carries nothing a placement could be derived from.
 *  2. **A path-carrying item with no explicit target keeps its own path.** An
 *     item authored as a path (`"config/sodium/mixins.json"`, `"options.txt"`)
 *     names both where its bytes come from and where they belong.
 *     {@link declaredPlacementTarget} normalizes that path into the placement
 *     target verbatim, so a nested config round-trips and a root-level
 *     override stays at the root.
 *  3. **Everything else is placed by kind.** A Modrinth/CurseForge/URL item
 *     with no declared target — or a local file that lives outside the
 *     instance — carries no path of its own, so {@link singleFilePlacement}
 *     puts it in the folder its {@link ItemKind} implies (mods/,
 *     resourcepacks/, shaderpacks/, datapacks/, config/).
 *
 * The complete placement table lives here so every source places consistently;
 * rule 1 is applied by each `Source.resolve` (it is the one rule not run
 * through {@link singleFilePlacement}/`declaredPlacementTarget`'s derivation —
 * the target already IS the placement, verbatim, once
 * `resolver/resolve.ts`'s `localizeRef` has validated it).
 */

import { posix } from "node:path";
import { findColonSegment, isPlacementRefusedTop, isWindowsDeviceName } from "../internal/fs.js";
import { PathEscape } from "../types/errors.js";
import type { ItemKind, Placement } from "../types/index.js";
import { placementDirForKind } from "./kind.js";

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
  // A Windows reserved device name (`con`, `nul`, `lpt1`, …) is reserved with any
  // extension, so `con.txt` needs the prefix as much as a bare `con` does.
  if (isWindowsDeviceName(cleaned)) {
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
 * Throws {@link PathEscape} for the cases that are genuinely malformed rather
 * than merely external: a NUL byte, a target under a protected top-level entry
 * (`saves/`, `.anvil/`, `.anvilignore`) or one of anvil's own reserved files
 * (`anvil.toml`, `anvil.lock`, `.anvilexclude` — LB-734), and any segment
 * containing a `:`
 * (opens an NTFS Alternate Data Stream on Windows instead of the ordinary file
 * the same string names on POSIX — see {@link findColonSegment}). Refusing at
 * lock time is deliberate — the kind-directory fallback would quietly place
 * `saves/level.dat` at `config/level.dat`, turning an illegal placement into a
 * silent relocation.
 */
export function declaredPlacementTarget(rawPath: string): string | undefined {
  if (rawPath.includes("\0")) {
    throw new PathEscape(rawPath, "path contains a NUL byte");
  }
  const segments = normalizeDeclaredSegments(rawPath);
  if (!segments) {
    return undefined;
  }
  const colonSegment = findColonSegment(segments);
  if (colonSegment !== undefined) {
    throw new PathEscape(
      rawPath,
      `segment "${colonSegment}" contains a ':' (opens an NTFS alternate data stream on Windows)`,
    );
  }
  const top = segments[0] ?? "";
  if (isPlacementRefusedTop(top)) {
    throw new PathEscape(rawPath, `targets protected path "${top}"`);
  }
  return segments.join("/");
}
