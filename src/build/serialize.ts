/**
 * Deterministic JSON helpers.
 *
 * `canonicalJson` (recursively key-sorted, stable) is used to fingerprint the
 * manifest for `meta.manifestHash` and to record the internal built-lock ref
 * (`.anvil/refs/built`). The user-facing `anvil.lock` is canonical **TOML** (see
 * `src/lock/`); the internal built ref stays canonical JSON — it is not the lock
 * artifact, only the incremental baseline + GC root, and JSON keeps it simple.
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

/** Serialize the internal built-lock ref as canonical JSON. */
export function serializeRefJson(lock: Lockfile): string {
  return canonicalJson(lock);
}

/** Parse the internal built-lock ref. */
export function parseRefJson(text: string): Lockfile {
  return JSON.parse(text) as Lockfile;
}
