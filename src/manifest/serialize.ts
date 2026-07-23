/**
 * The `anvil.toml` serializer — writes a clean, stable manifest. Unlike the lock,
 * the manifest is human-authored, so this is a friendly canonical form (used by
 * `anvil init`/`add` in Stage 4), not a byte-for-byte determinism contract.
 */

import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inlineTable, kv, tomlString } from "../lock/toml.js";
import type { Manifest, ManifestItem, ResolvedRef } from "../types/index.js";
import { MANIFEST_FILENAME } from "./parse.js";
import { formatVersionSpec } from "./ref.js";

/** Render a ref back to its grammar string. */
export function formatRef(ref: ResolvedRef): string {
  if (ref.source === "url" || ref.source === "local") {
    return ref.id;
  }
  const base = `${ref.source}:${ref.id}`;
  return ref.versionSpec.kind === "latest" ? base : `${base}@${formatVersionSpec(ref.versionSpec)}`;
}

/** Render a single item as either a string or a `{ path, kind }` inline table. */
function renderItem(item: ManifestItem): string {
  if (item.path !== undefined) {
    if (item.kind) {
      return inlineTable([
        ["path", tomlString(item.path)],
        ["kind", tomlString(item.kind)],
      ]);
    }
    return tomlString(item.path);
  }
  if (item.ref) {
    const s = formatRef(item.ref);
    // A ref that carried an explicit kind override round-trips as a table.
    if (item.ref.kind && item.ref.source !== "url" && item.ref.source !== "local") {
      return inlineTable([
        ["ref", tomlString(s)],
        ["kind", tomlString(item.ref.kind)],
      ]);
    }
    return tomlString(s);
  }
  return tomlString("");
}

/** Serialize a manifest to `anvil.toml` text. */
export function serializeManifest(manifest: Manifest): string {
  const lines: string[] = [];
  lines.push("[project]");
  lines.push(kv("name", tomlString(manifest.project.name)));
  lines.push(kv("version", tomlString(manifest.project.version)));
  if (manifest.project.summary !== undefined) {
    lines.push(kv("summary", tomlString(manifest.project.summary)));
  }
  lines.push("");
  lines.push("[game]");
  lines.push(kv("minecraft", tomlString(manifest.game.minecraft)));
  lines.push(kv("loader", tomlString(manifest.game.loader)));
  if (manifest.game.from !== undefined) {
    lines.push(kv("from", tomlString(manifest.game.from)));
  }
  if (manifest.game.remove && manifest.game.remove.length > 0) {
    const arr = manifest.game.remove.map((r) => tomlString(r)).join(", ");
    lines.push(kv("remove", `[${arr}]`));
  }
  lines.push("");
  if (manifest.items.length === 0) {
    lines.push("items = []");
  } else {
    lines.push("items = [");
    for (const item of manifest.items) {
      lines.push(`  ${renderItem(item)},`);
    }
    lines.push("]");
  }
  return `${lines.join("\n")}\n`;
}

/** Write `<dir>/anvil.toml` atomically. */
export async function writeManifest(instanceDir: string, manifest: Manifest): Promise<void> {
  const finalPath = join(instanceDir, MANIFEST_FILENAME);
  const tmpPath = join(instanceDir, `${MANIFEST_FILENAME}.${process.pid}.tmp`);
  await writeFile(tmpPath, serializeManifest(manifest));
  await rename(tmpPath, finalPath);
}
