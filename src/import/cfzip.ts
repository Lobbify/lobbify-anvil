/**
 * CurseForge modpack zip import.
 *
 * A CurseForge modpack is a zip carrying a `manifest.json` (`{ minecraft: {
 * version, modLoaders }, files: [{ projectID, fileID, required }], overrides }`)
 * plus an `overrides/` tree of loose files. Import turns it into a native anvil
 * instance:
 *
 *   - `minecraft` → the `[game]` (Minecraft + loader), resolved to full game pins
 *     via the injected {@link ImportCfZipInput.resolveGame};
 *   - `files[]` → **replay** lock entries — each pinned by fetching its bytes
 *     under the user's key to compute the sha256, **without** admitting the bytes
 *     to the shared store (they are re-fetched per-client at build time). This is
 *     why CF-zip import **needs a key to fully pin**;
 *   - `overrides/` → **tracked local** (copy) files under `.anvil/overrides/`,
 *     unpacked through the hardened {@link safeExtract}.
 *
 * The archive is fully **untrusted**; every safeExtract / protected-path /
 * bomb-bound defense from the `.mrpack` path applies here too.
 */

import { readFile, stat } from "node:fs/promises";
import { writeGraph } from "../build/graph.js";
import { canonicalJson } from "../build/serialize.js";
import type { AnvilEvent } from "../events.js";
import { writeLock } from "../lock/index.js";
import { comparePackages } from "../lock/serialize.js";
import { writeManifest } from "../manifest/index.js";
import type { DependencyEdge } from "../resolver/index.js";
import { canonicalKeyOf } from "../resolver/index.js";
import {
  CurseForgeApi,
  curseforgeFingerprint,
  defaultAllowSource,
  guardHop,
  inferKind,
  replayDownloadReason,
  safeBasename,
  singleFilePlacement,
} from "../sources/index.js";
import { hashBuffer } from "../store/index.js";
import {
  DecompressionBomb,
  ManifestError,
  ReplayUnavailable,
  ShaMismatch,
  SourceKeyMissing,
  SourceNotAllowed,
} from "../types/errors.js";
import type {
  AllowSource,
  Http,
  ItemKind,
  LockPackage,
  Lockfile,
  Manifest,
  ManifestItem,
  ObjectSink,
} from "../types/index.js";
import type { GamePinsForImport } from "./mrpack.js";
import { importOverrideTree } from "./pack-common.js";
import { readZipEntry } from "./zip-read.js";

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_CFZIP_BYTES = 128 * 1024 * 1024;
const MAX_PACK_FILES = 10_000;

/** CurseForge classId → kind (the placeable subset; else infer from bytes). */
const CF_CLASS_KIND: ReadonlyMap<number, ItemKind> = new Map<number, ItemKind>([
  [6, "mod"],
  [12, "resourcepack"],
  [6552, "shaderpack"],
  [6945, "datapack"],
]);
const CF_HASH_SHA1 = 1;

export interface ImportCfZipInput {
  readonly archivePath: string;
  readonly instanceDir: string;
  /** Where override (copy) bytes are admitted. Replay bytes never go here. */
  readonly store: ObjectSink;
  /** The CurseForge HTTP client (for the keyed API + CDN download). */
  readonly curseforgeHttp: Http;
  /** BYO CurseForge key — required to fully pin (else {@link SourceKeyMissing}). */
  readonly curseforgeKey?: string;
  /** CurseForge API base override. */
  readonly curseforgeBaseUrl?: string;
  /** Resolve the full game install for the pack's Minecraft/loader. */
  readonly resolveGame: (deps: {
    readonly minecraft: string;
    readonly loader: string;
  }) => Promise<GamePinsForImport>;
  readonly allowSource?: AllowSource;
  readonly emit?: (event: AnvilEvent) => void;
}

export interface ImportCfZipResult {
  readonly manifest: Manifest;
  readonly lock: Lockfile;
  /** Count of CurseForge (replay) file entries pinned. */
  readonly files: number;
  /** Count of override files tracked. */
  readonly overrides: number;
  readonly warnings: readonly string[];
}

// --- manifest.json shapes (only the fields we read) ------------------------

interface CfManifestFile {
  readonly projectID: number;
  readonly fileID: number;
  readonly required?: boolean;
}

