/**
 * `.mrpack` (Modrinth modpack) **export**.
 *
 * Turns a built anvil instance into a portable `.mrpack`:
 *   - the `[game]` base → `dependencies` (Minecraft + loader);
 *   - **copy** items with a rehostable URL (Modrinth / URL) → `files[]` entries,
 *     hashed sha1 + sha512 from the store bytes;
 *   - **local** items (and copy items lacking a URL) → `overrides/` files;
 *   - **CurseForge replay items → OMITTED with a clear per-item warning**. Per the
 *     CF ToS a replay jar is never re-hosted or exported; the export can only name
 *     it and tell the user to add it from CurseForge on the other side.
 *
 * The replay boundary is structural: this exporter reads bytes **only from the
 * shared content store** for copy/local rows and **never opens the replay cache**.
 * A `provenance: "replay"` row contributes a warning and nothing else.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { posix } from "node:path";
import type { AnvilEvent } from "../events.js";
import type { ContentStore } from "../store/index.js";
import type { LockPackage, Lockfile, Manifest } from "../types/index.js";
import { type ZipEntry, writeZip } from "./zip-write.js";

export interface ExportMrpackInput {
  readonly manifest: Manifest;
  /** The lock to export (the built lock, or the input lock as a fallback). */
  readonly lock: Lockfile;
  readonly store: ContentStore;
  readonly targetPath: string;
  readonly emit?: (event: AnvilEvent) => void;
}

export interface ExportMrpackResult {
  readonly path: string;
  /** `files[]` entries written (copy items with a rehostable URL). */
  readonly files: number;
  /** `overrides/` files written (local items + copy items lacking a URL). */
  readonly overrides: number;
  /** Names of CurseForge (replay) items omitted per the ToS. */
  readonly omitted: readonly string[];
  readonly warnings: readonly string[];
}

interface MrFileEntry {
  readonly path: string;
  readonly hashes: { readonly sha1: string; readonly sha512: string };
  readonly env: { readonly client: string; readonly server: string };
  readonly downloads: readonly string[];
  readonly fileSize: number;
}

/** Map a resolved loader label (`"fabric 0.19.1"`) to an mrpack dependency pair. */
function loaderDependency(loader: string): Record<string, string> {
  const parts = loader.trim().split(/\s+/);
  const name = (parts[0] ?? "vanilla").toLowerCase();
  const version = parts[1];
  if (!version || name === "vanilla") {
    return {};
  }
  switch (name) {
    case "fabric":
      return { "fabric-loader": version };
    case "quilt":
      return { "quilt-loader": version };
    case "neoforge":
      return { neoforge: version };
    case "forge":
      return { forge: version };
    default:
      return {};
  }
}

/** Read a stored object's bytes, or `undefined` when absent. */
async function readStoreBytes(
  store: ContentStore,
  pkg: LockPackage,
): Promise<Uint8Array | undefined> {
  if (!(await store.has(pkg.hash))) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of store.read(pkg.hash)) {
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function hashHex(bytes: Uint8Array, algo: "sha1" | "sha512"): string {
  return createHash(algo).update(bytes).digest("hex");
}

/** Only single-file `link` placements map cleanly onto an mrpack path/override. */
function linkTarget(pkg: LockPackage): string | undefined {
  return pkg.placement.method === "link" ? pkg.placement.target : undefined;
}

/** Whether a package is part of the game install (reconstructed from `dependencies`). */
function isGameInstall(pkg: LockPackage): boolean {
  return (
    pkg.source === "mojang" ||
    pkg.kind === "game" ||
    pkg.kind === "loader" ||
    pkg.kind === "library" ||
    pkg.kind === "java"
  );
}

/** Export the instance described by `manifest` + `lock` to a `.mrpack` file. */
export async function exportMrpack(input: ExportMrpackInput): Promise<ExportMrpackResult> {
  const emit = input.emit ?? (() => undefined);
  const files: MrFileEntry[] = [];
  const overrides: ZipEntry[] = [];
  const omitted: string[] = [];
  const warnings: string[] = [];

  for (const pkg of input.lock.resolved) {
    // The game install is represented by `dependencies`, not exported as files.
    if (isGameInstall(pkg)) {
      continue;
    }
    // CurseForge replay bytes are NEVER exported (CF ToS). Warn + omit.
    if (pkg.provenance === "replay") {
      omitted.push(pkg.name);
      warnings.push(
        `omitted CurseForge item "${pkg.name}" — replay bytes are never exported (CurseForge ToS); the recipient must add it from CurseForge.`,
      );
      continue;
    }
    const target = linkTarget(pkg);
    if (!target) {
      warnings.push(`skipped "${pkg.name}" — only single-file items are exportable`);
      continue;
    }

    // A copy item with a rehostable URL → an mrpack files[] entry.
    if (pkg.source !== "local" && pkg.url && /^https?:\/\//i.test(pkg.url)) {
      const bytes = await readStoreBytes(input.store, pkg);
      if (!bytes) {
        warnings.push(
          `skipped "${pkg.name}" — its bytes are not in the store; run \`anvil build\` before export`,
        );
        continue;
      }
      files.push({
        path: posix.normalize(target),
        hashes: { sha1: hashHex(bytes, "sha1"), sha512: hashHex(bytes, "sha512") },
        env: { client: "required", server: "required" },
        downloads: [pkg.url],
        fileSize: bytes.byteLength,
      });
      continue;
    }

    // Everything else with bytes (local items, url-less copies) → overrides/.
    const bytes = await readStoreBytes(input.store, pkg);
    if (!bytes) {
      warnings.push(`skipped "${pkg.name}" — no rehostable URL and its bytes are not in the store`);
      continue;
    }
    overrides.push({ name: posix.join("overrides", posix.normalize(target)), data: bytes });
  }

  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: input.manifest.project.version,
    name: input.manifest.project.name,
    ...(input.manifest.project.summary ? { summary: input.manifest.project.summary } : {}),
    dependencies: {
      minecraft: input.lock.meta.minecraft,
      ...loaderDependency(input.lock.meta.loader),
    },
    files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const entries: ZipEntry[] = [
    {
      name: "modrinth.index.json",
      data: new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`),
    },
    ...overrides,
  ];
  const zip = writeZip(entries);
  await writeFile(input.targetPath, zip);

  emit({ type: "resolve:done", pinned: files.length + overrides.length });
  return {
    path: input.targetPath,
    files: files.length,
    overrides: overrides.length,
    omitted,
    warnings,
  };
}
