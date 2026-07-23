/**
 * The shared-store **instance registry** — the cross-instance GC root map.
 *
 * The default content store (`~/.anvil/store`) is SHARED across every instance on
 * the machine, but a single instance's `gc` only knows its own built lock. Rooting
 * a mark-sweep at one instance would reclaim objects a DIFFERENT instance's built
 * lock still references — cross-instance data loss (its next `verify`/`build` then
 * fails with a missing object).
 *
 * This registry closes that gap. Every instance that builds against a store records
 * its absolute directory here; `gc` unions the built-lock roots of ALL registered
 * instances before sweeping. The file lives at the STORE root (`instances.toml`)
 * and is written atomically (tmp + rename). Callers serialize their read-modify-
 * write against the shared-store lock, so a concurrent build's registration and a
 * `gc` never interleave.
 *
 * Safety default: a registry that exists but will not parse raises
 * {@link StoreRegistryCorrupt} on read, so `gc` REFUSES to sweep rather than run
 * with an under-counted root set. Registration, by contrast, never clobbers an
 * unreadable registry (that would silently drop other instances' entries) — it
 * leaves it in place for a human to repair.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDir } from "../internal/fs.js";
import { StoreRegistryCorrupt } from "../types/errors.js";

/** The registry filename at the store root. */
export const INSTANCE_REGISTRY_FILENAME = "instances.toml";

/** One registered instance: its absolute dir plus an informational built-lock ref. */
export interface InstanceRegistryEntry {
  /** The instance's absolute directory (the GC-rooting key). */
  readonly dir: string;
  /** A content hash of the built lock at last registration (informational only). */
  readonly builtLockHash?: string;
  /** ms-epoch of the last registration/refresh (informational only). */
  readonly updatedAt?: number;
}

/** The parsed registry document. */
export interface InstanceRegistry {
  readonly version: 1;
  readonly instances: readonly InstanceRegistryEntry[];
}

const EMPTY: InstanceRegistry = { version: 1, instances: [] };

/** The absolute registry path for a store root. */
export function instanceRegistryPath(storeRoot: string): string {
  return join(storeRoot, INSTANCE_REGISTRY_FILENAME);
}

/**
 * Read the registry. A genuinely-absent file (`ENOENT`) is an empty registry — a
 * store nothing has registered against yet. A file that exists but does not parse
 * (or has the wrong shape) throws {@link StoreRegistryCorrupt}, so `gc` refuses.
 */
export async function readInstanceRegistry(storeRoot: string): Promise<InstanceRegistry> {
  const path = instanceRegistryPath(storeRoot);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY;
    }
    throw new StoreRegistryCorrupt(path, (err as Error).message);
  }
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch (err) {
    throw new StoreRegistryCorrupt(path, (err as Error).message);
  }
  return coerceRegistry(doc, path);
}

/** Validate + normalize a parsed TOML document into an {@link InstanceRegistry}. */
function coerceRegistry(doc: unknown, path: string): InstanceRegistry {
  if (typeof doc !== "object" || doc === null) {
    throw new StoreRegistryCorrupt(path, "not a table");
  }
  const rawInstances = (doc as { instance?: unknown }).instance;
  if (rawInstances === undefined) {
    return EMPTY;
  }
  if (!Array.isArray(rawInstances)) {
    throw new StoreRegistryCorrupt(path, "`instance` is not an array");
  }
  const instances: InstanceRegistryEntry[] = [];
  for (const raw of rawInstances) {
    if (typeof raw !== "object" || raw === null) {
      throw new StoreRegistryCorrupt(path, "an `[[instance]]` entry is not a table");
    }
    const dir = (raw as { dir?: unknown }).dir;
    if (typeof dir !== "string" || dir.length === 0) {
      throw new StoreRegistryCorrupt(path, "an `[[instance]]` entry has no string `dir`");
    }
    const builtLockHash = (raw as { builtLockHash?: unknown }).builtLockHash;
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    instances.push({
      dir,
      ...(typeof builtLockHash === "string" ? { builtLockHash } : {}),
      ...(typeof updatedAt === "number" ? { updatedAt } : {}),
    });
  }
  return { version: 1, instances };
}

/** Atomically (re)write the registry (tmp + rename). Entries sorted by `dir`. */
export async function writeInstanceRegistry(
  storeRoot: string,
  registry: InstanceRegistry,
): Promise<void> {
  await ensureDir(storeRoot);
  const sorted = [...registry.instances].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
  );
  const doc = {
    version: 1,
    instance: sorted.map((e) => ({
      dir: e.dir,
      ...(e.builtLockHash ? { builtLockHash: e.builtLockHash } : {}),
      ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}),
    })),
  };
  const path = instanceRegistryPath(storeRoot);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, stringifyToml(doc));
  await rename(tmp, path);
}

/** Return a registry with `dir`'s entry inserted or refreshed (keyed by exact dir). */
export function upsertInstance(
  registry: InstanceRegistry,
  dir: string,
  fields: { builtLockHash?: string; updatedAt?: number } = {},
): InstanceRegistry {
  const entry: InstanceRegistryEntry = {
    dir,
    ...(fields.builtLockHash ? { builtLockHash: fields.builtLockHash } : {}),
    ...(fields.updatedAt !== undefined ? { updatedAt: fields.updatedAt } : {}),
  };
  const rest = registry.instances.filter((e) => e.dir !== dir);
  return { version: 1, instances: [...rest, entry] };
}

/** Return a registry with `dir`'s entry removed (no-op if absent). */
export function removeInstance(registry: InstanceRegistry, dir: string): InstanceRegistry {
  return { version: 1, instances: registry.instances.filter((e) => e.dir !== dir) };
}
