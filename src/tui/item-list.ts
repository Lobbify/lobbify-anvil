/**
 * The **item list** model — turn a lock (optionally diffed against the currently
 * built lock) into display rows with source/kind badges, versions, and colorized
 * semver diffs. Pure: it maps library data to {@link Segment}s; it computes no
 * build behavior (that all lives in the `Anvil` library).
 */

import type { ItemKind, LockPackage, Lockfile, Provenance, SourceKind } from "../types/index.js";
import { kindBadge, provenanceBadge, sourceBadge } from "./badges.js";
import type { Line, Segment } from "./segments.js";
import { diffSegments, versionSegments } from "./semver-diff.js";

/** The kinds a user authors and sees in the list (infra kinds are summarized). */
const USER_KINDS = new Set<ItemKind>(["mod", "resourcepack", "shaderpack", "datapack", "config"]);

/** Stable kind ordering for a tidy list. */
const KIND_ORDER: readonly ItemKind[] = [
  "mod",
  "resourcepack",
  "shaderpack",
  "datapack",
  "config",
  "game",
  "loader",
  "library",
  "java",
];

/** Is this a user-authored item (vs. game/loader/library/java infrastructure)? */
export function isUserItem(pkg: LockPackage): boolean {
  return USER_KINDS.has(pkg.kind);
}

/** One display row in the item list. */
export interface ItemRow {
  readonly name: string;
  readonly kind: ItemKind;
  readonly source: SourceKind;
  readonly version?: string;
  readonly provenance: Provenance;
  readonly change: "added" | "removed" | "changed" | "unchanged";
  readonly fromVersion?: string;
  readonly toVersion?: string;
}

function rowFrom(pkg: LockPackage, change: ItemRow["change"]): ItemRow {
  return {
    name: pkg.name,
    kind: pkg.kind,
    source: pkg.source,
    provenance: pkg.provenance,
    change,
    ...(pkg.version !== undefined ? { version: pkg.version } : {}),
  };
}

function sortRows(rows: ItemRow[]): ItemRow[] {
  const rank = (k: ItemKind): number => {
    const i = KIND_ORDER.indexOf(k);
    return i === -1 ? KIND_ORDER.length : i;
  };
  return rows.sort(
    (a, b) => rank(a.kind) - rank(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/**
 * Build display rows for a lock's user items. When `previous` (the built lock)
 * is supplied, each row is annotated with its change (added / removed / changed)
 * and — for a change — the `from → to` versions for a colorized semver diff.
 */
export function buildItemRows(current: Lockfile, previous?: Lockfile): ItemRow[] {
  const cur = current.resolved.filter(isUserItem);
  if (!previous) {
    return sortRows(cur.map((p) => rowFrom(p, "unchanged")));
  }
  const prev = new Map<string, LockPackage>();
  for (const p of previous.resolved) {
    if (isUserItem(p)) {
      prev.set(p.name, p);
    }
  }
  const rows: ItemRow[] = [];
  const seen = new Set<string>();
  for (const p of cur) {
    seen.add(p.name);
    const was = prev.get(p.name);
    if (!was) {
      rows.push(rowFrom(p, "added"));
    } else if (was.hash.value !== p.hash.value) {
      rows.push({
        ...rowFrom(p, "changed"),
        ...(was.version !== undefined ? { fromVersion: was.version } : {}),
        ...(p.version !== undefined ? { toVersion: p.version } : {}),
      });
    } else {
      rows.push(rowFrom(p, "unchanged"));
    }
  }
  for (const [name, p] of prev) {
    if (!seen.has(name)) {
      rows.push(rowFrom(p, "removed"));
    }
  }
  return sortRows(rows);
}

/** The change marker segment for a row. */
function changeMarker(change: ItemRow["change"]): Segment {
  switch (change) {
    case "added":
      return { text: "+", color: "added", bold: true };
    case "removed":
      return { text: "-", color: "removed", bold: true };
    case "changed":
      return { text: "~", color: "changed", bold: true };
    default:
      return { text: " " };
  }
}

/** Segments for one item row: `[marker] [kind] [source] name  version  [replay]`. */
export function itemRowSegments(row: ItemRow): Line {
  const out: Segment[] = [changeMarker(row.change), { text: " " }];
  out.push(kindBadge(row.kind), { text: " " }, sourceBadge(row.source), { text: " " });
  out.push({ text: row.name, bold: true });
  const versionSegs =
    row.change === "changed"
      ? diffSegments(row.fromVersion, row.toVersion)
      : row.version !== undefined
        ? versionSegments(row.version)
        : [];
  if (versionSegs.length > 0) {
    out.push({ text: "  " }, ...versionSegs);
  }
  const prov = provenanceBadge(row.provenance);
  if (prov) {
    out.push({ text: " " }, prov);
  }
  return out;
}

/** A one-line game-base summary: `Minecraft <ver> · <loader> · N package(s)`. */
export function gameSummary(lock: Lockfile): Line {
  const total = lock.resolved.length;
  return [
    { text: "Minecraft ", color: "muted" },
    { text: lock.meta.minecraft, color: "game", bold: true },
    { text: "  ·  ", color: "muted" },
    { text: lock.meta.loader, color: "loader" },
    { text: "  ·  ", color: "muted" },
    { text: `${total} package${total === 1 ? "" : "s"}`, color: "muted" },
  ];
}