interface CfManifest {
  readonly minecraft: string;
  readonly loader: string;
  readonly files: readonly CfManifestFile[];
  readonly overrides: string;
  readonly name?: string;
  readonly version?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse a CurseForge `modLoaders` id (`"fabric-0.16.9"`) into a raw loader string. */
function loaderFromModLoaders(modLoaders: unknown): string {
  if (!Array.isArray(modLoaders) || modLoaders.length === 0) {
    return "vanilla";
  }
  const primary =
    modLoaders.find((m): m is Record<string, unknown> => isRecord(m) && m.primary === true) ??
    (isRecord(modLoaders[0]) ? (modLoaders[0] as Record<string, unknown>) : undefined);
  const id = primary && typeof primary.id === "string" ? primary.id : undefined;
  if (!id) {
    return "vanilla";
  }
  const dash = id.indexOf("-");
  if (dash <= 0) {
    return id.toLowerCase();
  }
  const name = id.slice(0, dash).toLowerCase();
  const version = id.slice(dash + 1);
  return `${name} ${version}`;
}

function parseManifest(bytes: Uint8Array): CfManifest {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new ManifestError(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc)) {
    throw new ManifestError("manifest.json must be a JSON object");
  }
  if (doc.manifestType !== undefined && doc.manifestType !== "minecraftModpack") {
    throw new ManifestError(
      `unsupported CurseForge manifestType "${String(doc.manifestType)}" (only "minecraftModpack")`,
    );
  }
  if (!isRecord(doc.minecraft) || typeof doc.minecraft.version !== "string") {
    throw new ManifestError("manifest.json is missing minecraft.version");
  }
  const minecraft = doc.minecraft.version;
  const loader = loaderFromModLoaders(doc.minecraft.modLoaders);
  const rawFiles = Array.isArray(doc.files) ? doc.files : [];
  const files: CfManifestFile[] = [];
  for (const [i, f] of rawFiles.entries()) {
    if (
      !isRecord(f) ||
      typeof f.projectID !== "number" ||
      typeof f.fileID !== "number" ||
      !Number.isSafeInteger(f.projectID) ||
      !Number.isSafeInteger(f.fileID)
    ) {
      throw new ManifestError(`manifest.json files[${i}] is missing numeric projectID/fileID`);
    }
    files.push({
      projectID: f.projectID,
      fileID: f.fileID,
      ...(typeof f.required === "boolean" ? { required: f.required } : {}),
    });
  }
  return {
    minecraft,
    loader,
    files,
    overrides: typeof doc.overrides === "string" ? doc.overrides : "overrides",
    ...(typeof doc.name === "string" ? { name: doc.name } : {}),
    ...(typeof doc.version === "string" ? { version: doc.version } : {}),
  };
}

// --- CF file metadata → a pinned replay LockPackage ------------------------

interface CfFileMeta {
  readonly id: number;
  readonly modId: number;
  readonly displayName?: string;
  readonly fileName: string;
  readonly classId?: number;
  readonly slug?: string;
  readonly hashes?: ReadonlyArray<{ readonly value: string; readonly algo: number }>;
  readonly fileFingerprint?: number;
  readonly fileLength?: number;
}

