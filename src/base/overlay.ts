/**
 * The base-pack **overlay** — the precedence engine.
 *
 * An instance that declares `game.from` is two layers: the base pack's member
 * set underneath, and the manifest's own `items` on top. This module defines,
 * exactly, what "on top" means. It is pure: no network, no filesystem, no
 * bytes — every decision is made on the identity and the placement target a
 * package already carries, which is why the ordering LB-706 established matters
 * (`ResolvedRef.target` / `Placement.target` is known before a byte is fetched).
 *
 * ## Precedence
 *
 * The effective set is computed in three phases, in this order:
 *
 * 1. **Remove.** Every `game.remove` entry drops matching packages from **both**
 *    layers. An entry matches on either axis:
 *      - *identity* — `refKey(entry)` equals the package's canonical key, or the
 *        entry's bare id equals the package's `name` (so `modrinth:sodium`
 *        removes the base's sodium whether the base recorded it by slug or not);
 *      - *placement* — the entry's declared placement path equals the package's
 *        `link` target (so `"./config/sodium.json"` removes a config member).
 *    An entry that matches **nothing** is an error, not a silent no-op: the
 *    failure mode it prevents is shipping the mod you believed you removed.
 *
 * 2. **Override.** A base member is dropped when *any* surviving instance
 *    package matches it on either axis:
 *      - *identity* — same canonical key. This is the "bump a base mod" case,
 *        and it drops the **whole** base member, including its old placement, so
 *        `mods/sodium-0.5.8.jar` does not survive alongside `mods/sodium-0.6.0.jar`.
 *      - *placement target* — same `link` target. This is the "override a config"
 *        case, where the two sides share no catalogue identity at all (a base
 *        config is a `url`/`local` blob; yours is a `local` path) but do share a
 *        destination.
 *    Matching on *either* axis, never on both, makes the phase order-independent:
 *    a base member is dropped iff some instance package claims its identity or
 *    its destination. Determinism does not depend on iteration order.
 *
 *    One exception, and it matters for the diff story: an instance package that
 *    shares a base member's identity **and is the same package** (same bytes,
 *    version and destination) overrides nothing. It *is* the base member — most
 *    often because a transitive dependency reused the base's pin — so it stays in
 *    the base partition instead of being counted as overlay. See {@link sameEntry}.
 *
 * 3. **Union.** Surviving base members (flagged `fromBase`) ∪ instance packages.
 *    The caller then runs the ordinary placement-collision check over the union,
 *    which now can only fire for two *instance* items — base-vs-instance target
 *    clashes were resolved in phase 2, by rule, in the instance's favour.
 *
 * **The instance always wins.** There is no rule under which a base member
 * displaces something the manifest asked for, so a hostile base cannot shadow a
 * user's file.
 */

import { canonicalJson } from "../build/serialize.js";
import { hashToString } from "../lock/serialize.js";
import { refKey } from "../manifest/ref.js";
import { canonicalKeyOf } from "../resolver/identity.js";
import { declaredPlacementTarget } from "../sources/place.js";
import { hashBuffer } from "../store/hash.js";
import type { Hash, LockPackage, ResolvedRef } from "../types/index.js";

/** The `link` target a package places to, or `undefined` for any other method. */
export function linkTargetOf(pkg: LockPackage): string | undefined {
  return pkg.placement.method === "link" ? pkg.placement.target : undefined;
}

/**
 * The two axes a base member can be matched on. Kept as an explicit union so a
 * report (and a test) can say *why* a member went away, not just that it did.
 */
export type MatchAxis = "identity" | "target";

/** One base member displaced by an instance package, and on which axis. */
export interface OverrideRecord {
  readonly base: LockPackage;
  readonly by: LockPackage;
  readonly on: MatchAxis;
}

/** One base member (or instance item) dropped by a `game.remove` entry. */
export interface RemovalRecord {
  readonly package: LockPackage;
  /** The `game.remove` entry, as authored. */
  readonly entry: string;
  readonly on: MatchAxis;
}

export interface OverlayInput {
  /** The base pack's resolved member set, in any order. */
  readonly base: readonly LockPackage[];
  /** The instance layer: the manifest's own items, fully resolved. */
  readonly instance: readonly LockPackage[];
  /** `game.remove`, parsed, paired with the string each was authored as. */
  readonly removes: readonly { readonly ref: ResolvedRef; readonly raw: string }[];
}

