/**
 * Package identity — the canonical key the resolver dedups, conflicts, and pins
 * on, and the map builder that seeds a constrained re-lock from a prior lock.
 *
 * Split out of `resolve.ts` so the overlay engine (`base/overlay.ts`) can key on
 * the same identity without importing the resolver, which imports the overlay.
 * The logic is unchanged: a project referenced by slug in one place and by id in
 * another must dedup to one entry, whichever module is asking.
 */

import { fileURLToPath } from "node:url";
import type { LockPackage, Lockfile } from "../types/index.js";

/** The canonical identity key for a resolved package (dedup + pin key). */
export function canonicalKeyOf(pkg: LockPackage): string {
  switch (pkg.source) {
    case "modrinth":
      return `modrinth:${pkg.name}`; // name is the (unique) Modrinth slug
    case "curseforge":
      return pkg.project !== undefined ? `curseforge:${pkg.project}` : `curseforge:${pkg.name}`;
    case "url":
      return `url:${pkg.url ?? pkg.name}`;
    case "local":
      return `local:${localPathOf(pkg)}`;
    default:
      return `${pkg.source}:${pkg.name}`;
  }
}

function localPathOf(pkg: LockPackage): string {
  if (!pkg.url) {
    return pkg.name;
  }
  try {
    return fileURLToPath(pkg.url);
  } catch {
    return pkg.url;
  }
}

/** Build a `lockedPins` map from a prior lock, keyed canonically. */
export function pinsFromLock(lock: Lockfile): Map<string, LockPackage> {
  const map = new Map<string, LockPackage>();
  for (const pkg of lock.resolved) {
    map.set(canonicalKeyOf(pkg), pkg);
  }
  return map;
}
