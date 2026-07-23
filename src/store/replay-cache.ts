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
 * It is a small content-addressed cache in its own right — sha256 only (anvil's
 * canonical domain), sharded, written `0444` (immutable), atomic (`tmp → fsync →
 * rename`), and it verifies bytes against their pin on admission — but it is a
 * deliberately **separate type** from {@link ContentStore} so the separation is
 * structural, not a convention.
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
   * The absolute on-disk path a replay object with `hash` occupies. sha256 only
   * — a replay object is always in anvil's canonical domain. A sha1 hash is a
   * programming error (the Mojang asset domain never holds a replay object).
   */
  objectPath(hash: Hash): string {
    if (hash.algo !== "sha256") {
      throw new ShaMismatch(
        "replay-cache",
        { algo: "sha256", value: hash.value },
        { algo: hash.algo, value: hash.value },
      );
    }
    return join(this.root, "objects", shardOf(hash.value), hash.value);
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
   * Admit a replay byte stream, verifying it hashes to `expected` (sha256)
   * before it lands ({@link ShaMismatch} otherwise — the bytes never enter the
   * cache if they do not match the lock's pin). Dedups when already present.
   */
  async #putStream(source: Readable, expected: Hash): Promise<{ deduped: boolean }> {
    if (expected.algo !== "sha256") {
      throw new ShaMismatch(
        "replay-cache admission",
        { algo: "sha256", value: expected.value },
        { algo: expected.algo, value: expected.value },
      );
    }
    const { tmpPath, hash } = await writeTemp(this.#tmpDir, source, "sha256");
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
