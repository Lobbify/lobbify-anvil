/**
 * The reference grammar: `source:id@version` | a URL | a `./local/path` | a
 * `{ path, kind }` table. Every manifest item parses into a {@link ResolvedRef}
 * the resolver can act on.
 *
 * Version-spec grammar (resolved under the frozen `ctx.now` clock at lock time):
 *   - **pin**   — an exact version (`@1.4.0`, `@mc1.21-0.5.2`).
 *   - **range** — a semver-ish range (`@^1.4`, `@~1.4.0`, `@>=1.2 <2`, `@1.2.x`).
 *   - **latest** — an explicit `@latest` / `@*`, or omitted entirely (both mean
 *     "the newest artifact published at or before `ctx.now`").
 */

import { ManifestError } from "../types/errors.js";
import type {
  ItemKind,
  ManifestItem,
  ResolvedRef,
  SourceKind,
  VersionSpec,
} from "../types/index.js";

const SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  "mojang",
  "modrinth",
  "curseforge",
  "url",
  "local",
]);

/** A source whose id is an opaque locator (URL / path), never split on `@`. */
function isOpaqueSource(source: SourceKind): boolean {
  return source === "url" || source === "local";
}

/** True when a version string is a range rather than an exact pin. */
function looksLikeRange(v: string): boolean {
  return (
    /^[\^~><=]/.test(v) || // operator-led: ^1.2, >=1.0
    /\s-\s/.test(v) || // hyphen range: 1.2 - 1.4
    v.includes("||") || // union: 1.x || 2.x
    /(^|\.)[xX*](\.|$)/.test(v) || // x-range: 1.2.x, 1.*
    /\s/.test(v.trim()) // compound: ">=1.2 <2.0"
  );
}

/** Parse the `@version` half of a ref (or `undefined`) into a {@link VersionSpec}. */
export function parseVersionSpec(raw: string | undefined): VersionSpec {
  const v = raw?.trim();
  if (v === undefined || v === "" || v === "latest" || v === "*") {
    return { kind: "latest" };
  }
  if (looksLikeRange(v)) {
    return { kind: "range", range: v };
  }
  return { kind: "pin", version: v };
}

/** Split `id@ver` on the LAST `@` (ids/slugs carry no `@`). */
function splitIdVersion(rest: string): { id: string; ver: string | undefined } {
  const at = rest.lastIndexOf("@");
  if (at <= 0) {
    return { id: rest, ver: undefined };
  }
  return { id: rest.slice(0, at), ver: rest.slice(at + 1) };
}

/** Parse a single string reference into a {@link ResolvedRef}. */
export function parseRef(spec: string): ResolvedRef {
  const s = spec.trim();
  if (s.length === 0) {
    throw new ManifestError("empty item reference");
  }
  if (/^https?:\/\//i.test(s)) {
    return { source: "url", id: s, versionSpec: { kind: "latest" } };
  }
  if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
    return { source: "local", id: s, versionSpec: { kind: "latest" } };
  }
  const colon = s.indexOf(":");
  if (colon > 0) {
    const source = s.slice(0, colon);
    const rest = s.slice(colon + 1);
    if (SOURCE_KINDS.has(source)) {
      const src = source as SourceKind;
      if (isOpaqueSource(src)) {
        return { source: src, id: rest, versionSpec: { kind: "latest" } };
      }
      const { id, ver } = splitIdVersion(rest);
      if (id.length === 0) {
        throw new ManifestError(`item "${spec}" is missing an id`);
      }
      return { source: src, id, versionSpec: parseVersionSpec(ver) };
    }
  }
  throw new ManifestError(
    `item "${spec}" is not a valid reference — expected "source:id@version", an http(s) URL, or a "./local/path"`,
  );
}

/** Resolve a parsed {@link ManifestItem} to the ref the resolver acts on. */
export function refForItem(item: ManifestItem): ResolvedRef {
  if (item.ref) {
    const kind: ItemKind | undefined = item.ref.kind ?? item.kind;
    return kind ? { ...item.ref, kind } : item.ref;
  }
  if (item.path !== undefined) {
    return {
      source: "local",
      id: item.path,
      versionSpec: { kind: "latest" },
      ...(item.kind ? { kind: item.kind } : {}),
    };
  }
  throw new ManifestError("manifest item has neither a ref nor a path");
}

/** A stable identity for a ref — the dedup/conflict key across the worklist. */
export function refKey(ref: ResolvedRef): string {
  return `${ref.source}:${ref.id}`;
}

/** Render a version spec back to its `@…` grammar (for diagnostics). */
export function formatVersionSpec(spec: VersionSpec): string {
  switch (spec.kind) {
    case "pin":
      return spec.version;
    case "range":
      return spec.range;
    case "latest":
      return "latest";
  }
}
