/**
 * Kind inference — decide an item's {@link ItemKind}, refusing to guess when the
 * signal is genuinely ambiguous.
 *
 * The precedence, per the plan:
 *   1. an explicit kind (from `{ path, kind }` or a ref override);
 *   2. provider metadata (Modrinth `project_type`);
 *   3. jar/zip introspection (loader-mod descriptors, `pack.mcmeta` + which of
 *      `assets/`|`data/`|`shaders/` the archive carries);
 *   4. the file extension.
 *
 * A `.zip` that could be a resourcepack, a datapack, **or** a shader is refused
 * with a {@link KindInferenceFailed} lock error rather than placed into the wrong
 * folder — silently mis-placing a datapack as a resourcepack is a real bug.
 */

import { KindInferenceFailed } from "../types/errors.js";
import type { ItemKind } from "../types/index.js";
import { listZipEntries, looksLikeZip } from "./zip-introspect.js";

export interface KindInferenceInput {
  /** A subject string for error messages (the item id / filename). */
  readonly subject: string;
  /** An explicit kind (highest precedence). */
  readonly explicit?: ItemKind;
  /** The Modrinth `project_type`, when the source is Modrinth. */
  readonly projectType?: string;
  /** The item's filename (for the extension fallback). */
  readonly filename?: string;
  /** The item's bytes (for jar/zip introspection). */
  readonly bytes?: Uint8Array;
}

/** Map a Modrinth `project_type` to an anvil {@link ItemKind}. */
function fromProjectType(projectType: string, subject: string): ItemKind {
  switch (projectType) {
    case "mod":
      return "mod";
    case "resourcepack":
      return "resourcepack";
    case "shader":
      return "shaderpack";
    case "datapack":
      return "datapack";
    default:
      throw new KindInferenceFailed(
        subject,
        `project type "${projectType}" is not a placeable instance item`,
      );
  }
}

const MOD_MARKERS = [
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/mods.toml",
  "META-INF/neoforge.mods.toml",
  "mcmod.info",
];

function hasPrefix(names: readonly string[], prefix: string): boolean {
  return names.some((n) => n === prefix || n.startsWith(prefix));
}

/** Introspect a jar/zip's entry names into a kind, or throw when ambiguous. */
function fromEntries(names: readonly string[], subject: string, isJar: boolean): ItemKind {
  if (MOD_MARKERS.some((m) => names.includes(m))) {
    return "mod";
  }
  const hasMeta = names.includes("pack.mcmeta");
  const hasAssets = hasPrefix(names, "assets/");
  const hasData = hasPrefix(names, "data/");
  const hasShaders = hasPrefix(names, "shaders/");

  if (hasShaders && !hasMeta) {
    return "shaderpack";
  }
  if (hasMeta) {
    if (hasAssets && !hasData) {
      return "resourcepack";
    }
    if (hasData && !hasAssets) {
      return "datapack";
    }
    if (hasShaders && !hasAssets && !hasData) {
      return "shaderpack";
    }
    throw new KindInferenceFailed(
      subject,
      "a pack.mcmeta archive that carries both/neither assets/ and data/ is ambiguous (resourcepack vs datapack vs shader)",
    );
  }
  if (isJar) {
    // A jar with no loader descriptor is still overwhelmingly a mod.
    return "mod";
  }
  throw new KindInferenceFailed(
    subject,
    "the zip has no recognizable resourcepack / datapack / shader / mod markers",
  );
}

function fromExtension(filename: string, subject: string): ItemKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jar") || lower.endsWith(".litemod")) {
    return "mod";
  }
  throw new KindInferenceFailed(subject, `cannot infer a kind from the extension of "${filename}"`);
}

/** Infer an item's kind following the documented precedence. */
export async function inferKind(input: KindInferenceInput): Promise<ItemKind> {
  if (input.explicit) {
    return input.explicit;
  }
  if (input.projectType) {
    return fromProjectType(input.projectType, input.subject);
  }
  const isJar = (input.filename ?? "").toLowerCase().endsWith(".jar");
  if (input.bytes && looksLikeZip(input.bytes)) {
    const names = await listZipEntries(input.bytes);
    return fromEntries(names, input.subject, isJar);
  }
  if (input.filename) {
    return fromExtension(input.filename, input.subject);
  }
  throw new KindInferenceFailed(input.subject, "no kind, provider metadata, bytes, or filename");
}

/** The instance placement folder for a placeable item kind. */
export function placementDirForKind(kind: ItemKind): string {
  switch (kind) {
    case "mod":
      return "mods";
    case "resourcepack":
      return "resourcepacks";
    case "shaderpack":
      return "shaderpacks";
    case "datapack":
      return "datapacks";
    case "config":
      return "config";
    default:
      // game/loader/library/java are handled by the game installer (Stage 3).
      return "mods";
  }
}
