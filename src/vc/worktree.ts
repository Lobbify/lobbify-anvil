/**
 * The working-tree walk: which **undeclared** files a snapshot tracks, the
 * exclusion model that decides it, and the path-level 3-way that merges two
 * tracked sets.
 *
 * Without this, a commit captured only `anvil.toml` / `anvil.lock` /
 * `.anvilignore` and the carried local items — so hand-editing a config or
 * dropping a jar into `mods/` produced a `commit` that reported success and
 * recorded nothing. Tracked files close that hole.
 *
 * Four rules make the walk safe and cheap:
 *
 *   - **`.anvilignore` entries are TRACKED, not excluded.** `.anvilignore` means
 *     "the build must never create, move, or delete this" — i.e. *this file is
 *     mine, preserve it*. Its entries are exactly the hand-edited files this walk
 *     exists to capture, so it is not an exclusion input. Only the always-
 *     protected set it carries (`saves`, `.anvil`, `.anvilignore`) is honoured.
 *     The separate `.anvilexclude` is the "version control must not record this"
 *     file. One sentence: **`.anvilignore` protects a path from the build,
 *     `.anvilexclude` hides a path from version control.**
 *   - **The game install is excluded by hardcoded top-level segment**, not by
 *     asking the lock what it owns. A *stale* subtree left by an earlier lock (an
 *     old `versions/…`, a replaced `runtime/` JRE) is still build product;
 *     lock-derived ownership alone would sweep it into version control the moment
 *     the lock stopped naming it.
 *   - **Exclusion is applied to DIRECTORIES during the walk**, so an excluded
 *     subtree is never descended into. A real instance holds tens of thousands of
 *     asset objects; walking them and filtering afterwards is not an option.
 *   - **Only regular files are tracked.** A symlink is skipped (there is no
 *     representation for a link target in the object store, and following one can
 *     escape the instance); so are sockets, fifos, and devices.
 *
 * No file mode is recorded — see the header of `objects.ts` for why an exec bit
 * would make a commit id platform-dependent.
 */

import { type Dirent, createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readBuiltLock } from "../build/refs.js";
import { NATIVES_DIR } from "../game/mojang.js";
import { foldName, isProtectedTop } from "../internal/fs.js";
import type { LockPackage, Lockfile } from "../types/index.js";
import type { TrackedFile, VcObjectStore } from "./objects.js";
import { blobIdOfStream, encodeObject, idOfEncoding } from "./objects.js";

/** The optional root file listing paths version control must not record. */
export const EXCLUDE_FILE = ".anvilexclude";

/** Root files that already have their own snapshot slot (never tracked twice). */
const SNAPSHOT_SLOTS = ["anvil.toml", "anvil.lock", ".anvilignore"].map(foldName);

/**
 * Top-level segments holding the game install. Pure build product, tens of
 * thousands of files, and re-derivable from the lock — never version-controlled.
 */
const GAME_INSTALL_TOP = ["assets", "libraries", "versions", NATIVES_DIR, "runtime"];

/**
 * Top-level segments holding runtime churn and user-local data. Hardcoded so an
 * instance with no `.anvilexclude` still gets the protection; a user who wants
 * one of these recorded can only get it by... not having one, which is the point.
 */
const DEFAULT_EXCLUDE_TOP = [
  "logs",
  "crash-reports",
  "screenshots",
  "backups",
  "debug",
  ".fabric",
  ".mixin.out",
  ".cache",
  "server-resource-packs",
  "usercache.json",
  "usernamecache.json",
  "realms_persistence.json",
];

const ALWAYS_EXCLUDED_TOP = new Set([...GAME_INSTALL_TOP, ...DEFAULT_EXCLUDE_TOP].map(foldName));

/**
 * Basenames excluded at **any depth**, whether or not the instance has an
 * `.anvilexclude`.
 *
 * `DEFAULT_EXCLUDE_TOP` matches a top-level segment, so it structurally cannot
 * express OS cruft: macOS writes a `.DS_Store` into every directory a user opens
 * in Finder, Windows drops `Thumbs.db` / `desktop.ini` beside images, and editors
 * leave swap files wherever the file being edited lives. Without a basename rule,
 * merely browsing the instance folder dirties the working tree, writes the cruft
 * into history for good, and makes `switch` refuse over files the user does not
 * know exist.
 */
