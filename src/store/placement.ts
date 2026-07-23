/**
 * The placement executor: turn a pinned {@link LockPackage} into materialized
 * bytes under a stage root, per its {@link Placement} discriminant.
 *
 *   - `link`       — link the object to a single target path (mod/resourcepack).
 *   - `extract`    — safe-extract the object (a natives jar) under a target dir,
 *                    excluding `META-INF/`, through the hardened `safeExtract`.
 *   - `asset-tree` — fan a Mojang asset index into the sha1 store: assert every
 *                    referenced asset object is present, then place the index file.
 *   - `store-only` — assert the object is present; place nothing in the instance.
 *
 * Every target path passes through `safeJoin`, so a placement can never write
 * outside the instance or into a protected path (`saves/`, `.anvil/`).
 */

import { chmod, symlink } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { LinkStrategy } from "../events.js";
import { ensureDir, safeJoin } from "../internal/fs.js";
import { MissingObject, PathEscape } from "../types/errors.js";
import type { Hash, LockPackage } from "../types/index.js";
import { excludeMetaInf, safeExtract } from "./safe-extract.js";
import type { ContentStore } from "./store.js";

/** The Mojang asset index shape (`assets/indexes/<id>.json`). */
export interface AssetIndex {
  readonly objects: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
}

/** One entry in a Mojang java-runtime per-platform manifest. */
export type RuntimeFile =
  | { readonly type: "directory" }
  | {
      readonly type: "file";
      readonly executable?: boolean;
      readonly downloads: {
        readonly raw: { readonly sha1: string; readonly size?: number; readonly url?: string };
      };
    }
  | { readonly type: "link"; readonly target: string };

/** The Mojang java-runtime per-platform manifest shape (`files` keyed by rel path). */
export interface RuntimeManifest {
  readonly files: Readonly<Record<string, RuntimeFile>>;
}

export interface PlacementContext {
  readonly store: ContentStore;
  /** The stage root the build materializes into before the atomic swap. */
  readonly stageRoot: string;
  readonly onWarn?: (message: string) => void;
}

export interface PlacementOutcome {
  /** Instance-relative target paths this placement created (empty for store-only). */
  readonly targets: readonly string[];
  /** The link strategy chosen, when the placement linked a single object. */
  readonly strategy?: LinkStrategy;
}

/** The relative instance target paths a package's placement will produce. */
export function targetsOf(pkg: LockPackage): readonly string[] {
  const p = pkg.placement;
  switch (p.method) {
    case "link":
      return [p.target];
    case "extract":
      return [p.targetDir];
    case "asset-tree":
      return [p.indexTarget];
    case "runtime-tree":
      return [p.targetDir];
    case "store-only":
      return [];
    default:
      return [];
  }
}

/** Parse and return the java-runtime manifest object under `manifestHash`. */
export async function readRuntimeManifest(
  store: ContentStore,
  manifestHash: Hash,
): Promise<RuntimeManifest> {
  const raw = await readFile(store.objectPath(manifestHash), "utf8");
  return JSON.parse(raw) as RuntimeManifest;
}

/** The sha1 leaf objects a java-runtime manifest references (deduped, stable order). */
export function runtimeLeafHashes(manifest: RuntimeManifest): Hash[] {
  const seen = new Set<string>();
  const out: Hash[] = [];
  for (const name of Object.keys(manifest.files).sort()) {
    const entry = manifest.files[name];
    if (entry && entry.type === "file" && !seen.has(entry.downloads.raw.sha1)) {
      seen.add(entry.downloads.raw.sha1);
      out.push({ algo: "sha1", value: entry.downloads.raw.sha1 });
    }
  }
  return out;
}

/**
 * The leaf objects a manifest-driven placement (`asset-tree` / `runtime-tree`)
 * fans out — needed by the acquirers (to bring them) and by GC (to root them).
 * The manifest object itself must already be present in the store.
 */
export async function treeLeaves(store: ContentStore, pkg: LockPackage): Promise<Hash[]> {
  if (pkg.placement.method === "asset-tree") {
    return assetHashes(await readAssetIndex(store, pkg.hash));
  }
  if (pkg.placement.method === "runtime-tree") {
    return runtimeLeafHashes(await readRuntimeManifest(store, pkg.hash));
  }
  return [];
}

/** Parse and return the asset objects referenced by an asset index object. */
export async function readAssetIndex(store: ContentStore, indexHash: Hash): Promise<AssetIndex> {
  const raw = await readFile(store.objectPath(indexHash), "utf8");
  return JSON.parse(raw) as AssetIndex;
}

