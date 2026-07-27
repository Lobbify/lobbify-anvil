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
 * absolute/drive-letter paths, NUL bytes, `..` traversal that escapes `root`, and
 * (unless `allowProtected`) a target whose top-level segment is protected
 * (`saves/`, `.anvil/`, `.anvilignore`). This is the placement-side half of the
 * zip-slip / "`saves/` never touched" guarantee.
 */
export function safeJoin(root: string, rel: string, opts?: { allowProtected?: boolean }): string {
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
