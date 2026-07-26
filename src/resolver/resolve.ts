/**
 * The resolver: a manifest → a fully-pinned {@link Lockfile}.
 *
 * A single-pass BFS worklist. For every ref reached — a root item or a transitive
 * dependency — the **`allowSource` gate runs first, before any network I/O**, so
 * a malicious manifest cannot even trigger a fetch to a source the embedder has
 * not permitted. Version specs resolve under a **frozen `ctx.now` clock** so
 * `latest`/omitted is deterministic.
 *
 * Identity is a **canonical key** (`source:slug` for Modrinth, the final URL for
 * `url`, the absolute path for `local`, the project id for CurseForge), so a
 * project referenced by slug in one place and by id in another dedups to one
 * entry. Conflict handling is **fail-closed**: one version per project; a second
 * demand the pinned version can't satisfy stops the resolve with a
 * {@link ConflictError} naming who-demanded-what.
 *
 * A `lockedPins` constraint (Stage 5's constrained re-lock) is honored: a key in
 * `lockedPins` and not selected for `upgrade` is reused **verbatim**, so untouched
 * items emerge byte-identical across a re-lock. Build `lockedPins` from a prior
 * lock with {@link pinsFromLock}.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import * as semver from "semver";
import { assertNoPlacementCollisions } from "../build/collision.js";
import { canonicalJson } from "../build/serialize.js";
import type { AnvilEvent } from "../events.js";
import { comparePackages } from "../lock/serialize.js";
import { formatVersionSpec, parseRef, refForItem, refKey } from "../manifest/ref.js";
import { declaredPlacementTarget } from "../sources/place.js";
import type { SourceRegistry } from "../sources/registry.js";
import { hashBuffer } from "../store/hash.js";
import type { ConflictDemand } from "../types/errors.js";
import {
  ConflictError,
  ManifestError,
  SourceNotAllowed,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type {
  AllowSource,
  LockPackage,
  Lockfile,
  Manifest,
  ObjectSink,
  ResolvedRef,
  SourceContext,
  VersionSpec,
} from "../types/index.js";

/**
 * One resolved demand edge: some root/dependency (`by`) required a package
 * (`child`, keyed canonically, `childName` its resolved name). Roots carry
 * `by: "(manifest)"`. The resolver never persists a dependency graph in the
 * (deterministic) lock, so `anvil lock` streams these to a `.anvil/graph.json`
 * sidecar that `anvil why` reads — offline — to trace which root pulled a dep.
 */
export interface DependencyEdge {
  /** The canonical key of the demanded package. */
  readonly child: string;
  /** The resolved name of the demanded package. */
  readonly childName: string;
  /** Who demanded it — a demander package name, or `"(manifest)"` for a root. */
  readonly by: string;
}

export interface ResolveManifestInput {
  readonly manifest: Manifest;
  readonly registry: SourceRegistry;
  readonly allowSource: AllowSource;
  /** The frozen lock clock (ms). `latest`/omitted resolves to newest ≤ this. */
  readonly now: number;
  /** Base directory local `./paths` resolve against (defaults to cwd). */
  readonly baseDir?: string;
  /** Resolve only from prior pins; never hit the network for a fresh ref. */
  readonly offline?: boolean;
  /** Where copy sources admit hashed bytes so a build finds them present. */
  readonly store?: ObjectSink;
  readonly curseforgeKey?: string;
  /** Prior pins to reuse verbatim (constrained re-lock). Keyed canonically. */
  readonly lockedPins?: ReadonlyMap<string, LockPackage>;
  /** Keys to re-resolve despite a locked pin (`true` = re-resolve everything). */
  readonly upgrade?: boolean | ReadonlySet<string>;
  readonly emit?: (event: AnvilEvent) => void;
  /** Streamed one edge per resolved demand — powers the `why` graph sidecar. */
  readonly onEdge?: (edge: DependencyEdge) => void;
}

/** The canonical identity key for a resolved package (dedup + pin key). */
export function canonicalKeyOf(pkg: LockPackage): string {
  switch (pkg.source) {
    case "modrinth":
      return `modrinth:${pkg.name}`; // name is the (unique) Modrinth slug
    case "curseforge":
      return pkg.project !== undefined ? `curseforge:${pkg.project}` : `curseforge:${pkg.name}`;
    case "url":
      return `url:${pkg.url ?? pkg.name}`;
    case "local":
      return `local:${localPathOf(pkg)}`;
    default:
      return `${pkg.source}:${pkg.name}`;
  }
}

