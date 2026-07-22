/**
 * The linking chain: reflink → hardlink → symlink → copy.
 *
 * A materialized instance file should share bytes with its immutable store object
 * where the filesystem allows (reflink or hardlink), falling back through the
 * chain to a plain copy. Two hard rules:
 *
 * - **Cross-volume** — reflink and hardlink cannot cross filesystem volumes, so a
 *   store/instance dev-id mismatch (detected up front) falls back to a real,
 *   independent **copy** with a warning — never a fragile symlink.
 * - **Symlink is never a default.** It is only ever attempted when explicitly
 *   requested, and never on Windows (it needs privilege there).
 */

import { constants as fsConstants } from "node:fs";
import { copyFile, link, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { LinkStrategy } from "../events.js";
import { ensureDir, statDevOf } from "../internal/fs.js";

export interface LinkOptions {
  /** Ordered strategies to try. Default: reflink → hardlink → copy (no symlink). */
  readonly order?: readonly LinkStrategy[];
  /** Injectable device-id probe (cross-volume simulation in tests). */
  readonly statDev?: (path: string) => Promise<number>;
  /** Called once when a cross-volume fallback to copy happens. */
  readonly onWarn?: (message: string) => void;
}

/** Default chain: prefer shared bytes, fall back to a copy. Symlink is opt-in. */
export const DEFAULT_LINK_ORDER: readonly LinkStrategy[] = ["reflink", "hardlink", "copy"];

/** True when `a` and `dir` are on the same filesystem volume. */
export async function sameVolume(
  a: string,
  dir: string,
  statDev: (p: string) => Promise<number> = statDevOf,
): Promise<boolean> {
  const [devA, devDir] = await Promise.all([statDev(a), statDev(dir)]);
  return devA === devDir;
}

async function attempt(strategy: LinkStrategy, src: string, dest: string): Promise<boolean> {
  try {
    switch (strategy) {
      case "reflink":
        await copyFile(src, dest, fsConstants.COPYFILE_FICLONE_FORCE);
        return true;
      case "hardlink":
        await link(src, dest);
        return true;
      case "symlink":
        if (process.platform === "win32") {
          return false; // never default to symlink on Windows
        }
        await symlink(src, dest);
        return true;
      case "copy":
        await copyFile(src, dest);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Materialize `src` (an immutable store object) at `dest`, walking the linking
 * chain and returning the strategy that succeeded. Cross-volume falls back to a
 * copy with a warning.
 */
export async function linkOrCopy(
  src: string,
  dest: string,
  opts: LinkOptions = {},
): Promise<LinkStrategy> {
  const statDev = opts.statDev ?? statDevOf;
  await ensureDir(dirname(dest));
  // Fresh, deterministic destination — never link atop an existing file.
  await rm(dest, { force: true }).catch(() => undefined);

  let order = opts.order ?? DEFAULT_LINK_ORDER;
  const cross = !(await sameVolume(src, dirname(dest), statDev));
  if (cross) {
    if (order.some((s) => s === "reflink" || s === "hardlink")) {
      opts.onWarn?.(
        `store and instance are on different volumes; copying "${src}" -> "${dest}" (reflink/hardlink cannot cross volumes)`,
      );
    }
    order = ["copy"];
  }

  for (const strategy of order) {
    if (await attempt(strategy, src, dest)) {
      return strategy;
    }
  }
  // Last resort: a plain copy always works on a writable destination.
  if (await attempt("copy", src, dest)) {
    return "copy";
  }
  throw new Error(`unable to materialize "${src}" -> "${dest}" via any strategy`);
}
