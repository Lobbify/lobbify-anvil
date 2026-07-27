/**
 * `.anvil/base.lock` — the resolved base pack's **full** member set, cached.
 *
 * ## Why this file has to exist
 *
 * The instance lock records the base members that *survived* the overlay:
 * removals and overrides are already applied. That is the right content for a
 * build, and the wrong content to re-lock from. Re-running the overlay against
 * survivors would see a `game.remove` entry match nothing (it already matched,
 * last time) and a base member that an override displaced could never come back
 * when the override is deleted. The base's member set as the pack published it is
 * a distinct fact from the instance's effective set, and it needs its own home.
 *
 * So the resolver's full base set is written here, beside `.anvil/graph.json` —
 * same pattern, same reason: a fact `lock` produced that the deterministic lock
 * must not carry, kept where the next `lock` can read it offline.
 *
 * ## Format
 *
 * The canonical lock format, deliberately: it means this file is parsed by the
 * same hardened, tolerant reader as a real lock rather than by a second parser
 * written to a lower standard. It is **not** an instance lock and is never built
 * from — `[meta]` is filled with the base's own game target, `manifest_hash`
 * carries the base archive's pin (there is no manifest here), and `java` is
 * `"n/a"`. The `[base]` block and the `[[package]]` rows are the real payload.
 *
 * ## Trust
 *
 * Same boundary as `anvil.lock` itself: anyone who can write `.anvil/` can
 * already write the lock. A file that does not parse, or that disagrees with the
 * lock's `[base]` block, is discarded rather than repaired — the cost is one
 * re-resolve, and a "repaired" cache is a lie about what a pack contains.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../internal/fs.js";
import { parseLock, serializeLock } from "../lock/serialize.js";
import type { Hash, Lockfile } from "../types/index.js";
import type { ResolvedBasePack } from "./types.js";

/** The base-set cache filename, under `.anvil/`. */
export const BASE_CACHE_FILENAME = "base.lock";

function cachePath(instanceDir: string): string {
  return join(instanceDir, ".anvil", BASE_CACHE_FILENAME);
}

/** A cache hit: the `game.from` string it was resolved for, and what it resolved to. */
export interface CachedBase {
  /** The `game.from` string **as authored** when this cache was written. */
  readonly ref: string;
  readonly pack: ResolvedBasePack;
  /** The base-set digest recorded alongside it. */
  readonly set: Hash;
}

/** Render a resolved base pack into the cache's lock-shaped form. */
export function baseCacheDocument(entry: CachedBase): Lockfile {
  const { pack } = entry;
  return {
    meta: {
      version: 1,
      manifestHash: pack.archive,
      minecraft: pack.game.minecraft,
      loader: pack.game.loader,
      java: "n/a",
    },
    base: {
      // The AUTHORED ref, not the resolved one: the next lock has to decide
      // whether this cache is for the base the manifest still names, and
      // `modrinth:atm10` resolving to `4.6` says nothing about whether the
      // manifest now asks for `@4.7`.
      ref: entry.ref,
      source: pack.source,
      id: pack.id,
      version: pack.version,
      archive: pack.archive,
      set: entry.set,
      members: pack.members.length,
    },
    resolved: pack.members,
  };
}

/** Atomically write the cache for a freshly-resolved base (`tmp → rename`). */
export async function writeBaseCache(instanceDir: string, entry: CachedBase): Promise<void> {
  const final = cachePath(instanceDir);
  await ensureDir(join(instanceDir, ".anvil"));
  const tmp = `${final}.${process.pid}.tmp`;
  await writeFile(tmp, serializeLock(baseCacheDocument(entry)));
  await rename(tmp, final);
}

/**
 * Read the cached base set, or `undefined` when it is absent, unreadable, or
 * malformed. Never throws: a missing cache is a re-resolve, not a failure.
 */
export async function readBaseCache(instanceDir: string): Promise<CachedBase | undefined> {
  let text: string;
  try {
    text = await readFile(cachePath(instanceDir), "utf8");
  } catch {
    return undefined;
  }
  let doc: Lockfile;
  try {
    doc = parseLock(text);
  } catch {
    return undefined;
  }
  const base = doc.base;
  if (!base) {
    return undefined;
  }
  return {
    ref: base.ref,
    set: base.set,
    pack: {
      source: base.source,
      id: base.id,
      version: base.version,
      archive: base.archive,
      game: { minecraft: doc.meta.minecraft, loader: doc.meta.loader },
      members: doc.resolved,
      warnings: [],
    },
  };
}
