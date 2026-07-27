/**
 * `modrinth.index.json` — parsing, mirror selection, and integrity verification.
 *
 * Shared by the two readers of the same format: `.mrpack` **import** (adopt a
 * pack as a new instance) and `.mrpack` **base resolution** (`game.from`, keep
 * the pack as a layer). They were one function until base packs landed; keeping
 * the parse in one place is what stops the two from drifting into disagreeing
 * about what a pack says — which, for a format this is all untrusted input in,
 * would be a security divergence rather than a cosmetic one.
 *
 * Every bound here is a defense against a hostile pack: an archive too large to
 * read into memory, a file list long enough to exhaust us, a download that never
 * ends, a declared hash that does not match the bytes that arrived.
 */

import { createHash } from "node:crypto";
import { hashBuffer } from "../store/hash.js";
import { AnvilError, ManifestError, ShaMismatch } from "../types/errors.js";

/** A single byte-download bomb bound (per pack member). */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Reject a `.mrpack` archive larger than this before reading it into memory. */
export const MAX_MRPACK_BYTES = 128 * 1024 * 1024;

/** Cap the file fan-out so a pack listing millions of entries can't exhaust us. */
export const MAX_PACK_FILES = 10_000;

// --- modrinth.index.json shapes (only the fields we read) ------------------

export interface MrFile {
  readonly path: string;
  readonly hashes: { readonly sha1?: string; readonly sha512?: string };
  readonly env?: { readonly client?: string; readonly server?: string };
  readonly downloads: readonly string[];
  readonly fileSize?: number;
}

export interface MrIndex {
  readonly formatVersion?: number;
  readonly game?: string;
  readonly versionId?: string;
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly MrFile[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseFile(raw: unknown, i: number): MrFile {
  if (!isRecord(raw) || typeof raw.path !== "string") {
    throw new ManifestError(`modrinth.index.json files[${i}] is missing a string "path"`);
  }
  const hashes = isRecord(raw.hashes) ? raw.hashes : {};
  const downloads = Array.isArray(raw.downloads)
    ? raw.downloads.filter((d): d is string => typeof d === "string")
    : [];
  const env = isRecord(raw.env) ? raw.env : undefined;
  return {
    path: raw.path,
    hashes: {
      ...(typeof hashes.sha1 === "string" ? { sha1: hashes.sha1 } : {}),
      ...(typeof hashes.sha512 === "string" ? { sha512: hashes.sha512 } : {}),
    },
    ...(env
      ? {
          env: {
            ...(typeof env.client === "string" ? { client: env.client } : {}),
            ...(typeof env.server === "string" ? { server: env.server } : {}),
          },
        }
      : {}),
    downloads,
    ...(typeof raw.fileSize === "number" ? { fileSize: raw.fileSize } : {}),
  };
}

/** Parse `modrinth.index.json` bytes into the fields anvil reads. */
export function parseMrpackIndex(bytes: Uint8Array): MrIndex {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new ManifestError(`modrinth.index.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new ManifestError("modrinth.index.json must be a JSON object");
  }
  if (doc.game !== undefined && doc.game !== "minecraft") {
    throw new ManifestError(`unsupported mrpack game "${String(doc.game)}" (only "minecraft")`);
  }
  const rawFiles = Array.isArray(doc.files) ? doc.files : [];
  const files: MrFile[] = rawFiles.map((f, i) => parseFile(f, i));
  return {
    ...(typeof doc.formatVersion === "number" ? { formatVersion: doc.formatVersion } : {}),
    ...(typeof doc.versionId === "string" ? { versionId: doc.versionId } : {}),
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(isRecord(doc.dependencies)
      ? { dependencies: doc.dependencies as Record<string, string> }
      : {}),
    files,
  };
}

/** Map a pack `dependencies` table to anvil's raw loader string. */
export function loaderFromDeps(deps: Readonly<Record<string, string>>): string {
  if (deps["fabric-loader"]) {
    return `fabric ${deps["fabric-loader"]}`;
  }
  if (deps["quilt-loader"]) {
    return `quilt ${deps["quilt-loader"]}`;
  }
  if (deps.neoforge) {
    return `neoforge ${deps.neoforge}`;
  }
  if (deps.forge) {
    return `forge ${deps.forge}`;
  }
  return "vanilla";
}

/** Pick a canonical download mirror: prefer the Modrinth CDN, else first https. */
export function pickMirror(downloads: readonly string[], subject: string): string {
  const https = downloads.filter((u) => /^https:\/\//i.test(u));
  const modrinth = https.find((u) => {
    try {
      // Exact-suffix match so `evilmodrinth.com` is NOT treated as the CDN.
      const h = new URL(u).hostname.toLowerCase();
      return h === "modrinth.com" || h.endsWith(".modrinth.com");
    } catch {
      return false;
    }
  });
  const chosen = modrinth ?? https[0] ?? downloads[0];
  if (!chosen) {
    throw new ManifestError(`mrpack file "${subject}" lists no download mirror`);
  }
  return chosen;
}

function sha512hex(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("hex");
}

/** Verify downloaded bytes against the pack's declared hashes (sha512 + sha1). */
export function verifyMrpackHashes(bytes: Uint8Array, file: MrFile): void {
  if (!file.hashes.sha512) {
    throw new ManifestError(`mrpack file "${file.path}" has no sha512 to verify against`);
  }
  const actual512 = sha512hex(bytes);
  if (actual512 !== file.hashes.sha512) {
    throw new AnvilError(
      "SHA_MISMATCH",
      `mrpack file "${file.path}": content does not match its declared sha512 ` +
        `(expected ${file.hashes.sha512}, got ${actual512}).`,
    );
  }
  if (file.hashes.sha1) {
    const actual1 = hashBuffer(bytes, "sha1");
    if (actual1.value !== file.hashes.sha1) {
      throw new ShaMismatch(file.path, { algo: "sha1", value: file.hashes.sha1 }, actual1);
    }
  }
}

/**
 * The Modrinth CDN's canonical file URL shape:
 * `https://cdn.modrinth.com/data/{projectId}/versions/{versionId}/{filename}`.
 *
 * A pack member served from it *is* a catalogue item, and recovering that
 * identity is what lets an instance override a base mod by name rather than by
 * filename. A member served from anywhere else keeps a `url` identity and can
 * only be overridden by placement path — the documented, honest fallback.
 */
export function modrinthCdnIdentity(
  url: string,
): { projectId: string; versionId: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "cdn.modrinth.com") {
    return undefined;
  }
  const parts = parsed.pathname.split("/").filter((p) => p.length > 0);
  // data / {projectId} / versions / {versionId} / {filename}
  if (parts.length < 5 || parts[0] !== "data" || parts[2] !== "versions") {
    return undefined;
  }
  const projectId = parts[1];
  const versionId = parts[3];
  if (!projectId || !versionId) {
    return undefined;
  }
  return { projectId, versionId };
}
