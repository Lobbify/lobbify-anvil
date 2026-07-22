/**
 * `.anvilignore` — the flagship safety input. Top-level instance entries listed
 * here are never created, moved, or deleted by a build. `saves/`, `.anvil/`, and
 * `.anvilignore` itself are always protected, whether or not a file exists.
 *
 * Matching is by top-level path segment (the granularity the swap operates on):
 * a line `saves/` protects the top-level `saves` entry; `options.txt` protects
 * that file. Blank lines and `#` comments are ignored.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROTECTED_TOP } from "../internal/fs.js";

/** A resolved set of protected top-level entry names. */
export class IgnoreSet {
  readonly #tops: Set<string>;

  constructor(tops: Iterable<string>) {
    this.#tops = new Set([...PROTECTED_TOP, ...tops]);
  }

  /** True if the relative target's top-level segment is protected. */
  ignores(relPath: string): boolean {
    const top = relPath.split(/[/\\]/).find((s) => s.length > 0 && s !== ".");
    return top !== undefined && this.#tops.has(top);
  }

  /** The protected top-level names (always includes `saves`, `.anvil`, `.anvilignore`). */
  get tops(): ReadonlySet<string> {
    return this.#tops;
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
