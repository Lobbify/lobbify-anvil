/**
 * Reading the build's input lock from disk.
 *
 * NOTE — interim. "The lock is the sole build input", but Stage 1 predates the
 * canonical TOML lock writer (Stage 2's `src/lock/`). So the build reads its input
 * lock as canonical JSON at `<dir>/anvil.lock`. When Stage 2 lands, this reader is
 * replaced by the TOML lock reader; the Lockfile object it yields is unchanged.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lockfile } from "../types/index.js";
import { deserializeLock, serializeLock } from "./serialize.js";

/** The input lock filename an instance's build reads. */
export const LOCK_FILENAME = "anvil.lock";

/** Read `<dir>/anvil.lock`. Throws if absent (a build needs a lock). */
export async function readInputLock(instanceDir: string): Promise<Lockfile> {
  const text = await readFile(join(instanceDir, LOCK_FILENAME), "utf8");
  return deserializeLock(text);
}

/**
 * Write `<dir>/anvil.lock` (interim JSON). Stage 2's canonical TOML writer
 * supersedes this; provided now so tests and callers can seed a build input.
 */
export async function writeInputLock(instanceDir: string, lock: Lockfile): Promise<void> {
  await writeFile(join(instanceDir, LOCK_FILENAME), serializeLock(lock));
}
