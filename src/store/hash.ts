/**
 * Streaming content hashing. The store's only currency is a {@link Hash}
 * `{algo, value}` — never a bare string — because the store is domain-partitioned
 * (sha1 for the Mojang asset domain, sha256 for everything anvil owns) and the
 * algorithm tag is what keeps the two apart.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import type { Hash, HashAlgo } from "../types/index.js";

/** Hash a buffer synchronously. */
export function hashBuffer(data: Uint8Array, algo: HashAlgo): Hash {
  return { algo, value: createHash(algo).update(data).digest("hex") };
}

/** Hash a readable stream to completion. */
export async function hashStream(source: Readable, algo: HashAlgo): Promise<Hash> {
  const h = createHash(algo);
  for await (const chunk of source) {
    h.update(chunk as Uint8Array);
  }
  return { algo, value: h.digest("hex") };
}

/** Hash a file by streaming it (constant memory, safe on large jars). */
export async function hashFile(path: string, algo: HashAlgo): Promise<Hash> {
  return hashStream(createReadStream(path), algo);
}

/**
 * A pass-through transform that hashes bytes as they flow, exposing the digest
 * once the stream ends. Used by the atomic writer to hash-while-writing so a
 * single pass both persists and verifies an object.
 */
export function hashingTap(algo: HashAlgo): { readonly tap: Transform; digest: () => Hash } {
  const h = createHash(algo);
  let done: Hash | undefined;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk as Uint8Array);
      cb(null, chunk);
    },
  });
  return {
    tap,
    digest: () => {
      if (!done) {
        done = { algo, value: h.digest("hex") };
      }
      return done;
    },
  };
}

/** The 2-hex-char shard directory for a hex digest. */
export function shardOf(value: string): string {
  return value.slice(0, 2);
}

/** A stable map key for a hash (`"sha256:abcd…"`). */
export function hashKey(hash: Hash): string {
  return `${hash.algo}:${hash.value}`;
}

/** Structural hash equality (algo and value). */
export function hashEquals(a: Hash, b: Hash): boolean {
  return a.algo === b.algo && a.value === b.value;
}
