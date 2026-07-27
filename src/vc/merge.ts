/**
 * The 3-way **item-set** merge (phase 1 of a merge/rebase).
 *
 * Given a base, ours, and theirs item set, classify every identity key with the
 * standard 3-way table and produce a merged manifest — or a list of conflicts.
 * `@game` is special-cased: a two-sided divergent change is a **high-severity**
 * conflict, and *any* resulting change to `@game` sets `gameChanged` (the cascade
 * that forces a game-aware re-lock of every source item in phase 2).
 *
 * This module is pure — no I/O, no sources. The constrained pin-preserving re-lock
 * (phase 2) is driven by the caller ({@link ../anvil.js Anvil.merge}) through the
 * existing Stage-2 resolver; this file only decides the merged *intent* and which
 * items the game cascade forces back through resolution.
 */

import * as semver from "semver";
import { canonicalKeyOf } from "../resolver/index.js";
import type { GameSpec, LockPackage, Manifest } from "../types/index.js";
import type { Conflict, OnConflict, Resolution } from "./conflict.js";
import type { GameValue, ItemEntry, ItemSet } from "./itemset.js";
import { gameValue } from "./itemset.js";

/** The combined resolver: a bare strategy, an `onConflict` callback, or both. */
export interface ResolutionPolicy {
  readonly strategy?: "ours" | "theirs" | "newest" | "manual";
  readonly onConflict?: OnConflict;
}

export interface ThreeWayInput {
  readonly base: ItemSet;
  readonly ours: ItemSet;
  readonly theirs: ItemSet;
  readonly project: Manifest["project"];
  /** Pins for "newest" resolution + the merged manifest's lock seeding. */
  readonly oursPins: ReadonlyMap<string, LockPackage>;
  readonly theirsPins: ReadonlyMap<string, LockPackage>;
  readonly basePins: ReadonlyMap<string, LockPackage>;
  readonly policy?: ResolutionPolicy;
}

export interface ThreeWayResult {
  /** The merged manifest — `undefined` when unresolved conflicts remain. */
  readonly manifest?: Manifest;
  /** Unresolved conflicts (empty ⇒ phase 1 clean). */
  readonly conflicts: readonly Conflict[];
  /** True when the merged `@game` differs from the base (the cascade). */
  readonly gameChanged: boolean;
  /** Canonical pin keys phase 2 must force back through resolution (game cascade). */
  readonly reResolveKeys: ReadonlySet<string>;
  /** The pins to seed the constrained re-lock (each item's winning-side pin). */
  readonly seedPins: ReadonlyMap<string, LockPackage>;
}

function entryValue(entry: ItemEntry | undefined): string | undefined {
  return entry?.value;
}

function resolvedVersion(
  entry: ItemEntry,
  pins: ReadonlyMap<string, LockPackage>,
): string | undefined {
  return pins.get(entry.canonicalKey)?.version;
}

/** Pick the entry with the newer resolved version (falls back to theirs). */
function pickNewestEntry(input: ThreeWayInput, o: ItemEntry, t: ItemEntry): "ours" | "theirs" {
  const ov = resolvedVersion(o, input.oursPins);
  const tv = resolvedVersion(t, input.theirsPins);
  const oc = ov ? semver.coerce(ov, { includePrerelease: true }) : null;
  const tc = tv ? semver.coerce(tv, { includePrerelease: true }) : null;
  if (oc && tc) {
    return semver.compare(oc, tc) >= 0 ? "ours" : "theirs";
  }
  if (ov && tv) {
    return ov >= tv ? "ours" : "theirs";
  }
  return "theirs";
}

async function resolveOne(
  input: ThreeWayInput,
  conflict: Conflict,
): Promise<Resolution | undefined> {
  const cb = await input.policy?.onConflict?.(conflict);
  if (cb) {
    return cb;
  }
  const strategy = input.policy?.strategy;
  if (strategy === "ours" || strategy === "theirs" || strategy === "newest") {
    return { choose: strategy };
  }
  return undefined; // "manual" with no callback, or no policy → unresolved
}

