/**
 * Replay provenance as a property of **bytes**, not of what the current lock
 * happens to name — the admission-side half of the replay-never-rehosted
 * invariant (CurseForge ToS).
 *
 * `replay-cache.ts` keeps CurseForge bytes out of every path that enumerates the
 * shared store. That holds for as long as a replay item's bytes exist only in the
 * replay cache and at a path some lock still claims. Both assumptions break the
 * moment a build strands a jar:
 *
 *   - a version bump renames the file (`mods/jei-1.19.2.jar` →
 *     `mods/jei-1.20.1.jar`), and the old path is in neither the current nor the
 *     built lock;
 *   - with no built lock there are no removals at all, so nothing is swept;
 *   - `.anvilignore` matches by top-level segment, so a line naming any file
 *     under `mods/` makes the swap skip *removing* a superseded replay jar.
 *
 * A stranded jar is then an ordinary undeclared file in the instance tree, and
 * the working-tree walk would admit its bytes into `.anvil/objects/` as a VC
 * blob. A `TrackedFile` records a path and a blob id and nothing else — no
 * provenance, no content hash — so from that point nothing downstream can tell
 * the bytes came from CurseForge, and `push` ships them.
 *
 * ## The rule, and why it is shaped this way
 *
 * The **content check** is the real one: bytes already in this instance's replay
 * cache are replay bytes, definitionally, whatever the file is called. The cache
 * has no eviction or prune path anywhere in the codebase, so "present" is a
 * durable signal rather than a cache-warmth accident.
 *
 * The **ledger** ({@link readReplayPaths}) exists only for the state where the
 * content check cannot answer: the user deleted `.anvil/replay-cache/`. It is not
 * a second opinion running alongside the content check, and deliberately so — an
 * earlier revision let a claimed path veto unconditionally, which meant a path
 * that once held a CurseForge jar was excluded from version control forever, for
 * whatever file later occupied it. `mods/<popular-mod>.jar` is exactly the name a
 * user re-creates by hand when they follow CurseForge's own "download it
 * yourself" workflow, and their file silently vanished from every commit.
 *
 * So {@link ReplayVeto.verdict} reads:
 *
 *   - bytes in the cache → veto, silently. The real case.
 *   - cache present, bytes not in it → **track**, even at a claimed path. The
 *     bytes demonstrably did not come from a replay item this instance holds.
 *   - cache absent, path claimed → veto, and **warn**. Fail safe, out loud.
 *   - otherwise → track.
 *
 * ## What this does NOT cover
 *
 * The two mechanisms do not compose into a complete guard, and reading them as
 * "either one catches it" is wrong. They share a blind spot: **replay cache
 * deleted AND the jar renamed**. The content check cannot run and the ledger has
 * never seen the new path, so the file is tracked and can be pushed. `build`
 * warns when it finds a non-empty ledger with no cache root, which is the only
 * signal available before the fact. Do not describe the pair as exhaustive.
 *
 * The receive side does not rely on either: {@link replayPinsOf} reads the pins
 * out of the incoming history's own locks, which needs no local state at all.
 */

import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, foldPath, pathExists } from "../internal/fs.js";
import type { Hash, HashAlgo, Lockfile } from "../types/index.js";
import { hashBuffer, hashKey } from "./hash.js";
import { targetsOf } from "./placement.js";
import { ReplayCache } from "./replay-cache.js";

/**
 * The ledger's instance-relative path. It lives under `.anvil/`, which
 * `isProtectedTop` already excludes from the walk, so the ledger can never
 * become a tracked file itself.
 */
export const REPLAY_PATHS_REF = join(".anvil", "refs", "replay-paths");

/**
 * The hash algorithms a replay pin may use, and therefore the digests a
 * candidate file has to be checked under.
 *
 * A directly-referenced `curseforge:` item pins **sha256** (that path downloads
 * the bytes anyway). A CurseForge **base pack** member pins **sha1**: the pack
 * names `(projectID, fileID)` and the strongest hash the API attests for a file
 * is sha1, so resolving a 482-member pack downloads nothing. Checking one domain
 * leaves the other half of the replay surface unguarded.
 */
