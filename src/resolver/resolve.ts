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
 *
 * A manifest declaring `game.from` resolves in **two layers**: the base pack's
 * member set underneath (supplied by the caller's `resolveBase`, since fetching a
 * pack is I/O this module does not own), then this manifest's `items` on top. The
 * precedence rules live in `base/overlay.ts` and are documented there and in
 * `ARCHITECTURE.md`; what happens here is the plumbing — base members seed
 * dependency resolution so a base's mods are not silently re-resolved out from
 * under it, and the overlay runs once the instance layer is fully pinned.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import * as semver from "semver";
import { baseSetDigest, overlayBase } from "../base/overlay.js";
import type { ResolvedBasePack } from "../base/types.js";
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
  PathEscape,
  SourceNotAllowed,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type {
  AllowSource,
  LockBase,
  LockPackage,
  Lockfile,
  Manifest,
  ObjectSink,
  ResolvedRef,
  SourceContext,
  VersionSpec,
} from "../types/index.js";
import { canonicalKeyOf, pinsFromLock } from "./identity.js";

export { canonicalKeyOf, pinsFromLock };

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
  /**
   * Resolve the manifest's `game.from` base pack. Required when the manifest
   * declares one, absent otherwise. It is a callback rather than a registry
   * because fetching and expanding a pack is I/O — the caller (`Anvil.lock`) owns
   * the instance dir, the store, and the HTTP clients; this module owns only the
   * layering.
   */
  readonly resolveBase?: (ref: ResolvedRef) => Promise<ResolvedBasePack>;
}

/**
 * Absolutize a local ref's path against the base dir (other sources unchanged),
 * and settle the placement target: an explicitly declared one when the item has
 * one, otherwise the one derived from the path **as authored**, before it is
 * absolutized.
 *
 * The manifest is instance-relative by construction (`baseDir` is the instance
 * dir), so an authored `"config/a/b.toml"` is both the read location and the
 * placement. Deriving it here, rather than in `parseRef`, keeps the parsed refs
 * that a manifest stores byte-identical — so this change does not perturb any
 * existing `meta.manifestHash`.
 *
 * A declared `target` separates the two: the bytes are read from `id` and placed
 * at `target`. That is how a tracked copy (`.anvil/overrides/<path>`, written by
 * `import` before any build) names a placement its read path could not — the read
 * path is inside `.anvil/`, which is never a legal placement. Derivation is
 * skipped entirely in that case, since running it on the read path is exactly the
 * `PathEscape` this exists to avoid.
 *
 * The declared target runs the **same** {@link declaredPlacementTarget} guards a
 * derived one does, and a target naming nothing inside the instance is a hard
 * failure rather than a fall back to kind placement: for a derived target the
 * fallback is right (the path was never a placement claim), but silently ignoring
 * a placement the manifest states outright would relocate the file — the failure
 * class LB-704/LB-706 exist to eliminate.
 */
