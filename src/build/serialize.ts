/**
 * Deterministic JSON serialization for the on-disk locks Stage 1 reads and writes.
 *
 * NOTE — interim format. Stage 2 introduces the canonical, diff-friendly **TOML**
 * lock (`anvil.lock`) and its reader/writer in `src/lock/`. Until then, the build
 * engine reads its input lock and records the built-lock ref as canonical JSON
 * (recursively key-sorted, `/`-separated paths) so the bytes are stable and this
 * layer is self-contained. The Lockfile *object* is the real contract; only its
 * serialization changes in Stage 2.
 */

import type { Lockfile } from "../types/index.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Stable stringify: object keys sorted recursively, 2-space indent. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): JsonValue => {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(normalize);
    }
    if (typeof v === "object") {
      const out: { [k: string]: JsonValue } = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const child = (v as Record<string, unknown>)[key];
        if (child !== undefined) {
          out[key] = normalize(child);
        }
      }
      return out;
    }
    return null;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

export function serializeLock(lock: Lockfile): string {
  return canonicalJson(lock);
}

export function deserializeLock(text: string): Lockfile {
  return JSON.parse(text) as Lockfile;
}
