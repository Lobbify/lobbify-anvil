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
import { formatVersionSpec, parseRef } from "./ref.js";

/**
 * True when the bare id alone parses back to the same ref.
 *
 * An opaque source (`url` / `local`) can often be written without its prefix —
 * `https://…` and `./mods/x.jar` are the forms the docs teach, and echoing them
 * back leaves a hand-authored manifest byte-identical. But the bare form is not
 * always readable: `parseRef` accepts a bare local path only when it starts with
 * `./`, `../` or `/`, which no Windows absolute path (`C:\…`) does and no bare
 * relative path (`mods/x.jar`) does either.
 *
 * Rather than restate the parser's rule here — the restatement drifting from the
 * rule is the LB-862 defect itself — this **asks the parser**. A shortcut the
 * reader cannot read is not taken, for every source kind, including ones added
 * after this was written.
 */
function bareIdIsReadable(ref: ResolvedRef): boolean {
  try {
    const back = parseRef(ref.id);
    return back.source === ref.source && back.id === ref.id;
  } catch {
    return false;
  }
}

/**
 * Render a ref back to its grammar string.
 *
 * Every string this produces must parse back to the ref it came from: anvil
 * rewrites the whole manifest on `anvil add`, so a form the parser rejects does
 * not merely look wrong, it stops the instance from opening (LB-862).
 */
export function formatRef(ref: ResolvedRef): string {
  if (ref.source === "url" || ref.source === "local") {
    // Prefer the bare form so a documented, hand-authored manifest round-trips
    // unchanged; fall back to the explicit prefix when bare would be unreadable.
    //
    // The `parseRef` call inside `bareIdIsReadable` is LOAD-BEARING — it is not a
    // redundant parse to be optimised away. It is what makes this writer correct
    // *by construction* rather than by restating a rule that lives in `ref.ts`,
    // and those two drifting apart is the entire bug (LB-862). Delete it and the
    // manifests anvil writes stop being manifests anvil can read, silently, for
    // exactly the ids nobody has a test for. Manifest writes are rare and item
    // counts are small; this has never been a hot path.
    return bareIdIsReadable(ref) ? ref.id : `${ref.source}:${ref.id}`;
  }
  const base = `${ref.source}:${ref.id}`;
  return ref.versionSpec.kind === "latest" ? base : `${base}@${formatVersionSpec(ref.versionSpec)}`;
}

/** Render a single item as either a string or a `{ path, kind, target }` table. */
function renderItem(item: ManifestItem): string {
  if (item.path !== undefined) {
    // Always a table, even with no `kind`/`target` to carry. Dropping a bare
    // `{ path = "mods/x.jar" }` to the string `"mods/x.jar"` was the third and
    // least visible half of LB-862: the string form has to satisfy the ref
    // grammar and a bare relative path does not, so the rewrite produced a
    // manifest that would not re-open — on any platform, from the documented
    // table syntax, with no `local:` prefix anywhere in sight.
    //
    // Keeping the shape the author wrote also means a rewrite touching an
    // unrelated item leaves this line alone in their diff.
    return inlineTable([
      ["path", tomlString(item.path)],
      ...(item.kind ? [["kind", tomlString(item.kind)] as const] : []),
      ...(item.target !== undefined ? [["target", tomlString(item.target)] as const] : []),
    ]);
  }
  if (item.ref) {
    const s = formatRef(item.ref);
    // A ref that carried an explicit kind override round-trips as a table.
    //
    // The `url`/`local` exemption this used to carry dropped the kind on the
    // floor: `{ ref = "./mods/mine.jar", kind = "config" }` is a form the parser
    // accepts (parse.ts:136) and the writer emitted as a bare string, so the
    // override vanished on the next rewrite. Same defect as the rest of LB-862 —
    // the writer discarding something the reader accepts — and found by
    // adversarial review, because this file's input set had not enumerated it.
    if (item.ref.kind) {
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
