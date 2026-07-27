/**
 * The per-instance **replay cache** — the storage-layer enforcement of the
 * replay-never-rehosted invariant (CurseForge ToS).
 *
 * CurseForge bytes are `provenance: "replay"`: fetched per-client under the
 * user's **own** API key and **never** re-hosted, transferred, pushed, or
 * exported. The plan makes this a property of **where the bytes live**, not a
 * lock-row flag — so that the code which serves, garbage-collects, transfers,
 * and exports objects *physically cannot enumerate* a replay object:
 *
 *   - the shared {@link ContentStore} lives at `~/.anvil/store` and only ever
 *     walks its own two domains (`assets/objects`, `blobs/objects`). It holds no
 *     reference to this class and never sees a replay object.
 *   - this cache lives under the instance's **`.anvil/replay-cache/`** — a
 *     protected top-level path that the atomic swap never touches, that
 *     `treeManifest`/exports exclude (`.anvil/` is metadata, not instance
 *     content), and that GC roots against the shared store, never this dir.
 *
 * Concretely: `build` acquires a replay item's bytes here (never the store) and
 * the placement executor materializes a replay item from here (never the store).
 * There is no method on the shared store that reads this directory, so a
 * sha-only transfer/serve path cannot leak a CurseForge jar. This is a
 * standing, hard review rule (see AGENT.md "Replay-never-rehosted").
 *
 * It is a small content-addressed cache in its own right — sharded, written
 * `0444` (immutable), atomic (`tmp → fsync → rename`), and it verifies bytes
 * against their pin on admission — but it is a deliberately **separate type**
 * from {@link ContentStore} so the separation is structural, not a convention.
 *
 * ## Two hash domains, like the shared store
 *
 * An object is addressed by **the algorithm its lock row pins**, in a per-algo
 * domain directory — the same shape {@link ContentStore.domainDir} uses. sha256
 * stays at `objects/`, so existing caches are unaffected.
 *
 * A sha1 domain exists because a CurseForge **base pack** member is pinned from
 * catalogue metadata rather than from bytes: the pack names `(projectID,
 * fileID)`, and the strongest hash the CurseForge API attests for a file is sha1
 * (algo 1; algo 2 is md5). Resolving a 482-member pack therefore downloads
 * nothing, which is the entire reason a pack that size is usable as a base — but
 * it means the pin arrives in the sha1 domain. Refusing it here would have
 * forced the alternative: fetching every member at lock time purely to compute a
 * sha256, discarding the bytes, and fetching them again at build time.
 *
 * The security property that matters is unchanged: **bytes are verified against
 * the lock's pin before they land**, in whichever algorithm that pin uses, and a
 * mismatch is a hard {@link ShaMismatch} with nothing admitted. sha1 is weaker
 * tamper-evidence than sha256 and is used only where CurseForge offers nothing
 * better; a directly-referenced `curseforge:` item still pins sha256, because
 * that path downloads the bytes anyway.
 */

import { rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { LinkStrategy } from "../events.js";
import { ensureDir, statDevOf } from "../internal/fs.js";
import { ShaMismatch } from "../types/errors.js";
import type { Hash } from "../types/index.js";
import { fsyncDir, writeTemp } from "./atomic.js";
import { hashEquals, shardOf } from "./hash.js";
import type { LinkOptions } from "./linking.js";
import { linkOrCopy } from "./linking.js";

/** The instance-relative directory the replay cache occupies (under `.anvil/`). */
export const REPLAY_CACHE_DIRNAME = "replay-cache";

export interface ReplayCacheOptions {
  /** The instance root — the cache lives at `<instanceDir>/.anvil/replay-cache/`. */
  readonly instanceDir: string;
  /** Injectable device-id probe (for cross-volume tests). */
  readonly statDev?: (path: string) => Promise<number>;
  readonly onWarn?: (message: string) => void;
}

/**
 * A per-instance, non-enumerable content-addressed cache for `replay` bytes.
 *
 * The API mirrors just enough of {@link ContentStore} to acquire and materialize
 * replay objects — but it is intentionally **not** a `ContentStore`, so nothing
 * that walks the shared store can ever reach a replay object through it.
 */
export class ReplayCache {
  /** The absolute cache root: `<instanceDir>/.anvil/replay-cache`. */
  readonly root: string;
  readonly #statDev: (path: string) => Promise<number>;
  readonly #onWarn?: (message: string) => void;

  constructor(opts: ReplayCacheOptions) {
    this.root = join(opts.instanceDir, ".anvil", REPLAY_CACHE_DIRNAME);
    this.#statDev = opts.statDev ?? statDevOf;
    this.#onWarn = opts.onWarn;
  }

  /** The scratch dir for atomic writes (under the cache root). */
  get #tmpDir(): string {
    return join(this.root, "tmp");
  }

  /**
   * The object directory for a hash algorithm. sha256 keeps the original
   * `objects/` path so existing caches keep resolving; sha1 gets its own domain
   * (see the module doc for why a replay pin may be sha1).
   */
  domainDir(algo: Hash["algo"]): string {
    return algo === "sha1" ? join(this.root, "objects-sha1") : join(this.root, "objects");
  }

  /** The absolute on-disk path a replay object with `hash` occupies. */
  objectPath(hash: Hash): string {
    return join(this.domainDir(hash.algo), shardOf(hash.value), hash.value);
  }

  /** True if the replay object is already cached (a prior build fetched it). */
  async has(hash: Hash): Promise<boolean> {
    try {
      await stat(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Admit a replay byte stream, verifying it hashes to `expected` **in that
   * pin's own algorithm** before it lands ({@link ShaMismatch} otherwise — the
   * bytes never enter the cache if they do not match the lock's pin). Dedups
   * when already present.
   */
  async #putStream(source: Readable, expected: Hash): Promise<{ deduped: boolean }> {
    const { tmpPath, hash } = await writeTemp(this.#tmpDir, source, expected.algo);
    if (!hashEquals(hash, expected)) {
      await unlink(tmpPath).catch(() => undefined);
      throw new ShaMismatch("replay-cache admission", expected, hash);
    }
    const dest = this.objectPath(hash);
    if (await this.has(hash)) {
      await unlink(tmpPath).catch(() => undefined);
      return { deduped: true };
    }
    await ensureDir(dirname(dest));
    try {
      await rename(tmpPath, dest); // temp is already 0444 — immutable at this instant
    } catch (err) {
      if (await this.has(hash)) {
        await unlink(tmpPath).catch(() => undefined);
        return { deduped: true };
      }
      throw err;
    }
    await fsyncDir(dirname(dest));
    return { deduped: false };
  }

  /** Admit an in-memory buffer, verifying its sha256 against `expected`. */
  async putBuffer(data: Uint8Array, expected: Hash): Promise<{ deduped: boolean }> {
    return this.#putStream(Readable.from(Buffer.from(data)), expected);
  }

  /**
   * Materialize a cached replay object into the instance tree via the linking
   * chain (reflink → hardlink → copy). Identical placement mechanics to the
   * shared store, but sourced from this per-instance cache.
   */
  async materialize(
    hash: Hash,
    dest: string,
    opts?: Omit<LinkOptions, "statDev" | "onWarn">,
  ): Promise<LinkStrategy> {
    return linkOrCopy(this.objectPath(hash), dest, {
      ...opts,
      statDev: this.#statDev,
      onWarn: this.#onWarn,
    });
  }
}
