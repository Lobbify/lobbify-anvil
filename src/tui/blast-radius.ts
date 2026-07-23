/**
 * **Blast radius** + **re-lock preview** — a **display-only** projection a
 * conflict card shows so the user understands the consequence of a resolution
 * *before* the commit. It reads only the current pack's lock and computes a
 * count; it drives **no** resolution and never feeds back into the merge (the
 * real merge is 100% library-driven via `Anvil.merge`'s `onConflict`). It is a
 * presentation summary of library data, in the same category as the CLI's status
 * summary — not a re-implementation of build behavior.
 *
 * The metrics track the constrained, pin-preserving re-lock:
 *   - a `@game` (game-base) conflict cascades: **every source (Modrinth /
 *     CurseForge) package** in the pack is re-resolved under the new game — the
 *     manifest roots are forced (the resolver's `reResolveKeys`) and their source
 *     dependencies re-resolve with them, so the whole source set is the radius;
 *   - any other conflict changes only its **one** item; every other package
 *     keeps its byte-identical pin.
 */

import type { Lockfile } from "../types/index.js";
import type { Conflict } from "../vc/index.js";

/** Facts about the current pack needed to size a conflict's blast radius. */
export interface PackContext {
  /**
   * Names of source (Modrinth / CurseForge) packages — the game-cascade set.
   * Includes transitively-resolved source deps, which re-resolve alongside their
   * roots when the game bumps.
   */
  readonly sourceItems: readonly string[];
  /** Names of local / url items — kept verbatim across a game cascade. */
  readonly keptItems: readonly string[];
}

/** Derive the {@link PackContext} from the current lock (or an empty pack). */
export function packContextFromLock(lock: Lockfile | undefined): PackContext {
  if (!lock) {
    return { sourceItems: [], keptItems: [] };
  }
  const sourceItems: string[] = [];
  const keptItems: string[] = [];
  for (const p of lock.resolved) {
    if (p.source === "modrinth" || p.source === "curseforge") {
      sourceItems.push(p.name);
    } else if (p.source === "url" || p.source === "local") {
      keptItems.push(p.name);
    }
  }
  return { sourceItems: sourceItems.sort(), keptItems: keptItems.sort() };
}

/** The set of items a resolution will disturb. */
export interface BlastRadius {
  /** Number of items re-resolved/changed by resolving this conflict. */
  readonly count: number;
  /** The affected item names (bounded for display). */
  readonly items: readonly string[];
  /** A one-line human summary. */
  readonly note: string;
}

/** A preview of the constrained re-lock a resolution triggers. */
export interface RelockPreview {
  /** Items forced back through resolution. */
  readonly reResolved: number;
  /** Packages that keep their exact (byte-identical) pin. */
  readonly keptPins: number;
  readonly note: string;
}

function isGameConflict(conflict: Conflict): boolean {
  return conflict.kind === "game" || conflict.key === "@game";
}

/** Compute the blast radius of resolving `conflict` against the pack. */
export function computeBlastRadius(conflict: Conflict, ctx: PackContext): BlastRadius {
  if (isGameConflict(conflict)) {
    const items = ctx.sourceItems;
    return {
      count: items.length,
      items,
      note:
        items.length === 0
          ? "no source items to re-resolve"
          : `${items.length} source item${items.length === 1 ? "" : "s"} re-resolve under the new game base`,
    };
  }
  // A phase-2 re-lock secondary already IS the cascade fallout — size it likewise.
  if (conflict.kind === "no-compatible-version" || conflict.kind === "dependency") {
    return {
      count: 1,
      items: [conflict.key],
      note: "the re-lock cannot satisfy this item under the merged game",
    };
  }
  // A single-item conflict changes only that item.
  return { count: 1, items: [conflict.key], note: "only this item changes" };
}

/** Compute the pin-preserving re-lock preview of resolving `conflict`. */
export function computeRelockPreview(conflict: Conflict, ctx: PackContext): RelockPreview {
  const totalItems = ctx.sourceItems.length + ctx.keptItems.length;
  if (isGameConflict(conflict)) {
    const reResolved = ctx.sourceItems.length;
    const keptPins = ctx.keptItems.length;
    return {
      reResolved,
      keptPins,
      note: `${reResolved} item${reResolved === 1 ? "" : "s"} re-resolve; ${keptPins} local/url item${keptPins === 1 ? "" : "s"} keep their pin (the game install is re-resolved too)`,
    };
  }
  const keptPins = Math.max(0, totalItems - 1);
  return {
    reResolved: 1,
    keptPins,
    note: `only the chosen version is applied; ${keptPins} other item${keptPins === 1 ? "" : "s"} keep their exact pin`,
  };
}
