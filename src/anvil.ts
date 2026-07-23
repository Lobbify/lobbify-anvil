/**
 * The public `Anvil` class — the library-first entry point.
 *
 * A host app (e.g. Lobbify) constructs `new Anvil({ dir, paths, curseforgeKey,
 * allowSource })` and calls these methods directly, subscribing to the typed
 * progress bus for observable progress. The CLI and TUI are thin skins over this
 * class and carry no logic.
 *
 * Stage 0 wires the constructor, the progress bus, and the full public method
 * surface — every method is fully typed and throws {@link NotImplemented} until
 * its owning stage lands. The three hard invariants (determinism, atomic swap,
 * replay-never-rehosted) are enforced as these methods gain real bodies.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Acquirer, WhyResult } from "./build/index.js";
import {
  StoreOnlyAcquirer,
  buildInstance,
  canonicalJson,
  collectRoots,
  currentPlatform,
  packageAppliesToPlatform,
  readBuiltLock,
  readGraph,
  recoverSwap,
  resolvePaths,
  whyChains,
  writeGraph,
} from "./build/index.js";
import type { AnvilEvent, ProgressListener } from "./events.js";
import type { MojangApiOptions } from "./game/index.js";
import { GameAcquirer, isGamePackage, resolveGame } from "./game/index.js";
import { importMrpack } from "./import/index.js";
import { ensureDir, pathExists } from "./internal/fs.js";
import { comparePackages, readInputLock, readLockIfPresent, writeLock } from "./lock/index.js";
import {
  MANIFEST_FILENAME,
  parseRef,
  readManifest,
  refForItem,
  refKey,
  writeManifest,
} from "./manifest/index.js";
import type { DependencyEdge } from "./resolver/index.js";
import { pinsFromLock, resolveManifest } from "./resolver/index.js";
import type { SourceRegistry } from "./sources/index.js";
import {
  NetworkAcquirer,
  RateLimitedHttp,
  USER_AGENT,
  buildRegistry,
  defaultAllowSource,
} from "./sources/index.js";
import { ContentStore, hashBuffer, hashFile } from "./store/index.js";
import { AnvilError, ManifestError, NotImplemented, UnsatisfiableTarget } from "./types/errors.js";
import type {
  AnvilOptions,
  Hash,
  Http,
  LockPackage,
  Lockfile,
  Manifest,
  ManifestItem,
} from "./types/index.js";

/**
 * The runtime environment an {@link Anvil} resolves/fetches through. Every field
 * is optional and defaults to the production wiring (the standard source
 * registry + a rate-limited HTTP client hitting the real Mojang/Modrinth
 * endpoints). It doubles as the **mirror / proxy** seam — point `mojangOptions`
 * / `loaderMetaBase` / `resourcesBase` at an internal mirror — and as the seam
 * tests inject offline fixtures through. The CLI passes the default (production).
 */
export interface AnvilEnv {
  /** Build the source registry (Modrinth / URL / local / CurseForge). */
  readonly registry?: () => SourceRegistry;
  /** Construct the HTTP client for Mojang / loader / game-CDN fetches. */
  readonly gameHttp?: () => Http;
  /** Mojang endpoint overrides (mirrors or offline fixtures). */
  readonly mojangOptions?: MojangApiOptions;
  /** Fabric/Quilt loader-meta base override. */
  readonly loaderMetaBase?: string;
  /** Mojang asset-object CDN base override. */
  readonly resourcesBase?: string;
}

/**
 * A typed progress bus: a fan-out event emitter that is also an
 * `AsyncIterable<AnvilEvent>`. Consumers either register a listener with
 * {@link on} or `for await (const event of bus)`.
 */
export class ProgressBus implements AsyncIterable<AnvilEvent> {
  readonly #listeners = new Set<ProgressListener>();
  readonly #buffer: AnvilEvent[] = [];
  #pending: ((result: IteratorResult<AnvilEvent>) => void) | undefined;
  #closed = false;