export async function threeWayMerge(input: ThreeWayInput): Promise<ThreeWayResult> {
  const { base, ours, theirs } = input;
  const conflicts: Conflict[] = [];
  const mergedItems = new Map<string, ItemEntry>();
  const seedPins = new Map<string, LockPackage>();

  const keys = new Set<string>([
    ...base.items.keys(),
    ...ours.items.keys(),
    ...theirs.items.keys(),
  ]);

  const take = (entry: ItemEntry | undefined, side: "ours" | "theirs"): void => {
    if (!entry) {
      return; // absent → the item is dropped from the merge
    }
    mergedItems.set(entry.key, entry);
    const pins = side === "ours" ? input.oursPins : input.theirsPins;
    const pin = pins.get(entry.canonicalKey);
    if (pin) {
      // Key the seed by the pin's OWN canonical key (matching `pinsFromLock`), so
      // an item referenced by project-id instead of slug still reuses its pin in
      // the re-lock rather than re-resolving and drifting.
      seedPins.set(canonicalKeyOf(pin), pin);
    }
  };

  for (const key of [...keys].sort()) {
    const b = base.items.get(key);
    const o = ours.items.get(key);
    const t = theirs.items.get(key);
    const bv = entryValue(b);
    const ov = entryValue(o);
    const tv = entryValue(t);

    if (ov === tv) {
      take(o, "ours"); // both unchanged, both added same, or both removed
      continue;
    }
    if (ov === bv) {
      take(t, "theirs"); // theirs changed (or removed); ours untouched
      continue;
    }
    if (tv === bv) {
      take(o, "ours"); // ours changed (or removed); theirs untouched
      continue;
    }
    // Both sides changed the same key differently → a real conflict.
    const conflict: Conflict = {
      key,
      kind: "item",
      severity: "normal",
      ...(bv !== undefined ? { base: bv } : {}),
      ...(ov !== undefined ? { ours: ov } : {}),
      ...(tv !== undefined ? { theirs: tv } : {}),
      message: `both branches changed "${key}"`,
    };
    const resolution = await resolveOne(input, conflict);
    if (!resolution) {
      conflicts.push(conflict);
      continue;
    }
    if ("manual" in resolution) {
      if (resolution.manual) {
        const entry: ItemEntry = {
          key,
          value: "manual",
          item: resolution.manual,
          canonicalKey: key,
        };
        mergedItems.set(key, entry);
      }
      continue;
    }
    if (resolution.choose === "ours") {
      take(o, "ours");
    } else if (resolution.choose === "theirs") {
      take(t, "theirs");
    } else {
      // newest
      if (o && t) {
        const side = pickNewestEntry(input, o, t);
        take(side === "ours" ? o : t, side);
      } else {
        take(o ?? t, o ? "ours" : "theirs");
      }
    }
  }

  // --- @game ---------------------------------------------------------------
  const gameResult = await resolveGame(input, conflicts);
  const mergedGame = gameResult.game;
  const gameChanged = gameValue(mergedGame) !== gameValue(base.game);

  // The game cascade forces every source (Modrinth/CurseForge) item back through
  // resolution under the new game — a still-compatible item re-pins, an orphaned
  // one surfaces `no-compatible-version` in phase 2.
  const reResolveKeys = new Set<string>();
  if (gameChanged) {
    for (const entry of mergedItems.values()) {
      if (
        entry.canonicalKey.startsWith("modrinth:") ||
        entry.canonicalKey.startsWith("curseforge:")
      ) {
        reResolveKeys.add(entry.canonicalKey);
      }
    }
  }

  if (conflicts.length > 0) {
    return { conflicts, gameChanged, reResolveKeys, seedPins };
  }

  // Every authored `[game]` field, not just the two version strings — a field
  // dropped here vanishes from the merged manifest silently, and `game.from`
  // vanishing takes the whole base layer with it.
  const game: GameSpec = {
    minecraft: mergedGame.minecraft,
    loader: mergedGame.loader,
    ...(mergedGame.from !== undefined ? { from: mergedGame.from } : {}),
    ...(mergedGame.remove !== undefined ? { remove: mergedGame.remove } : {}),
  };
  const items = [...mergedItems.values()]
    .sort((a, b2) => (a.key < b2.key ? -1 : a.key > b2.key ? 1 : 0))
    .map((e) => e.item);
  const manifest: Manifest = { project: input.project, game, items };
  return { manifest, conflicts, gameChanged, reResolveKeys, seedPins };
}

async function resolveGame(
  input: ThreeWayInput,
  conflicts: Conflict[],
): Promise<{ game: GameValue }> {
  const { base, ours, theirs } = input;
  const bv = gameValue(base.game);
  const ov = gameValue(ours.game);
  const tv = gameValue(theirs.game);
  if (ov === tv) {
    return { game: ours.game };
  }
  if (ov === bv) {
    return { game: theirs.game };
  }
  if (tv === bv) {
    return { game: ours.game };
  }
  // Divergent game change on both sides → a high-severity cascade conflict.
  const conflict: Conflict = {
    key: "@game",
    kind: "game",
    severity: "high",
    base: bv,
    ours: ov,
    theirs: tv,
    message: "both branches changed the game base (Minecraft/loader) differently",
  };
  const resolution = await resolveOne(input, conflict);
  if (resolution && "choose" in resolution) {
    if (resolution.choose === "ours") {
      return { game: ours.game };
    }
    if (resolution.choose === "theirs") {
      return { game: theirs.game };
    }
    // newest: the higher Minecraft version wins (loader tiebreak: ours).
    const oc = semver.coerce(ours.game.minecraft, { includePrerelease: true });
    const tc = semver.coerce(theirs.game.minecraft, { includePrerelease: true });
    if (oc && tc) {
      return { game: semver.compare(oc, tc) >= 0 ? ours.game : theirs.game };
    }
    return { game: ours.game.minecraft >= theirs.game.minecraft ? ours.game : theirs.game };
  }
  conflicts.push(conflict);
  return { game: ours.game }; // placeholder; conflicts present ⇒ no manifest emitted
}
