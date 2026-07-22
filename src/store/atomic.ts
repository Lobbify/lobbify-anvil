/**
 * Atomic object writes.
 *
 * Every object lands via the same durable ritual: stream into a unique
 * `tmp/<uuid>.tmp`, hashing as we write, `fsync` the data, then `rename` into its
 * final content-addressed path (rename is atomic on a single volume) and `fsync`
 * the directory. A crash leaves at most an orphan temp file — never a
 * half-written object at a real path — and `sweepTmp` reaps orphans on startup.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FaultHook } from "../internal/faults.js";
import { fireFault } from "../internal/faults.js";
import { ensureDir } from "../internal/fs.js";
import type { Hash, HashAlgo } from "../types/index.js";
import { hashingTap } from "./hash.js";

/** Immutable object mode: read-only for everyone. Editing a linked object fails. */
export const OBJECT_MODE = 0o444;

/**
 * `fsync` a directory so a rename into it survives a power loss. Best-effort:
 * some platforms/filesystems reject a directory fsync, and durability there is
 * simply weaker — never a correctness failure.
 */
export async function fsyncDir(dir: string): Promise<void> {
  let dh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    dh = await open(dir, "r");
    await dh.sync();
  } catch {
    // Directory fsync unsupported here; durability is best-effort.
  } finally {
    await dh?.close();
  }
}

/**
 * Stream `source` into a fresh temp file under `tmpDir`, hashing as it writes and
 * `fsync`-ing the bytes. Returns the temp path and the content hash; the caller
 * renames it into place (dedup on collision) or unlinks it on mismatch.
 */
export async function writeTemp(
  tmpDir: string,
  source: Readable,
  algo: HashAlgo,
  fault?: FaultHook,
): Promise<{ tmpPath: string; hash: Hash }> {
  await ensureDir(tmpDir);
  const tmpPath = join(tmpDir, `${randomUUID()}.tmp`);
  const { tap, digest } = hashingTap(algo);
  // Create the temp already-immutable (0444): the write fd (O_WRONLY) can still
  // write it, but the object is read-only the instant it appears at its final
  // path after rename — no rename→chmod window, and dedup can't leave a mutable
  // object behind. Reopen read-only (not "r+", which EACCESes on 0444) to fsync.
  await pipeline(source, tap, createWriteStream(tmpPath, { mode: OBJECT_MODE }));
  await fireFault(fault, "object:temp-written");
  const fh = await open(tmpPath, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { tmpPath, hash: digest() };
}

/** Delete every leftover temp file in `tmpDir` (startup orphan sweep). */
export async function sweepTmp(tmpDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(tmpDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    try {
      await unlink(join(tmpDir, name));
      removed += 1;
    } catch {
      // Another process may be mid-write; leave it.
    }
  }
  return removed;
}