/** The sha1 hashes an asset index references. */
export function assetHashes(index: AssetIndex): Hash[] {
  return Object.values(index.objects).map((o) => ({ algo: "sha1" as const, value: o.hash }));
}

export async function executePlacement(
  pkg: LockPackage,
  ctx: PlacementContext,
): Promise<PlacementOutcome> {
  const p = pkg.placement;
  switch (p.method) {
    case "link": {
      const dest = safeJoin(ctx.stageRoot, p.target);
      const strategy = await ctx.store.materialize(pkg.hash, dest);
      return { targets: [p.target], strategy };
    }
    case "extract": {
      const destDir = safeJoin(ctx.stageRoot, p.targetDir);
      await safeExtract(ctx.store.objectPath(pkg.hash), destDir, { exclude: excludeMetaInf });
      return { targets: [p.targetDir] };
    }
    case "asset-tree": {
      const index = await readAssetIndex(ctx.store, pkg.hash);
      for (const hash of assetHashes(index)) {
        if (!(await ctx.store.has(hash))) {
          throw new MissingObject(hash, `asset of ${pkg.name}`);
        }
      }
      const dest = safeJoin(ctx.stageRoot, p.indexTarget);
      const strategy = await ctx.store.materialize(pkg.hash, dest);
      return { targets: [p.indexTarget], strategy };
    }
    case "runtime-tree": {
      const destRoot = safeJoin(ctx.stageRoot, p.targetDir);
      await materializeRuntime(pkg, destRoot, ctx);
      return { targets: [p.targetDir] };
    }
    case "store-only": {
      if (!(await ctx.store.has(pkg.hash))) {
        throw new MissingObject(pkg.hash, pkg.name);
      }
      return { targets: [] };
    }
    default:
      return { targets: [] };
  }
}

/** File modes for a materialized JRE entry — the executable bit is load-bearing. */
const RUNTIME_MODE_EXEC = 0o755;
const RUNTIME_MODE_PLAIN = 0o644;

/**
 * Materialize a pinned java-runtime manifest into a JRE tree under `destRoot`,
 * preserving the executable bit on files and re-creating the mac-bundle symlinks.
 * Entries are applied in a fixed (path-sorted) order so the tree is deterministic;
 * every destination — and every symlink target — is asserted to stay under the
 * runtime root (defense-in-depth even though the manifest is sha-pinned).
 *
 * Files are materialized via reflink/copy (never a hardlink) so their mode can be
 * set without disturbing the immutable `0444` store object they share bytes with.
 */
async function materializeRuntime(
  pkg: LockPackage,
  destRoot: string,
  ctx: PlacementContext,
): Promise<void> {
  const manifest = await readRuntimeManifest(ctx.store, pkg.hash);
  const root = resolve(destRoot);
  const names = Object.keys(manifest.files).sort();

  // Directories first (sorted → parents precede children), then files, then links
  // (a symlink may target a sibling that must already exist).
  for (const name of names) {
    if (manifest.files[name]?.type === "directory") {
      await ensureDir(safeChild(root, name));
    }
  }
  for (const name of names) {
    const entry = manifest.files[name];
    if (!entry || entry.type !== "file") {
      continue;
    }
    const dest = safeChild(root, name);
    await ensureDir(dirname(dest));
    const hash: Hash = { algo: "sha1", value: entry.downloads.raw.sha1 };
    if (!(await ctx.store.has(hash))) {
      throw new MissingObject(hash, `runtime file ${name} of ${pkg.name}`);
    }
    await ctx.store.materialize(hash, dest, { order: ["reflink", "copy"] });
    await chmod(dest, entry.executable ? RUNTIME_MODE_EXEC : RUNTIME_MODE_PLAIN);
  }
  for (const name of names) {
    const entry = manifest.files[name];
    if (!entry || entry.type !== "link") {
      continue;
    }
    const dest = safeChild(root, name);
    await ensureDir(dirname(dest));
    // The link target is manifest-controlled: assert it cannot escape the runtime
    // root before creating it (a symlink out of root is a zip-slip-class hazard).
    const resolvedTarget = resolve(dirname(dest), entry.target);
    if (resolvedTarget !== root && !resolvedTarget.startsWith(root + sep)) {
      throw new PathEscape(name, "runtime symlink target escapes the runtime root");
    }
    await symlink(entry.target, dest);
  }
}

/** safeJoin a manifest-relative entry under an absolute runtime root. */
function safeChild(root: string, rel: string): string {
  return safeJoin(root, rel, { allowProtected: true });
}
