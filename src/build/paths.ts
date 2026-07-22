/**
 * Machine-local path resolution.
 *
 * Resolution order for every category: explicit {@link AnvilOptions} > the
 * instance's `.anvil/config.toml [paths]` table > a built-in default. This is how
 * an instance points its heavy shared categories (store, assets, libraries,
 * runtime) at directories the machine already has — including an existing
 * `.minecraft/assets`, which already *is* a content-addressed sha1 store.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AnvilOptions } from "../types/index.js";

export interface ResolvedPaths {
  readonly store: string;
  readonly instance: string;
  readonly assets?: string;
  readonly libraries?: string;
  readonly runtime?: string;
}

interface PathsTable {
  store?: string;
  instance?: string;
  assets?: string;
  libraries?: string;
  runtime?: string;
}

async function readPathsTable(instanceDir: string): Promise<PathsTable> {
  try {
    const text = await readFile(join(instanceDir, ".anvil", "config.toml"), "utf8");
    const doc = parseToml(text) as { paths?: PathsTable };
    return doc.paths ?? {};
  } catch {
    return {};
  }
}

function abs(base: string, p: string | undefined): string | undefined {
  if (p === undefined) {
    return undefined;
  }
  return isAbsolute(p) ? p : resolve(base, p);
}

/** Resolve every path category for `instanceDir` under the documented precedence. */
export async function resolvePaths(
  instanceDir: string,
  options: AnvilOptions,
): Promise<ResolvedPaths> {
  const table = await readPathsTable(instanceDir);
  const defaultStore = join(homedir(), ".anvil", "store");
  return {
    store: abs(instanceDir, options.storeDir) ?? abs(instanceDir, table.store) ?? defaultStore,
    instance: abs(instanceDir, table.instance) ?? resolve(instanceDir),
    assets: abs(instanceDir, options.paths?.assets) ?? abs(instanceDir, table.assets),
    libraries: abs(instanceDir, options.paths?.libraries) ?? abs(instanceDir, table.libraries),
    runtime: abs(instanceDir, options.paths?.runtime) ?? abs(instanceDir, table.runtime),
  };
}
