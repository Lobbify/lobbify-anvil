/**
 * Prism Launcher / MultiMC instance **import**.
 *
 * A Prism/MultiMC instance is a directory carrying `mmc-pack.json` (its component
 * list → Minecraft version + loader) and a `.minecraft/` game folder with loose
 * `mods/`, `resourcepacks/`, `shaderpacks/`, `datapacks/`. anvil adopts it by
 * **re-identifying every jar**:
 *
 *   - a jar Modrinth recognizes by its sha1 → a **copy** item (Modrinth source,
 *     rehostable, sha256-pinned from the local bytes and admitted to the store);
 *   - else a jar CurseForge recognizes by its Murmur2 fingerprint → a **replay**
 *     item (project/file, sha256-pinned, bytes never stored — re-fetched per client);
 *   - else it stays a **local** file under `.anvil/overrides/` (tracked verbatim).
 *
 * Placement follows what the manifest can reproduce. An unmatched file becomes a
 * `{ path, kind }` item and keeps its pack-relative path, subdirectories and all,
 * across every later re-lock. A re-identified one becomes a bare `source:id` ref,
 * which carries no path, so it is placed by kind — the same thing a re-lock would
 * derive. Preserving a subdirectory only in the import lock would put the lock and
 * every later re-lock into silent disagreement, so a jar that does move is
 * reported in `warnings` instead.
 *
 * Re-identification runs through the injected {@link IdentityResolver} seam, so the
 * importer is fully offline-testable and the (network) Modrinth/CurseForge lookups
 * are a thin production wiring. The written lock never carries a rehostable URL for
 * a replay item; matched CurseForge jars are `provenance: "replay"` from the start.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { writeGraph } from "../build/graph.js";
import { canonicalJson } from "../build/serialize.js";
import type { AnvilEvent } from "../events.js";
import { ensureDir, isProtectedTop, pathExists } from "../internal/fs.js";
import { writeLock } from "../lock/index.js";
import { comparePackages } from "../lock/serialize.js";
import { writeManifest } from "../manifest/index.js";
import type { DependencyEdge } from "../resolver/index.js";
import { canonicalKeyOf } from "../resolver/index.js";
import { safeBasename, singleFilePlacement } from "../sources/index.js";
import { curseforgeFingerprint } from "../sources/index.js";
import { hashBuffer } from "../store/index.js";
import { ManifestError } from "../types/errors.js";
import type {
  ItemKind,
  LockPackage,
  Lockfile,
  Manifest,
  ManifestItem,
  ObjectSink,
} from "../types/index.js";
import type { GamePinsForImport } from "./mrpack.js";
import { kindForPackPath } from "./pack-common.js";

/** A Modrinth re-identification of a local jar. */
export interface ModrinthMatch {
  /** The project slug (the copy item's name + canonical key). */
  readonly slug: string;
  readonly versionNumber: string;
  /** The rehostable Modrinth CDN URL. */
  readonly url: string;
}

/** A CurseForge re-identification of a local jar (a replay item). */
export interface CurseForgeMatch {
  readonly projectId: number;
  readonly fileId: number;
  readonly slug?: string;
  readonly displayName?: string;
}

/** The seam the importer re-identifies jars through (Modrinth sha1 / CF Murmur2). */
export interface IdentityResolver {
  matchModrinth(sha1: string): Promise<ModrinthMatch | undefined>;
  matchCurseForge(fingerprint: number): Promise<CurseForgeMatch | undefined>;
}

export interface ImportPrismInput {
  /** The Prism/MultiMC instance directory (holds `mmc-pack.json` + `.minecraft/`). */
  readonly prismDir: string;
  /** Where to write `anvil.toml` + `anvil.lock`. */
  readonly instanceDir: string;
  /** Where matched-Modrinth + local (copy) bytes are admitted. */
  readonly store: ObjectSink;
  /** Resolve the full game install for the instance's Minecraft/loader. */
  readonly resolveGame: (deps: {
    readonly minecraft: string;
    readonly loader: string;
  }) => Promise<GamePinsForImport>;
  readonly identify: IdentityResolver;
  readonly emit?: (event: AnvilEvent) => void;
}