const DEFAULT_EXCLUDE_BASENAME = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".directory",
  "*.swp",
  "*.swo",
  "*~",
];

/** Files at or above this size are hashed by streaming rather than by full read. */
const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** How many files the walk hashes at once. Bounded so a big instance cannot flood I/O. */
const HASH_CONCURRENCY = 8;

// --- `.anvilexclude` -------------------------------------------------------

/**
 * One parsed `.anvilexclude` line. Which of the three forms a line takes is
 * decided by what it contains, not by a sigil:
 *
 *   - `glob` — a `*` and no `/`: a **basename** glob matched at any depth
 *     (`*.log`), split here into the literal parts between its wildcards.
 *   - `path` — a `*` **and** a `/`: matched against the whole instance-relative
 *     path, one segment at a time (`config/*.json`), each segment split the same
 *     way. A `*` never crosses a `/`.
 *   - `prefix` — no `*`: a literal path, matching it and everything under it.
 */
export type ExcludePattern =
  | { readonly kind: "glob"; readonly parts: readonly string[] }
  | { readonly kind: "path"; readonly segments: readonly (readonly string[])[] }
  | { readonly kind: "prefix"; readonly path: string };

/** Normalize a candidate or pattern path: `\` → `/`, no leading `./`, no trailing `/`. */
function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Split one pattern segment on its wildcards into the literal parts between them. */
function globParts(segment: string): string[] {
  return segment.split("*");
}

/**
 * Parse `.anvilexclude` text. The syntax is deliberately small: blank lines and
 * `#` comments are ignored, `*` is the only wildcard (no `?`, no `**`), and a
 * line takes one of the three {@link ExcludePattern} forms. There is no negation
 * (`!`); a v1 with one unambiguous direction beats one where the order of two
 * rules decides whether a file is in the commit.
 *
 * A line with a `*` **and** a `/` is a path pattern, not a basename one. Matching
 * `config/*.json` against a basename can never succeed — a basename holds no `/` —
 * so the obvious `.gitignore`-shaped line would silently protect nothing, with no
 * parse error to say so.
 */
export function parseAnvilexclude(text: string): ExcludePattern[] {
  const patterns: ExcludePattern[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const normalized = foldName(normalizePath(line));
    if (normalized.length === 0) {
      continue;
    }
    if (!normalized.includes("*")) {
      patterns.push({ kind: "prefix", path: normalized });
      continue;
    }
    if (!normalized.includes("/")) {
      patterns.push({ kind: "glob", parts: globParts(normalized) });
      continue;
    }
    const segments = normalized.split("/").filter((s) => s.length > 0);
    if (segments.length > 0) {
      patterns.push({ kind: "path", segments: segments.map(globParts) });
    }
  }
  return patterns;
}

/** The built-in basename excludes, parsed by the matcher `.anvilexclude` globs use. */
const DEFAULT_BASENAME_PATTERNS: readonly ExcludePattern[] = DEFAULT_EXCLUDE_BASENAME.map(
  (raw) => ({ kind: "glob", parts: globParts(foldName(raw)) }) as const,
);

/**
 * True when an instance-relative path IS the root `.anvilexclude`. Materialize
 * needs it to find the exclude file a target commit carries in its own tracked
 * set, and the comparison folds because the file is tracked under whatever case
 * the filesystem handed back.
 */
export function isExcludeFilePath(relPath: string): boolean {
  return foldName(normalizePath(relPath)) === foldName(EXCLUDE_FILE);
}

/** Match one name against a `*`-only glob already split on its wildcards. */
function globMatches(parts: readonly string[], name: string): boolean {
  const first = parts[0] ?? "";
  if (parts.length <= 1) {
    // No wildcard in this piece — an exact match, not a prefix one. Reached by the
    // literal segments of a path pattern and by a wildcard-free built-in basename.
    return name === first;
  }
  const last = parts[parts.length - 1] ?? "";
  if (!name.startsWith(first) || !name.endsWith(last)) {
    return false;
  }
  let from = first.length;
  const until = name.length - last.length;
  if (until < from) {
    return false;
  }
  for (const middle of parts.slice(1, -1)) {
    if (middle.length === 0) {
      continue;
    }
    const at = name.indexOf(middle, from);
    if (at < 0 || at + middle.length > until) {
      return false;
    }
    from = at + middle.length;
  }
  return true;
}