function localPathOf(pkg: LockPackage): string {
  if (!pkg.url) {
    return pkg.name;
  }
  try {
    return fileURLToPath(pkg.url);
  } catch {
    return pkg.url;
  }
}

/** Build a `lockedPins` map from a prior lock, keyed canonically. */
export function pinsFromLock(lock: Lockfile): Map<string, LockPackage> {
  const map = new Map<string, LockPackage>();
  for (const pkg of lock.resolved) {
    map.set(canonicalKeyOf(pkg), pkg);
  }
  return map;
}

/**
 * Absolutize a local ref's path against the base dir (other sources unchanged),
 * and — from the path **as authored**, before it is absolutized — derive the
 * placement target it declares.
 *
 * The manifest is instance-relative by construction (`baseDir` is the instance
 * dir), so an authored `"config/a/b.toml"` is both the read location and the
 * placement. Deriving it here, rather than in `parseRef`, keeps the parsed refs
 * that a manifest stores byte-identical — so this change does not perturb any
 * existing `meta.manifestHash`.
 */
function localizeRef(ref: ResolvedRef, baseDir: string): ResolvedRef {
  if (ref.source !== "local") {
    return ref;
  }
  const target = declaredPlacementTarget(ref.id);
  return {
    ...ref,
    id: isAbsolute(ref.id) ? ref.id : resolvePath(baseDir, ref.id),
    ...(target !== undefined ? { target } : {}),
  };
}

/** Whether an already-pinned package satisfies a demanded version spec. */
function specSatisfiedBy(spec: VersionSpec, pkg: LockPackage): boolean {
  switch (spec.kind) {
    case "latest":
      return true;
    case "pin":
      return pkg.version === spec.version;
    case "range": {
      if (!pkg.version) {
        return false;
      }
      const c = semver.coerce(pkg.version, { includePrerelease: true });
      return (
        c !== null && semver.satisfies(c, spec.range, { includePrerelease: true, loose: true })
      );
    }
  }
}

