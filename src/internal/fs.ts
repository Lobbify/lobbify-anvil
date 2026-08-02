/**
 * Small filesystem helpers shared by the store and build layers, plus the single
 * hardened `safeJoin` used to keep every materialized path under its allowed root
 * and away from protected paths (`saves/`, `.anvil/`).
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { PathEscape } from "../types/errors.js";

/** Top-level instance entries the build must never create, move, or delete. */
export const PROTECTED_TOP = new Set([".anvil", ".anvilignore", "saves"]);

/**
 * Case-fold + Unicode-normalize a path segment for protection checks. Windows
 * (NTFS) and macOS (APFS) are case-insensitive, so `Saves`/`SAVES`/`saves` all
 * resolve to the same directory on disk — protection must fold the same way.
 */
export function foldName(segment: string): string {
  return segment.normalize("NFC").toLowerCase();
}

const PROTECTED_TOP_FOLDED = new Set([...PROTECTED_TOP].map(foldName));

/** True if a top-level segment is protected (case-insensitive). */
export function isProtectedTop(segment: string): boolean {
  return PROTECTED_TOP_FOLDED.has(foldName(segment));
}

/**
 * The first segment in `segments` that contains a `:` (colon), or `undefined`
 * if none do.
 *
 * A colon inside a single path segment is an ordinary, legal filename
 * character on POSIX — but on Windows/NTFS it introduces an **Alternate Data
 * Stream**: `name:stream` does not create a file literally called that, it
 * opens a hidden stream attached to `name` (creating `name` itself first, as
 * an empty file, if it did not already exist). The same declared string
 * therefore produces a structurally different filesystem outcome per
 * platform — an ordinary sibling file on POSIX, a hidden stream grafted onto
 * a possibly-protected node on Windows — which breaks determinism (same
 * lock → byte-identical instance) on its own, with no attacker required. It
 * is also how a path can graft data onto a protected top-level entry
 * (`saves:level.dat`) without ever spelling `saves` as its own top-level
 * segment, bypassing {@link isProtectedTop}.
 *
 * Checked against **every** segment, not just the top-level one
 * (`config/D:evil.txt` is exactly as cross-platform-divergent as
 * `saves:level.dat`), and rejected outright regardless of what the segment
 * before the colon happens to name — an unprotected `config:foo` diverges by
 * the same mechanism as a protected one, so narrowing this to "only under a
 * protected prefix" would still leave the platform-divergence bug live.
 */
export function findColonSegment(segments: readonly string[]): string | undefined {
  return segments.find((s) => s.includes(":"));
}

/**
 * Canonicalize an instance-relative path: split on either separator, drop empty
 * and `.` segments, rejoin with `/`.
 *
 * It canonicalizes by **decomposition**, not by rewriting rules, because a rule
 * list is always one case short of `path.join`. Stripping a single leading `./`
 * and a trailing `/` leaves `mods//jei.jar`, `././mods/jei.jar` and
 * `mods/./jei.jar` as three distinct strings that `safeJoin` and the filesystem
 * all resolve to one file. Anything keyed on this string — the exclusion set, the
 * replay-path ledger, the push gate — then answers differently depending on how
 * the path happened to be spelled, which is a protection bypass rather than a
 * cosmetic difference.
 *
 * `..` segments are preserved: they are not a normalization question but a
 * rejection one, and `safeJoin` refuses them outright.
 */
export function normalizeRelPath(raw: string): string {
  return raw
    .split(/[/\\]/)
    .filter((s) => s.length > 0 && s !== ".")
    .join("/");
}

/**
 * The comparison form of a whole instance-relative path: normalized, then
 * case-folded and NFC-normalized.
 *
 * It lives here, next to `foldName`, because more than one subsystem stores a
 * path in order to compare it against a path some other subsystem produced — the
 * working-tree exclusion set, the replay-path ledger, the `push` backstop. Two
 * copies of "normalize, then fold" that drift by one rule (a trailing slash, a
 * backslash) compare unequal for paths that name the same file, and a protection
 * keyed on that comparison then silently stops matching.
 *
 * Folding the whole path is folding each segment: `foldName` only lowercases and
 * NFC-normalizes, and `/` is fixed under both.
 */
export function foldPath(raw: string): string {
  return foldName(normalizeRelPath(raw));
}

/** True if `p` exists (file, dir, or symlink). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `mkdir -p`. */
export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

/** `rm -rf` (never throws on a missing path). */
export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}

/** Rename, creating the destination parent first. */
export async function renameInto(from: string, to: string): Promise<void> {
  await mkdir(resolve(to, ".."), { recursive: true });
  await rename(from, to);
}

/** The device (volume) id backing `path`. Injectable in tests for cross-volume cases. */
export async function statDevOf(path: string): Promise<number> {
  return (await stat(path)).dev;
}

/**
 * Resolve a relative target under `root`, rejecting anything unsafe:
 * absolute/drive-letter paths, NUL bytes, `..` traversal that escapes `root`,
 * (unless `allowProtected`) a target whose top-level segment is protected
 * (`saves/`, `.anvil/`, `.anvilignore`), and (only when `rejectColon` is set) a
 * segment containing `:`. This is the placement-side half of the zip-slip /
 * "`saves/` never touched" guarantee.
 *
 * `rejectColon` is deliberately opt-in, unlike every other check here — see
 * {@link findColonSegment} for the mechanism it guards against. `safeJoin` is not
 * only the placement gate: `src/vc/snapshot.ts` (`materializeSnapshot`) runs
 * every tracked and carried path through it during VC checkout, and those paths
 * are the user's own working-tree files, not anything a pack or lock declared.
 * A colon is a legal POSIX filename character, so a real file a POSIX user
 * created and committed (`config/server:25565.toml`) must still round-trip
 * through `switch` — refusing to restore a file that exists only because the
 * user made it is strictly worse than restoring it, and on Windows the case
 * cannot arise in the first place (such a file could never have been committed
 * there to begin with). Callers on the pack/lock-controlled surface — where the
 * string is untrusted input that has never touched disk yet — pass
 * `rejectColon: true` explicitly; VC checkout must not.
 */
export function safeJoin(
  root: string,
  rel: string,
  opts?: { allowProtected?: boolean; rejectColon?: boolean },
): string {
  if (rel.includes("\0")) {
    throw new PathEscape(rel, "path contains a NUL byte");
  }
  if (isAbsolute(rel) || /^[a-zA-Z]:[/\\]?/.test(rel)) {
    throw new PathEscape(rel, "absolute or drive-letter path");
  }
  const segments = rel.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  if (segments.includes("..")) {
    throw new PathEscape(rel, "contains a '..' traversal segment");
  }
  if (opts?.rejectColon) {
    const colonSegment = findColonSegment(segments);
    if (colonSegment !== undefined) {
      throw new PathEscape(
        rel,
        `segment "${colonSegment}" contains a ':' (opens an NTFS alternate data stream on Windows)`,
      );
    }
  }
  const normalizedRoot = resolve(root);
  const abs = resolve(normalizedRoot, rel);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new PathEscape(rel, "escapes the target root");
  }
  const top = segments[0] ?? "";
  if (!opts?.allowProtected && isProtectedTop(top)) {
    throw new PathEscape(rel, `targets protected path "${top}"`);
  }
  return abs;
}