/**
 * Match a `/`-bearing pattern against the full instance-relative path, one
 * segment at a time — so a `*` matches within a segment and never crosses a `/`.
 *
 * A path pattern matches the path it names **and everything under it**, the same
 * rule a literal prefix line follows. That is what lets `config/*` prune a whole
 * directory during the walk instead of only its immediate children, and it keeps
 * the walk (which asks about directories) and materialize (which asks about full
 * file paths) answering the same question.
 */
function pathGlobMatches(
  pattern: readonly (readonly string[])[],
  segments: readonly string[],
): boolean {
  if (segments.length < pattern.length) {
    return false;
  }
  return pattern.every((parts, i) => globMatches(parts, segments[i] ?? ""));
}

/** Does one parsed pattern claim this (already folded + split) candidate path? */
function patternMatches(
  pattern: ExcludePattern,
  folded: string,
  segments: readonly string[],
): boolean {
  switch (pattern.kind) {
    case "glob":
      return globMatches(pattern.parts, segments[segments.length - 1] ?? "");
    case "path":
      return pathGlobMatches(pattern.segments, segments);
    default:
      return folded === pattern.path || folded.startsWith(`${pattern.path}/`);
  }
}

// --- build-owned paths -----------------------------------------------------

/** The instance paths (and subtrees) a lock's placements own. Case-folded. */
export interface BuildOwnedPaths {
  /** Exact instance-relative paths a placement writes. */
  readonly files: ReadonlySet<string>;
  /** Instance-relative subtrees a placement owns wholesale. */
  readonly trees: readonly string[];
}

/** The top-level segment of an instance-relative path. */
function topSegment(path: string): string {
  return normalizePath(path).split("/")[0] ?? "";
}

function ownedByPackage(pkg: LockPackage, files: Set<string>, trees: Set<string>): void {
  const p = pkg.placement;
  switch (p.method) {
    case "link":
      files.add(foldName(normalizePath(p.target)));
      return;
    case "extract":
      trees.add(foldName(normalizePath(p.targetDir)));
      return;
    case "asset-tree":
      // The index lands at `assets/indexes/<id>.json`, but the objects it names
      // fan out under `assets/objects/**` — paths `targetsOf` never reports. Own
      // the whole top-level segment, or every asset object reads as undeclared.
      trees.add(foldName(topSegment(p.indexTarget)));
      return;
    case "runtime-tree":
      trees.add(foldName(normalizePath(p.targetDir)));
      return;
    case "forge-build":
      for (const out of p.outputs) {
        files.add(foldName(normalizePath(out)));
      }
      return;
    case "store-only":
      return;
    default:
      return;
  }
}

/**
 * The paths the build owns across a set of locks. The **union** of the current
 * lock and the built lock is what the walk uses: a lock edited but not yet built
 * would otherwise briefly reclassify live build output as undeclared, and a whole
 * game install would land in the next commit.
 */
export function buildOwnedPaths(locks: readonly (Lockfile | undefined)[]): BuildOwnedPaths {
  const files = new Set<string>();
  const trees = new Set<string>();
  for (const lock of locks) {
    for (const pkg of lock?.resolved ?? []) {
      ownedByPackage(pkg, files, trees);
    }
  }
  return { files, trees: [...trees].sort() };
}

// --- the exclusion set -----------------------------------------------------

/**
 * The "version control does not manage this path" predicate. It is asked about
 * directories as well as files during the walk, so an excluded subtree is pruned
 * rather than filtered, and materialize asks it too — an excluded path is skipped
 * for **writes and deletes alike**, or adding `screenshots/` to `.anvilexclude`
 * and switching branches would delete the screenshots an older commit tracked.
 */
export class WorktreeExclusion {
  readonly #patterns: readonly ExcludePattern[];
  readonly #ownedFiles: ReadonlySet<string>;
  readonly #ownedTrees: readonly string[];

