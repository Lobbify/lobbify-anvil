/**
 * Shared helpers for foreign-pack import (`.mrpack` and CurseForge zip): pack
 * path safety, kind inference by placement folder, and the hardened
 * `overrides/`-tree importer used by both formats.
 *
 * The override tree is fully **untrusted**: it is unpacked through the hardened
 * {@link safeExtract} (zip-slip / symlink / decompression-bomb guarded) into a
 * throwaway stage dir, and any file whose destination is a protected/unsafe path
 * — including a `:`-bearing segment, {@link isUnsafePackPath}, LB-827 — is
 * refused, never placed. Each surviving file becomes a tracked **local**
 * (copy) entry under `.anvil/overrides/` — placed into the pre-resolved import
 * lock **and** appended to the manifest's `items` (the same shape
 * {@link importPrism} uses for its unmatched-jar case), so a later `anvil lock`
 * (regenerating the lock FROM the manifest, e.g. after a merge or rebase)
 * reproduces the override instead of silently dropping it.
 *
 * `safeExtract` supports an opt-in `rejectColon` (LB-827), and the call below
 * deliberately does **not** set it — not because `safeExtract` can't check for a
 * colon segment in general, but because it doesn't need to here specifically:
 * this call only extracts into the throwaway stage dir, unconditionally removed
 * (`rm -rf`, in the `finally` below) once this function returns, so a
 * colon-bearing entry landing there for a few lines is harmless. **That
 * reasoning is local to this call site, not a property of `safeExtract`
 * itself** — a caller that extracts onto a surface that is NOT thrown away
 * (`store/placement.ts`'s `extract` placement, which unpacks a natives jar
 * straight onto the build's instance stage) sets `rejectColon: true` and must
 * keep doing so; do not read this paragraph as license to drop that elsewhere.
 * The refusal that actually matters HERE is `isUnsafePackPath` below, checked
 * against `destRel` (the pack-relative, final tracked-copy destination)
 * **before** the persisted write at {@link importOverrideTree}'s
 * `writeFile(trackedPath, bytes)` — that write is the one bare `join` (no
 * `safeJoin`) in this file, and the one an attacker's `overrides/config/foo:bar.txt`
 * would otherwise reach unguarded.
 *
 * That manifest entry reads from the tracked copy and declares the pack-relative
 * path as its `target`. Both halves matter: the tracked copy is the only place
 * the bytes exist before a build has run, and the target is where they belong in
 * the built tree.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDir, findColonSegment, isProtectedTop } from "../internal/fs.js";
import { safeBasename } from "../sources/index.js";
import { hashBuffer, safeExtract } from "../store/index.js";
import type { ItemKind, LockPackage, ManifestItem, ObjectSink } from "../types/index.js";

/**
 * Reject an obviously-unsafe pack path: traversal, absolute, drive letter, or a
 * segment containing `:` (an NTFS alternate-data-stream trigger on Windows —
 * see {@link findColonSegment} — LB-827).
 *
 * This is the gate for declared paths that never went through
 * `declaredPlacementTarget`/`safeJoin`: `mrpack.ts`'s top-level `files[]` loop
 * and `importOverrideTree` below both call this directly on archive-supplied,
 * untrusted path strings before any byte is written. `prism.ts`'s importer calls
 * it too, on the SAME reasoning even though a Prism instance is trusted content
 * (not a hostile pack): an unmatched file's pack-relative path still becomes a
 * manifest `target`, and `declaredPlacementTarget` cannot distinguish that
 * target from a hand-written manifest's — a colon there is refused unconditionally
 * at lock time regardless of who wrote it, so the importer must not emit one
 * (LB-827). Deliberately a boolean predicate rather than a throw — every call
 * site skips the one offending file with a warning and continues, matching how
 * a protected-top path is already handled; a single bad entry must not abort an
 * otherwise-good import.
 */
export function isUnsafePackPath(path: string): boolean {
  if (path.includes("\0") || path.length === 0) {
    return true;
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[/\\]?/.test(path)) {
    return true;
  }
  const segments = path.split(/[/\\]/);
  if (segments.includes("..")) {
    return true;
  }
  return findColonSegment(segments) !== undefined;
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
  /**
   * The manifest's root item list — each surviving override gets a `{ path,
   * kind }` entry appended here too, or it exists only in the lock this import
   * writes and vanishes the moment anything re-resolves the manifest (`anvil
   * lock`, a merge/rebase re-lock).
   *
   * **Omitted for a base pack's overrides**, and deliberately: a base's files are
   * not the instance's authored items. They are re-derived from `game.from` on
   * every lock, and writing them into `items` would flatten the base into the
   * instance the first time anything re-locked — exactly the layering the base
   * exists to keep.
   */
  readonly manifestItems?: ManifestItem[];
  readonly warnings: string[];
  readonly onStored: (hash: LockPackage["hash"]) => void;
  /**
   * The `.anvil/` subdirectory the tracked bytes are written under. Defaults to
   * `"overrides"` (import); base resolution passes `"base"` so a re-resolved
   * base cannot clobber an imported override that happens to share a path.
   */
  readonly trackedSubdir?: string;
}

