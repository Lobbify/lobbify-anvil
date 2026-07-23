/**
 * `.anvil/refs/built` — the record of the lock the current instance tree was
 * built from. Read at the start of a build to compute the incremental delta, and
 * written (atomically) at the end. Also the GC reachability root: `collectRoots`
 * expands a built lock into every object it references (package hashes plus, for
 * `asset-tree` packages, all assets named by the index).
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../internal/fs.js";
import type { ContentStore } from "../store/index.js";
import { assetHashes, readAssetIndex } from "../store/index.js";
import type { Hash, Lockfile } from "../types/index.js";
import { parseRefJson, serializeRefJson } from "./serialize.js";

const REFS_DIR = join(".anvil", "refs");
const BUILT_REF = join(REFS_DIR, "built");

/** Read the built-lock ref, or `undefined` if the instance was never built. */
export async function readBuiltLock(instanceDir: string): Promise<Lockfile | undefined> {
  try {
    const text = await readFile(join(instanceDir, BUILT_REF), "utf8");
    return parseRefJson(text);
  } catch {
    return undefined;
  }
}

/** Atomically record the lock the instance was just built from. */
export async function writeBuiltLock(instanceDir: string, lock: Lockfile): Promise<void> {
  const dir = join(instanceDir, REFS_DIR);
  await ensureDir(dir);
  const finalPath = join(dir, "built");
  const tmpPath = join(dir, `built.${process.pid}.tmp`);
  await writeFile(tmpPath, serializeRefJson(lock));
  await rename(tmpPath, finalPath);
}

/**
 * Expand a built lock into the full set of objects reachable from it — the GC
 * root set. Package hashes are always roots; an `asset-tree` package additionally
 * roots every asset object its index names.
 */
export async function collectRoots(lock: Lockfile, store: ContentStore): Promise<Hash[]> {
  const roots: Hash[] = [];
  for (const pkg of lock.resolved) {
    roots.push(pkg.hash);
    if (pkg.placement.method === "asset-tree" && (await store.has(pkg.hash))) {
      const index = await readAssetIndex(store, pkg.hash);
      roots.push(...assetHashes(index));
    }
  }
  return roots;
}
