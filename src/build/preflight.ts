/**
 * Build preflight: filter the lock's package set to the ones that apply to this
 * platform (Mojang-style allow/disallow rules), and assert there is enough free
 * disk to stage them.
 *
 * NOTE — where rules live. A fully-resolved {@link LockPackage} carries no rules
 * field (kept lean on purpose; Stage 2/3 owns the resolved lock schema and how
 * per-OS natives get pinned). So Stage 1 evaluates rules from an optional
 * side-map keyed by package name; with no map, every package applies. The rules
 * evaluator itself is complete and tested so later stages can feed it directly.
 */

import { statfs } from "node:fs/promises";
import { PreflightFailed } from "../types/errors.js";
import type { LockPackage } from "../types/index.js";

/** The build target platform. */
export interface Platform {
  readonly os: "linux" | "osx" | "windows";
  readonly arch: string;
}

/** A Mojang-style applicability rule. */
export interface Rule {
  readonly action: "allow" | "disallow";
  readonly os?: { readonly name?: string; readonly arch?: string };
  readonly features?: Readonly<Record<string, boolean>>;
}

/** The current platform, in Mojang's `os.name` vocabulary. */
export function currentPlatform(): Platform {
  const os =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  return { os, arch: process.arch };
}

function ruleMatches(rule: Rule, platform: Platform): boolean {
  if (rule.os?.name !== undefined && rule.os.name !== platform.os) {
    return false;
  }
  if (rule.os?.arch !== undefined && rule.os.arch !== platform.arch) {
    return false;
  }
  // Feature rules (e.g. is_demo) default off in an unattended build.
  if (rule.features && Object.values(rule.features).some((v) => v)) {
    return false;
  }
  return true;
}

/**
 * Evaluate Mojang rule semantics: with no rules, applicable; otherwise the last
 * matching rule's action decides, defaulting to disallow when rules exist but
 * none match.
 */
export function evaluateRules(rules: readonly Rule[] | undefined, platform: Platform): boolean {
  if (!rules || rules.length === 0) {
    return true;
  }
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, platform)) {
      allowed = rule.action === "allow";
    }
  }
  return allowed;
}

/** Filter packages to those applicable on `platform`, per an optional rules map. */
export function filterByRules(
  packages: readonly LockPackage[],
  platform: Platform,
  rules?: ReadonlyMap<string, readonly Rule[]>,
): LockPackage[] {
  if (!rules) {
    return [...packages];
  }
  return packages.filter((pkg) => evaluateRules(rules.get(pkg.name), platform));
}

/**
 * Assert the volume backing `dir` has room for `packages` plus headroom. Best-
 * effort: on a platform without `statfs`, the check is skipped rather than failing.
 */
export async function checkDiskSpace(
  dir: string,
  packages: readonly LockPackage[],
  headroomBytes = 64 * 1024 * 1024,
): Promise<void> {
  const need = packages.reduce((sum, p) => sum + (p.size ?? 0), 0) + headroomBytes;
  let free: number;
  try {
    const st = await statfs(dir);
    free = st.bavail * st.bsize;
  } catch {
    return; // statfs unavailable here — skip the check
  }
  if (free < need) {
    throw new PreflightFailed(
      `not enough free space to build in "${dir}": need ~${need} bytes, ${free} available`,
    );
  }
}