export const REPLAY_PIN_ALGOS: readonly HashAlgo[] = ["sha256", "sha1"];

/** No digests wanted — what {@link ReplayVeto.algos} returns with no cache. */
const NO_ALGOS: readonly HashAlgo[] = [];

/** The placement targets every `provenance: "replay"` row across `locks` claims. */
export function replayTargetsOf(locks: readonly (Lockfile | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const lock of locks) {
    for (const pkg of lock?.resolved ?? []) {
      if (pkg.provenance !== "replay") {
        continue;
      }
      for (const target of targetsOf(pkg)) {
        out.add(foldPath(target));
      }
    }
  }
  return out;
}

/**
 * The content pins of every `provenance: "replay"` row across `locks`, as
 * `"algo:value"` keys.
 *
 * This is what makes the **receive** side self-contained. A pulled snapshot
 * carries its own lock, and those replay rows are an authoritative, byte-level
 * statement of which incoming blobs are CurseForge content — no local ledger, no
 * local cache, nothing a fresh clone does not already have in hand.
 */
export function replayPinsOf(locks: readonly (Lockfile | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const lock of locks) {
    for (const pkg of lock?.resolved ?? []) {
      if (pkg.provenance === "replay") {
        out.add(hashKey(pkg.hash));
      }
    }
  }
  return out;
}

/** The content digests of an in-memory buffer, under every replay pin algorithm. */
export function replayDigestsOf(bytes: Uint8Array): ReadonlyMap<HashAlgo, Hash> {
  return new Map(REPLAY_PIN_ALGOS.map((algo) => [algo, hashBuffer(bytes, algo)]));
}

/** True when any of a candidate's digests is one of `pins`. */
export function matchesReplayPin(
  digests: ReadonlyMap<HashAlgo, Hash>,
  pins: ReadonlySet<string>,
): boolean {
  if (pins.size === 0) {
    return false;
  }
  for (const hash of digests.values()) {
    if (pins.has(hashKey(hash))) {
      return true;
    }
  }
  return false;
}

/**
 * The instance paths recorded as having held replay bytes, in {@link foldPath}
 * form. An absent ledger is an empty set.
 *
 * Only `ENOENT` means "there is no ledger". Every other error is rethrown, for
 * the same reason `loadWorktreeExclusion` rethrows one: an `EACCES` degrading to
 * "no claimed paths" removes a protection with no trace that it was ever there.
 */
export async function readReplayPaths(instanceDir: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(join(instanceDir, REPLAY_PATHS_REF), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw err;
  }
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      out.add(foldPath(trimmed));
    }
  }
  return out;
}

/**
 * Claim the placement targets of every replay row in `locks`, unioned into
 * whatever the ledger already holds.
 *
 * **Union only, never shrink.** A path stays claimed after the lock stops naming
 * it, which is the only state the ledger exists for. It does not over-exclude a
 * user's own file on its own: see {@link ReplayVeto.verdict}, where a claimed
 * path only vetoes when the content check cannot run.
 *
 * Written atomically and durably: tmp → fsync → rename. The fsync is not
 * ceremony. Without it a crash can leave a zero-length file at the final path,
 * and `readReplayPaths` reads that as "nothing is claimed" — the same silent
 * downgrade the `ENOENT`-only rule above exists to prevent.
 */
export async function recordReplayPaths(
  instanceDir: string,
  locks: readonly (Lockfile | undefined)[],
): Promise<void> {
  const claimed = replayTargetsOf(locks);
  if (claimed.size === 0) {
    return;
  }
  const existing = await readReplayPaths(instanceDir);
  if ([...claimed].every((path) => existing.has(path))) {
    return; // nothing new to claim — leave the file (and its mtime) alone
  }
  const merged = [...new Set([...existing, ...claimed])].sort();
  const finalPath = join(instanceDir, REPLAY_PATHS_REF);
  await ensureDir(join(finalPath, ".."));
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmpPath, `${merged.join("\n")}\n`);
    const fh = await open(tmpPath, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, finalPath);
  } finally {
    // The rename already consumed it, so this only fires on a failure path — the
    // temp never outlives the call. `.anvil/refs/` has no orphan sweep of its own.
    await unlink(tmpPath).catch(() => undefined);
  }
}

