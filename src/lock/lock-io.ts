/**
 * On-disk I/O for the canonical `anvil.lock` (TOML). This replaces the interim
 * JSON lock-io Stage 1 used: the build engine reads its sole input from here.
 * Writes are atomic (`tmp → rename`) so a crash never leaves a half-written lock.
 */

import { rename, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lockfile } from "../types/index.js";
import { parseLock, serializeLock } from "./serialize.js";

/** The lockfile name at the instance root — the build's sole input. */
export const LOCK_FILENAME = "anvil.lock";

/** Read + parse `<dir>/anvil.lock`. Rejects if absent (a build needs a lock). */
export async function readLock(instanceDir: string): Promise<Lockfile> {
  const text = await readFile(join(instanceDir, LOCK_FILENAME), "utf8");
  return parseLock(text);
}

/** Read the lock if present, else `undefined` (used to seed re-lock pins). */
export async function readLockIfPresent(instanceDir: string): Promise<Lockfile | undefined> {
  try {
    return await readLock(instanceDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Atomically write the canonical `<dir>/anvil.lock`. */
export async function writeLock(instanceDir: string, lock: Lockfile): Promise<void> {
  const finalPath = join(instanceDir, LOCK_FILENAME);
  const tmpPath = join(instanceDir, `${LOCK_FILENAME}.${process.pid}.tmp`);
  await writeFile(tmpPath, serializeLock(lock));
  await rename(tmpPath, finalPath);
}

/** Back-compat alias — the build's input lock reader (now canonical TOML). */
export const readInputLock = readLock;

/** Back-compat alias — seed a build input lock (now canonical TOML). */
export const writeInputLock = writeLock;
