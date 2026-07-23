/**
 * Colorized semver diffs — turn a `from → to` version change into styled
 * {@link Segment}s, tinted by the **bump level** (major = red, minor = amber,
 * patch = green). Additions render `+<ver>`, removals `-<ver>`.
 *
 * Pure and offline. The version text is always preserved verbatim, so the diff
 * reads correctly with color stripped (`1.2.0 → 1.3.0`), never color-only.
 */

import semver from "semver";
import type { Segment, SemColor } from "./segments.js";

/** The semver bump between two versions, or `unknown` when unparseable. */
export type BumpLevel = "major" | "minor" | "patch" | "none" | "unknown";

/** Classify the bump from `from` → `to` (coercing loose versions). */
export function bumpLevel(from: string, to: string): BumpLevel {
  const a = semver.coerce(from, { includePrerelease: true });
  const b = semver.coerce(to, { includePrerelease: true });
  if (!a || !b) {
    return from === to ? "none" : "unknown";
  }
  const cmp = semver.compare(a, b);
  if (cmp === 0) {
    return "none";
  }
  const diff = semver.diff(a, b);
  if (diff === null) {
    return "none";
  }
  if (diff.startsWith("pre")) {
    // Treat prerelease transitions by their underlying release component.
    if (diff === "premajor") {
      return "major";
    }
    if (diff === "preminor") {
      return "minor";
    }
    return "patch";
  }
  if (diff === "major" || diff === "minor" || diff === "patch") {
    return diff;
  }
  return "patch";
}

/** The tint for a bump level. */
function bumpColor(level: BumpLevel): SemColor {
  switch (level) {
    case "major":
      return "removed";
    case "minor":
      return "changed";
    case "patch":
      return "added";
    default:
      return "muted";
  }
}

/** Segments for a single version string (dim, uncolored by default). */
export function versionSegments(version: string): Segment[] {
  return [{ text: version, color: "muted" }];
}

/**
 * Segments for a version change. Covers add (`from` absent), remove (`to`
 * absent), and change (`from → to`, the target tinted by bump level).
 */
export function diffSegments(from: string | undefined, to: string | undefined): Segment[] {
  if (from === undefined && to === undefined) {
    return [];
  }
  if (from === undefined && to !== undefined) {
    return [
      { text: "+", color: "added", bold: true },
      { text: to, color: "added" },
    ];
  }
  if (to === undefined && from !== undefined) {
    return [
      { text: "-", color: "removed", bold: true },
      { text: from, color: "removed" },
    ];
  }
  // Both present.
  const f = from as string;
  const t = to as string;
  if (f === t) {
    return [{ text: t, color: "muted" }];
  }
  const level = bumpLevel(f, t);
  const tint = bumpColor(level);
  return [
    { text: f, color: "muted", dim: true },
    { text: " → ", color: "muted" },
    { text: t, color: tint, bold: true },
  ];
}