/** Import a CurseForge modpack zip into `instanceDir`. */
export async function importCurseForgeZip(input: ImportCfZipInput): Promise<ImportCfZipResult> {
  const emit = input.emit ?? (() => undefined);
  const allowSource = input.allowSource ?? defaultAllowSource;
  const warnings: string[] = [];

  const archiveSize = (await stat(input.archivePath)).size;
  if (archiveSize > MAX_CFZIP_BYTES) {
    throw new DecompressionBomb(
      `CurseForge zip "${input.archivePath}" is ${archiveSize} bytes, over the ${MAX_CFZIP_BYTES} limit`,
    );
  }
  const archiveBytes = new Uint8Array(await readFile(input.archivePath));
  const manifestBytes = await readZipEntry(archiveBytes, "manifest.json");
  if (!manifestBytes) {
    throw new ManifestError(
      `"${input.archivePath}" is not a valid CurseForge modpack (no manifest.json)`,
    );
  }
  const cf = parseManifest(manifestBytes);
  if (cf.files.length > MAX_PACK_FILES) {
    throw new DecompressionBomb(
      `CurseForge zip lists ${cf.files.length} files, over the ${MAX_PACK_FILES} limit`,
    );
  }

  // Fully pinning CurseForge files requires the BYO key — fail closed, never a
  // silent skip. (An import with files but no key cannot compute their shas.)
  if (cf.files.length > 0 && !input.curseforgeKey) {
    throw new SourceKeyMissing(
      "curseforge",
      "importing a CurseForge modpack needs an API key to pin its files. " +
        "Set the CurseForge key and retry.",
    );
  }

  emit({ type: "resolve:start", items: cf.files.length });

  // 1. Resolve the full game install.
  const game = await input.resolveGame({ minecraft: cf.minecraft, loader: cf.loader });

  // 2. files[] → replay entries (fetched under the key, sha256-pinned, NOT stored).
  const api = input.curseforgeKey
    ? new CurseForgeApi(input.curseforgeHttp, input.curseforgeKey, input.curseforgeBaseUrl)
    : undefined;
  const placeable = new Map<string, LockPackage>();
  const manifestItems: ManifestItem[] = [];
  let fileCount = 0;
  let idx = 0;
  for (const entry of cf.files) {
    if (!api) {
      break; // unreachable — guarded above — but keeps the type narrow
    }
    const subject = `curseforge:${entry.projectID}`;
    // The host source policy can veto CurseForge before any network I/O.
    if (
      !allowSource({
        source: "curseforge",
        id: String(entry.projectID),
        versionSpec: { kind: "pin", version: String(entry.fileID) },
      })
    ) {
      throw new SourceNotAllowed("curseforge", String(entry.projectID));
    }
    const meta = (await api.getModFile(entry.projectID, entry.fileID)) as CfFileMeta;

    const url = await api.getDownloadUrl(entry.projectID, entry.fileID);
    if (!url) {
      throw new ReplayUnavailable(
        subject,
        "the author disabled third-party API downloads for this file",
      );
    }
    let bytes: Uint8Array;
    try {
      const res = await input.curseforgeHttp.get(url, {
        guard: guardHop,
        maxBytes: MAX_FILE_BYTES,
      });
      bytes = res.body;
    } catch (err) {
      // Never surface the resolved CDN URL (kept out of messages/events/logs).
      throw new ReplayUnavailable(subject, replayDownloadReason(err));
    }

    // Cross-check CF's attested sha1 + murmur2 fingerprint; pin sha256.
    const sha1 = meta.hashes?.find((h) => h.algo === CF_HASH_SHA1)?.value;
    if (sha1) {
      const actual = hashBuffer(bytes, "sha1");
      if (actual.value !== sha1.toLowerCase()) {
        throw new ShaMismatch(subject, { algo: "sha1", value: sha1.toLowerCase() }, actual);
      }
    }
    if (
      meta.fileFingerprint !== undefined &&
      curseforgeFingerprint(bytes) !== meta.fileFingerprint
    ) {
      throw new ShaMismatch(
        `${subject} (murmur2 fingerprint)`,
        { algo: "sha256", value: String(meta.fileFingerprint) },
        { algo: "sha256", value: String(curseforgeFingerprint(bytes)) },
      );
    }
    const hash = hashBuffer(bytes, "sha256");
    // The bytes are DISCARDED here — a replay item is re-fetched per-client into
    // the replay cache at build time; it never enters the shared store.

    const kind =
      (meta.classId !== undefined ? CF_CLASS_KIND.get(meta.classId) : undefined) ??
      (await inferKind({ subject, filename: meta.fileName, bytes }));
    const filename = safeBasename(meta.fileName, ".jar");
    const size =
      typeof meta.fileLength === "number" && Number.isSafeInteger(meta.fileLength)
        ? meta.fileLength
        : bytes.byteLength;
    const pkg: LockPackage = {
      name: meta.slug || String(entry.projectID),
      kind,
      source: "curseforge",
      version: meta.displayName || meta.fileName,
      hash,
      provenance: "replay",
      placement: singleFilePlacement(kind, filename),
      size,
      project: entry.projectID,
      file: entry.fileID,
      // NOTE: no `url` — a replay item is never pinned to a rehostable URL.
    };
    placeable.set(pkg.placement.method === "link" ? pkg.placement.target : pkg.name, pkg);
    manifestItems.push({
      ref: {
        source: "curseforge",
        id: String(entry.projectID),
        versionSpec: { kind: "pin", version: String(entry.fileID) },
      },
    });
    emit({ type: "resolve:item", name: pkg.name, index: idx++, total: cf.files.length });
    fileCount += 1;
  }

  // 3. overrides/ → tracked local files (the copy tree).
  const overrideCount = await importOverrideTree({
    archivePath: input.archivePath,
    instanceDir: input.instanceDir,
    store: input.store,
    prefixes: [cf.overrides],
    placeable,
    warnings,
    onStored: (h) => emit({ type: "object:store", hash: h, deduped: false }),
  });

  // 4. Assemble the manifest + pre-resolved lock.
  const manifest: Manifest = {
    project: { name: cf.name ?? "imported-cf-pack", version: cf.version ?? "0.0.0" },
    game: { minecraft: cf.minecraft, loader: game.loader },
    items: manifestItems,
  };
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
  const lock: Lockfile = {
    meta: {
      version: 1,
      manifestHash,
      minecraft: cf.minecraft,
      loader: game.loader,
      java: game.java,
    },
    resolved: [...game.packages, ...placeable.values()].sort(comparePackages),
  };

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
