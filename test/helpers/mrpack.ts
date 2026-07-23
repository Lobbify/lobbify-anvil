/**
 * Build a `.mrpack` fixture in memory. The declared sha1/sha512 hashes are
 * computed from the given bytes so a faithful download verifies; a test can also
 * inject `malicious` raw zip entries (traversal / symlink) to exercise the
 * untrusted-input guards, or point a mirror at mismatching bytes to trip the
 * integrity check.
 */

import { createHash } from "node:crypto";
import type { ZipEntrySpec } from "./zip.js";
import { makeZip } from "./zip.js";

function sha1hex(b: Uint8Array): string {
  return createHash("sha1").update(b).digest("hex");
}
function sha512hex(b: Uint8Array): string {
  return createHash("sha512").update(b).digest("hex");
}

export interface MrpackFileSpec {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mirror: string;
  readonly env?: { readonly client?: string; readonly server?: string };
  /** Override the declared sha512 (to force an integrity mismatch). */
  readonly declaredSha512?: string;
}

export interface MrpackSpec {
  readonly name?: string;
  readonly versionId?: string;
  readonly minecraft: string;
  readonly loader?: { readonly name: "fabric-loader" | "quilt-loader"; readonly version: string };
  readonly files?: readonly MrpackFileSpec[];
  readonly overrides?: readonly { readonly path: string; readonly data: string | Uint8Array }[];
  readonly clientOverrides?: readonly {
    readonly path: string;
    readonly data: string | Uint8Array;
  }[];
  /** Raw zip entries appended verbatim — for zip-slip / symlink attack cases. */
  readonly malicious?: readonly ZipEntrySpec[];
}

/** Serialize a `.mrpack` (zip) buffer from the spec. */
export function buildMrpack(spec: MrpackSpec): Buffer {
  const dependencies: Record<string, string> = { minecraft: spec.minecraft };
  if (spec.loader) {
    dependencies[spec.loader.name] = spec.loader.version;
  }
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: spec.versionId ?? "1.0.0",
    name: spec.name ?? "Test Pack",
    dependencies,
    files: (spec.files ?? []).map((f) => ({
      path: f.path,
      hashes: { sha1: sha1hex(f.bytes), sha512: f.declaredSha512 ?? sha512hex(f.bytes) },
      ...(f.env ? { env: f.env } : {}),
      downloads: [f.mirror],
      fileSize: f.bytes.byteLength,
    })),
  };
  const entries: ZipEntrySpec[] = [{ name: "modrinth.index.json", data: JSON.stringify(index) }];
  for (const o of spec.overrides ?? []) {
    entries.push({ name: `overrides/${o.path}`, data: o.data });
  }
  for (const o of spec.clientOverrides ?? []) {
    entries.push({ name: `client-overrides/${o.path}`, data: o.data });
  }
  for (const m of spec.malicious ?? []) {
    entries.push(m);
  }
  return makeZip(entries);
}
