/**
 * Shared helpers for foreign-pack import (`.mrpack` and CurseForge zip): pack
 * path safety, kind inference by placement folder, and the hardened
 * `overrides/`-tree importer used by both formats.
 *
 * The override tree is fully **untrusted**: it is unpacked through the hardened
 * {@link safeExtract} (zip-slip / symlink / decompression-bomb guarded) into a
 * throwaway stage dir, and any file whose destination is a protected/unsafe path
 * is refused, never placed. Each surviving file becomes a tracked **local**
 * (copy) entry under `.anvil/overrides/`.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDir, isProtectedTop } from "../internal/fs.js";
import { safeBasename } from "../sources/index.js";
import { hashBuffer, safeExtract } from "../store/index.js";
import type { ItemKind, LockPackage, ObjectSink } from "../types/index.js";

/** Reject an obviously-unsafe pack path (traversal / absolute / drive letter). */
export function isUnsafePackPath(path: string): boolean {
  if (path.includes("\0") || path.length === 0) {
    return true;
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[/\\]?/.test(path)) {
    return true;
  }
  return path.split(/[/\\]/).includes("..");
}

/** Infer a placement kind from a pack-relative path's top-level directory. */
export function kindForPackPath(path: string): ItemKind {
  const top = path.split("/")[0]?.toLowerCase();
  switch (top) {
    case "mods":
      return "mod";
    case "resourcepacks":
      return "resourcepack";
    case "shaderpacks":
      return "shaderpack";
    case "datapacks":
      return "datapack";
    default:
      return "config";
  }
}

async function* walkFiles(root: string, rel = ""): AsyncGenerator<string> {
  let names: string[];
  try {
    names = await readdir(join(root, rel));
  } catch {
    return;
  }
  for (const name of names) {
    const childRel = rel ? posix.join(rel, name) : name;
    const st = await stat(join(root, childRel));
    if (st.isDirectory()) {
      yield* walkFiles(root, childRel);
    } else if (st.isFile()) {
      yield childRel;
    }
  }
}

export interface ImportOverrideTreeInput {
  readonly archivePath: string;
  readonly instanceDir: string;
  /** Where override bytes are admitted (copy provenance). */
  readonly store: ObjectSink;
  /**
   * The archive prefixes to keep, in precedence order (**later wins** a path
   * collision). `.mrpack` uses `["overrides", "client-overrides"]`; a CurseForge
   * zip uses `["overrides"]`.
   */
  readonly prefixes: readonly string[];
  /** The placeable map to add tracked-local entries to (keyed by dest path). */
  readonly placeable: Map<string, LockPackage>;
  readonly warnings: string[];
  readonly onStored: (hash: LockPackage["hash"]) => void;
}

/**
 * Extract the pack's override prefixes through the hardened extractor, track them
 * under `.anvil/overrides/`, admit their bytes, and register a `local` copy entry
 * per file. A later prefix wins a path collision (e.g. `client-overrides/`); a
 * file whose top segment is protected/unsafe is refused.
 */
export async function importOverrideTree(input: ImportOverrideTreeInput): Promise<number> {
  const stageDir = join(input.instanceDir, ".anvil", `import-stage-${process.pid}`);
  const trackedRoot = join(input.instanceDir, ".anvil", "overrides");
  await rm(stageDir, { recursive: true, force: true });
  await ensureDir(stageDir);

  let count = 0;
  try {
    const keep = new Set(input.prefixes.map((p) => `${p}/`));
    // safeExtract applies every zip-slip / symlink / bomb guard; we keep only the
    // requested override subtrees.
    await safeExtract(input.archivePath, stageDir, {
      exclude: (name) => ![...keep].some((prefix) => name.startsWith(prefix)),
    });

    // Map destRel → absolute staged source; a later prefix overwrites an earlier
    // one for the same path (config precedence).
    const chosen = new Map<string, string>();
    for (const prefix of input.prefixes) {
      const sub = join(stageDir, prefix);
      for await (const rel of walkFiles(sub)) {
        chosen.set(rel, join(sub, rel));
      }
    }

    for (const [destRel, absSrc] of chosen) {
      const top = destRel.split(/[/\\]/)[0] ?? "";
      if (isProtectedTop(top) || isUnsafePackPath(destRel)) {
        input.warnings.push(`skipped override targeting a protected/unsafe path: ${destRel}`);
        continue;
      }
      const bytes = new Uint8Array(await readFile(absSrc));
      const hash = hashBuffer(bytes, "sha256");
      await input.store.putBuffer(bytes, "sha256", hash);
      const trackedPath = join(trackedRoot, destRel);
      await mkdir(join(trackedPath, ".."), { recursive: true });
      // Write the already-read+hashed bytes (no re-read → no TOCTOU on absSrc).
      await writeFile(trackedPath, bytes);
      input.placeable.set(destRel, {
        name: safeBasename(destRel, ".txt"),
        kind: kindForPackPath(destRel),
        source: "local",
        hash,
        provenance: "copy",
        placement: { method: "link", target: destRel },
        size: bytes.byteLength,
        url: pathToFileURL(trackedPath).toString(),
      });
      input.onStored(hash);
      count += 1;
    }
  } finally {
    // Always reap the staging dir, even if extraction/placement threw.
    await rm(stageDir, { recursive: true, force: true });
  }
  return count;
}
