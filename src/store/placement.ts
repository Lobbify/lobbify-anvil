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

import { readFile } from "node:fs/promises";
import type { LinkStrategy } from "../events.js";
import { safeJoin } from "../internal/fs.js";
import { MissingObject } from "../types/errors.js";
import type { Hash, LockPackage } from "../types/index.js";
import { excludeMetaInf, safeExtract } from "./safe-extract.js";
import type { ContentStore } from "./store.js";

/** The Mojang asset index shape (`assets/indexes/<id>.json`). */
export interface AssetIndex {
  readonly objects: Readonly<Record<string, { readonly hash: string; readonly size: number }>>;
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
    case "store-only":
      return [];
    default:
      return [];
  }
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
