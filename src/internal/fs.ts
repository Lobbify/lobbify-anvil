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
 * The top-level entries that are anvil's own metadata for an instance: the
 * manifest (`anvil.toml`), the lock (`anvil.lock`), and the version-control
 * exclude file (`.anvilexclude`).
 *
 * **A SEPARATE set from {@link PROTECTED_TOP}, deliberately — do not merge them
 * (LB-734).** The two sets answer different questions, and the three names below
 * belong to only one of them:
 *
 *   - {@link PROTECTED_TOP} means "version control and the build do not manage
 *     this path **at all**". It is consulted by `WorktreeExclusion.excludes`
 *     (so a protected path is neither recorded nor materialized) and by the
 *     default branch of {@link safeJoin} (so materialize *throws* on a snapshot
 *     claiming one).
 *   - This set means "package content must never be **placed** here". These
 *     files are anvil's own, but version control very much does manage them:
 *     `anvil.toml` / `anvil.lock` have their own snapshot slots, and
 *     `.anvilexclude` is an ordinary **tracked** file — a commit travels with
 *     the exclude rules it was authored under, and `materializeSnapshot` looks
 *     it up in the target commit's tracked set by name.
 *
 * So adding these three to `PROTECTED_TOP` would not have hardened anything; it
 * would have stopped `.anvilexclude` being tracked and made `safeJoin` throw on
 * every checkout of a commit that tracks one. The protection this set expresses
 * is placement-side only, which is why it has its own predicate.
 *
 * The names are literals rather than imports of `MANIFEST_FILENAME` /
 * `LOCK_FILENAME` / `EXCLUDE_FILE`: this module sits underneath the manifest,
 * lock, and VC layers and importing them here would cycle. `test/security/`
 * pins the set against those three constants instead, so a rename there goes
 * red rather than silently narrowing this set.
 */
export const ANVIL_RESERVED_TOP = new Set(["anvil.toml", "anvil.lock", ".anvilexclude"]);

const ANVIL_RESERVED_TOP_FOLDED = new Set([...ANVIL_RESERVED_TOP].map(foldName));

/** True if a top-level segment is one of anvil's own metadata files (case-insensitive). */
export function isAnvilReservedTop(segment: string): boolean {
  return ANVIL_RESERVED_TOP_FOLDED.has(foldName(segment));
}

/**
 * True if package content must never be **placed** at this top-level segment —
 * the union of {@link isProtectedTop} and {@link isAnvilReservedTop}.
 *
 * This is the predicate every placement-declaring surface asks (a manifest item's
 * declared path, a `.mrpack` file entry, an imported override tree). It is
 * deliberately *not* what `safeJoin` and the working-tree exclusion ask — see
 * {@link ANVIL_RESERVED_TOP} for why those two must stay on the narrower set.
 */
export function isPlacementRefusedTop(segment: string): boolean {
  return isProtectedTop(segment) || isAnvilReservedTop(segment);
}

/**
 * The names Windows reserves for character devices. Reserved **case-insensitively
 * and with any extension**: `CON`, `con`, and `con.txt` all name the console
 * device, while `console` is an ordinary filename. Opening one yields a device
 * handle rather than a file, so writing `mods/con.txt` on Windows fails at the
 * OS level instead of creating a file.
 */
const WINDOWS_DEVICE_NAMES = new Set([
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

/**
 * True when a single path segment names a Windows reserved device.
 *
 * The boundary is the **stem before the first `.`**, case-folded: `con`,
 * `CON.TXT` and `con.tar.gz` are all the console device, and `console`,
 * `con2` and `mycon` are ordinary names. Matching the whole segment instead
 * would miss `con.txt`; matching a prefix would reject `console`.
 */
export function isWindowsDeviceName(segment: string): boolean {
  return WINDOWS_DEVICE_NAMES.has(foldName(segment).split(".")[0] ?? "");
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