export async function resolveManifest(input: ResolveManifestInput): Promise<Lockfile> {
  const { manifest, registry, allowSource, now } = input;
  const emit = input.emit;
  const baseDir = input.baseDir ?? process.cwd();

  if (manifest.game.from !== undefined) {
    throw new ManifestError(
      "game.from (starting from a base pack) is not supported yet — it lands with the base-merge stage. List items directly for now.",
    );
  }

  // Fingerprint the authored manifest (pre-localization) for a portable hash.
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");

  const removeSet = new Set<string>();
  for (const r of manifest.game.remove ?? []) {
    removeSet.add(refKey(localizeRef(parseRef(r), baseDir)));
  }

  const upgrade = input.upgrade;
  const isUpgraded = (key: string): boolean => {
    if (upgrade === true) {
      return true;
    }
    if (!(upgrade instanceof Set)) {
      return false;
    }
    // Match a canonical key ("modrinth:sodium") or its bare id/slug ("sodium").
    return upgrade.has(key) || upgrade.has(key.slice(key.indexOf(":") + 1));
  };

  const resolved = new Map<string, LockPackage>(); // canonical key → package
  const alias = new Map<string, string>(); // refKey → canonical key
  const demandLog: Array<{ rk: string; by: string; demanded: string }> = [];
  const queue: Array<{ ref: ResolvedRef; by: string }> = [];

  const gameCtx = {
    minecraft: manifest.game.minecraft,
    ...(manifest.game.loader ? { loader: manifest.game.loader } : {}),
  };

  let rootCount = 0;
  for (const item of manifest.items) {
    const ref = localizeRef(refForItem(item), baseDir);
    if (removeSet.has(refKey(ref))) {
      continue;
    }
    queue.push({ ref, by: "(manifest)" });
    rootCount += 1;
  }
  emit?.({ type: "resolve:start", items: rootCount });

  const demandsForKey = (ck: string): ConflictDemand[] =>
    demandLog
      .filter((d) => (alias.get(d.rk) ?? d.rk) === ck)
      .map((d) => ({ by: d.by, demanded: d.demanded }));

  const conflictIf = (spec: VersionSpec, ck: string, pkg: LockPackage): void => {
    if (!specSatisfiedBy(spec, pkg)) {
      throw new ConflictError(pkg.name, demandsForKey(ck));
    }
  };

  let index = 0;
  for (;;) {
    const next = queue.shift();
    if (!next) {
      break;
    }
    const { ref, by } = next;
    const rk = refKey(ref);
    demandLog.push({ rk, by, demanded: formatVersionSpec(ref.versionSpec) });

    // The allow gate runs BEFORE any network I/O, for roots and deps alike.
    if (!allowSource(ref)) {
      throw new SourceNotAllowed(ref.source, ref.id);
    }

    // Already resolved under a known alias → dedup / conflict-check.
    const knownCk = alias.get(rk);
    if (knownCk) {
      const ex = resolved.get(knownCk);
      if (ex) {
        conflictIf(ref.versionSpec, knownCk, ex);
        input.onEdge?.({ child: knownCk, childName: ex.name, by });
        continue;
      }
    }

    // Constrained re-lock: reuse a locked pin verbatim (no network) when the
    // ref's own key is already canonical (slug / url / path refs).
    const directPin = input.lockedPins?.get(rk);
    if (directPin && !isUpgraded(rk) && specSatisfiedBy(ref.versionSpec, directPin)) {
      resolved.set(rk, directPin);
      alias.set(rk, rk);
      input.onEdge?.({ child: rk, childName: directPin.name, by });
      emit?.({ type: "resolve:item", name: directPin.name, index: index++, total: rootCount });
      continue;
    }

    if (input.offline) {
      throw new UnsatisfiableTarget(
        rk,
        "offline: cannot resolve a new version without network — run `lock` online first",
      );
    }

    const entry = registry.get(ref.source);
    if (!entry) {
      throw new ManifestError(`no source is registered for "${ref.source}"`);
    }
    const ctx: SourceContext = {
      ...(entry.http ? { http: entry.http } : {}),
      offline: false,
      now,
      ...(input.curseforgeKey ? { curseforgeKey: input.curseforgeKey } : {}),
      allowSource,
      ...(input.store ? { store: input.store } : {}),
      game: gameCtx,
    };
    emit?.({ type: "resolve:item", name: ref.id, index: index++, total: rootCount });
    const result = await entry.source.resolve(ref, ctx);
    const ck = canonicalKeyOf(result.pkg);
    alias.set(rk, ck);

    const already = resolved.get(ck);
    if (already) {
      // A different alias resolved this project first — dedup, keep the winner.
      conflictIf(ref.versionSpec, ck, already);
      input.onEdge?.({ child: ck, childName: already.name, by });
      continue;
    }

    // Post-resolve pin reuse (for id-referenced deps whose canonical key was
    // only known after resolving): prefer the byte-identical locked pin.
    const pin = input.lockedPins?.get(ck);
    if (pin && !isUpgraded(ck) && specSatisfiedBy(ref.versionSpec, pin)) {
      resolved.set(ck, pin);
    } else {
      resolved.set(ck, result.pkg);
    }
    input.onEdge?.({ child: ck, childName: result.pkg.name, by });
    for (const dep of result.dependencies ?? []) {
      queue.push({ ref: localizeRef(dep, baseDir), by: result.pkg.name });
    }
  }

  emit?.({ type: "resolve:done", pinned: resolved.size });
  const resolvedPackages = [...resolved.values()].sort(comparePackages);
  // Two distinct items must never claim the same placement target — the resolver
  // dedups by identity, not by where a file lands, so a shared basename would make
  // one silently overwrite the other in the built instance. Fail at lock time.
  assertNoPlacementCollisions(resolvedPackages);
  return {
    meta: {
      version: 1,
      manifestHash,
      minecraft: manifest.game.minecraft,
      loader: manifest.game.loader,
      // Stage 2 locks items only; the game client, loader libraries, and the
      // pinned JRE (meta.java) are resolved by the game installer in Stage 3.
      java: "pending:game-install",
    },
    resolved: resolvedPackages,
  };
}