export interface OverlayResult {
  /** Base survivors (flagged `fromBase`) ∪ instance packages. Unsorted. */
  readonly effective: readonly LockPackage[];
  readonly removed: readonly RemovalRecord[];
  readonly overridden: readonly OverrideRecord[];
  /** `game.remove` entries that matched nothing — always an error upstream. */
  readonly unmatched: readonly string[];
}

/**
 * The placement path a `game.remove` entry names, or `undefined` when it names
 * an identity rather than a path. Only a `local`-parsed entry (`"./x"`, `"/x"`,
 * `"local:x"`) can name a path; a `modrinth:`/`curseforge:`/`url:` entry never
 * does, so `modrinth:sodium` can never accidentally match a file called
 * `sodium`.
 *
 * Reaching an imported `overrides/` file **by its placement path** is intended
 * behavior, not an accident of the target axis existing (LB-726). A pack's loose
 * override has no upstream `(source, id)` to be named by — it is registered as a
 * `local`/`copy` row whose identity *is* where it lands — so the path is the only
 * handle a `game.remove` entry could ever use for one. Removing the target axis,
 * or narrowing it to lock-declared items, would leave overrides unremovable.
 */
function removeTargetOf(ref: ResolvedRef): string | undefined {
  if (ref.source !== "local") {
    return undefined;
  }
  return declaredPlacementTarget(ref.id);
}

/**
 * Whether two packages are *the same package* — same identity, same bytes, same
 * destination — rather than one displacing the other.
 *
 * This is not a micro-optimization. A transitive dependency the base already
 * provides is resolved by reusing the base's pin verbatim, so it arrives in the
 * instance layer holding the base's own row. Calling that an override would be
 * true of nothing observable and would move the row out of the base partition —
 * inflating the very overlay that a base-sharing pair has to reconcile, with
 * entries the other side already has. Identical content is attributed to the
 * base, which is where it came from.
 */
function sameEntry(a: LockPackage, b: LockPackage): boolean {
  return (
    a.hash.algo === b.hash.algo &&
    a.hash.value === b.hash.value &&
    (a.version ?? "") === (b.version ?? "") &&
    linkTargetOf(a) === linkTargetOf(b)
  );
}

/** Whether a `game.remove` entry matches a package, and on which axis. */
function removeMatch(
  ref: ResolvedRef,
  target: string | undefined,
  pkg: LockPackage,
): MatchAxis | undefined {
  if (refKey(ref) === canonicalKeyOf(pkg)) {
    return "identity";
  }
  // A bare id match (`modrinth:sodium` vs a member the base recorded under the
  // slug `sodium`) — same source, same name. Never cross-source: a `url:` member
  // is not removed by a `modrinth:` entry that happens to share a basename.
  if (ref.source === pkg.source && ref.id === pkg.name) {
    return "identity";
  }
  if (target !== undefined && target === linkTargetOf(pkg)) {
    return "target";
  }
  return undefined;
}

/**
 * Apply `game.remove`, then the instance layer, to a base member set. See the
 * module doc for the precedence rules this implements.
 */