  /** Register a listener. Returns an unsubscribe function. */
  on(listener: ProgressListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Remove a previously-registered listener. */
  off(listener: ProgressListener): void {
    this.#listeners.delete(listener);
  }

  /** Emit an event to every listener and any pending async iterator. */
  emit(event: AnvilEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
    if (this.#pending) {
      const resolve = this.#pending;
      this.#pending = undefined;
      resolve({ value: event, done: false });
    } else {
      this.#buffer.push(event);
    }
  }

  /** Close the bus; any active async iteration completes. */
  close(): void {
    this.#closed = true;
    if (this.#pending) {
      const resolve = this.#pending;
      this.#pending = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AnvilEvent> {
    while (true) {
      const buffered = this.#buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.#closed) {
        return;
      }
      const next = await new Promise<IteratorResult<AnvilEvent>>((resolve) => {
        this.#pending = resolve;
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}

// --- Method option / result shapes (typed spine; bodies land in later stages) ---

/** Options for {@link Anvil.lock}. `upgrade` re-resolves to newer versions. */
export interface LockOptions {
  /** `true` upgrades everything; a list upgrades only the named packages. */
  readonly upgrade?: boolean | readonly string[];
}

/** Normalize the `upgrade` option to the resolver's `boolean | Set` shape. */
function normalizeUpgrade(
  upgrade: boolean | readonly string[] | undefined,
): boolean | ReadonlySet<string> | undefined {
  if (upgrade === undefined || upgrade === false) {
    return undefined;
  }
  if (upgrade === true) {
    return true;
  }
  return new Set(upgrade);
}

/**
 * The prior lock's concrete loader version to reuse — but only when the manifest
 * loader is **unpinned** (a bare `"fabric"`, no version) and its name matches the
 * prior `meta.loader`. An explicit manifest pin, a loader switch, or a first lock
 * returns `undefined` (resolve fresh). This is what keeps a plain `anvil lock`
 * from silently bumping an unpinned loader on every run.
 */
function priorLoaderVersion(
  prior: Lockfile | undefined,
  manifestLoader: string | undefined,
): string | undefined {
  if (!prior) {
    return undefined;
  }
  const wanted = (manifestLoader ?? "vanilla").trim().split(/\s+/);
  if (wanted.length > 1) {
    return undefined; // the manifest pins an explicit loader version — that wins
  }
  const wantedName = (wanted[0] ?? "vanilla").toLowerCase();
  const priorParts = prior.meta.loader.trim().split(/\s+/);
  const priorName = (priorParts[0] ?? "").toLowerCase();
  const priorVersion = priorParts[1];
  if (priorName !== wantedName || !priorVersion) {
    return undefined;
  }
  return priorVersion;
}

/** Options for {@link Anvil.build}. */
export interface BuildOptions {
  /** Build purely from the populated store; error on the first missing object. */
  readonly offline?: boolean;
}

/** Result of a {@link Anvil.build}. */
export interface BuildResult {
  readonly dir: string;
  readonly objects: number;
}

/** Options for {@link Anvil.verify}. */
export interface VerifyOptions {
  /** Also fail if the instance is not built from the current lock (drift). */
  readonly strict?: boolean;
}

/** Result of a {@link Anvil.verify} / `fsck`-style reconciliation. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/** One changed package in a {@link LockDiff} — same name, different pinned hash. */
export interface LockDiffEntry {
  readonly name: string;
  /** The previously-built pin (`algo:value`), when present. */
  readonly from?: string;
  /** The pin the next build would install (`algo:value`). */
  readonly to?: string;
}

/**
 * A package-level diff of what the next `build` would change: the current lock's
 * platform-applicable package set vs the lock the instance was last built from.
 */
export interface LockDiff {
  readonly added: readonly LockPackage[];
  readonly removed: readonly LockPackage[];
  readonly changed: readonly LockDiffEntry[];
}

/** The summary an {@link Anvil.import} returns. */
export interface ImportSummary {
  /** File entries imported (server-only ones excluded). */
  readonly files: number;
  /** Override files tracked under `.anvil/overrides/`. */
  readonly overrides: number;
  /** Non-fatal skips (server-only files, protected-path targets, …). */
  readonly warnings: readonly string[];
}

/** The scaffold spec for {@link Anvil.init}. */
export interface InitSpec {
  readonly name: string;
  readonly minecraft: string;
  /** `"fabric <v>"` | `"quilt <v>"` | `"vanilla"` (default `"vanilla"`). */
  readonly loader?: string;
  readonly version?: string;
  readonly summary?: string;
  /** Overwrite an existing `anvil.toml` instead of refusing. */
  readonly force?: boolean;
}

/**
 * The `.anvilignore` a fresh `anvil init` scaffolds. `saves/`, `.anvil/`, and
 * `.anvilignore` itself are ALWAYS protected (whether listed or not); a user
 * lists additional hand-edited files here to make **their** config win over a
 * pack-provided one (the pack-config-vs-user-config precedence rule).
 */
const DEFAULT_ANVILIGNORE = `# .anvilignore — top-level entries a build must never create, move, or delete.
# saves/, .anvil/, and .anvilignore itself are ALWAYS protected.
# List any file or directory you hand-edit and want preserved across builds
# (your config then wins over a pack-provided one), for example:
# options.txt
# config/
`;

/** The manifest-vs-lock-vs-built dirty state reported by {@link Anvil.status}. */
export interface StatusResult {
  readonly hasManifest: boolean;
  readonly hasLock: boolean;
  readonly hasBuilt: boolean;
  /** The manifest changed since the lock was written — a re-`lock` is due. */
  readonly manifestDirty: boolean;
  /** The lock differs from what the instance was built from — a `build` is due. */
  readonly buildDirty: boolean;
  /** A one-line, human-readable summary of the state. */
  readonly summary: string;
}

/** A commit reference. Generation numbers order history — wall-clock never is. */
export interface CommitRef {
  readonly id: Hash;
  readonly generation: number;
}

/** Result of a {@link Anvil.merge}. */
export interface MergeResult {
  readonly conflicts: readonly string[];
  readonly committed?: CommitRef;
}

/** Result of a {@link Anvil.pull}. */
export interface PullResult {
  readonly fastForwarded: number;
  readonly objects: number;
}

/** Result of a store GC pass. */
export interface GcResult {
  readonly removed: number;
  readonly freedBytes: number;
}

/** Result of an `fsck` integrity pass. */
export interface FsckResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * The `Anvil` class. Construct once per folder-instance; every command in the
 * design maps to a method here.
 */
export class Anvil {
  readonly #options: AnvilOptions;
  readonly #env: AnvilEnv;

  /** The typed progress bus. Prefer {@link on} or `for await` over reaching in. */
  readonly progress = new ProgressBus();

  /**
   * @param options Per-instance configuration (dir, store, key, policy).
   * @param env Optional runtime/mirror overrides. Defaults to production wiring;
   *   the CLI passes nothing, tests inject offline fixtures here.
   */
  constructor(options: AnvilOptions, env: AnvilEnv = {}) {
    this.#options = options;
    this.#env = env;
  }

  /** The source registry (Modrinth / URL / local / CF), env-overridable. */
  #registry(): SourceRegistry {
    return this.#env.registry?.() ?? buildRegistry();
  }

  /** The instance root — this directory *is* the `.minecraft`. */
  get dir(): string {
    return this.#options.dir;
  }

  /** The (frozen) options this instance was constructed with. */
  get options(): AnvilOptions {
    return this.#options;
  }

  /** Subscribe to progress events. Returns an unsubscribe function. */
  on(_event: "progress", listener: ProgressListener): () => void {
    return this.progress.on(listener);
  }

  /** Iterate progress events: `for await (const e of anvil) { … }`. */
  [Symbol.asyncIterator](): AsyncIterator<AnvilEvent> {
    return this.progress[Symbol.asyncIterator]();
  }

  // --- authoring (init / add / remove — manifest edits) -------------------

  /**
   * `anvil init` — scaffold `anvil.toml` (+ a documented `.anvilignore`) for a
   * fresh instance. Refuses to clobber an existing manifest unless `force`.
   */
  async init(spec: InitSpec): Promise<Manifest> {
    if (!spec.force && (await pathExists(join(this.dir, MANIFEST_FILENAME)))) {
      throw new ManifestError(
        `an ${MANIFEST_FILENAME} already exists in "${this.dir}" — pass force to overwrite`,
      );
    }
    const manifest: Manifest = {
      project: {
        name: spec.name,
        version: spec.version ?? "0.1.0",
        ...(spec.summary ? { summary: spec.summary } : {}),
      },
      game: { minecraft: spec.minecraft, loader: spec.loader ?? "vanilla" },
      items: [],
    };
    await ensureDir(this.dir);
    await writeManifest(this.dir, manifest);
    if (!(await pathExists(join(this.dir, ".anvilignore")))) {
      await writeFile(join(this.dir, ".anvilignore"), DEFAULT_ANVILIGNORE);
    }
    return manifest;
  }

  /**
   * `anvil add` — append item references (`source:id@ver`, a URL, or a `./path`)
   * to the manifest, deduped by identity. Editing the manifest never touches the
   * lock; a following `anvil lock` re-resolves.
   */
  async addItems(specs: readonly string[]): Promise<Manifest> {
    const manifest = await readManifest(this.dir);
    const have = new Set(manifest.items.map((it) => refKey(refForItem(it))));
    const items: ManifestItem[] = [...manifest.items];
    for (const spec of specs) {
      const item: ManifestItem = { ref: parseRef(spec) };
      const key = refKey(refForItem(item));
      if (!have.has(key)) {
        have.add(key);
        items.push(item);
      }
    }
    const next: Manifest = { ...manifest, items };
    await writeManifest(this.dir, next);
    return next;
  }

  /**
   * `anvil remove` — drop item references matching the given specs (by identity).
   * Unmatched specs are ignored. A following `anvil lock` re-resolves.
   */
  async removeItems(specs: readonly string[]): Promise<Manifest> {
    const manifest = await readManifest(this.dir);
    const drop = new Set(specs.map((s) => refKey(parseRef(s))));
    const items = manifest.items.filter((it) => !drop.has(refKey(refForItem(it))));
    const next: Manifest = { ...manifest, items };
    await writeManifest(this.dir, next);
    return next;
  }

  // --- resolve + build (uv lock / docker build) ---------------------------
  //
  // Every method below is `async` so it returns a *rejected* promise (never a
  // synchronous throw) — the same contract callers get once bodies land.

  /**
   * `anvil lock` — resolve `anvil.toml` and freeze the fully-pinned `anvil.lock`.
   *
   * Resolution runs under a **frozen clock** (`Date.now()` captured once), the
   * `allowSource` policy gates every ref before any network I/O, and copy items
   * (Modrinth / URL / local) are admitted to the store as they are hashed so a
   * following build performs zero network. A prior lock, when present, seeds the
   * constrained re-lock: untouched items keep their exact pins unless `upgrade`
   * names them. The canonical TOML lock is written atomically.
   */
  async lock(options?: LockOptions): Promise<Lockfile> {
    const emit = (event: AnvilEvent): void => {
      this.progress.emit(event);
    };
    try {
      const manifest = await readManifest(this.dir);
      const paths = await resolvePaths(this.dir, this.#options);
      const store = new ContentStore({ root: paths.store });
      const registry = this.#registry();
      const prior = await readLockIfPresent(this.dir);
      const upgrade = normalizeUpgrade(options?.upgrade);
      const offline = this.#options.offline ?? false;
      const edges: DependencyEdge[] = [];
      const itemLock = await resolveManifest({
        manifest,
        registry,
        allowSource: this.#options.allowSource ?? defaultAllowSource,
        now: Date.now(),
        baseDir: this.dir,
        offline,
        store,
        ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
        ...(prior ? { lockedPins: pinsFromLock(prior) } : {}),
        ...(upgrade !== undefined ? { upgrade } : {}),
        emit,
        onEdge: (edge) => edges.push(edge),
      });

      // The full game install (client + libraries + natives + assets + pinned JRE
      // + optional loader) — resolved here so the lock carries the whole instance.
      const game = await this.#resolveGamePackages(manifest, store, offline, prior, upgrade);
      const lock: Lockfile = {
        meta: { ...itemLock.meta, java: game.java, loader: game.loader },
        resolved: [...itemLock.resolved, ...game.packages].sort(comparePackages),
      };
      await writeLock(this.dir, lock);
      // The dependency-edge sidecar for `anvil why` (never part of the lock).
      await writeGraph(this.dir, edges);
      return lock;
    } catch (err) {
      if (err instanceof AnvilError) {
        emit({ type: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** A per-endpoint-group rate-limited HTTP client for the game installer. */
  #gameHttp(): Http {
    return this.#env.gameHttp?.() ?? new RateLimitedHttp({ userAgent: USER_AGENT });
  }

  /**
   * Resolve the game install (client + libraries + natives + assets + pinned JRE
   * + optional loader) at lock time, or — offline — carry the prior lock's game
   * pins forward verbatim (a full game re-resolve needs the network).
   */
  async #resolveGamePackages(
    manifest: Manifest,
    store: ContentStore,
    offline: boolean,
    prior: Lockfile | undefined,
    upgrade: boolean | ReadonlySet<string> | undefined,
  ): Promise<{ packages: readonly LockPackage[]; java: string; loader: string }> {
    if (offline) {
      if (!prior) {
        throw new UnsatisfiableTarget(
          "game install",
          "offline: cannot resolve the game without network — run `lock` online first",
        );
      }
      return {
        packages: prior.resolved.filter(isGamePackage),
        java: prior.meta.java,
        loader: prior.meta.loader,
      };
    }
    // Pin stability: when the manifest loader is unpinned and this isn't an
    // upgrade, reuse the prior lock's concrete loader version so a plain re-lock
    // never silently bumps the loader (its libs + the generated version.json).
    const reuse = upgrade !== true ? priorLoaderVersion(prior, manifest.game.loader) : undefined;
    const game = await resolveGame({
      minecraft: manifest.game.minecraft,
      ...(manifest.game.loader ? { loader: manifest.game.loader } : {}),
      ...(reuse ? { reuseLoaderVersion: reuse } : {}),
      mojangHttp: this.#gameHttp(),
      loaderHttp: this.#gameHttp(),
      store,
      ...(this.#env.mojangOptions ? { mojangOptions: this.#env.mojangOptions } : {}),
      ...(this.#env.loaderMetaBase ? { loaderMetaBase: this.#env.loaderMetaBase } : {}),
    });
    return { packages: game.packages, java: game.java, loader: game.loader };
  }

  /**
   * The build acquirer: offline → store-only; else a router that fetches game
   * bytes from the Mojang/loader CDNs (via {@link GameAcquirer}) and manifest
   * items from their sources (via {@link NetworkAcquirer}).
   */
  #buildAcquirer(
    store: ContentStore,
    offline: boolean,
    emit: (event: AnvilEvent) => void,
  ): Acquirer {
    if (offline) {
      return new StoreOnlyAcquirer(store, emit);
    }
    const network = new NetworkAcquirer({
      store,
      registry: this.#registry(),
      allowSource: this.#options.allowSource ?? defaultAllowSource,
      ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
      emit,
    });
    const game = new GameAcquirer({
      store,
      http: this.#gameHttp(),
      ...(this.#env.resourcesBase ? { resourcesBase: this.#env.resourcesBase } : {}),
      emit,
    });
    return {
      ensure: (pkg: LockPackage) => (isGamePackage(pkg) ? game.ensure(pkg) : network.ensure(pkg)),
    };
  }

  /**
   * `anvil build` — install a launch-ready instance from the lock, atomically.
   *
   * Stage 1 is offline: it materializes from the populated content store and
   * fails clearly on the first missing object (the network `Source` fetch lands
   * in Stage 3). The lock is the sole input; a prior interrupted swap is
   * reconciled first, and the swap into place is journaled and crash-atomic.
   */
  async build(options?: BuildOptions): Promise<BuildResult> {
    const emit = (event: AnvilEvent): void => {
      this.progress.emit(event);
    };
    try {
      await recoverSwap(this.dir);
      const paths = await resolvePaths(this.dir, this.#options);
      const store = new ContentStore({ root: paths.store });
      const lock = await readInputLock(this.dir);
      const previousLock = await readBuiltLock(this.dir);
      const offline = options?.offline ?? this.#options.offline ?? false;
      const acquire = this.#buildAcquirer(store, offline, emit);
      const result = await buildInstance({
        instanceDir: this.dir,
        lock,
        store,
        acquire,
        platform: currentPlatform(),
        previousLock,
        emit,
      });
      return { dir: result.dir, objects: result.objects };
    } catch (err) {
      if (err instanceof AnvilError) {
        emit({ type: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /**
   * `anvil verify` — check the materialized instance matches the lock it was
   * built from (re-hashing every single-file target against its pin). With
   * `strict`, additionally fails if the instance has drifted from the current
   * input lock (i.e. a `build` is due).
   */
  async verify(options?: VerifyOptions): Promise<VerifyResult> {
    const built = await readBuiltLock(this.dir);
    const lock = built ?? (await readInputLock(this.dir));
    const targets = lock.resolved.filter(
      (p: LockPackage) => p.placement.method === "link" || p.placement.method === "asset-tree",
    );
    this.progress.emit({ type: "verify:start", items: targets.length });
    const mismatches: string[] = [];
    for (const pkg of targets) {
      const rel =
        pkg.placement.method === "link"
          ? pkg.placement.target
          : pkg.placement.method === "asset-tree"
            ? pkg.placement.indexTarget
            : "";
      let ok = false;
      try {
        const actual = await hashFile(`${this.dir}/${rel}`, pkg.hash.algo);
        ok = actual.value === pkg.hash.value;
      } catch {
        ok = false;
      }
      if (!ok) {
        mismatches.push(pkg.name);
      }
      this.progress.emit({ type: "verify:item", name: pkg.name, ok });
    }
    if (options?.strict) {
      const input = await readLockIfPresent(this.dir);
      if (input && this.#buildDirty(input, built)) {
        mismatches.push("<instance is out of date — run `anvil build`>");
      }
    }
    this.progress.emit({
      type: "verify:done",
      ok: mismatches.length === 0,
      mismatches: mismatches.length,
    });
    return { ok: mismatches.length === 0, mismatches };
  }

  /** The platform-applicable package set of a lock, keyed by name. */
  #applicable(lock: Lockfile): Map<string, LockPackage> {
    const platform = currentPlatform();
    const map = new Map<string, LockPackage>();
    for (const pkg of lock.resolved) {
      if (packageAppliesToPlatform(pkg, platform)) {
        map.set(pkg.name, pkg);
      }
    }
    return map;
  }

  /** Whether the current input lock differs from what was last built. */
  #buildDirty(input: Lockfile, built: Lockfile | undefined): boolean {
    if (!built) {
      return true;
    }
    const cur = this.#applicable(input);
    const prev = this.#applicable(built);
    if (cur.size !== prev.size) {
      return true;
    }
    for (const [name, pkg] of cur) {
      const was = prev.get(name);
      if (!was || was.hash.value !== pkg.hash.value) {
        return true;
      }
    }
    return false;
  }

  /**
   * `anvil diff` — the package-level delta the next `build` would apply: the
   * current lock's platform-applicable set vs the lock last built from.
   */
  async diff(): Promise<LockDiff> {
    const input = await readInputLock(this.dir);
    const built = await readBuiltLock(this.dir);
    const cur = this.#applicable(input);
    const prev = built ? this.#applicable(built) : new Map<string, LockPackage>();
    const added: LockPackage[] = [];
    const removed: LockPackage[] = [];
    const changed: LockDiffEntry[] = [];
    for (const [name, pkg] of cur) {
      const was = prev.get(name);
      if (!was) {
        added.push(pkg);
      } else if (was.hash.value !== pkg.hash.value) {
        changed.push({
          name,
          from: `${was.hash.algo}:${was.hash.value}`,
          to: `${pkg.hash.algo}:${pkg.hash.value}`,
        });
      }
    }
    for (const [name, pkg] of prev) {
      if (!cur.has(name)) {
        removed.push(pkg);
      }
    }
    const byName = (a: LockPackage, b: LockPackage) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return {
      added: added.sort(byName),
      removed: removed.sort(byName),
      changed: changed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  /**
   * `anvil status` — the manifest-vs-lock-vs-built dirty state: whether the
   * manifest has changed since the lock (a re-`lock` is due), and whether the
   * lock has changed since the last build (a `build` is due). Offline.
   */
  async status(): Promise<StatusResult> {
    const manifest = await readManifest(this.dir).catch(() => undefined);
    const input = await readLockIfPresent(this.dir);
    const built = await readBuiltLock(this.dir);
    let manifestDirty = false;
    if (manifest && input) {
      const mh = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
      manifestDirty = mh.value !== input.meta.manifestHash.value;
    }
    const buildDirty = input ? this.#buildDirty(input, built) : false;
    let summary: string;
    if (!manifest) {
      summary = "no anvil.toml — run `anvil init`";
    } else if (!input) {
      summary = "not locked — run `anvil lock`";
    } else if (manifestDirty) {
      summary = "manifest changed since lock — run `anvil lock`";
    } else if (!built) {
      summary = "locked but never built — run `anvil build`";
    } else if (buildDirty) {
      summary = "lock changed since build — run `anvil build`";
    } else {
      summary = "clean — manifest, lock, and instance are in sync";
    }
    return {
      hasManifest: manifest !== undefined,
      hasLock: input !== undefined,
      hasBuilt: built !== undefined,
      manifestDirty,
      buildDirty,
      summary,
    };
  }

  /**
   * `anvil why <item>` — which root item pulled a (transitive) dependency in.
   * Reads the `.anvil/graph.json` sidecar written at `lock` time, so it is fully
   * offline; returns `present: false` when the item is unknown or the instance
   * has not been locked.
   */
  async why(item: string): Promise<WhyResult> {
    const graph = await readGraph(this.dir);
    if (!graph) {
      return { item, present: false, roots: [], chains: [] };
    }
    return whyChains(graph, item);
  }

  // --- version control (git) ----------------------------------------------

  /** `anvil commit` — snapshot manifest + lock into history. */
  async commit(_message: string): Promise<CommitRef> {
    throw new NotImplemented("Anvil.commit");
  }

  /** `anvil branch` — create a variant branch. */
  async branch(_name: string): Promise<void> {
    throw new NotImplemented("Anvil.branch");
  }

  /** `anvil switch` — switch the working branch/ref. */
  async switch(_ref: string): Promise<void> {
    throw new NotImplemented("Anvil.switch");
  }

  /** `anvil merge` — item-set 3-way merge of a branch, then a constrained re-lock. */
  async merge(_branch: string): Promise<MergeResult> {
    throw new NotImplemented("Anvil.merge");
  }

  /** `anvil rebase` — replay local changes onto another branch, crash-survivable. */
  async rebase(_onto: string): Promise<void> {
    throw new NotImplemented("Anvil.rebase");
  }

  /** `anvil revert` — roll back to a past version. */
  async revert(_ref: string): Promise<CommitRef> {
    throw new NotImplemented("Anvil.revert");
  }

  // --- remotes (git clone/pull/push) --------------------------------------

  /** `anvil clone` — create an instance from a remote and build in place. */
  async clone(_url: string): Promise<void> {
    throw new NotImplemented("Anvil.clone");
  }

  /** `anvil pull` — content-addressed fast-forward to the remote's latest. */
  async pull(): Promise<PullResult> {
    throw new NotImplemented("Anvil.pull");
  }

  /** `anvil push` — publish local commits + changed objects to a remote. */
  async push(_remote?: string): Promise<void> {
    throw new NotImplemented("Anvil.push");
  }

  // --- import / export (docker load/save) ---------------------------------

  /**
   * `anvil import` — adopt an `.mrpack` (Modrinth modpack) into this instance,
   * writing `anvil.toml` + a pre-resolved `anvil.lock`. The archive is untrusted:
   * files are integrity-checked, server-only files filtered, `overrides/` unpacked
   * through the hardened extractor, and nothing is placed into a protected path.
   * (CurseForge-zip / Prism import land in Stages 6–7.)
   */
  async import(archive: string): Promise<ImportSummary> {
    const emit = (event: AnvilEvent): void => {
      this.progress.emit(event);
    };
    try {
      const paths = await resolvePaths(this.dir, this.#options);
      const store = new ContentStore({ root: paths.store });
      const registry = this.#registry();
      const fileHttp = registry.get("url")?.http ?? this.#gameHttp();
      const result = await importMrpack({
        archivePath: archive,
        instanceDir: this.dir,
        store,
        fileHttp,
        resolveGame: async ({ minecraft, loader }) => {
          const game = await resolveGame({
            minecraft,
            ...(loader && loader !== "vanilla" ? { loader } : {}),
            mojangHttp: this.#gameHttp(),
            loaderHttp: this.#gameHttp(),
            store,
            ...(this.#env.mojangOptions ? { mojangOptions: this.#env.mojangOptions } : {}),
            ...(this.#env.loaderMetaBase ? { loaderMetaBase: this.#env.loaderMetaBase } : {}),
          });
          return { packages: game.packages, java: game.java, loader: game.loader };
        },
        allowSource: this.#options.allowSource ?? defaultAllowSource,
        emit,
      });
      return { files: result.files, overrides: result.overrides, warnings: result.warnings };
    } catch (err) {
      if (err instanceof AnvilError) {
        emit({ type: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** `anvil export` — write an `.mrpack` (CF replay items omitted, with a warning). */
  async export(_target: string): Promise<void> {
    throw new NotImplemented("Anvil.export");
  }

  // --- store maintenance (git gc / fsck) ----------------------------------

  /**
   * `anvil store gc` — mark-sweep unreachable objects, rooted at this instance's
   * built lock (and the assets its indexes name).
   *
   * NOTE — Stage 1 roots GC at this single instance. The store-level instance
   * registry that unions every instance's roots before sweeping (so GC from one
   * instance can't delete another's objects) is a later-stage addition; the
   * underlying {@link ContentStore.gc} already takes an explicit root set.
   */
  async gc(): Promise<GcResult> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    const built = await readBuiltLock(this.dir);
    const roots = built ? await collectRoots(built, store) : [];
    const result = await store.gc(roots, { graceMs: 0 });
    return { removed: result.removed, freedBytes: result.freedBytes };
  }

  /** `anvil fsck` — re-hash every stored object and report content-address drift. */
  async fsck(): Promise<FsckResult> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    const result = await store.fsck();
    return { ok: result.ok, problems: result.problems };
  }
}