export interface ImportPrismResult {
  readonly manifest: Manifest;
  readonly lock: Lockfile;
  /** Jars matched to a Modrinth project (copy items). */
  readonly modrinth: number;
  /** Jars matched to a CurseForge file (replay items). */
  readonly curseforge: number;
  /** Files kept as local overrides (unmatched). */
  readonly local: number;
  readonly warnings: readonly string[];
}

const PLACEABLE_DIRS = ["mods", "resourcepacks", "shaderpacks", "datapacks"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse `mmc-pack.json` into a Minecraft version + a raw loader string. */
function parseMmcPack(bytes: Uint8Array): { minecraft: string; loader: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new ManifestError(`mmc-pack.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(doc) || !Array.isArray(doc.components)) {
    throw new ManifestError("mmc-pack.json is missing a components array");
  }
  let minecraft: string | undefined;
  let loader = "vanilla";
  for (const raw of doc.components) {
    if (!isRecord(raw)) {
      continue;
    }
    const uid = typeof raw.uid === "string" ? raw.uid : "";
    const version = typeof raw.version === "string" ? raw.version : undefined;
    if (!version) {
      continue;
    }
    switch (uid) {
      case "net.minecraft":
        minecraft = version;
        break;
      case "net.fabricmc.fabric-loader":
        loader = `fabric ${version}`;
        break;
      case "org.quiltmc.quilt-loader":
        loader = `quilt ${version}`;
        break;
      case "net.neoforged":
        loader = `neoforge ${version}`;
        break;
      case "net.minecraftforge":
        loader = `forge ${version}`;
        break;
      default:
        break;
    }
  }
  if (!minecraft) {
    throw new ManifestError("mmc-pack.json does not pin a net.minecraft version");
  }
  return { minecraft, loader };
}

/** The `.minecraft` (or `minecraft`) game dir inside a Prism instance. */
async function gameDir(prismDir: string): Promise<string> {
  for (const name of [".minecraft", "minecraft"]) {
    if (await pathExists(join(prismDir, name))) {
      return join(prismDir, name);
    }
  }
  throw new ManifestError(`no .minecraft directory found under "${prismDir}"`);
}

async function* walkDir(root: string, rel = ""): AsyncGenerator<string> {
  let names: string[];
  try {
    names = await readdir(join(root, rel));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const childRel = rel ? posix.join(rel, name) : name;
    const st = await stat(join(root, childRel));
    if (st.isDirectory()) {
      yield* walkDir(root, childRel);
    } else if (st.isFile()) {
      yield childRel;
    }
  }
}

/** Import a Prism/MultiMC instance into `instanceDir`. */
export async function importPrism(input: ImportPrismInput): Promise<ImportPrismResult> {
  const emit = input.emit ?? (() => undefined);
  const warnings: string[] = [];

  const mmcBytes = await readFile(join(input.prismDir, "mmc-pack.json")).catch(() => {
    throw new ManifestError(
      `"${input.prismDir}" is not a Prism/MultiMC instance (no mmc-pack.json)`,
    );
  });
  const { minecraft, loader } = parseMmcPack(new Uint8Array(mmcBytes));
  const mc = await gameDir(input.prismDir);

  emit({ type: "resolve:start", items: 0 });
  const game = await input.resolveGame({ minecraft, loader });

  const placeable = new Map<string, LockPackage>();
  const manifestItems: ManifestItem[] = [];
  const trackedRoot = join(input.instanceDir, ".anvil", "overrides");
  let modrinthCount = 0;
  let cfCount = 0;
  let localCount = 0;

  for (const dir of PLACEABLE_DIRS) {
    const root = join(mc, dir);
    if (!(await pathExists(root))) {
      continue;
    }
    for await (const rel of walkDir(root)) {
      const packRel = posix.join(dir, rel);
      if (isProtectedTop(dir)) {
        warnings.push(`skipped file in a protected path: ${packRel}`);
        continue;
      }
      const bytes = new Uint8Array(await readFile(join(root, rel)));
      const sha1 = hashBuffer(bytes, "sha1").value;
      const sha256 = hashBuffer(bytes, "sha256");
      const kind: ItemKind = kindForPackPath(packRel);
      const filename = safeBasename(rel, dir === "mods" ? ".jar" : ".zip");

      // A re-identified jar is recorded in the manifest as a bare `source:id`
      // ref, which carries no path — so every later `anvil lock` re-derives its
      // placement from kind + basename. Placing it that way here keeps the
      // import lock and every re-lock in agreement, which is the whole point of
      // LB-706; the cost is that a jar sitting in a subdirectory does move, so
      // say so instead of relocating it silently. (An UNMATCHED file keeps its
      // path: it is tracked as a `{ path, kind }` item the manifest reproduces.)
      const matched = singleFilePlacement(kind, filename);
      const warnIfMoved = (): void => {
        if (matched.target !== packRel) {
          warnings.push(
            `re-identified "${packRel}" is placed at "${matched.target}" — an item referenced by id carries no path of its own`,
          );
        }
      };

      // 1. Modrinth match (by sha1) → a copy item.
      const mr = await input.identify.matchModrinth(sha1);
      if (mr) {
        warnIfMoved();
        await input.store.putBuffer(bytes, "sha256", sha256);
        const pkg: LockPackage = {
          name: mr.slug,
          kind,
          source: "modrinth",
          version: mr.versionNumber,
          hash: sha256,
          provenance: "copy",
          placement: matched,
          size: bytes.byteLength,
          url: mr.url,
        };
        placeable.set(matched.target, pkg);
        manifestItems.push({
          ref: {
            source: "modrinth",
            id: mr.slug,
            versionSpec: { kind: "pin", version: mr.versionNumber },
          },
        });
        modrinthCount += 1;
        emit({ type: "object:store", hash: sha256, deduped: false });
        continue;
      }

      // 2. CurseForge match (by Murmur2 fingerprint) → a replay item (no bytes stored).
      const cf = await input.identify.matchCurseForge(curseforgeFingerprint(bytes));
      if (cf) {
        warnIfMoved();
        const pkg: LockPackage = {
          name: cf.slug || String(cf.projectId),
          kind,
          source: "curseforge",
          ...(cf.displayName ? { version: cf.displayName } : {}),
          hash: sha256,
          provenance: "replay",
          placement: matched,
          size: bytes.byteLength,
          project: cf.projectId,
          file: cf.fileId,
          // No `url` — a replay item is never pinned to a rehostable URL.
        };
        placeable.set(matched.target, pkg);
        manifestItems.push({
          ref: {
            source: "curseforge",
            id: String(cf.projectId),
            versionSpec: { kind: "pin", version: String(cf.fileId) },
          },
        });
        cfCount += 1;
        continue;
      }

      // 3. Unmatched → a tracked local file under .anvil/overrides/.
      const trackedPath = join(trackedRoot, packRel);
      await mkdir(join(trackedPath, ".."), { recursive: true });
      await writeFile(trackedPath, bytes);
      await input.store.putBuffer(bytes, "sha256", sha256);
      placeable.set(packRel, {
        name: safeBasename(packRel, ".jar"),
        kind,
        source: "local",
        hash: sha256,
        provenance: "copy",
        placement: { method: "link", target: packRel },
        size: bytes.byteLength,
        url: pathToFileURL(trackedPath).toString(),
      });
      manifestItems.push({ path: packRel, kind });
      localCount += 1;
      emit({ type: "object:store", hash: sha256, deduped: false });
    }
  }

  const manifest: Manifest = {
    project: { name: "imported-prism-instance", version: "0.0.0" },
    game: { minecraft, loader: game.loader },
    items: manifestItems,
  };
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
  const lock: Lockfile = {
    meta: { version: 1, manifestHash, minecraft, loader: game.loader, java: game.java },
    resolved: [...game.packages, ...placeable.values()].sort(comparePackages),
  };
  const edges: DependencyEdge[] = [...placeable.values()].map((pkg) => ({
    child: canonicalKeyOf(pkg),
    childName: pkg.name,
    by: "(manifest)",
  }));

  await ensureDir(input.instanceDir);
  await writeManifest(input.instanceDir, manifest);
  await writeLock(input.instanceDir, lock);
  await writeGraph(input.instanceDir, edges);

  emit({ type: "resolve:done", pinned: lock.resolved.length });
  return {
    manifest,
    lock,
    modrinth: modrinthCount,
    curseforge: cfCount,
    local: localCount,
    warnings,
  };
}