/**
 * Extract the pack's override prefixes through the hardened extractor, track them
 * under `.anvil/overrides/`, admit their bytes, and register a `local` copy entry
 * per file — both in `placeable` (the lock this import writes) and in
 * `manifestItems` (so the entry survives a later re-resolve of the manifest). A
 * later prefix wins a path collision (e.g. `client-overrides/`); a file whose
 * top segment is protected/unsafe is refused.
 */
export async function importOverrideTree(input: ImportOverrideTreeInput): Promise<number> {
  const subdir = input.trackedSubdir ?? "overrides";
  // Namespaced by subdir as well as pid: an import and a base resolve in one
  // process must not stage into the same throwaway directory.
  const stageDir = join(input.instanceDir, ".anvil", `import-stage-${subdir}-${process.pid}`);
  const trackedRoot = join(input.instanceDir, ".anvil", subdir);
  await rm(stageDir, { recursive: true, force: true });
  await ensureDir(stageDir);

  let count = 0;
  try {
    const keep = new Set(input.prefixes.map((p) => `${p}/`));
    // A ':'-bearing entry has to be dropped HERE, during extraction, and not by
    // the isUnsafePackPath check further down (LB-827).
    //
    // On NTFS, writing `config/foo:bar.txt` does not create that file — the write
    // is redirected into an Alternate Data Stream and leaves a PRIMARY file named
    // `config/foo` behind. The walk below then finds an ordinary name with no
    // colon in it, isUnsafePackPath has nothing left to match, and the entry is
    // imported instead of skipped. Windows CI measured exactly that: the skip
    // assertion got `imported …` where it expected `unsafe`.
    //
    // ⚠️ So the later check is POSIX-effective only, which is backwards — ADS is
    // a Windows mechanism, so a guard that runs after the write protects only the
    // platform that never needed it. Excluding at extraction is what makes the
    // guarantee true on the platform the threat exists on.
    //
    // `exclude` rather than safeExtract's `rejectColon`: this must skip one entry
    // with a warning, exactly like a protected top does, not abort a whole pack.
    const colonSkipped: string[] = [];
    await safeExtract(input.archivePath, stageDir, {
      exclude: (name) => {
        if (![...keep].some((prefix) => name.startsWith(prefix))) return true;
        if (name.split(/[/\\]/).some((seg) => seg.includes(":"))) {
          colonSkipped.push(name);
          return true;
        }
        return false;
      },
    });
    for (const name of colonSkipped) {
      // Report it as the destRel the caller would have seen, so the message
      // matches the post-walk skip warning below rather than leaking the prefix.
      const prefix = input.prefixes.find((p) => name.startsWith(`${p}/`));
      const destRel = prefix ? name.slice(prefix.length + 1) : name;
      input.warnings.push(`skipped override targeting a protected/unsafe path: ${destRel}`);
    }

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
      // isUnsafePackPath now also refuses a ':'-bearing segment (LB-827): this is
      // the check standing between an untrusted archive path and the persisted
      // write below, which is a bare `join` — not `safeJoin` — so this is the
      // only gate a colon-carrying override would meet before landing on disk.
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
      const kind = kindForPackPath(destRel);
      input.placeable.set(destRel, {
        name: safeBasename(destRel, ".txt"),
        kind,
        source: "local",
        hash,
        provenance: "copy",
        placement: { method: "link", target: destRel },
        size: bytes.byteLength,
        url: pathToFileURL(trackedPath).toString(),
      });
      // Same shape importPrism uses for its unmatched-jar local entries — see
      // module doc. A base pack passes no list: its files are not authored items.
      //
      // The item reads from the TRACKED copy and places at the pack-relative
      // path. Naming `destRel` for both would describe a file that does not
      // exist until a build has materialized it, so `import` → `lock` with no
      // build in between went looking for it and crashed (LB-719). The tracked
      // copy exists from the moment this loop writes it.
      input.manifestItems?.push({
        path: posix.join(".anvil", subdir, destRel),
        kind,
        target: destRel,
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
