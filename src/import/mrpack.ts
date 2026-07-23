/**
 * `.mrpack` (Modrinth modpack) import.
 *
 * A `.mrpack` is a zip carrying a `modrinth.index.json` manifest plus an
 * `overrides/` (and optional `client-overrides/`) tree of loose files. Import
 * turns it into a native anvil instance:
 *
 *   - `dependencies` → the `[game]` (Minecraft + loader), resolved to full game
 *     pins via the injected {@link ImportMrpackInput.resolveGame};
 *   - `files[]` → **copy** lock entries, each fetched from a canonical mirror,
 *     integrity-checked, and pinned by the sha256 of the bytes;
 *   - `overrides/` → **tracked local** files under `.anvil/overrides/`, placed
 *     verbatim into the instance tree.
 *
 * The `.mrpack` is fully **untrusted input**, so every defense applies:
 *   - the `overrides/` tree is unpacked through the hardened {@link safeExtract}
 *     (zip-slip / symlink / decompression-bomb guarded);
 *   - a file/override whose destination is a **protected** top-level entry
 *     (`saves/`, `.anvil/`) is refused, never placed;
 *   - mrpack ships **sha512** (and sha1), not anvil's canonical sha256 — so the
 *     bytes are downloaded, verified against the declared hash, and only then is
 *     the sha256 store key computed;
 *   - **server-only** files (`env.client == "unsupported"`) are filtered out —
 *     anvil builds a client instance;
 *   - the download mirror is chosen from `downloads[]` and passes the SSRF guard
 *     and the host `allowSource` policy before any byte is fetched.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { writeGraph } from "../build/graph.js";
import { canonicalJson } from "../build/serialize.js";
import type { AnvilEvent } from "../events.js";
import { isProtectedTop } from "../internal/fs.js";
import { writeLock } from "../lock/index.js";
import { comparePackages } from "../lock/serialize.js";
import { writeManifest } from "../manifest/index.js";
import type { DependencyEdge } from "../resolver/index.js";
import { canonicalKeyOf } from "../resolver/index.js";
import { defaultAllowSource, guardHop, safeBasename } from "../sources/index.js";
import { hashBuffer } from "../store/index.js";
import {
  AnvilError,
  DecompressionBomb,
  ManifestError,
  ShaMismatch,
  SourceNotAllowed,
} from "../types/errors.js";
import type {
  AllowSource,
  Http,
  LockPackage,
  Lockfile,
  Manifest,
  ManifestItem,
  ObjectSink,
} from "../types/index.js";
import { importOverrideTree, isUnsafePackPath, kindForPackPath } from "./pack-common.js";
import { readZipEntry } from "./zip-read.js";

/** A single byte-download bomb bound during import. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Reject a `.mrpack` archive larger than this before reading it into memory. */
const MAX_MRPACK_BYTES = 128 * 1024 * 1024;

/** Cap the file fan-out so a pack listing millions of entries can't exhaust us. */
const MAX_PACK_FILES = 10_000;

/** The pre-resolved game install a pack's `[game]` deps expand to. */
export interface GamePinsForImport {
  readonly packages: readonly LockPackage[];
  /** `meta.java` — the pinned JRE component. */
  readonly java: string;
  /** `meta.loader` — the resolved loader label (`"fabric 0.19.3"` | `"vanilla"`). */
  readonly loader: string;
}

export interface ImportMrpackInput {
  readonly archivePath: string;
  readonly instanceDir: string;
  /** Where downloaded file/override bytes are admitted (copy provenance). */
  readonly store: ObjectSink;
  /** HTTP client for the file mirrors — the SSRF guard runs on it. */
  readonly fileHttp: Http;
  /** Resolve the full game install for the pack's game/loader dependencies. */
  readonly resolveGame: (deps: {
    readonly minecraft: string;
    readonly loader: string;
  }) => Promise<GamePinsForImport>;
  /** Host source policy; defaults to allow-all (the standalone CLI default). */
  readonly allowSource?: AllowSource;
  readonly emit?: (event: AnvilEvent) => void;
}

export interface ImportMrpackResult {
  readonly manifest: Manifest;
  readonly lock: Lockfile;
  /** Count of file entries imported (server-only ones excluded). */
  readonly files: number;
  /** Count of override files tracked. */
  readonly overrides: number;
  /** Non-fatal skips (server-only files, protected-path targets, …). */
  readonly warnings: readonly string[];
}

// --- modrinth.index.json shapes (only the fields we read) ------------------

interface MrFile {
  readonly path: string;
  readonly hashes: { readonly sha1?: string; readonly sha512?: string };
  readonly env?: { readonly client?: string; readonly server?: string };
  readonly downloads: readonly string[];
  readonly fileSize?: number;
}