  constructor(
    opts: {
      readonly patterns?: readonly ExcludePattern[];
      readonly owned?: BuildOwnedPaths;
    } = {},
  ) {
    this.#patterns = opts.patterns ?? [];
    this.#ownedFiles = opts.owned?.files ?? new Set();
    this.#ownedTrees = opts.owned?.trees ?? [];
  }

  /** True when version control must not record (or materialize) this path. */
  excludes(relPath: string): boolean {
    // Folding the whole path is folding each segment: `foldName` only lowercases
    // and NFC-normalizes, and `/` is fixed under both.
    const folded = foldName(normalizePath(relPath));
    const segments = folded.split("/").filter((s) => s.length > 0 && s !== ".");
    const top = segments[0];
    if (top === undefined) {
      return true; // the instance root itself is not a candidate
    }
    if (segments.length === 1 && SNAPSHOT_SLOTS.includes(top)) {
      return true;
    }
    if (isProtectedTop(top) || ALWAYS_EXCLUDED_TOP.has(top)) {
      return true;
    }
    if (this.#ownedFiles.has(folded)) {
      return true;
    }
    for (const tree of this.#ownedTrees) {
      if (folded === tree || folded.startsWith(`${tree}/`)) {
        return true;
      }
    }
    // The built-in basenames come first and apply everywhere, exactly like the
    // hardcoded tops above: an instance with no `.anvilexclude` still gets them.
    for (const pattern of DEFAULT_BASENAME_PATTERNS) {
      if (patternMatches(pattern, folded, segments)) {
        return true;
      }
    }
    for (const pattern of this.#patterns) {
      if (patternMatches(pattern, folded, segments)) {
        return true;
      }
    }
    return false;
  }
}

export interface LoadExclusionInput {
  readonly instanceDir: string;
  /**
   * Locks whose placements name build-owned paths — pass the current and built
   * locks when snapshotting. Omitted by materialize, which has only the built-in
   * defaults and the on-disk `.anvilexclude` to go on.
   */
  readonly locks?: readonly (Lockfile | undefined)[];
}

/**
 * Read `.anvilexclude` (absent is fine) and combine it with the build-owned paths.
 *
 * Only `ENOENT` means "there is no exclude file". Every other error is rethrown,
 * for the same reason the walk rethrows one: an `EACCES` degrading to "no rules"
 * silently drops exactly the delete-protection materialize consults this set for,
 * and a switch would then remove the paths the file was written to protect.
 */
