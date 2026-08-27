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
 * # "./local/path", a { path, kind, target } table, or a { ref, kind, target }
 * # table.
 * items = [
 *   "modrinth:fabric-api",
 *   "modrinth:sodium@^0.5",
 *   "https://example.com/mod.jar",
 *   "./config/sodium/mixins.json",
 *   { path = "./options.txt", kind = "config" },
 *   # a tracked copy: read from .anvil/, placed where it belongs
 *   { path = ".anvil/overrides/config/sodium.json", target = "config/sodium.json" },
 *   # a re-identified jar (LB-720): identity from ref, placement from target
 *   { ref = "modrinth:sodium", target = "mods/26.2/sodium.jar" },
 * ]
 *
 * [sources]                       # optional per-source base-URL overrides
 * # modrinth = "https://api.modrinth.com/v2"
 * ```
 *
 * `items` may sit at the document top level (before the first table) or nested
 * as `project.items`; both are accepted.
 *
 * A path item's path is **instance-relative and is also where the file is
 * placed** — `"./config/sodium/mixins.json"` is read from there and built back
 * there, and `"./options.txt"` stays at the instance root. Only a path that
 * resolves outside the instance (`"../shared/mods/foo.jar"`, an absolute path)
 * names no placement of its own; such an item is placed by its kind, like any
 * Modrinth/CurseForge/URL item.
 *
 * An explicit `target` splits identity from placement. On a `path` item it
 * separates the two halves a path normally names at once: `path` stays the
 * read location and `target` becomes the placement. That is how a **tracked
 * copy** (an imported override, whose bytes live under `.anvil/overrides/`
 * before any build has run) names a manifest that is self-consistent from the
 * moment `import` writes it. On a `ref` item (LB-720) it does the analogous job
 * for something that names no path at all: `ref` stays the identity Modrinth/
 * CurseForge/URL resolve against, and `target` is where the resolved bytes
 * land — the only way a re-identified jar (a Prism import matched against
 * Modrinth/CurseForge) can keep a subdirectory across every later re-lock,
 * since its ref alone carries nothing to derive a placement from. Either way,
 * `saves/`, `.anvil/`, and `.anvilignore` are refused as a *placement* — a
 * target is checked by the same guards a derived one is, so the field cannot
 * be used to write where a path could not.
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
        ...(t.target !== undefined ? { target: asString(t.target, `items[${i}].target`) } : {}),
      };
    }
    if (typeof t.ref === "string") {
      // A `ref` item carries no path to place from, so declaring `target` is
      // how it names a placement separately from its identity (LB-720) — every
      // `Source` honors it the same way `local` honors a derived one.
      const kind = asOptionalKind(t.kind, `items[${i}].kind`);
      const ref = parseRef(t.ref);
      return {
        ref: kind ? { ...ref, kind } : ref,
        ...(t.target !== undefined ? { target: asString(t.target, `items[${i}].target`) } : {}),
      };
    }
  }
  // Enumerates every form the parser accepts, `{ ref, kind }` included. This
  // string gets read as the grammar's definition — it is the first place anyone
  // looks after a rejection — so a form omitted here is undocumented grammar.
  // That omission is what hid LB-862's second instance: a test list sourced from
  // this message could not contain a case the message never mentioned.
  throw new ManifestError(
    `items[${i}]: expected a "source:id@ver" string, a URL, a "./path", a { path, kind } table, or a { ref, kind } table`,
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
