/**
 * The domain-partitioned content-addressed store.
 *
 * Two object domains under one root:
 *   - `assets/objects/<xx>/<sha1>`  — the Mojang-native sha1 domain, so the store
 *     can *be* an existing `.minecraft/assets`.
 *   - `blobs/objects/<xx>/<sha256>` — the sha256 domain for everything anvil owns.
 * Objects are sharded by the first two hex chars and written `0444` (immutable),
 * so a hardlink/reflink into an instance physically cannot be edited in place.
 *
 * Writes are atomic (`tmp → fsync → rename`, dedup on collision); `fsck` re-hashes
 * every object; `gc` mark-sweeps unreachable objects rooted at the built locks,
 * touching only the store's own domains (never a borrowed/foreign `.minecraft`).
 */

import { createReadStream } from "node:fs";
import { chmod, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { LinkStrategy } from "../events.js";
import type { FaultHook } from "../internal/faults.js";
import { ensureDir, statDevOf } from "../internal/fs.js";
import { ShaMismatch } from "../types/errors.js";
import type { Hash, HashAlgo } from "../types/index.js";
import { fsyncDir, sweepTmp, writeTemp } from "./atomic.js";
import { hashEquals, hashFile, hashKey, shardOf } from "./hash.js";
import type { LinkOptions } from "./linking.js";
import { linkOrCopy } from "./linking.js";

export interface ContentStoreOptions {
  readonly root: string;
  /** Injectable device-id probe (for cross-volume tests). */
  readonly statDev?: (path: string) => Promise<number>;
  readonly onWarn?: (message: string) => void;
  /** Test-only crash hook, threaded into the atomic write. */
  readonly fault?: FaultHook;
}

export interface PutResult {
  readonly hash: Hash;
  /** True when an identical object already existed (write was discarded). */
  readonly deduped: boolean;
}

export interface StoreFsckResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export interface StoreGcOptions {
  /** Keep objects modified within this many ms (protects in-flight writes). */
  readonly graceMs?: number;
  /** Injectable clock. */
  readonly now?: number;
}

export interface StoreGcResult {
  readonly removed: number;
  readonly freedBytes: number;
}

async function* walkObjects(domainDir: string): AsyncGenerator<{ path: string; value: string }> {
  let shards: string[];
  try {
    shards = await readdir(domainDir);
  } catch {
    return;
  }
  for (const shard of shards.sort()) {
    const shardDir = join(domainDir, shard);
    let names: string[];
    try {
      names = await readdir(shardDir);
    } catch {
      continue;
    }
    for (const value of names.sort()) {
      yield { path: join(shardDir, value), value };
    }
  }
}

export class ContentStore {
  readonly root: string;
  readonly #statDev: (path: string) => Promise<number>;
  readonly #onWarn?: (message: string) => void;
  readonly #fault?: FaultHook;

  constructor(opts: ContentStoreOptions) {
    this.root = opts.root;
    this.#statDev = opts.statDev ?? statDevOf;
    this.#onWarn = opts.onWarn;
    this.#fault = opts.fault;
  }

  /** The scratch dir for atomic writes. */
  get tmpDir(): string {
    return join(this.root, "tmp");
  }

  /** The object directory for a hash algorithm (sha1 → assets, sha256 → blobs). */
  domainDir(algo: HashAlgo): string {
    return algo === "sha1"
      ? join(this.root, "assets", "objects")
      : join(this.root, "blobs", "objects");
  }

  /** The absolute on-disk path an object with `hash` would occupy. */
  objectPath(hash: Hash): string {
    return join(this.domainDir(hash.algo), shardOf(hash.value), hash.value);
  }

  /** True if the object is present in the store. */
  async has(hash: Hash): Promise<boolean> {
    try {
      await stat(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Admit a stream as an object under `algo`. If `expected` is given, the arrived
   * bytes must hash to it or the store rejects them ({@link ShaMismatch}). Dedups
   * when the object already exists.
   */
  async putStream(source: Readable, algo: HashAlgo, expected?: Hash): Promise<PutResult> {
    const { tmpPath, hash } = await writeTemp(this.tmpDir, source, algo, this.#fault);
    if (expected && !hashEquals(hash, expected)) {
      await unlink(tmpPath).catch(() => undefined);
      throw new ShaMismatch("store admission", expected, hash);
    }
    const dest = this.objectPath(hash);
    if (await this.has(hash)) {
      await unlink(tmpPath).catch(() => undefined);
      await this.#touch(dest);
      return { hash, deduped: true };
    }
    await ensureDir(dirname(dest));
    try {
      await rename(tmpPath, dest); // object is already 0444 — immutable at this instant
    } catch (err) {
      // A racing writer may have landed the same object between has() and rename.
      if (await this.has(hash)) {
        await unlink(tmpPath).catch(() => undefined);
        await this.#touch(dest);
        return { hash, deduped: true };
      }
      throw err;
    }
    await fsyncDir(dirname(dest));
    return { hash, deduped: false };
  }

  /**
   * Re-arm the GC grace window on a deduped object by bumping its mtime, so a
   * concurrent GC won't sweep an object a build just deduped against but hasn't
   * linked yet. Best-effort (owner can touch times on a 0444 file). Full
   * cross-process build/GC locking lands with remotes (Stage 7).
   */
  async #touch(dest: string): Promise<void> {
    const now = new Date();
    await utimes(dest, now, now).catch(() => undefined);
  }

  /** Admit a file by path. */
  async putFile(src: string, algo: HashAlgo, expected?: Hash): Promise<PutResult> {
    return this.putStream(createReadStream(src), algo, expected);
  }

  /** Admit an in-memory buffer. */
  async putBuffer(data: Uint8Array, algo: HashAlgo, expected?: Hash): Promise<PutResult> {
    return this.putStream(Readable.from(Buffer.from(data)), algo, expected);
  }

  /** A read stream over a stored object. */
  read(hash: Hash): Readable {
    return createReadStream(this.objectPath(hash));
  }

  /** Materialize an object into the instance tree via the linking chain. */
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

  /** Reap orphaned temp files (call on startup). */
  async sweepTmp(): Promise<number> {
    return sweepTmp(this.tmpDir);
  }

  /** Re-hash every stored object and report any whose content drifted from its address. */
  async fsck(): Promise<StoreFsckResult> {
    const problems: string[] = [];
    for (const algo of ["sha1", "sha256"] as const) {
      for await (const { path, value } of walkObjects(this.domainDir(algo))) {
        let actual: Hash;
        try {
          actual = await hashFile(path, algo);
        } catch (err) {
          problems.push(`${algo}:${value} unreadable (${(err as Error).message})`);
          continue;
        }
        if (actual.value !== value) {
          problems.push(`${algo}:${value} corrupt (content hashes to ${actual.value})`);
        }
      }
    }
    return { ok: problems.length === 0, problems };
  }

  /**
   * Mark-sweep GC rooted at `roots` (the union of built-lock object sets). Sweeps
   * only this store's own domains, so a remapped/foreign `.minecraft/assets` (not
   * under `root`) is never enumerated, let alone deleted. Objects modified inside
   * the grace window are kept to protect concurrent in-flight writes.
   */
  async gc(roots: Iterable<Hash>, opts: StoreGcOptions = {}): Promise<StoreGcResult> {
    const keep = new Set<string>();
    for (const r of roots) {
      keep.add(hashKey(r));
    }
    const now = opts.now ?? Date.now();
    const graceMs = opts.graceMs ?? 0;
    let removed = 0;
    let freedBytes = 0;

    for (const algo of ["sha1", "sha256"] as const) {
      for await (const { path, value } of walkObjects(this.domainDir(algo))) {
        if (keep.has(`${algo}:${value}`)) {
          continue;
        }
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(path);
        } catch {
          continue;
        }
        if (now - st.mtimeMs < graceMs) {
          continue; // inside the grace window
        }
        await chmod(path, 0o644).catch(() => undefined); // objects are 0444
        try {
          await unlink(path);
          removed += 1;
          freedBytes += st.size;
        } catch {
          // best-effort; a live reader may hold it
        }
      }
    }
    return { removed, freedBytes };
  }
}
