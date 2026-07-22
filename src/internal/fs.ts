/**
 * Small filesystem helpers shared by the store and build layers, plus the single
 * hardened `safeJoin` used to keep every materialized path under its allowed root
 * and away from protected paths (`saves/`, `.anvil/`).
 */

import { mkdir, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { PathEscape } from "../types/errors.js";

/** Top-level instance entries the build must never create, move, or delete. */
export const PROTECTED_TOP = new Set([".anvil", ".anvilignore", "saves"]);

/** True if `p` exists (file, dir, or symlink). */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `mkdir -p`. */
export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

/** `rm -rf` (never throws on a missing path). */
export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}

/** Rename, creating the destination parent first. */
export async function renameInto(from: string, to: string): Promise<void> {
  await mkdir(resolve(to, ".."), { recursive: true });
  await rename(from, to);
}

/** The device (volume) id backing `path`. Injectable in tests for cross-volume cases. */
export async function statDevOf(path: string): Promise<number> {
  return (await stat(path)).dev;
}

/**
 * Resolve a relative target under `root`, rejecting anything unsafe:
 * absolute/drive-letter paths, NUL bytes, `..` traversal that escapes `root`, and
 * (unless `allowProtected`) a target whose top-level segment is protected
 * (`saves/`, `.anvil/`, `.anvilignore`). This is the placement-side half of the
 * zip-slip / "`saves/` never touched" guarantee.
 */
export function safeJoin(root: string, rel: string, opts?: { allowProtected?: boolean }): string {
  if (rel.includes("\0")) {
    throw new PathEscape(rel, "path contains a NUL byte");
  }
  if (isAbsolute(rel) || /^[a-zA-Z]:[/\\]?/.test(rel)) {
    throw new PathEscape(rel, "absolute or drive-letter path");
  }
  const segments = rel.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  if (segments.includes("..")) {
    throw new PathEscape(rel, "contains a '..' traversal segment");
  }
  const normalizedRoot = resolve(root);
  const abs = resolve(normalizedRoot, rel);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + sep)) {
    throw new PathEscape(rel, "escapes the target root");
  }
  const top = segments[0] ?? "";
  if (!opts?.allowProtected && PROTECTED_TOP.has(top)) {
    throw new PathEscape(rel, `targets protected path "${top}"`);
  }
  return abs;
}