export async function loadWorktreeExclusion(input: LoadExclusionInput): Promise<WorktreeExclusion> {
  let patterns: ExcludePattern[] = [];
  try {
    patterns = parseAnvilexclude(await readFile(join(input.instanceDir, EXCLUDE_FILE), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  return new WorktreeExclusion({ patterns, owned: buildOwnedPaths(input.locks ?? []) });
}

/** The exclusion a snapshot of `instanceDir` uses: defaults + `.anvilexclude` + the locks. */
export async function snapshotExclusion(
  instanceDir: string,
  lock: Lockfile | undefined,
): Promise<WorktreeExclusion> {
  return loadWorktreeExclusion({
    instanceDir,
    locks: [lock, await readBuiltLock(instanceDir)],
  });
}

// --- the walk --------------------------------------------------------------

/**
 * Whether a filesystem error means "this path raced away mid-walk" — the only
 * kind the walk may swallow. `ENOENT` (gone) and `ENOTDIR` (a parent replaced by
 * a file) are genuinely fine to skip: the tree moved under us, and the next
 * commit sees whatever it settled into.
 *
 * Everything else — `EACCES` above all — is a real failure, and swallowing it is
 * silent data loss: a file that merely could not be read would be absent from the
 * tracked set, and absence IS deletion in a full-state snapshot. `commit` would
 * cheerfully record the removal of files that are still sitting on disk. So the
 * walk fails loudly instead.
 */
function isRacedAway(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function walkInto(
  dir: string,
  prefix: string,
  exclude: WorktreeExclusion,
  out: string[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!isRacedAway(err)) {
      throw err; // unreadable ≠ empty — see `isRacedAway`
    }
    return; // removed under us — nothing to track here
  }
  // A fixed (name-sorted) order keeps the walk itself deterministic; the tracked
  // array is sorted by full path afterwards, which is a different order.
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (exclude.excludes(rel)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkInto(join(dir, entry.name), rel, exclude, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
    // `Dirent` predicates do not follow links, so a symlink is neither of those
    // and falls through here — deliberately skipped, along with sockets/fifos.
  }
}

/** Every trackable candidate under `instanceDir`, instance-relative and POSIX. */
export async function walkWorktree(
  instanceDir: string,
  exclude: WorktreeExclusion,
): Promise<string[]> {
  const out: string[] = [];
  await walkInto(instanceDir, "", exclude, out);
  return out;
}

export interface TrackWorktreeInput {
  readonly instanceDir: string;
  readonly vcStore: VcObjectStore;
  readonly exclude: WorktreeExclusion;
  /**
   * Admit newly-seen bytes as VC blobs. `false` keeps the walk read-only, which
   * is what `status` needs: it reports whether the tree is dirty, it does not
   * write history.
   */
  readonly store?: boolean;
}

/**
 * The path form a {@link TrackedFile} stores: NFC, always.
 *
 * `readdir` hands back whatever byte sequence the filesystem holds, and
 * filesystems disagree about Unicode normalization — macOS classically returns
 * NFD where Linux returns what was written. That string is hashed into the
 * snapshot id, so `café.txt` would otherwise produce a **different commit id on
 * macOS than on Linux** for an identical logical tree, breaking the "identical
 * commit hash on Node 20/22 and every OS" guarantee (the same guarantee that is
 * the documented reason no file mode is recorded — see `objects.ts`). NFC is what
 * `foldName` already normalizes to, so the stored form and the protection checks
 * agree.
 *
 * Only the **stored** path is normalized. Every read still uses the raw name the
 * directory gave us: on a filesystem that preserves the NFD bytes, opening the
 * NFC spelling fails.
 */
function toTrackedPath(rel: string): string {
  return rel.normalize("NFC");
}

/**
 * Hash one candidate, admitting its bytes when asked to.
 *
 * Store presence is **probed, never inferred**. A prior snapshot recording the
 * same blob id for this path says a snapshot mentioned those bytes, which is not
 * the claim that the object is in this store — and the short-circuit bought
 * nothing anyway, since `put` already stats before writing. The only thing worth
 * avoiding is loading a large unchanged file into memory, which the streaming
 * branch handles with a real `has()`.
 */
async function trackOne(rel: string, input: TrackWorktreeInput): Promise<TrackedFile | undefined> {
  const abs = join(input.instanceDir, rel);
  let size: number;
  try {
    const st = await lstat(abs);
    if (!st.isFile()) {
      return undefined; // swapped for a link/dir since the walk — not trackable
    }
    size = st.size;
  } catch (err) {
    if (!isRacedAway(err)) {
      throw err; // an unreadable file must not read as a deleted one
    }
    return undefined; // deleted since the walk
  }

  if (size >= STREAM_THRESHOLD_BYTES) {
    const blob = await blobIdOfStream(createReadStream(abs));
    // The full read happens ONLY when the store does not already hold the bytes,
    // so a big unchanged file is never loaded just to discover it is unchanged.
    if (input.store && !(await input.vcStore.has(blob))) {
      await input.vcStore.putBlob(new Uint8Array(await readFile(abs)));
    }
    return { path: toTrackedPath(rel), blob };
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(abs));
  } catch (err) {
    if (!isRacedAway(err)) {
      throw err; // ditto: EACCES is a failure, not an absence
    }
    return undefined;
  }
  const blob = idOfEncoding(encodeObject({ type: "blob", bytes }));
  if (input.store) {
    await input.vcStore.putBlob(bytes); // dedups internally (a `has` stat, then write)
  }
  return { path: toTrackedPath(rel), blob };
}

/**
 * The tracked set of the current working tree, sorted by path. Hashing runs at a
 * bounded concurrency (a modpack instance is thousands of files; `Promise.all`
 * over all of them would open thousands of descriptors at once).
 */
export async function trackWorktree(input: TrackWorktreeInput): Promise<TrackedFile[]> {
  const candidates = await walkWorktree(input.instanceDir, input.exclude);
  const results: (TrackedFile | undefined)[] = new Array(candidates.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const i = next++;
      const rel = candidates[i];
      if (rel !== undefined) {
        results[i] = await trackOne(rel, input);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, candidates.length) }, () => worker()),
  );
  return results
    .filter((t): t is TrackedFile => t !== undefined)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// --- merging two tracked sets ----------------------------------------------

/** The outcome of a {@link mergeTrackedSets} — the merged set plus what it had to decide. */
export interface TrackedMergeResult {
  readonly tracked: readonly TrackedFile[];
  readonly warnings: readonly string[];
}

function indexByPath(files: readonly TrackedFile[]): Map<string, TrackedFile> {
  return new Map(files.map((f) => [f.path, f]));
}

/**
 * A path-level 3-way over two tracked sets — the same shape as anvil's item-set
 * merge, one level down. Without it, a merge would snapshot the working tree
 * (which is "ours") and silently drop every file the other branch added.
 *
 * | base | ours | theirs | result |
 * | --- | --- | --- | --- |
 * | absent | absent | present | take theirs (their addition) |
 * | absent | present | absent | keep ours (our addition) |
 * | absent | present | present, blobs differ | ours wins, with a warning |
 * | present as B | equals B | absent | delete (ours untouched, theirs deleted) |
 * | present as B | differs from B | absent | keep ours, **with a warning** |
 * | present as B | absent | equals B | stay deleted (theirs untouched) |
 * | present as B | absent | differs from B | stay deleted, **with a warning** |
 * | present | present | present, blobs differ | ours wins, with a warning |
 * | any | same blob | same blob | keep, no warning |
 *
 * The two modify/delete rows are why the base is consulted at all. Deciding a
 * one-sided survivor purely on "was it in the base" drops a file that one side
 * *edited* and the other merely deleted — the edit is gone, no commit records it,
 * and nothing says so. That is exactly the silent-loss class tracked files exist
 * to close, so a modify/delete never resolves quietly: the surviving side is
 * announced along with what was thrown away. An untouched-vs-deleted pair is a
 * clean deletion and stays silent, or every switch would be noise.
 *
 * It merges the set **by path**. It never merges file **contents** — anvil does
 * not diff or splice bytes, and divergent content is resolved ours-wins loudly
 * rather than quietly.
 */
export function mergeTrackedSets(
  base: readonly TrackedFile[],
  ours: readonly TrackedFile[],
  theirs: readonly TrackedFile[],
): TrackedMergeResult {
  const inBase = indexByPath(base);
  const inOurs = indexByPath(ours);
  const inTheirs = indexByPath(theirs);
  const tracked: TrackedFile[] = [];
  const warnings: string[] = [];

  // Paths present on neither side are deleted by both — nothing to emit.
  for (const path of [...new Set([...inOurs.keys(), ...inTheirs.keys()])].sort()) {
    const our = inOurs.get(path);
    const their = inTheirs.get(path);
    const priorFile = inBase.get(path);
    if (our && their) {
      tracked.push(our);
      if (our.blob.value !== their.blob.value) {
        warnings.push(
          `tracked file "${path}" changed on both sides — keeping ours (anvil never merges file contents)`,
        );
      }
      continue;
    }
    if (our) {
      // Ours has it, theirs does not. A new file when the base never had it; a
      // deletion by them when it did — and if we also edited it since the base,
      // honouring their deletion would throw our edit away, so ours survives.
      if (!priorFile) {
        tracked.push(our);
      } else if (our.blob.value !== priorFile.blob.value) {
        tracked.push(our);
        warnings.push(
          `tracked file "${path}" was edited here and deleted on the other side — keeping ours (their deletion is discarded)`,
        );
      }
      continue;
    }
    if (their) {
      // Theirs has it, ours does not: their addition, or our deletion. Our
      // deletion stands, but an edit of theirs going with it is announced.
      if (!priorFile) {
        tracked.push(their);
      } else if (their.blob.value !== priorFile.blob.value) {
        warnings.push(
          `tracked file "${path}" was deleted here and edited on the other side — staying deleted (their edit is discarded)`,
        );
      }
    }
  }
  return { tracked, warnings };
}
