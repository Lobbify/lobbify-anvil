/**
 * Platform tables for the game installer.
 *
 * Two providers describe platforms in their own vocabularies, and both fold onto
 * anvil's {@link TargetTuple} (Mojang `os.name` + a Node `process.arch`):
 *
 *   - **natives classifiers** (`natives-macos-arm64`, `natives-windows-x86`, …) —
 *     the CPU **arch is in the classifier suffix**, not the Mojang rule (which only
 *     gates the OS), so the classifier is the sole source of arch truth. Picking a
 *     native by the OS rule alone would install a wrong-arch binary on Apple
 *     silicon; we key off the classifier.
 *   - **java-runtime platform keys** (`mac-os-arm64`, `windows-x86`, …) — the keys
 *     of Mojang's `java-runtime/all.json`.
 *
 * Everything here is a pure lookup so the resolver stays deterministic and offline-
 * testable.
 */

import type { Platform } from "../build/index.js";
import type { TargetTuple } from "../types/index.js";

/** The current host as a {@link TargetTuple} (os + normalized arch). */
export function currentTarget(platform: Platform): TargetTuple {
  return { os: platform.os, arch: platform.arch };
}

/**
 * Map a Mojang natives classifier (the part after `natives-`) to a target tuple.
 * Returns `undefined` for a classifier we don't recognize (skip, never guess).
 */
export function nativesClassifierTarget(classifier: string): TargetTuple | undefined {
  switch (classifier) {
    case "linux":
      return { os: "linux", arch: "x64" };
    case "linux-arm64":
      return { os: "linux", arch: "arm64" };
    case "linux-arm32":
      return { os: "linux", arch: "arm" };
    case "macos":
    case "osx":
      return { os: "osx", arch: "x64" };
    case "macos-arm64":
      return { os: "osx", arch: "arm64" };
    case "windows":
    case "windows-x64":
      return { os: "windows", arch: "x64" };
    case "windows-arm64":
      return { os: "windows", arch: "arm64" };
    case "windows-x86":
      return { os: "windows", arch: "ia32" };
    default:
      return undefined;
  }
}

/** The `:natives-<classifier>` suffix of a modern-format library name, if any. */
export function nativesClassifierOf(libraryName: string): string | undefined {
  const m = libraryName.match(/:natives-([a-z0-9-]+)$/);
  return m ? (m[1] as string) : undefined;
}

/** Map a java-runtime `all.json` platform key to a target tuple (or `undefined`). */
export function jrePlatformTarget(key: string): TargetTuple | undefined {
  switch (key) {
    case "linux":
      return { os: "linux", arch: "x64" };
    case "linux-i386":
      return { os: "linux", arch: "ia32" };
    case "mac-os":
      return { os: "osx", arch: "x64" };
    case "mac-os-arm64":
      return { os: "osx", arch: "arm64" };
    case "windows-x64":
      return { os: "windows", arch: "x64" };
    case "windows-arm64":
      return { os: "windows", arch: "arm64" };
    case "windows-x86":
      return { os: "windows", arch: "ia32" };
    default:
      return undefined; // e.g. "gamecore" — not a launch target
  }
}

/** Turn a maven coordinate (`group:artifact:version[:classifier]`) into its jar path. */
export function mavenPath(coordinate: string): string {
  const parts = coordinate.split(":");
  const [group, artifact, version] = parts;
  if (!group || !artifact || !version) {
    throw new Error(`malformed maven coordinate "${coordinate}"`);
  }
  const classifier = parts[3];
  const groupPath = group.split(".").join("/");
  const jar = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${groupPath}/${artifact}/${version}/${jar}`;
}

/** The `group:artifact` identity of a maven coordinate (ignores version/classifier). */
export function mavenGroupArtifact(coordinate: string): string {
  const [group, artifact] = coordinate.split(":");
  return `${group}:${artifact}`;
}
