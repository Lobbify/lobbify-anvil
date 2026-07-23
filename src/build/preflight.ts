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
import { PreflightFailed, UnsatisfiableTarget } from "../types/errors.js";
import type { LockPackage, OsName, TargetTuple } from "../types/index.js";

/** The build target platform. */
export interface Platform {
  readonly os: OsName;
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

/** True when a single target tuple matches the host platform. */
function targetMatches(t: TargetTuple, platform: Platform): boolean {
  return t.os === platform.os && (t.arch === undefined || t.arch === platform.arch);
}

/**
 * Whether a package's intrinsic `targets` admit this platform. A package with no
 * `targets` is universal (applies everywhere); otherwise the host must match one
 * tuple. This is how the per-OS natives and the per-platform JRE in a single
 * cross-platform lock resolve down to just the host's artifacts at build time.
 */
export function packageAppliesToPlatform(pkg: LockPackage, platform: Platform): boolean {
  if (!pkg.targets || pkg.targets.length === 0) {
    return true;
  }
  return pkg.targets.some((t) => targetMatches(t, platform));
}

/** Filter packages by their intrinsic per-platform `targets`. */
export function filterByTargets(
  packages: readonly LockPackage[],
  platform: Platform,
): LockPackage[] {
  return packages.filter((pkg) => packageAppliesToPlatform(pkg, platform));
}

/** A natives package is a per-platform `library` extracted into the instance. */
function isNativesPackage(pkg: LockPackage): boolean {
  return (
    pkg.kind === "library" &&
    pkg.placement.method === "extract" &&
    pkg.targets !== undefined &&
    pkg.targets.length > 0 &&
    /:natives-[a-z0-9-]+$/.test(pkg.name)
  );
}

/** The base maven coordinate of a natives package (its name minus the classifier). */
function nativesBase(name: string): string {
  return name.replace(/:natives-[a-z0-9-]+$/, "");
}

/**
 * Assert every native the host **needs** is actually present for its exact arch.
 *
 * Natives ship per (os, arch) as separate packages. If a library provides a
 * native for the host OS but none for the host **arch** (the macOS-arm64 /
 * windows-arm64 gap on versions that never shipped an arm64 classifier), we fail
 * loudly with {@link UnsatisfiableTarget} rather than silently omitting it or —
 * far worse — installing a wrong-arch binary that crashes the JVM at launch.
 */
export function assertNativesSatisfiable(
  packages: readonly LockPackage[],
  platform: Platform,
): void {
  const byBase = new Map<string, LockPackage[]>();
  for (const pkg of packages) {
    if (!isNativesPackage(pkg)) {
      continue;
    }
    const base = nativesBase(pkg.name);
    const list = byBase.get(base) ?? [];
    list.push(pkg);
    byBase.set(base, list);
  }
  for (const [base, group] of byBase) {
    const targetsThisOs = group.some((p) => (p.targets ?? []).some((t) => t.os === platform.os));
    if (!targetsThisOs) {
      continue; // this library ships no native for the host OS → not needed here
    }
    const coversHost = group.some((p) => packageAppliesToPlatform(p, platform));
    if (!coversHost) {
      throw new UnsatisfiableTarget(
        `${base} on ${platform.os}-${platform.arch}`,
        `no native binary is published for ${platform.os}-${platform.arch} (this library provides natives for the OS but not this CPU architecture)`,
      );
    }
  }
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
