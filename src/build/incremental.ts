/**
 * Incremental build planning: diff the previous built lock against the new lock
 * by hash (and placement) so a rebuild materializes only the delta and the swap
 * touches only the targets that actually changed.
 */

import { targetsOf } from "../store/index.js";
import type { Hash, LockPackage, Lockfile } from "../types/index.js";

function hashKey(hash: Hash): string {
  return `${hash.algo}:${hash.value}`;
}

function placementKey(pkg: LockPackage): string {
  return JSON.stringify(pkg.placement);
}

/** True when two packages of the same name resolved to identical materialization. */
function unchanged(a: LockPackage, b: LockPackage): boolean {
  return hashKey(a.hash) === hashKey(b.hash) && placementKey(a) === placementKey(b);
}

export interface BuildDelta {
  /** Packages to (re)acquire and materialize. */
  readonly install: readonly LockPackage[];
  /** Relative instance target paths the install set will write. */
  readonly installTargets: readonly string[];
  /** Relative instance target paths to delete (present before, gone now). */
  readonly removeTargets: readonly string[];
}

/**
 * Compute the delta between an optional previous build and the new lock. With no
 * previous build, everything installs and nothing is removed.
 */
export function diffLocks(previous: Lockfile | undefined, next: Lockfile): BuildDelta {
  const prevByName = new Map<string, LockPackage>();
  for (const pkg of previous?.resolved ?? []) {
    prevByName.set(pkg.name, pkg);
  }

  const install: LockPackage[] = [];
  for (const pkg of next.resolved) {
    const prev = prevByName.get(pkg.name);
    if (!prev || !unchanged(prev, pkg)) {
      install.push(pkg);
    }
  }

  const nextTargets = new Set<string>();
  for (const pkg of next.resolved) {
    for (const t of targetsOf(pkg)) {
      nextTargets.add(t);
    }
  }
  const removeTargets = new Set<string>();
  for (const pkg of previous?.resolved ?? []) {
    for (const t of targetsOf(pkg)) {
      if (!nextTargets.has(t)) {
        removeTargets.add(t);
      }
    }
  }

  const installTargets = new Set<string>();
  for (const pkg of install) {
    for (const t of targetsOf(pkg)) {
      installTargets.add(t);
    }
  }

  return {
    install,
    installTargets: [...installTargets],
    removeTargets: [...removeTargets],
  };
}