export function overlayBase(input: OverlayInput): OverlayResult {
  const removed: RemovalRecord[] = [];
  const overridden: OverrideRecord[] = [];
  const unmatched: string[] = [];

  // --- phase 1: remove, from both layers ----------------------------------
  const removeSpecs = input.removes.map((r) => ({
    ...r,
    target: removeTargetOf(r.ref),
  }));
  const dropped = new Set<LockPackage>();
  for (const spec of removeSpecs) {
    let matched = false;
    for (const pkg of [...input.base, ...input.instance]) {
      const axis = removeMatch(spec.ref, spec.target, pkg);
      if (axis === undefined) {
        continue;
      }
      matched = true;
      if (!dropped.has(pkg)) {
        dropped.add(pkg);
        removed.push({ package: pkg, entry: spec.raw, on: axis });
      }
    }
    if (!matched) {
      unmatched.push(spec.raw);
    }
  }

  const survivingInstance = input.instance.filter((p) => !dropped.has(p));

  // --- phase 2: the instance layer overrides the base ---------------------
  // Index the instance layer by both axes so the scan is linear, not quadratic:
  // a 482-member base against a 90-item overlay is the shape this must stay
  // cheap for.
  const byKey = new Map<string, LockPackage>();
  const byTarget = new Map<string, LockPackage>();
  for (const pkg of survivingInstance) {
    const key = canonicalKeyOf(pkg);
    if (!byKey.has(key)) {
      byKey.set(key, pkg);
    }
    const target = linkTargetOf(pkg);
    if (target !== undefined && !byTarget.has(target)) {
      byTarget.set(target, pkg);
    }
  }

  const survivingBase: LockPackage[] = [];
  /** Instance entries that turned out to *be* a base member — see `sameEntry`. */
  const carried = new Set<LockPackage>();
  for (const member of input.base) {
    if (dropped.has(member)) {
      continue;
    }
    const byIdentity = byKey.get(canonicalKeyOf(member));
    if (byIdentity && !sameEntry(member, byIdentity)) {
      overridden.push({ base: member, by: byIdentity, on: "identity" });
      continue;
    }
    if (byIdentity) {
      carried.add(byIdentity);
    } else {
      const target = linkTargetOf(member);
      const byPlacement = target !== undefined ? byTarget.get(target) : undefined;
      if (byPlacement) {
        overridden.push({ base: member, by: byPlacement, on: "target" });
        continue;
      }
    }
    survivingBase.push(member.fromBase === true ? member : { ...member, fromBase: true });
  }

  return {
    effective: [...survivingBase, ...survivingInstance.filter((p) => !carried.has(p))],
    removed,
    overridden,
    unmatched,
  };
}

/**
 * A portable substitute for {@link canonicalKeyOf}, used only inside the base-set
 * digest (LB-723).
 *
 * `canonicalKeyOf` is correct for its own job — deduping and pinning within one
 * resolve — but for a `local` package it keys on the **absolute** tracked-copy
 * path (`resolver/identity.ts`'s `localPathOf`, via `fileURLToPath(pkg.url)`).
 * An overlay member's `url` is `<instanceDir>/.anvil/base/<destRel>`
 * (`base/mrpack-base.ts` / `pack-common.ts`'s `importOverrideTree`), and
 * `instanceDir` is wherever THIS machine happened to clone the instance — so a
 * pack with an `overrides/` tree produced a different digest on every machine
 * (and every re-clone) for byte-identical content, defeating the entire point of
 * `LockBase.set`: two instances sharing a base are supposed to be known
 * identical without comparing a single row.
 *
 * A `local` override's real, portable identity is exactly its placement target
 * (`destRel`) — already carried as the row's own `target` column below, and
 * unique within one base (two members at the same target would already be a
 * placement collision). Every other source kind keeps `canonicalKeyOf` as-is:
 * a Modrinth slug, a CurseForge project id, and a `url` source's URL are already
 * machine-independent.
 */
function digestKeyOf(pkg: LockPackage): string {
  return pkg.source === "local" ? `local:${linkTargetOf(pkg) ?? pkg.name}` : canonicalKeyOf(pkg);
}

/**
 * The digest of a base's resolved member set — {@link LockBase.set}.
 *
 * Computed over the members **as the base resolved them**, before any removal or
 * override, so it is a property of the base reference alone. Two locks carrying
 * the same digest started from the same bytes in the same places, which is what
 * lets a base-sharing pair collapse the entire base partition to one line
 * instead of comparing it member by member — a property that depends on the
 * digest itself being machine-independent; see {@link digestKeyOf}.
 *
 * The tuple per member is `[digest key, name, version, hash, target]`: enough
 * that any difference a build could observe moves the digest, and nothing that
 * varies between two faithful resolutions of the same pack. The list is sorted
 * by digest key so member order out of the pack index cannot leak in.
 */
export function baseSetDigest(members: readonly LockPackage[]): Hash {
  const rows = members
    .map((m) => [
      digestKeyOf(m),
      m.name,
      m.version ?? "",
      hashToString(m.hash),
      linkTargetOf(m) ?? "",
    ])
    .sort((a, b) =>
      (a[0] as string) < (b[0] as string) ? -1 : (a[0] as string) > (b[0] as string) ? 1 : 0,
    );
  return hashBuffer(new TextEncoder().encode(canonicalJson(rows)), "sha256");
}