interface MrIndex {
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

function parseIndex(bytes: Uint8Array): MrIndex {
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

// --- pack helpers ----------------------------------------------------------

/** Map a `[game]` dependencies table to anvil's raw loader string. */
function loaderFromDeps(deps: Readonly<Record<string, string>>): string {
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
function pickMirror(downloads: readonly string[], subject: string): string {
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

/** Verify downloaded bytes against the mrpack's declared hashes (sha512 + sha1). */
function verifyMrpackHashes(bytes: Uint8Array, file: MrFile): void {
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

// --- the importer ----------------------------------------------------------

/** Import a `.mrpack` into `instanceDir`, writing `anvil.toml` + `anvil.lock`. */
export async function importMrpack(input: ImportMrpackInput): Promise<ImportMrpackResult> {
  const emit = input.emit ?? (() => undefined);
  const allowSource = input.allowSource ?? defaultAllowSource;
  const warnings: string[] = [];

  // Size-gate the untrusted archive before slurping it into memory (OOM guard).
  const archiveSize = (await stat(input.archivePath)).size;
  if (archiveSize > MAX_MRPACK_BYTES) {
    throw new DecompressionBomb(
      `.mrpack "${input.archivePath}" is ${archiveSize} bytes, over the ${MAX_MRPACK_BYTES} limit`,
    );
  }
  const archiveBytes = new Uint8Array(await readFile(input.archivePath));
  const indexBytes = await readZipEntry(archiveBytes, "modrinth.index.json");
  if (!indexBytes) {
    throw new ManifestError(
      `"${input.archivePath}" is not a valid .mrpack (no modrinth.index.json)`,
    );
  }
  const index = parseIndex(indexBytes);
  if ((index.files?.length ?? 0) > MAX_PACK_FILES) {
    throw new DecompressionBomb(
      `.mrpack lists ${index.files?.length} files, over the ${MAX_PACK_FILES} limit`,
    );
  }

  const deps = index.dependencies ?? {};
  const minecraft = deps.minecraft;
  if (!minecraft) {
    throw new ManifestError("mrpack dependencies are missing a Minecraft version");
  }
  const rawLoader = loaderFromDeps(deps);

  emit({ type: "resolve:start", items: index.files?.length ?? 0 });

  // 1. Resolve the full game install for the pack's [game] deps.
  const game = await input.resolveGame({ minecraft, loader: rawLoader });

  // 2. files[] → copy entries (fetched from a mirror, verified, sha256-pinned).
  //    Keyed by placement target so an override can later win a collision.
  const placeable = new Map<string, LockPackage>();
  const manifestItems: ManifestItem[] = [];
  let fileCount = 0;
  let index2 = 0;
  for (const file of index.files ?? []) {
    if (file.env?.client === "unsupported") {
      warnings.push(`skipped server-only file: ${file.path}`);
      continue;
    }
    if (isUnsafePackPath(file.path)) {
      warnings.push(`skipped unsafe file path: ${file.path}`);
      continue;
    }
    const top = file.path.split(/[/\\]/)[0] ?? "";
    if (isProtectedTop(top)) {
      warnings.push(`skipped file targeting a protected path: ${file.path}`);
      continue;
    }
    const mirror = pickMirror(file.downloads, file.path);
    if (!allowSource({ source: "url", id: mirror, versionSpec: { kind: "latest" } })) {
      throw new SourceNotAllowed("url", mirror);
    }
    const res = await input.fileHttp.get(mirror, { guard: guardHop, maxBytes: MAX_FILE_BYTES });
    const bytes = res.body;
    verifyMrpackHashes(bytes, file);
    const hash = hashBuffer(bytes, "sha256");
    await input.store.putBuffer(bytes, "sha256", hash);
    const kind = kindForPackPath(file.path);
    const target = posix.normalize(file.path);
    placeable.set(target, {
      name: safeBasename(file.path, ".jar"),
      kind,
      source: "url",
      hash,
      provenance: "copy",
      placement: { method: "link", target },
      size: bytes.byteLength,
      url: mirror,
    });
    manifestItems.push({ ref: { source: "url", id: mirror, versionSpec: { kind: "latest" } } });
    emit({ type: "object:store", hash, deduped: false });
    emit({
      type: "resolve:item",
      name: file.path,
      index: index2++,
      total: index.files?.length ?? 0,
    });
    fileCount += 1;
  }

  // 3. overrides/ (+ client-overrides/, which wins) → tracked local files.
  const overrideCount = await importOverrideTree({
    archivePath: input.archivePath,
    instanceDir: input.instanceDir,
    store: input.store,
    prefixes: ["overrides", "client-overrides"],
    placeable,
    warnings,
    onStored: (h) => emit({ type: "object:store", hash: h, deduped: false }),
  });

  // 4. Assemble the manifest + the pre-resolved lock.
  const manifest: Manifest = {
    project: { name: index.name ?? "imported-pack", version: index.versionId ?? "0.0.0" },
    game: { minecraft, loader: game.loader },
    items: manifestItems,
  };
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");

  const lock: Lockfile = {
    meta: { version: 1, manifestHash, minecraft, loader: game.loader, java: game.java },
    resolved: [...game.packages, ...placeable.values()].sort(comparePackages),
  };

  // 5. A flat `why` graph: every pack file/override is a direct pack item.
  const edges: DependencyEdge[] = [...placeable.values()].map((pkg) => ({
    child: canonicalKeyOf(pkg),
    childName: pkg.name,
    by: "(manifest)",
  }));

  await writeManifest(input.instanceDir, manifest);
  await writeLock(input.instanceDir, lock);
  await writeGraph(input.instanceDir, edges);

  emit({ type: "resolve:done", pinned: lock.resolved.length });
  return { manifest, lock, files: fileCount, overrides: overrideCount, warnings };
}
