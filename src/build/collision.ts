/**
 * Placement-target collision detection.
 *
 * The resolver dedups packages by *identity* (a canonical `source:id` key), never
 * by where their file lands in the instance tree. So two DISTINCT items — a
 * Modrinth `sodium.jar` and a `url` `sodium.jar`, two mods from different sources
 * that happen to share a basename — can both resolve to `mods/sodium.jar`. At
 * build time the second `link` silently overwrites the first, yet the lock still
 * lists both: a silently-wrong build. We detect that here and fail loudly.
 *
 * Only single-file `link` placements can collide this way — `extract` /
 * `asset-tree` / `runtime-tree` write into a directory the engine owns, and
 * `store-only` places nothing. Two `link` entries are a genuine collision only
 * when their content actually differs: two lock entries that point identical bytes
 * at the same path (a rare but harmless duplicate) materialize the same file and
 * are not flagged.
 *
 * The scan is order-independent: entries are grouped by target, targets and the
 * colliding items are sorted, so the reported pair is deterministic across runs —
 * the same lock always fails the same way (a determinism invariant).
 */

import { PlacementCollision } from "../types/errors.js";
import type { LockPackage } from "../types/index.js";

/** A stable, human-readable identity for a package, for collision messages. */
function describePackage(pkg: LockPackage): string {
  const version = pkg.version ? `@${pkg.version}` : "";
  // `url`/`local` blobs share names freely; the url/path disambiguates them.
  const id = pkg.url ?? pkg.name;
  return `${pkg.source}:${id}${version}`;
}

/**
 * Throw {@link PlacementCollision} if two distinct-content packages `link` to the
 * same target path. A no-op when every `link` target is unique (the normal case)
 * and when the same single item appears once (a re-lock of one item never trips).
 */
export function assertNoPlacementCollisions(packages: readonly LockPackage[]): void {
  // target → (hashKey → package). Keying the inner map by content hash collapses
  // identical-bytes duplicates so only a genuine content clash counts.
  const byTarget = new Map<string, Map<string, LockPackage>>();
  for (const pkg of packages) {
    if (pkg.placement.method !== "link") {
      continue;
    }
    const target = pkg.placement.target;
    let group = byTarget.get(target);
    if (!group) {
      group = new Map();
      byTarget.set(target, group);
    }
    const hashKey = `${pkg.hash.algo}:${pkg.hash.value}`;
    if (!group.has(hashKey)) {
      group.set(hashKey, pkg);
    }
  }

  const colliding = [...byTarget.entries()]
    .filter(([, group]) => group.size > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const first = colliding[0];
  if (!first) {
    return;
  }
  const [target, group] = first;
  const items = [...group.values()].map(describePackage).sort();
  throw new PlacementCollision(target, items);
}