function localizeRef(ref: ResolvedRef, baseDir: string): ResolvedRef {
  if (ref.source !== "local") {
    return ref;
  }
  const id = isAbsolute(ref.id) ? ref.id : resolvePath(baseDir, ref.id);
  if (ref.target !== undefined) {
    const declared = declaredPlacementTarget(ref.target);
    if (declared === undefined) {
      throw new PathEscape(
        ref.target,
        "an explicit target must name a path inside the instance — it cannot be absolute, nor walk out with `..`",
      );
    }
    return { ...ref, id, target: declared };
  }
  const target = declaredPlacementTarget(ref.id);
  return {
    ...ref,
    id,
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

/**
 * Resolve the manifest's `game.from`, and check the pack's game target against
 * the manifest's. A pack's mods are built for one Minecraft version; starting
 * from a 26.1 pack while declaring 26.2 is a mistake that would otherwise surface
 * as a pile of unrelated launch failures, so it fails here, naming both sides.
 * The loader *version* may differ (the instance's wins); the loader *name* may
 * not — a Fabric pack under a Forge instance shares no mods at all.
 */
async function resolveBaseLayer(
  input: ResolveManifestInput,
  baseDir: string,
): Promise<{ ref: ResolvedRef; raw: string; pack: ResolvedBasePack } | undefined> {
  const raw = input.manifest.game.from;
  if (raw === undefined) {
    return undefined;
  }
  if (!input.resolveBase) {
    throw new ManifestError(
      `game.from "${raw}" needs a base-pack resolver — resolveManifest was called without one. Resolve through \`Anvil.lock\`, or pass \`resolveBase\`.`,
    );
  }
  const ref = localizeRef(parseRef(raw), baseDir);
  // The policy gate runs on the base ref BEFORE any pack byte is fetched, exactly
  // as it does for an item — a manifest cannot make anvil reach a source the
  // embedder refused by hiding it in `game.from`.
  if (!input.allowSource(ref)) {
    throw new SourceNotAllowed(ref.source, ref.id);
  }
  const pack = await input.resolveBase(ref);
  const game = input.manifest.game;
  if (pack.game.minecraft !== game.minecraft) {
    throw new ManifestError(
      `game.from "${raw}" is a Minecraft ${pack.game.minecraft} pack, but this manifest declares ` +
        `Minecraft ${game.minecraft}. Set game.minecraft = "${pack.game.minecraft}", or pick a pack version for ${game.minecraft}.`,
    );
  }
  const packLoader = loaderNameOf(pack.game.loader);
  const ownLoader = loaderNameOf(game.loader);
  if (packLoader !== ownLoader) {
    throw new ManifestError(
      `game.from "${raw}" is a ${packLoader} pack, but this manifest declares ${ownLoader}. A pack's mods are loader-specific; pick a pack for your loader.`,
    );
  }
  return { ref, raw, pack };
}

/** The loader name (`"fabric 0.19.1"` → `"fabric"`), lower-cased. */
function loaderNameOf(loader: string): string {
  return (loader.trim().split(/\s+/)[0] ?? "vanilla").toLowerCase();
}

export async function resolveManifest(input: ResolveManifestInput): Promise<Lockfile> {
  const { manifest, registry, allowSource, now } = input;
  const emit = input.emit;
  const baseDir = input.baseDir ?? process.cwd();

  // Fingerprint the authored manifest (pre-localization) for a portable hash.
  const manifestHash = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");

  const base = await resolveBaseLayer(input, baseDir);
  for (const warning of base?.pack.warnings ?? []) {
    emit?.({ type: "warning", message: warning });
  }
  // Base members seed dependency resolution: a transitive dep the base already
  // provides reuses the base's pin verbatim instead of hitting the network and
  // bumping a mod nobody asked to bump. Roots are deliberately NOT pinned this
  // way — an item you listed yourself is one you control.
  const basePins = new Map<string, LockPackage>();
  for (const member of base?.pack.members ?? []) {
    basePins.set(canonicalKeyOf(member), member);
  }

  const removes = (manifest.game.remove ?? []).map((raw) => ({
    raw,
    ref: localizeRef(parseRef(raw), baseDir),
  }));
  const removeSet = new Set(removes.map((r) => refKey(r.ref)));

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

  // Remove entries that already matched a manifest item here are matched, full
  // stop — the item is dropped before it is ever resolved, so the overlay (which
  // only ever sees what survived) must not later call the entry unmatched.
  const matchedRemoves = new Set<string>();
  let rootCount = 0;
  for (const item of manifest.items) {
    const ref = localizeRef(refForItem(item), baseDir);
    const rk = refKey(ref);
    if (removeSet.has(rk)) {
      for (const r of removes) {
        if (refKey(r.ref) === rk) {
          matchedRemoves.add(r.raw);
        }
      }
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
    // ref's own key is already canonical (slug / url / path refs). A base member
    // does the same job for a **dependency** — but never for a root, which the
    // manifest declared and therefore controls.
    const directPin =
      input.lockedPins?.get(rk) ?? (by === "(manifest)" ? undefined : basePins.get(rk));
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
    // only known after resolving): prefer the byte-identical locked pin. Modrinth
    // dependencies name project *ids* while a base member is keyed by slug, so
    // for a base pin this is the branch that fires — the network round trip has
    // already happened, but the base's version is what gets kept.
    const pin = input.lockedPins?.get(ck) ?? (by === "(manifest)" ? undefined : basePins.get(ck));
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

  // The instance layer, fully pinned. Now lay it over the base — see
  // `base/overlay.ts` for the precedence rules this delegates to.
  const overlay = overlayBase({
    base: base?.pack.members ?? [],
    instance: [...resolved.values()],
    removes,
  });
  const unmatched = overlay.unmatched.filter((raw) => !matchedRemoves.has(raw));
  if (unmatched.length > 0) {
    throw new ManifestError(
      `game.remove names ${unmatched.length === 1 ? "an item" : "items"} that nothing provides: ${unmatched.map((r) => `"${r}"`).join(", ")}. A remove that matches nothing is refused, so a typo cannot leave a mod you believed you dropped.`,
    );
  }
  for (const record of overlay.removed) {
    emit?.({
      type: "warning",
      message: `game.remove "${record.entry}" dropped ${record.package.name} (matched on ${record.on})`,
    });
  }

  const resolvedPackages = [...overlay.effective].sort(comparePackages);
  // Two distinct items must never claim the same placement target — the resolver
  // dedups by identity, not by where a file lands, so a shared basename would make
  // one silently overwrite the other in the built instance. Fail at lock time.
  // Base-vs-instance clashes cannot reach here: the overlay resolved them, in the
  // instance's favour. What is left is two *instance* items colliding.
  assertNoPlacementCollisions(resolvedPackages);

  // Base members are edges too, so `anvil why` can answer "because the base pack
  // ships it" instead of going blank on two thirds of a base-derived instance.
  for (const member of base?.pack.members ?? []) {
    input.onEdge?.({ child: canonicalKeyOf(member), childName: member.name, by: "(base)" });
  }

  const lockBase: LockBase | undefined = base
    ? {
        ref: base.raw,
        source: base.pack.source,
        id: base.pack.id,
        version: base.pack.version,
        archive: base.pack.archive,
        set: baseSetDigest(base.pack.members),
        members: base.pack.members.length,
      }
    : undefined;

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
    ...(lockBase ? { base: lockBase } : {}),
    resolved: resolvedPackages,
  };
}
