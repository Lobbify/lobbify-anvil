/**
 * The `anvil.toml` parser (uv-style manifest → typed {@link Manifest}).
 *
 * Layout:
 *
 * ```toml
 * [project]
 * name = "my-pack"
 * version = "1.0.0"
 * summary = "optional one-liner"
 *
 * [game]
 * minecraft = "26.2"
 * loader = "fabric 0.19.1"      # or "vanilla" / "quilt <v>" / "neoforge <v>"
 * # from = "modrinth:some-pack@1.4.0"   # start from a base pack (later stage)
 * # remove = ["modrinth:unwanted-mod"]  # drop items the base ships
 *
 * # unified, flat item list — each entry is "source:id@ver", a URL, a
 * # "./local/path", or a { path, kind } table.
 * items = [
 *   "modrinth:fabric-api",
 *   "modrinth:sodium@^0.5",
 *   "https://example.com/mod.jar",
 *   "./overrides/config.toml",
 *   { path = "./options.txt", kind = "config" },
 * ]
 *
 * [sources]                       # optional per-source base-URL overrides
 * # modrinth = "https://api.modrinth.com/v2"
 * ```
 *
 * `items` may sit at the document top level (before the first table) or nested
 * as `project.items`; both are accepted.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ManifestError } from "../types/errors.js";
import type { GameSpec, ItemKind, Manifest, ManifestItem } from "../types/index.js";
import { parseRef } from "./ref.js";

const MANIFEST_FILENAME = "anvil.toml";

const ITEM_KINDS: ReadonlySet<string> = new Set<ItemKind>([
  "game",
  "loader",
  "library",
  "java",
  "mod",
  "resourcepack",
  "shaderpack",
  "datapack",
  "config",
]);

function asString(v: unknown, where: string): string {
  if (typeof v !== "string") {
    throw new ManifestError(`${where}: expected a string`);
  }
  return v;
}

function asOptionalKind(v: unknown, where: string): ItemKind | undefined {
  if (v === undefined) {
    return undefined;
  }
  const s = asString(v, where);
  if (!ITEM_KINDS.has(s)) {
    throw new ManifestError(`${where}: unknown kind "${s}"`);
  }
  return s as ItemKind;
}

function readProject(raw: unknown): Manifest["project"] {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestError("missing [project] table");
  }
  const p = raw as Record<string, unknown>;
  return {
    name: asString(p.name, "project.name"),
    version: asString(p.version, "project.version"),
    ...(p.summary !== undefined ? { summary: asString(p.summary, "project.summary") } : {}),
  };
}

function readGame(raw: unknown): GameSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestError("missing [game] table");
  }
  const g = raw as Record<string, unknown>;
  const remove = g.remove;
  if (remove !== undefined && !Array.isArray(remove)) {
    throw new ManifestError("game.remove: expected an array of item references");
  }
  return {
    minecraft: asString(g.minecraft, "game.minecraft"),
    loader: asString(g.loader, "game.loader"),
    ...(g.from !== undefined ? { from: asString(g.from, "game.from") } : {}),
    ...(remove !== undefined
      ? { remove: (remove as unknown[]).map((r, i) => asString(r, `game.remove[${i}]`)) }
      : {}),
  };
}

function parseItemValue(v: unknown, i: number): ManifestItem {
  if (typeof v === "string") {
    return { ref: parseRef(v) };
  }
  if (typeof v === "object" && v !== null) {
    const t = v as Record<string, unknown>;
    if (typeof t.path === "string") {
      return {
        path: t.path,
        ...(t.kind !== undefined ? { kind: asOptionalKind(t.kind, `items[${i}].kind`) } : {}),
      };
    }
    if (typeof t.ref === "string") {
      const kind = asOptionalKind(t.kind, `items[${i}].kind`);
      const ref = parseRef(t.ref);
      return { ref: kind ? { ...ref, kind } : ref };
    }
  }
  throw new ManifestError(
    `items[${i}]: expected a "source:id@ver" string, a URL, a "./path", or a { path, kind } table`,
  );
}

function readItems(doc: Record<string, unknown>): ManifestItem[] {
  const project = doc.project as Record<string, unknown> | undefined;
  const game = doc.game as Record<string, unknown> | undefined;
  // `items` may live at the document top level, or (per TOML ordering, when
  // authored after a table header) under `[game]` or `[project]`.
  const raw = doc.items ?? game?.items ?? project?.items;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new ManifestError("items: expected an array");
  }
  return raw.map(parseItemValue);
}

/** Parse `anvil.toml` text into a typed {@link Manifest}. */
export function parseManifest(text: string): Manifest {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new ManifestError(`could not parse anvil.toml: ${(err as Error).message}`);
  }
  return {
    project: readProject(doc.project),
    game: readGame(doc.game),
    items: readItems(doc),
  };
}

/** Read + parse `<dir>/anvil.toml`. */
export async function readManifest(instanceDir: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(join(instanceDir, MANIFEST_FILENAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManifestError(`no ${MANIFEST_FILENAME} found in "${instanceDir}"`);
    }
    throw err;
  }
  return parseManifest(text);
}

export { MANIFEST_FILENAME };