/** What {@link ReplayVeto.verdict} decided about one candidate's bytes. */
export type ReplayVerdict =
  /** Not replay content: record it. */
  | "track"
  /** The bytes are in the replay cache. Definitional, and silent. */
  | "veto"
  /** The path is claimed but the cache is gone, so the bytes cannot be checked. */
  | "veto-unverified";

/**
 * The replay admission rule for one instance: the ledger, plus a membership
 * query against the replay cache.
 *
 * The cache is asked with {@link ReplayCache.has} — one `stat` per digest, never
 * an enumeration. Its non-enumerability is the structural property that keeps the
 * shared store, transfer and export code from reaching a replay object, and an
 * `entries()` on it would hand that capability to every future caller.
 */
export class ReplayVeto {
  readonly #cache: ReplayCache;
  readonly #paths: ReadonlySet<string>;
  readonly #cachePresent: boolean;

  private constructor(cache: ReplayCache, paths: ReadonlySet<string>, cachePresent: boolean) {
    this.#cache = cache;
    this.#paths = paths;
    this.#cachePresent = cachePresent;
  }

  /** Read the ledger and probe the cache root once, up front. */
  static async load(instanceDir: string): Promise<ReplayVeto> {
    const cache = new ReplayCache({ instanceDir });
    return new ReplayVeto(cache, await readReplayPaths(instanceDir), await pathExists(cache.root));
  }

  /** A veto that can never fire — for a caller with no instance (unit tests). */
  static none(): ReplayVeto {
    return new ReplayVeto(new ReplayCache({ instanceDir: "" }), new Set(), false);
  }

  /**
   * The digest algorithms a caller should compute for {@link verdict}. Empty when
   * there is no cache to compare against, so an instance that never had a replay
   * item pays nothing beyond the one probe `load` already did.
   */
  get algos(): readonly HashAlgo[] {
    return this.#cachePresent ? REPLAY_PIN_ALGOS : NO_ALGOS;
  }

  /** True when a ledger exists but the cache does not — the degraded state. */
  get degraded(): boolean {
    return !this.#cachePresent && this.#paths.size > 0;
  }

  /** The recorded paths, for a caller that needs the ledger itself. */
  get claimedPaths(): ReadonlySet<string> {
    return this.#paths;
  }

  /** Whether the bytes behind `digests` are in the replay cache. */
  async isCached(digests: ReadonlyMap<HashAlgo, Hash>): Promise<boolean> {
    for (const hash of digests.values()) {
      if (await this.#cache.has(hash)) {
        return true;
      }
    }
    return false;
  }

  /** The admission rule (see this module's header for why it is shaped this way). */
  async verdict(relPath: string, digests: ReadonlyMap<HashAlgo, Hash>): Promise<ReplayVerdict> {
    if (this.#cachePresent) {
      return (await this.isCached(digests)) ? "veto" : "track";
    }
    return this.#paths.has(foldPath(relPath)) ? "veto-unverified" : "track";
  }
}

/** The message a refusal to materialize incoming replay bytes reports. */
export function refusedReplayWarning(relPath: string): string {
  return (
    `skipping "${relPath}": the incoming history records CurseForge (replay) content at that ` +
    "path. Those bytes are fetched per-client under your own API key and are never re-hosted, so " +
    "they are not written here. Add the item to `anvil.toml` and run `anvil build` with your own " +
    "CurseForge key to obtain it."
  );
}

/** The message a `veto-unverified` verdict reports. */
export function unverifiedReplayWarning(relPath: string): string {
  return (
    `not recording "${relPath}": a previous build placed CurseForge (replay) content there, and ` +
    "the per-instance replay cache is missing, so its bytes cannot be checked. Re-run `anvil build` " +
    "to restore the cache; if the file is your own, move it to a path no replay item has used."
  );
}
