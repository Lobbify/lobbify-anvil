/**
 * The **item set** — the unit merge and rebase operate on. anvil never merges raw
 * files, and never merges two derived locks: it merges the *authored intent* (the
 * manifest's item set), keyed by a stable identity, then re-derives the lock.
 *
 * Identity keys:
 *   - `<source>:<id>`  — a Modrinth / CurseForge / URL item (`modrinth:sodium`).
 *   - `local:<path>`   — a tracked local file item.
 *   - `config:<path>`  — a config-override item.
 *   - `@game`          — the game base (Minecraft version + loader). A change here
 *                        cascades (it can orphan every mod), so it is special-cased.
 *
 * Change detection compares a normalized **value** per key: a source item's value
 * is its version spec (+ any kind override); a local/config item's value folds in
 * the pinned content hash so a byte edit to the same path is a real change.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { formatVersionSpec, refForItem, refKey } from "../manifest/index.js";
import { canonicalKeyOf } from "../resolver/index.js";
import type { LockPackage, Manifest, ManifestItem, ResolvedRef } from "../types/index.js";

/** The game-base value (`@game`). */
export interface GameValue {
  readonly minecraft: string;
  readonly loader: string;
}

/** One entry in an item set. */
export interface ItemEntry {
  /** The stable, portable identity key. */
  readonly key: string;
  /** The normalized change-detection value. */
  readonly value: string;
  /** The authored manifest item, for reconstructing a merged manifest. */
  readonly item: ManifestItem;
  /** The side-local canonical pin key, for seeding a constrained re-lock. */
  readonly canonicalKey: string;
}

/** A manifest, decomposed into its identity-keyed item set plus the game base. */
export interface ItemSet {
  readonly items: ReadonlyMap<string, ItemEntry>;
  readonly game: GameValue;
}

/** Normalize a local path to a portable POSIX-relative identity fragment. */
function normLocalPath(raw: string): string {
  let p = raw.split("\\").join("/");
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  return p;
}

/** Absolutize a local ref's id against the base dir (mirrors the resolver). */
function localize(ref: ResolvedRef, baseDir: string): ResolvedRef {
  if (ref.source !== "local") {
    return ref;
  }
  return { ...ref, id: isAbsolute(ref.id) ? ref.id : resolvePath(baseDir, ref.id) };
}

/** The portable identity key of a manifest item. */
export function identityKeyOf(item: ManifestItem): string {
  const ref = refForItem(item);
  if (ref.source === "local") {
    const kind = ref.kind ?? item.kind;
    const prefix = kind === "config" ? "config" : "local";
    return `${prefix}:${normLocalPath(ref.id)}`;
  }
  if (ref.source === "url") {
    return `url:${ref.id}`;
  }
  return `${ref.source}:${ref.id}`;
}

/**
 * Build an item set from a manifest + its lock. `pins` (keyed by
 * {@link canonicalKeyOf}) supplies the content hash that makes a local/config
 * edit visible as a change.
 */
export function buildItemSet(
  manifest: Manifest,
  baseDir: string,
  pins: ReadonlyMap<string, LockPackage>,
): ItemSet {
  const items = new Map<string, ItemEntry>();
  for (const item of manifest.items) {
    const ref = refForItem(item);
    const localized = localize(ref, baseDir);
    const canonicalKey = refKey(localized);
    const key = identityKeyOf(item);
    let value: string;
    if (ref.source === "local") {
      const pin = pins.get(canonicalKey);
      value = `local#${pin ? pin.hash.value : "?"}`;
    } else {
      value = `${formatVersionSpec(ref.versionSpec)}#${ref.kind ?? item.kind ?? ""}`;
    }
    items.set(key, { key, value, item, canonicalKey });
  }
  return {
    items,
    game: { minecraft: manifest.game.minecraft, loader: manifest.game.loader },
  };
}

/** The value string for a game base (`@game`). */
export function gameValue(g: GameValue): string {
  return `${g.minecraft}␟${g.loader}`;
}

/** One item-level delta between two manifests (for `log --stat` and rebase replay). */
export interface ItemDelta {
  readonly added: readonly ItemEntry[];
  readonly removed: readonly ItemEntry[];
  readonly changed: readonly { readonly from: ItemEntry; readonly to: ItemEntry }[];
  /** `undefined` when the game base is unchanged. */
  readonly game?: { readonly from: GameValue; readonly to: GameValue };
}

/** The item delta `from → to` (the changes `to` introduced on top of `from`). */
export function diffItemSets(from: ItemSet, to: ItemSet): ItemDelta {
  const added: ItemEntry[] = [];
  const removed: ItemEntry[] = [];
  const changed: { from: ItemEntry; to: ItemEntry }[] = [];
  for (const [key, entry] of to.items) {
    const was = from.items.get(key);
    if (!was) {
      added.push(entry);
    } else if (was.value !== entry.value) {
      changed.push({ from: was, to: entry });
    }
  }
  for (const [key, entry] of from.items) {
    if (!to.items.has(key)) {
      removed.push(entry);
    }
  }
  const sortByKey = <T extends { key: string }>(a: T, b: T): number =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  added.sort(sortByKey);
  removed.sort(sortByKey);
  changed.sort((a, b) => sortByKey(a.to, b.to));
  const gameChanged = gameValue(from.game) !== gameValue(to.game);
  return {
    added,
    removed,
    changed,
    ...(gameChanged ? { game: { from: from.game, to: to.game } } : {}),
  };
}
