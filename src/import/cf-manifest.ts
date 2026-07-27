/**
 * The CurseForge modpack `manifest.json` — parsing and bounds.
 *
 * Shared by the two places a CurseForge pack enters anvil: `anvil import` of a
 * pack zip (`cfzip.ts`) and `game.from = "curseforge:…"` base resolution
 * (`base/cf-base.ts`). Same relationship `mrpack-index.ts` has to `mrpack.ts` /
 * `mrpack-base.ts`, and for the same reason — a second parser written to a lower
 * standard is exactly how a bounds check goes missing on one path only.
 *
 * ## The shape, and why it is a better pin than a `.mrpack` index
 *
 * ```json
 * { "minecraft": { "version": "26.2", "modLoaders": [{ "id": "fabric-0.19.1" }] },
 *   "files": [{ "projectID": 238222, "fileID": 5000, "required": true }],
 *   "overrides": "overrides" }
 * ```
 *
 * A member is named by a `(projectID, fileID)` pair and **nothing else** — no
 * URL, no hash, no filename. That is a stable catalogue *identity*, not a content
 * address, which has three consequences the rest of the CurseForge base path is
 * built on:
 *
 *   - **The pack cannot lie about its members' bytes**, because it never states
 *     them. Everything authoritative (hash, filename, size, class) is read from
 *     the CurseForge API for that `(projectID, fileID)`, not from this file. The
 *     `.mrpack` path has to verify a pack-declared sha512 precisely because a
 *     pack *can* state one; here there is nothing to verify against.
 *   - **Two pack versions diff without bytes**: a plain set difference over
 *     `(projectID, fileID)` (see `base/diff.ts`). No hashing, no filename
 *     matching, no heuristics.
 *   - **A member is resolvable from metadata alone.** Nothing here needs a
 *     download, which is what lets a 482-member pack lock without moving a jar.
 *
 * The file is still attacker-controlled input: it can claim any number of
 * members, any project ids, and an arbitrary `overrides` prefix. Bounds live
 * here; path safety lives in the extractor.
 */

import { ManifestError } from "../types/errors.js";

/** Cap on the `files[]` list — a manifest is a small JSON document, not a stream. */
export const MAX_CF_PACK_FILES = 10_000;

/** One `files[]` entry: a CurseForge catalogue identity, and nothing more. */
export interface CfManifestFile {
  readonly projectID: number;
  readonly fileID: number;
  readonly required?: boolean;
}

/** A parsed, bounded CurseForge `manifest.json`. */
export interface CfManifest {
  readonly minecraft: string;
  /** The loader, normalized to anvil's `"<name> <version>"` form. */
  readonly loader: string;
  readonly files: readonly CfManifestFile[];
  /** The archive prefix holding the loose override tree (default `"overrides"`). */
  readonly overrides: string;
  readonly name?: string;
  readonly version?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse a CurseForge `modLoaders` id (`"fabric-0.19.1"`) into anvil's raw loader
 * string (`"fabric 0.19.1"`). The entry flagged `primary` wins; absent that, the
 * first one. An unparseable list is `"vanilla"` rather than an error — a pack
 * with no loader is a valid (if unusual) vanilla pack.
 */
export function loaderFromModLoaders(modLoaders: unknown): string {
  if (!Array.isArray(modLoaders) || modLoaders.length === 0) {
    return "vanilla";
  }
  const primary =
    modLoaders.find((m): m is Record<string, unknown> => isRecord(m) && m.primary === true) ??
    (isRecord(modLoaders[0]) ? (modLoaders[0] as Record<string, unknown>) : undefined);
  const id = primary && typeof primary.id === "string" ? primary.id : undefined;
  if (!id) {
    return "vanilla";
  }
  const dash = id.indexOf("-");
  if (dash <= 0) {
    return id.toLowerCase();
  }
  return `${id.slice(0, dash).toLowerCase()} ${id.slice(dash + 1)}`;
}

/**
 * An `overrides` prefix a pack may name. The prefix is used to select archive
 * entries, so a pack that names `"../"` or an absolute path would widen the
 * extraction set beyond its own subtree. It must be a plain single path segment;
 * anything else falls back to the default rather than being honored.
 */
function safeOverridePrefix(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return "overrides";
  }
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed !== trimmed.trim()) {
    return "overrides";
  }
  // A single, non-traversing, non-absolute, non-drive-letter segment.
  if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === ".." || trimmed.includes("\0")) {
    return "overrides";
  }
  return trimmed;
}

/**
 * Parse and bound a `manifest.json`. Every failure is a typed
 * {@link ManifestError} naming what was wrong — a pack that does not parse is
 * never treated as an empty pack, which would silently install nothing.
 */
export function parseCfManifest(bytes: Uint8Array): CfManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new ManifestError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new ManifestError("manifest.json must be a JSON object");
  }
  if (doc.manifestType !== undefined && doc.manifestType !== "minecraftModpack") {
    throw new ManifestError(
      `unsupported CurseForge manifestType "${String(doc.manifestType)}" (only "minecraftModpack")`,
    );
  }
  if (!isRecord(doc.minecraft) || typeof doc.minecraft.version !== "string") {
    throw new ManifestError("manifest.json is missing minecraft.version");
  }
  const rawFiles = Array.isArray(doc.files) ? doc.files : [];
  if (rawFiles.length > MAX_CF_PACK_FILES) {
    throw new ManifestError(
      `manifest.json lists ${rawFiles.length} files, over the ${MAX_CF_PACK_FILES} limit`,
    );
  }
  const files: CfManifestFile[] = [];
  for (const [i, f] of rawFiles.entries()) {
    if (
      !isRecord(f) ||
      typeof f.projectID !== "number" ||
      typeof f.fileID !== "number" ||
      !Number.isSafeInteger(f.projectID) ||
      !Number.isSafeInteger(f.fileID) ||
      f.projectID <= 0 ||
      f.fileID <= 0
    ) {
      throw new ManifestError(`manifest.json files[${i}] is missing numeric projectID/fileID`);
    }
    files.push({
      projectID: f.projectID,
      fileID: f.fileID,
      ...(typeof f.required === "boolean" ? { required: f.required } : {}),
    });
  }
  return {
    minecraft: doc.minecraft.version,
    loader: loaderFromModLoaders(doc.minecraft.modLoaders),
    files,
    overrides: safeOverridePrefix(doc.overrides),
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(typeof doc.version === "string" ? { version: doc.version } : {}),
  };
}
