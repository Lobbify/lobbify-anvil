/**
 * `.anvilignore` — the flagship safety input. Top-level instance entries listed
 * here are never created, moved, or deleted by a build. `saves/`, `.anvil/`, and
 * `.anvilignore` itself are always protected, whether or not a file exists, and
 * so are anvil's own `anvil.toml`, `anvil.lock` and `.anvilexclude` (LB-734) —
 * a build writes those through their own writers, never through the swap.
 *
 * Matching is by top-level path segment (the granularity the swap operates on):
 * a line `saves/` protects the top-level `saves` entry; `options.txt` protects
 * that file. Blank lines and `#` comments are ignored.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANVIL_RESERVED_TOP, PROTECTED_TOP, foldName } from "../internal/fs.js";

/** A resolved set of protected top-level entry names (case-folded for match). */
export class IgnoreSet {
  readonly #folded: Set<string>;

  constructor(tops: Iterable<string>) {
    // `ANVIL_RESERVED_TOP` joins the always-protected names here (LB-734) so the
    // swap is the second gate under `declaredPlacementTarget`, not the only one.
    // `journaledSwap`'s `removes` come from the PREVIOUS built lock, which is
    // never re-validated — an install target refused at lock time still has a
    // remove-shaped sibling that would otherwise rename `anvil.toml` aside.
    this.#folded = new Set([...PROTECTED_TOP, ...ANVIL_RESERVED_TOP, ...tops].map(foldName));
  }

  /** True if the relative target's top-level segment is protected (case-insensitive). */
  ignores(relPath: string): boolean {
    const top = relPath.split(/[/\\]/).find((s) => s.length > 0 && s !== ".");
    return top !== undefined && this.#folded.has(foldName(top));
  }

  /** The protected top-level names, case-folded (always includes the built-in set). */
  get tops(): ReadonlySet<string> {
    return this.#folded;
  }
}

/** Parse `.anvilignore` text into the extra protected top-level names. */
export function parseAnvilignore(text: string): string[] {
  const tops: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const top = line.split(/[/\\]/).find((s) => s.length > 0 && s !== ".");
    if (top !== undefined) {
      tops.push(top);
    }
  }
  return tops;
}

/** Load the instance's `.anvilignore` (if any) into an {@link IgnoreSet}. */
export async function loadIgnoreSet(instanceDir: string): Promise<IgnoreSet> {
  try {
    const text = await readFile(join(instanceDir, ".anvilignore"), "utf8");
    return new IgnoreSet(parseAnvilignore(text));
  } catch {
    return new IgnoreSet([]);
  }
}
