/**
 * The canonical merged `versions/<id>/<id>.json` builder — a **generated file**,
 * so it is held to the same byte-identical determinism bar as any materialized
 * object and covered by the determinism harness.
 *
 * For a loader install it flattens `inheritsFrom`: the vanilla profile and the
 * loader profile are merged into one self-contained launch profile —
 *
 *   - the loader `mainClass` replaces vanilla's;
 *   - libraries are a **union deduped by `group:artifact` (+ natives classifier),
 *     the loader winning a version conflict**, then **sorted by maven coordinate**.
 *     This ordering is load-bearing: keeping both vanilla's and the loader's ASM
 *     put two `org.ow2.asm:asm` jars on the classpath and crashed Fabric on 1.21
 *     (the "dup-ASM" lesson) — dedup-by-coordinate is the fix;
 *   - `arguments.game` / `arguments.jvm` are concatenated (vanilla then loader).
 *
 * The result is serialized with a recursively key-sorted canonical JSON writer, so
 * neither host map-iteration order nor a provider's key order can perturb the
 * bytes. For a vanilla install the vanilla profile is canonicalized as-is.
 */

import { canonicalJson } from "../build/index.js";
import { mavenGroupArtifact } from "./platform.js";

/** A launcher-profile library entry (only the fields the merge reasons about). */
export interface ProfileLibrary {
  readonly name: string;
  readonly rules?: unknown;
  readonly downloads?: unknown;
  readonly url?: string;
  readonly [k: string]: unknown;
}

/** A parsed launcher profile (vanilla or loader) — loosely typed, we read a few keys. */
export interface LauncherProfile {
  readonly id?: string;
  readonly type?: string;
  readonly mainClass?: string;
  readonly inheritsFrom?: string;
  readonly libraries?: readonly ProfileLibrary[];
  readonly arguments?: { readonly game?: readonly unknown[]; readonly jvm?: readonly unknown[] };
  readonly [k: string]: unknown;
}

/** Pure code-unit compare — never `localeCompare` (its collation is host-variant). */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The dedup identity of a library: `group:artifact` for a plain jar (so two
 * versions collapse to one), but `group:artifact:<classifier>` for a natives jar
 * (each per-OS/arch native is a distinct artifact that must survive the union).
 */
function dedupKey(name: string): string {
  const parts = name.split(":");
  const classifier = parts[3];
  const ga = mavenGroupArtifact(name);
  return classifier ? `${ga}:${classifier}` : ga;
}

/**
 * Union the vanilla and loader libraries, deduped by {@link dedupKey} with the
 * **loader winning** a conflict, then sorted by full coordinate. Deterministic and
 * order-independent: shuffling either input yields byte-identical output.
 */
export function mergeLibraries(
  vanilla: readonly ProfileLibrary[],
  loader: readonly ProfileLibrary[],
): ProfileLibrary[] {
  const byKey = new Map<string, ProfileLibrary>();
  for (const lib of vanilla) {
    byKey.set(dedupKey(lib.name), lib);
  }
  for (const lib of loader) {
    byKey.set(dedupKey(lib.name), lib); // loader overrides on conflict
  }
  return [...byKey.values()].sort((a, b) => byCodeUnit(a.name, b.name));
}

function argArray(profile: LauncherProfile | undefined, which: "game" | "jvm"): unknown[] {
  return [...(profile?.arguments?.[which] ?? [])];
}

export interface BuildVersionJsonInput {
  readonly vanilla: LauncherProfile;
  /** The loader profile for a loader install; omitted for vanilla. */
  readonly loader?: LauncherProfile;
  /** The id the merged profile is written under (loader id, or the mc version). */
  readonly id: string;
}

/**
 * Build the canonical merged launch profile object (self-contained; no
 * `inheritsFrom`). Exposed for assertions; {@link serializeVersionJson} returns
 * its byte-stable string form.
 */
export function buildVersionProfile(input: BuildVersionJsonInput): Record<string, unknown> {
  const { vanilla, loader, id } = input;
  // A merged profile is self-contained — drop the inheritance pointer up front.
  const { inheritsFrom: _inheritsFrom, ...rest } = vanilla;
  const merged: Record<string, unknown> = { ...rest };
  merged.id = id;

  if (loader) {
    if (loader.mainClass !== undefined) {
      merged.mainClass = loader.mainClass;
    }
    if (loader.type !== undefined) {
      merged.type = loader.type;
    }
    merged.libraries = mergeLibraries(vanilla.libraries ?? [], loader.libraries ?? []);
    merged.arguments = {
      game: [...argArray(vanilla, "game"), ...argArray(loader, "game")],
      jvm: [...argArray(vanilla, "jvm"), ...argArray(loader, "jvm")],
    };
  } else {
    // Vanilla: keep Mojang's own (already stable) library order; canonical
    // key-sorting at serialization time is what makes the bytes deterministic.
    merged.libraries = [...(vanilla.libraries ?? [])];
  }
  return merged;
}

/** Serialize the merged launch profile to its canonical, byte-stable JSON form. */
export function serializeVersionJson(input: BuildVersionJsonInput): string {
  return canonicalJson(buildVersionProfile(input));
}
