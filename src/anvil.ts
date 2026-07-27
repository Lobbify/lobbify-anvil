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

import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BaseRegistry, CachedBase, ResolvedBasePack } from "./base/index.js";
import { baseSetDigest, buildBaseRegistry, readBaseCache, writeBaseCache } from "./base/index.js";
import type { Acquirer, BuildEngineResult, WhyResult } from "./build/index.js";
import {
  StoreOnlyAcquirer,
  buildInstance,
  canonicalJson,
  collectRoots,
  currentPlatform,
  packageAppliesToPlatform,
  readBuiltLock,
  readBuiltLockStrict,
  readGraph,
  recoverSwap,
  resolvePaths,
  whyChains,
  writeGraph,
} from "./build/index.js";
import type { AnvilEvent, ProgressListener } from "./events.js";
import { exportMrpack } from "./export/index.js";
import type { ForgeEndpoints, MojangApiOptions, ProcessorRunner } from "./game/index.js";
import { GameAcquirer, JvmProcessorRunner, isGamePackage, resolveGame } from "./game/index.js";
import {
  ApiIdentityResolver,
  importCurseForgeZip,
  importMrpack,
  importPrism,
  readZipEntry,
} from "./import/index.js";
import { ensureDir, pathExists } from "./internal/fs.js";
import { instanceLockPath, storeLockPath, withLock } from "./internal/lock.js";
import { comparePackages, readInputLock, readLockIfPresent, writeLock } from "./lock/index.js";
import {
  MANIFEST_FILENAME,
  parseRef,
  readManifest,
  refForItem,
  refKey,
  writeManifest,
} from "./manifest/index.js";
import type { CloneOutcome, PullOutcome, PushOutcome, RunBuild } from "./remote/index.js";
import {
  RemotePullAcquirer,
  addRemote as addRemoteToConfig,
  cloneInstance,
  listRemotes,
  makeDescriptor,
  makeTransport,
  pullInstance,
  pushInstance,
  removeRemote as removeRemoteFromConfig,
  resolveRemote,
} from "./remote/index.js";
import type { RemoteDescriptor, RemoteKind } from "./remote/index.js";
import type { DependencyEdge } from "./resolver/index.js";
import { pinsFromLock, resolveManifest } from "./resolver/index.js";
import type { SourceRegistry } from "./sources/index.js";
import {
  CurseForgeApi,
  ModrinthApi,
  NetworkAcquirer,
  RateLimitedHttp,
  ReplayAcquirer,
  USER_AGENT,
  buildRegistry,
  defaultAllowSource,
} from "./sources/index.js";
import type { InstanceRegistryEntry } from "./store/index.js";
import {
  ContentStore,
  ReplayCache,
  ReplayVeto,
  hashBuffer,
  hashFile,
  readInstanceRegistry,
  upsertInstance,
  writeInstanceRegistry,
} from "./store/index.js";
import {
  AnvilError,
  ManifestError,
  RemoteNotFound,
  StoreRegistryCorrupt,
  UnsatisfiableTarget,
  VcStateError,
} from "./types/errors.js";
import type {
  AnvilOptions,
  Hash,
  Http,
  LockPackage,
  Lockfile,
  Manifest,
  ManifestItem,
  ResolvedRef,
} from "./types/index.js";
import type {
  CommitRef,
  Conflict,
  ConflictStrategy,
  LogEntry,
  MergeOutcome,
  OnConflict,
  RebaseOutcome,
  RelockFn,
  RevertOutcome,
} from "./vc/index.js";
import {
  EXCLUDE_FILE,
  Refs,
  VcObjectStore,
  VcRepo,
  snapshotExclusion,
  trackWorktree,
  vcReachability,
} from "./vc/index.js";

/**
 * The default GC grace window (ms). Objects modified within this window are kept
 * even when unrooted, a secondary guard (below the instance-registry root union)
 * against sweeping bytes a concurrent build just wrote but has not yet linked or
 * registered. Non-zero so a store shared with an in-flight build on another
 * instance is not reclaimed out from under it mid-write.
 */
const DEFAULT_GC_GRACE_MS = 60_000;

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
  /** Build the `game.from` base-pack registry (Modrinth `.mrpack`; CurseForge next). */
  readonly baseRegistry?: () => BaseRegistry;
  /** Construct the HTTP client for Mojang / loader / game-CDN fetches. */
  readonly gameHttp?: () => Http;
  /** Mojang endpoint overrides (mirrors or offline fixtures). */
  readonly mojangOptions?: MojangApiOptions;
  /** Fabric/Quilt loader-meta base override. */
  readonly loaderMetaBase?: string;
  /** Forge/NeoForge maven + promotions endpoint overrides (mirrors / fixtures). */
  readonly forgeEndpoints?: ForgeEndpoints;
  /** Mojang asset-object CDN base override. */
  readonly resourcesBase?: string;
  /**
   * The JVM runner Forge/NeoForge installer processors replay through (Stage 9).
   * Defaults to {@link JvmProcessorRunner} (launches the pinned `java`, no
   * confinement — trust the source). A host app building from untrusted sources
   * injects a confining runner here; tests inject a hermetic fake.
   */
  readonly processorRunner?: () => ProcessorRunner;
  /**
   * The clock version control stamps commits with (ms). Display-only — history
   * order is by generation number, never wall-clock. Tests inject a controlled
   * (even backwards-running) clock through here to prove clock-skew safety.
   */
  readonly now?: () => number;
  /** The author label recorded on commits + reflog entries. Defaults to `"anvil"`. */
  readonly author?: string;
  /**
   * Hostname resolver for the untrusted-remote-lock DNS pre-vet (clone/pull).
   * Defaults to real DNS; tests inject a hermetic resolver here.
   */
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
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

/**
 * Whether the cached base set may be reused instead of re-resolving the pack.
 *
 * Same principle as `lockedPins` for items — a re-lock must not move a pin nobody
 * asked to move, and must not re-download several hundred megabytes to arrive
 * back where it started. Three conditions, each of which has a failure mode
 * behind it:
 *
 *  - the cache is for the base the manifest **currently** names (edit `from`,
 *    re-resolve);
 *  - the prior lock, when there is one, agrees with the cache on the archive pin
 *    (a cache that disagrees with the lock is stale or tampered — distrust it);
 *  - the game target is unchanged. This one is easy to miss: the cached members
 *    were selected for the Minecraft version the manifest declared *then*.
 *    Editing `game.minecraft` while leaving `game.from` alone must re-resolve, or
 *    the instance quietly keeps a base built for the version it left.
 */
function baseCacheUsable(
  manifest: Manifest,
  cached: CachedBase | undefined,
  prior: Lockfile | undefined,
  upgrade: boolean | ReadonlySet<string> | undefined,
): cached is CachedBase {
  const from = manifest.game.from;
  if (from === undefined || !cached || cached.ref !== from) {
    return false;
  }
  if (
    upgrade === true ||
    (upgrade instanceof Set && (upgrade.has(from) || upgrade.has(cached.pack.id)))
  ) {
    return false;
  }
  if (prior?.base && prior.base.archive.value !== cached.pack.archive.value) {
    return false;
  }
  if (cached.pack.game.minecraft !== manifest.game.minecraft) {
    return false;
  }
  const loaderName = (s: string): string => (s.trim().split(/\s+/)[0] ?? "vanilla").toLowerCase();
  return loaderName(cached.pack.game.loader) === loaderName(manifest.game.loader);
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

/**
 * The `.anvilexclude` a fresh `anvil init` scaffolds. The two files are easy to
 * confuse, so the template says it outright: **`.anvilignore` protects a path from
 * the build, `.anvilexclude` hides a path from version control.** The built-in
 * defaults are listed as comments so they are discoverable without reading source.
 */
const DEFAULT_ANVILEXCLUDE = `# .anvilexclude — paths version control must not record in a commit.
# .anvilignore protects a path from the BUILD; .anvilexclude hides it from COMMITS.
#
# Excluded already, whether or not this file exists:
#   the game install — assets/ libraries/ versions/ natives/ runtime/
#   runtime churn    — logs/ crash-reports/ screenshots/ backups/ debug/ .fabric/
#                      .mixin.out/ .cache/ server-resource-packs/
#   user-local data  — usercache.json usernamecache.json realms_persistence.json
#   OS + editor cruft, at any depth — .DS_Store Thumbs.db desktop.ini .directory
#                      *.swp *.swo *~
#   saves/, .anvil/, .anvilignore, and everything the lock says the build owns
#
# A line takes one of three forms. * is the only wildcard (no ? and no **), it
# never crosses a /, matching ignores case, and there is no negation:
#   *.log          a * and no / — a basename glob, matched at any depth
#   config/*.json  a * and a /  — matched against the whole path, segment by
#                                 segment, and everything under a match
#   notes/         no *         — a literal path, and everything under it
`;

/** The manifest-vs-lock-vs-built dirty state reported by {@link Anvil.status}. */
export interface StatusResult {
  /** An `anvil.toml` file is present on disk (whether or not it parses). */
  readonly hasManifest: boolean;
  /**
   * The manifest file is present but could not be parsed; the reason, when so.
   * Distinguishes a genuinely-absent manifest ("run `anvil init`") from a broken
   * one ("fix the manifest") — `status` never crashes on a malformed manifest.
   */
  readonly manifestError?: string;
  readonly hasLock: boolean;
  readonly hasBuilt: boolean;
  /** The manifest changed since the lock was written — a re-`lock` is due. */
  readonly manifestDirty: boolean;
  /** The lock differs from what the instance was built from — a `build` is due. */
  readonly buildDirty: boolean;
  /**
   * Tracked working-tree files differ from HEAD's commit — a `commit` is due.
   * `false` before the first commit (there is nothing to be dirty against) and
   * for an instance with no `.anvil/` history at all.
   */
  readonly worktreeDirty: boolean;
  /** A one-line, human-readable summary of the state. */
  readonly summary: string;
}

/** Result of a {@link Anvil.merge} — the item-set 3-way + constrained re-lock. */
export type MergeResult = MergeOutcome;

/** Result of a {@link Anvil.revert}. */
export type RevertResult = RevertOutcome;

/** Result of a {@link Anvil.rebase} (start / `--continue` / `--skip` / `--abort`). */
export type RebaseResult = RebaseOutcome;

/** Options for {@link Anvil.merge}. Non-interactive resolution of item conflicts. */
export interface MergeOptions {
  /** Auto-resolve every item conflict with this strategy. */
  readonly strategy?: ConflictStrategy;
  /** A per-conflict resolution callback (takes precedence over `strategy`). */
  readonly onConflict?: OnConflict;
}

/** Options for {@link Anvil.rebase}. Exactly one mode: onto / continue / skip / abort. */
export interface RebaseOptions {
  /** The ref to rebase the current branch onto (start a new rebase). */
  readonly onto?: string;
  /** Resume a paused rebase from the resolved working tree. */
  readonly continue?: boolean;
  /** Drop the current (conflicting) commit and continue. */
  readonly skip?: boolean;
  /** Abort, restoring `ORIG_HEAD` and the pre-rebase working tree. */
  readonly abort?: boolean;
  readonly strategy?: ConflictStrategy;
  readonly onConflict?: OnConflict;
}

/** Options for {@link Anvil.clone}. */
export interface CloneOptions {
  /** The remote name to record (default `origin`). */
  readonly name?: string;
  /** The branch/ref to track (default `main`). */
  readonly ref?: string;
  /** Force a remote kind instead of inferring it from the URL. */
  readonly kind?: RemoteKind;
}

/** Result of a {@link Anvil.clone}. */
export interface CloneResult {
  readonly dir: string;
  /** The commit HEAD was set to (`algo:value`). */
  readonly commit: string;
  readonly branch: string;
  /** Content objects transferred during the in-place build. */
  readonly objects: number;
}

/** Result of a {@link Anvil.pull}. */
export interface PullResult {
  /** Commits fast-forwarded past (0 when already up to date). */
  readonly fastForwarded: number;
  /** Content objects transferred (fetched, not deduped). */
  readonly objects: number;
  /** True when the local branch already contained the remote tip. */
  readonly upToDate: boolean;
  /** The `local/<ts>` branch local commits were stashed onto, on divergence. */
  readonly stashedTo?: string;
}

/** Result of a {@link Anvil.push}. */
export interface PushResult {
  /** The commit published (`algo:value`). */
  readonly commit: string;
  readonly branch: string;
  /** Copy content objects published (never a replay object). */
  readonly objects: number;
}

/** Result of a {@link Anvil.export}. */
export interface ExportResult {
  readonly path: string;
  /** `files[]` entries written (copy items with a rehostable URL). */
  readonly files: number;
  /** `overrides/` files written. */
  readonly overrides: number;
  /** CurseForge (replay) items omitted per the ToS. */
  readonly omitted: readonly string[];
  readonly warnings: readonly string[];
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

  /**
   * A resolved base pack, memoized for this `Anvil` by its `game.from` string.
   * A rebase re-locks once per replayed commit; without this, each step would
   * re-download the same pack.
   *
   * Keyed by the ref alone, so a manifest edited *between two locks on the same
   * object* still gets the memo. That is fine and fails closed: the resolver
   * re-checks the pack's game target against the manifest on every resolve, so an
   * edit to `game.minecraft` surfaces as a refused lock, never a stale base.
   */
  readonly #baseCache = new Map<string, ResolvedBasePack>();

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
    if (!(await pathExists(join(this.dir, EXCLUDE_FILE)))) {
      await writeFile(join(this.dir, EXCLUDE_FILE), DEFAULT_ANVILEXCLUDE);
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
        resolveBase: this.#baseResolver(manifest, store, offline, prior, upgrade, emit),
      });

      // The full game install (client + libraries + natives + assets + pinned JRE
      // + optional loader) — resolved here so the lock carries the whole instance.
      const game = await this.#resolveGamePackages(manifest, store, offline, prior, upgrade);
      const lock: Lockfile = {
        meta: { ...itemLock.meta, java: game.java, loader: game.loader },
        ...(itemLock.base ? { base: itemLock.base } : {}),
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

  /**
   * The `game.from` base-pack resolver handed to the resolver, or `undefined`
   * when this environment registers no base sources at all.
   *
   * Three behaviours, in precedence order:
   *
   *  1. **Reuse the prior lock's base** when the manifest still names the same
   *     `from`, under the same game target, and this is not an upgrade. Same
   *     principle as `lockedPins` for items: a re-lock must not silently move a
   *     pin nobody asked to move — and it must not re-download several hundred
   *     megabytes to arrive back where it started.
   *  2. **Offline** with no reusable prior base is a hard failure, not a silently
   *     base-less instance.
   *  3. Otherwise resolve the pack from its source, once per process per ref (a
   *     rebase re-locks per commit; re-fetching the pack each step is not
   *     something to make a user watch).
   */
  #baseResolver(
    manifest: Manifest,
    store: ContentStore,
    offline: boolean,
    prior: Lockfile | undefined,
    upgrade: boolean | ReadonlySet<string> | undefined,
    emit: (event: AnvilEvent) => void,
  ): (ref: ResolvedRef) => Promise<ResolvedBasePack> {
    const registry = this.#env.baseRegistry?.() ?? buildBaseRegistry();
    return async (ref: ResolvedRef): Promise<ResolvedBasePack> => {
      const from = manifest.game.from ?? "";
      const inProcess = this.#baseCache.get(from);
      if (inProcess) {
        return inProcess;
      }
      const cached = await readBaseCache(this.dir);
      if (baseCacheUsable(manifest, cached, prior, upgrade)) {
        this.#baseCache.set(from, cached.pack);
        return cached.pack;
      }
      if (offline) {
        throw new UnsatisfiableTarget(
          `game.from ${from}`.trim(),
          "offline: no usable cached base pack — run `lock` online first",
        );
      }
      const entry = registry.get(ref.source);
      if (!entry) {
        throw new ManifestError(
          `game.from "${from}": no base-pack source is registered for "${ref.source}"`,
        );
      }
      const pack = await entry.source.resolveBase(ref, {
        ...(entry.http ? { http: entry.http } : {}),
        now: Date.now(),
        allowSource: this.#options.allowSource ?? defaultAllowSource,
        store,
        instanceDir: this.dir,
        ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
        emit,
      });
      // Persist the FULL member set beside the lock's survivors, so the next
      // re-lock re-runs the overlay against what the pack actually ships. See
      // `base/cache.ts` for why the lock alone cannot answer that.
      await writeBaseCache(this.dir, { ref: from, pack, set: baseSetDigest(pack.members) });
      this.#baseCache.set(from, pack);
      return pack;
    };
  }

  /** A per-endpoint-group rate-limited HTTP client for the game installer. */
  #gameHttp(): Http {
    return this.#env.gameHttp?.() ?? new RateLimitedHttp({ userAgent: USER_AGENT });
  }

  /**
   * The JVM runner Forge/NeoForge installer processors replay through. Defaults to
   * {@link JvmProcessorRunner}, which launches the build's pinned `java` (no
   * confinement — trust the source you build). A host app building from untrusted
   * sources injects a confining runner; a test injects a hermetic fake.
   */
  #processorRunner(): ProcessorRunner {
    return this.#env.processorRunner?.() ?? new JvmProcessorRunner();
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
      ...(this.#env.forgeEndpoints ? { forgeEndpoints: this.#env.forgeEndpoints } : {}),
      ...(this.#options.allowProcessor ? { allowProcessor: this.#options.allowProcessor } : {}),
    });
    return { packages: game.packages, java: game.java, loader: game.loader };
  }

  /**
   * The build acquirer. `provenance: "replay"` (CurseForge) items ALWAYS route
   * to the {@link ReplayAcquirer} — which fetches per-client into the instance
   * replay cache, never the shared store — regardless of offline. Everything
   * else: offline → store-only; else a router that fetches game bytes from the
   * Mojang/loader CDNs (via {@link GameAcquirer}) and copy items from their
   * sources (via {@link NetworkAcquirer}).
   */
  #buildAcquirer(
    store: ContentStore,
    replayCache: ReplayCache,
    offline: boolean,
    emit: (event: AnvilEvent) => void,
  ): Acquirer {
    const registry = this.#registry();
    const cfHttp = registry.get("curseforge")?.http;
    const replay = new ReplayAcquirer({
      replayCache,
      ...(cfHttp ? { http: cfHttp } : {}),
      ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
      offline,
      emit,
    });
    const base: Acquirer = offline
      ? new StoreOnlyAcquirer(store, emit)
      : this.#onlineCopyAcquirer(store, registry, emit);
    return {
      ensure: (pkg: LockPackage) =>
        pkg.provenance === "replay" ? replay.ensure(pkg) : base.ensure(pkg),
    };
  }

  /** The online copy/game router (Mojang/loader CDNs + copy sources). */
  #onlineCopyAcquirer(
    store: ContentStore,
    registry: SourceRegistry,
    emit: (event: AnvilEvent) => void,
  ): Acquirer {
    const network = new NetworkAcquirer({
      store,
      registry,
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
      const paths = await resolvePaths(this.dir, this.#options);
      // The per-instance process lock (`.anvil/lock`) serializes mutating ops on
      // this instance, so two concurrent builds (or a build racing a pull) can
      // never interleave the atomic swap or the VC ref database.
      const result = await withLock(instanceLockPath(this.dir), async () => {
        await recoverSwap(this.dir);
        const store = new ContentStore({ root: paths.store });
        const lock = await readInputLock(this.dir);
        const previousLock = await readBuiltLock(this.dir);
        const offline = options?.offline ?? this.#options.offline ?? false;
        // The per-instance replay cache — where CurseForge (replay) bytes are
        // materialized from. Physically separate from the shared store so the
        // store-serve / GC / transfer / export code cannot enumerate CF bytes.
        const replayCache = new ReplayCache({ instanceDir: this.dir });
        const acquire = this.#buildAcquirer(store, replayCache, offline, emit);
        const result = await buildInstance({
          instanceDir: this.dir,
          lock,
          store,
          acquire,
          replayCache,
          platform: currentPlatform(),
          previousLock,
          // The processor runner (+ host allowProcessor policy) for a Forge/NeoForge
          // lock; harmless for any other build.
          processorRunner: this.#processorRunner(),
          ...(this.#options.allowProcessor ? { allowProcessor: this.#options.allowProcessor } : {}),
          // Honor a mapped `[paths].assets` shared pool; absent → the instance's
          // own `assets/` is materialized self-contained (index + objects).
          ...(paths.assets ? { assetsDir: paths.assets } : {}),
          emit,
        });
        return { dir: result.dir, objects: result.objects };
      });
      // Register/refresh this instance in the shared-store instance registry so a
      // `gc` run from ANY instance sharing this store unions our built-lock roots
      // and never reclaims an object we still reference. Done as a SEPARATE store-
      // lock critical section (NOT nested inside the instance lock) so it can never
      // deadlock against `gc`, which takes the store lock and then the instance lock.
      await this.#registerInstance(paths.store);
      return result;
    } catch (err) {
      if (err instanceof AnvilError) {
        emit({ type: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /**
   * Record (or refresh) this instance in the shared-store instance registry — the
   * cross-instance GC root map. Keyed by the instance's absolute directory. A
   * future `destroy`/`uninstall` command (not yet implemented) should DEREGISTER
   * here via `removeInstance` so an intentionally-deleted instance stops rooting
   * objects immediately; until then a deleted instance is pruned lazily by `gc`
   * (its dir no longer exists). A registry that is present but unreadable is left
   * untouched — clobbering it would silently drop other instances' roots, and `gc`
   * already refuses to sweep against a corrupt registry.
   */
  async #registerInstance(storeRoot: string): Promise<void> {
    const built = await readBuiltLock(this.dir);
    if (!built) {
      return; // nothing built to protect — no roots to register
    }
    const dir = resolve(this.dir);
    const builtLockHash = `sha256:${hashBuffer(new TextEncoder().encode(canonicalJson(built)), "sha256").value}`;
    const now = (this.#env.now ?? (() => Date.now()))();
    await ensureDir(storeRoot);
    await withLock(storeLockPath(storeRoot), async () => {
      let registry: Awaited<ReturnType<typeof readInstanceRegistry>>;
      try {
        registry = await readInstanceRegistry(storeRoot);
      } catch (err) {
        if (err instanceof StoreRegistryCorrupt) {
          return; // never clobber a corrupt registry — `gc` will refuse until fixed
        }
        throw err;
      }
      await writeInstanceRegistry(
        storeRoot,
        upsertInstance(registry, dir, { builtLockHash, updatedAt: now }),
      );
    });
  }

  /**
   * `anvil verify` — check the materialized instance matches the lock it was
   * built from. Re-hashes every single-file `link` target against its pin, and
   * for every `asset-tree` re-hashes both the index file AND every object it
   * names under `assets/objects/` — so an instance whose `assets/objects/` is
   * empty or incomplete FAILS (it is not the launch-ready `.minecraft` the lock
   * describes). With `strict`, additionally fails if the instance has drifted
   * from the current input lock (i.e. a `build` is due).
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
      const placement = pkg.placement;
      let ok: boolean;
      if (placement.method === "asset-tree") {
        ok = await this.#hashMatches(placement.indexTarget, pkg.hash);
        // The index alone is not the instance — every object it references must
        // also be materialized + hash-correct, or the folder won't launch.
        if (ok && (await this.#unmaterializedAssets(placement.indexTarget)) > 0) {
          ok = false;
        }
      } else if (placement.method === "link") {
        ok = await this.#hashMatches(placement.target, pkg.hash);
      } else {
        continue; // filtered to link | asset-tree above — unreachable
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

  /** True when the instance file at `rel` re-hashes to `expected` (missing → false). */
  async #hashMatches(rel: string, expected: Hash): Promise<boolean> {
    try {
      const actual = await hashFile(join(this.dir, rel), expected.algo);
      return actual.value === expected.value;
    } catch {
      return false;
    }
  }

  /**
   * Count the objects an asset index names that are missing or hash-wrong under
   * the instance's `assets/objects/` — i.e. how far the instance is from being a
   * complete assets dir. `0` means every indexed object is materialized and
   * correct; anything above `0` is a launch-blocking gap `verify` must report.
   * The objects dir is derived from the index target (`…/indexes/<id>.json` →
   * `…/objects/<xx>/<sha1>`), so it follows a mapped-assets symlink transparently.
   */
  async #unmaterializedAssets(indexTarget: string): Promise<number> {
    let objects: Record<string, { hash: string }>;
    try {
      const raw = await readFile(join(this.dir, indexTarget), "utf8");
      objects = (JSON.parse(raw) as { objects?: Record<string, { hash: string }> }).objects ?? {};
    } catch {
      return 1; // an unreadable/corrupt index is itself a failure
    }
    const assetsBase = indexTarget.split("/").slice(0, -2); // drop `indexes/<id>.json`
    let missing = 0;
    for (const { hash } of Object.values(objects)) {
      const rel = [...assetsBase, "objects", hash.slice(0, 2), hash].join("/");
      if (!(await this.#hashMatches(rel, { algo: "sha1", value: hash }))) {
        missing += 1;
      }
    }
    return missing;
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
   * Whether the tracked working-tree files differ from the ones HEAD's commit
   * recorded. **A read, not a write**: it hashes candidates to compare blob ids
   * and never admits an object, so `status` cannot mutate history. An unborn HEAD
   * — or no `.anvil/` at all — reports clean, since there is nothing to differ
   * from. Offline; it needs only the VC object store and the refs.
   */
  async #worktreeDirty(lock: Lockfile | undefined): Promise<boolean> {
    const anvilDir = join(this.dir, ".anvil");
    const vcStore = new VcObjectStore({ anvilDir });
    // Only the history lookup is tolerant: an instance with no `.anvil/`, an unborn
    // HEAD, or an object database that will not read has nothing to be dirty
    // against, and `status` never crashes on one. The WALK is deliberately outside
    // this guard — a directory it cannot read would otherwise report "clean", which
    // is the same lie as a commit silently recording a deletion.
    let committed: Map<string, string>;
    try {
      const head = await new Refs(anvilDir).resolveHead();
      if (!head) {
        return false;
      }
      const snapshot = await vcStore.getSnapshot((await vcStore.getCommit(head)).snapshot);
      committed = new Map(snapshot.tracked.map((t) => [t.path, t.blob.value]));
    } catch {
      return false;
    }
    const tracked = await trackWorktree({
      instanceDir: this.dir,
      vcStore,
      exclude: await snapshotExclusion(this.dir, lock),
      store: false,
      // The same veto `commit` applies, or `status` reports a tree dirty over a
      // file no commit will ever record.
      replayVeto: await ReplayVeto.load(this.dir),
    });
    return (
      tracked.length !== committed.size ||
      tracked.some((t) => committed.get(t.path) !== t.blob.value)
    );
  }

  /**
   * `anvil status` — the manifest-vs-lock-vs-built dirty state: whether the
   * manifest has changed since the lock (a re-`lock` is due), whether the lock has
   * changed since the last build (a `build` is due), and whether the tracked
   * working-tree files have changed since HEAD (a `commit` is due). Offline.
   */
  async status(): Promise<StatusResult> {
    // Distinguish a truly-absent manifest from one that is present but won't
    // parse: probe presence first, then attempt the parse and capture (never
    // throw) its reason. A broken manifest must not crash `status`.
    const manifestPresent = await pathExists(join(this.dir, MANIFEST_FILENAME));
    let manifest: Manifest | undefined;
    let manifestError: string | undefined;
    if (manifestPresent) {
      try {
        manifest = await readManifest(this.dir);
      } catch (err) {
        manifestError =
          err instanceof AnvilError ? err.message : String((err as Error)?.message ?? err);
      }
    }
    const input = await readLockIfPresent(this.dir);
    const built = await readBuiltLock(this.dir);
    let manifestDirty = false;
    if (manifest && input) {
      const mh = hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256");
      manifestDirty = mh.value !== input.meta.manifestHash.value;
    }
    const buildDirty = input ? this.#buildDirty(input, built) : false;
    const worktreeDirty = await this.#worktreeDirty(input);
    let summary: string;
    if (!manifestPresent) {
      summary = "no anvil.toml — run `anvil init`";
    } else if (manifestError) {
      // Strip the parser's own "could not parse anvil.toml:" prefix and keep only
      // the first line so the one summary line reads cleanly (the TOML parser
      // appends a multi-line source snippet; the full detail is shown by `lock`).
      const reason = (
        manifestError.replace(/^could not parse anvil\.toml:\s*/i, "").split("\n")[0] ?? ""
      ).trim();
      summary = `anvil.toml present but could not be parsed: ${reason} — fix the manifest`;
    } else if (!input) {
      summary = "not locked — run `anvil lock`";
    } else if (manifestDirty) {
      summary = "manifest changed since lock — run `anvil lock`";
    } else if (!built) {
      summary = "locked but never built — run `anvil build`";
    } else if (buildDirty) {
      summary = "lock changed since build — run `anvil build`";
    } else if (worktreeDirty) {
      summary = "working tree changed since the last commit — run `anvil commit`";
    } else {
      summary = "clean — manifest, lock, and instance are in sync";
    }
    return {
      hasManifest: manifestPresent,
      ...(manifestError ? { manifestError } : {}),
      hasLock: input !== undefined,
      hasBuilt: built !== undefined,
      manifestDirty,
      buildDirty,
      worktreeDirty,
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

  // --- version control (anvil-native VCS over the item set) ----------------

  /** Emit an `error` event for a surfaced {@link AnvilError}, then rethrow. */
  async #withErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AnvilError) {
        this.progress.emit({ type: "error", code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /**
   * Construct the {@link VcRepo} for this instance: the `.anvil/` object + ref
   * database, plus the **constrained pin-preserving re-lock** wired to the Stage-2
   * resolver. Merge/rebase never merge two derived locks — they merge the item set
   * and re-derive the lock here, reusing every untouched pin verbatim and forcing
   * only the game-cascade items back through resolution.
   */
  async #vc(): Promise<VcRepo> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    const registry = this.#registry();
    const allowSource = this.#options.allowSource ?? defaultAllowSource;
    const nowFn = this.#env.now ?? (() => Date.now());
    const anvilDir = join(this.dir, ".anvil");
    const vcStore = new VcObjectStore({ anvilDir });
    const relock: RelockFn = async (req) => {
      const prior = await readLockIfPresent(this.dir);
      const itemLock = await resolveManifest({
        manifest: req.manifest,
        registry,
        allowSource,
        now: nowFn(),
        baseDir: this.dir,
        offline: false,
        store,
        ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
        lockedPins: req.seedPins,
        ...(req.reResolveKeys.size > 0 ? { upgrade: req.reResolveKeys } : {}),
        // A merged/rebased manifest can carry `game.from`; without this the
        // re-lock would refuse it, and every VC operation on a base-derived
        // instance would fail.
        resolveBase: this.#baseResolver(req.manifest, store, false, prior, undefined, (event) => {
          this.progress.emit(event);
        }),
      });
      return {
        meta: {
          ...itemLock.meta,
          minecraft: req.gameMeta.minecraft,
          loader: req.gameMeta.loader,
          java: req.gameMeta.java,
        },
        ...(itemLock.base ? { base: itemLock.base } : {}),
        resolved: [...itemLock.resolved, ...req.gamePackages].sort(comparePackages),
      };
    };
    return new VcRepo({
      instanceDir: this.dir,
      anvilDir,
      sharedStore: store,
      vcStore,
      relock,
      author: this.#env.author ?? "anvil",
      now: nowFn,
      // A refusal to record (or to materialize) a file is otherwise invisible:
      // the file is simply absent from the commit, which reads as a bug.
      onWarn: (message: string) => this.progress.emit({ type: "warning", message }),
    });
  }

  /**
   * Run a **mutating** operation under the per-instance process lock, so a VC write
   * (commit / branch / switch / merge / revert / rebase) can never interleave with a
   * concurrent build / pull / gc on the same instance's ref database + working tree.
   */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(instanceLockPath(this.dir), fn);
  }

  /**
   * `anvil commit` — snapshot the tracked working tree (manifest + lock + ignore +
   * the carried local-blob closure) into history, advancing HEAD's branch. Refuses
   * when the lock is stale relative to the manifest (the manifest is the index).
   */
  async commit(message: string): Promise<CommitRef> {
    return this.#withErrors(() => this.#locked(async () => (await this.#vc()).commit(message)));
  }

  /** `anvil branch` — create a branch at HEAD (does not switch to it). */
  async branch(name: string): Promise<CommitRef> {
    return this.#withErrors(() => this.#locked(async () => (await this.#vc()).branch(name)));
  }

  /**
   * `anvil switch` — move the working tree + HEAD to a branch / tag / commit,
   * materializing the tracked files by hash-diff. Refuses on a dirty working tree;
   * `saves/` and the build product are never touched.
   */
  async switch(ref: string): Promise<CommitRef> {
    return this.#withErrors(() => this.#locked(async () => (await this.#vc()).switchTo(ref)));
  }

  /** `anvil log` — history reachable from `start` (default HEAD), newest-first by generation. */
  async log(start?: string): Promise<LogEntry[]> {
    // Read-only — no instance lock needed.
    return this.#withErrors(async () => (await this.#vc()).log(start));
  }

  /**
   * `anvil merge` — a 3-way merge of `branch`'s item set into HEAD keyed by stable
   * identity, then a constrained pin-preserving re-lock. A phase-1 item conflict or
   * a phase-2 secondary (e.g. an `@game` bump orphaning a mod → `no-compatible-version`)
   * aborts without committing.
   */
  async merge(branch: string, options?: MergeOptions): Promise<MergeResult> {
    return this.#withErrors(() =>
      this.#locked(async () => (await this.#vc()).merge(branch, options ?? {})),
    );
  }

  /** `anvil revert` — a new commit that undoes a past commit's item-delta, then re-locks. */
  async revert(ref: string): Promise<RevertResult> {
    return this.#withErrors(() => this.#locked(async () => (await this.#vc()).revert(ref)));
  }

  /**
   * `anvil rebase` — replay the current branch's commits onto another ref, one
   * item-delta + per-step re-lock at a time, crash-survivable via `REBASE_STATE`.
   * Modes: `onto` (start), `continue`, `skip`, `abort` (restore `ORIG_HEAD`).
   */
  async rebase(options: RebaseOptions): Promise<RebaseResult> {
    return this.#withErrors(() =>
      this.#locked(async () => {
        const vc = await this.#vc();
        const policy = {
          ...(options.strategy ? { strategy: options.strategy } : {}),
          ...(options.onConflict ? { onConflict: options.onConflict } : {}),
        };
        if (options.abort) {
          return vc.rebaseAbort();
        }
        if (options.continue) {
          return vc.rebaseContinue(policy);
        }
        if (options.skip) {
          return vc.rebaseSkip(policy);
        }
        if (!options.onto) {
          throw new VcStateError("rebase needs an `onto` ref (or --continue / --skip / --abort)");
        }
        return vc.rebase(options.onto, policy);
      }),
    );
  }

  // --- remotes (clone / pull / push) --------------------------------------

  /** An HTTP client for http(s) served-tree remotes + room reads (SSRF-guarded). */
  #remoteHttp(): Http {
    return this.#env.gameHttp?.() ?? new RateLimitedHttp({ userAgent: USER_AGENT });
  }

  /** Construct the per-instance stores + the transport for a remote descriptor. */
  async #remoteContext(descriptor: RemoteDescriptor): Promise<{
    store: ContentStore;
    replayCache: ReplayCache;
    vcStore: VcObjectStore;
    refs: Refs;
    transport: ReturnType<typeof makeTransport>;
  }> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    const replayCache = new ReplayCache({ instanceDir: this.dir });
    const anvilDir = join(this.dir, ".anvil");
    const vcStore = new VcObjectStore({ anvilDir });
    const refs = new Refs(anvilDir);
    const transport = makeTransport(descriptor, {
      http: this.#remoteHttp(),
      clonesDir: join(anvilDir, "remotes"),
      gitAuthor: { name: this.#env.author ?? "anvil", email: "anvil@lobbify.games" },
    });
    return { store, replayCache, vcStore, refs, transport };
  }

  /**
   * The `clone`/`pull` build step: materialize the just-fast-forwarded lock,
   * fetching only the changed objects through the {@link RemotePullAcquirer}
   * (local store → remote endpoint → source). Replay items are re-fetched
   * per-client (never transferred); the incremental delta keeps unchanged objects
   * linked.
   */
  #syncRunBuild(
    store: ContentStore,
    replayCache: ReplayCache,
    transport: ReturnType<typeof makeTransport>,
  ): RunBuild {
    return async ({ previousLock, emit }): Promise<BuildEngineResult> => {
      const lock = await readInputLock(this.dir);
      const base = this.#buildAcquirer(store, replayCache, false, emit);
      const acquire = new RemotePullAcquirer({ base, transport, store, emit });
      return buildInstance({
        instanceDir: this.dir,
        lock,
        store,
        acquire,
        replayCache,
        platform: currentPlatform(),
        processorRunner: this.#processorRunner(),
        ...(this.#options.allowProcessor ? { allowProcessor: this.#options.allowProcessor } : {}),
        ...(previousLock ? { previousLock } : {}),
        emit,
      });
    };
  }

  /** The shared source-policy / clock / author for a sync op. */
  #syncPrincipals(): {
    allowSource: NonNullable<AnvilOptions["allowSource"]>;
    author: string;
    now: () => number;
  } {
    return {
      allowSource: this.#options.allowSource ?? defaultAllowSource,
      author: this.#env.author ?? "anvil",
      now: this.#env.now ?? (() => Date.now()),
    };
  }

  /**
   * `anvil clone` — create an instance from a remote and build it in place. The
   * remote's (untrusted) lock is vetoed through `allowSource` before any transfer;
   * the `.anvil/` history (or a single initial commit) is set up, then the pack is
   * built with objects fetched from the remote endpoint or re-fetched from source.
   */
  async clone(url: string, options?: CloneOptions): Promise<CloneResult> {
    const emit = (event: AnvilEvent): void => this.progress.emit(event);
    return this.#withErrors(() =>
      withLock(instanceLockPath(this.dir), async () => {
        if (await pathExists(join(this.dir, MANIFEST_FILENAME))) {
          throw new ManifestError(
            `"${this.dir}" already contains an ${MANIFEST_FILENAME} — clone into an empty directory`,
          );
        }
        const descriptor = makeDescriptor(options?.name ?? "origin", url, {
          ...(options?.ref ? { ref: options.ref } : {}),
          ...(options?.kind ? { kind: options.kind } : {}),
        });
        const ctx = await this.#remoteContext(descriptor);
        const principals = this.#syncPrincipals();
        const outcome: CloneOutcome = await cloneInstance({
          descriptor,
          transport: ctx.transport,
          instanceDir: this.dir,
          vcStore: ctx.vcStore,
          refs: ctx.refs,
          sharedStore: ctx.store,
          ...principals,
          ...(this.#env.resolveHost ? { resolveHost: this.#env.resolveHost } : {}),
          runBuild: this.#syncRunBuild(ctx.store, ctx.replayCache, ctx.transport),
          ...(options?.ref ? { ref: options.ref } : {}),
          emit,
        });
        return {
          dir: outcome.dir,
          commit: `${outcome.commit.algo}:${outcome.commit.value}`,
          branch: outcome.branch,
          objects: outcome.objects,
        };
      }),
    );
  }

  /**
   * `anvil pull` — content-addressed fast-forward to a remote's latest. Joiners
   * only ever fast-forward; on divergence local commits are preserved on a
   * `local/<ts>` branch and the pack is fast-forwarded to the remote tip
   * (`saves/` untouched). Only the changed objects transfer.
   */
  async pull(remote?: string): Promise<PullResult> {
    const emit = (event: AnvilEvent): void => this.progress.emit(event);
    return this.#withErrors(async () => {
      const descriptor = await resolveRemote(this.dir, remote);
      if (!descriptor) {
        throw new RemoteNotFound(remote ?? "origin");
      }
      return withLock(instanceLockPath(this.dir), async () => {
        const ctx = await this.#remoteContext(descriptor);
        const principals = this.#syncPrincipals();
        const outcome: PullOutcome = await pullInstance({
          descriptor,
          transport: ctx.transport,
          instanceDir: this.dir,
          vcStore: ctx.vcStore,
          refs: ctx.refs,
          sharedStore: ctx.store,
          ...principals,
          ...(this.#env.resolveHost ? { resolveHost: this.#env.resolveHost } : {}),
          runBuild: this.#syncRunBuild(ctx.store, ctx.replayCache, ctx.transport),
          emit,
        });
        return {
          fastForwarded: outcome.fastForwarded,
          objects: outcome.objects,
          upToDate: outcome.upToDate,
          ...(outcome.stashedTo ? { stashedTo: outcome.stashedTo } : {}),
        };
      });
    });
  }

  /**
   * `anvil push` — publish the current branch to a writable remote (git remote or
   * a writable directory; a static `url` is read-only). Transfers the two files +
   * VC history + **copy-only** content objects; replay rows are skipped and the
   * replay cache is never read.
   */
  async push(remote?: string): Promise<PushResult> {
    const emit = (event: AnvilEvent): void => this.progress.emit(event);
    return this.#withErrors(async () => {
      const descriptor = await resolveRemote(this.dir, remote);
      if (!descriptor) {
        throw new RemoteNotFound(remote ?? "origin");
      }
      return withLock(instanceLockPath(this.dir), async () => {
        const ctx = await this.#remoteContext(descriptor);
        const principals = this.#syncPrincipals();
        const outcome: PushOutcome = await pushInstance({
          descriptor,
          transport: ctx.transport,
          instanceDir: this.dir,
          vcStore: ctx.vcStore,
          refs: ctx.refs,
          sharedStore: ctx.store,
          ...principals,
          // push never builds; a stub satisfies the shared deps shape.
          runBuild: async () => {
            throw new VcStateError("internal: push does not build");
          },
          emit,
        });
        return {
          commit: `${outcome.commit.algo}:${outcome.commit.value}`,
          branch: outcome.branch,
          objects: outcome.objects,
        };
      });
    });
  }

  /** `anvil remote list` — the configured remotes for this instance. */
  async remotes(): Promise<readonly RemoteDescriptor[]> {
    return listRemotes(this.dir);
  }

  /** `anvil remote add` — record a remote in `.anvil/config.toml`. */
  async addRemote(
    name: string,
    url: string,
    options?: { ref?: string; kind?: RemoteKind },
  ): Promise<RemoteDescriptor> {
    const descriptor = makeDescriptor(name, url, {
      ...(options?.ref ? { ref: options.ref } : {}),
      ...(options?.kind ? { kind: options.kind } : {}),
    });
    await addRemoteToConfig(this.dir, descriptor);
    return descriptor;
  }

  /** `anvil remote remove` — drop a remote from `.anvil/config.toml`. */
  async removeRemote(name: string): Promise<boolean> {
    return removeRemoteFromConfig(this.dir, name);
  }

  // --- import / export (docker load/save) ---------------------------------

  /** The game-install resolver an importer uses for the pack's `[game]` deps. */
  #importGameResolver(store: ContentStore) {
    return async ({ minecraft, loader }: { minecraft: string; loader: string }) => {
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
    };
  }

  /**
   * `anvil import` — adopt a modpack into this instance, writing `anvil.toml` +
   * a pre-resolved `anvil.lock`. Auto-detects the format:
   *
   *   - a `.mrpack` (Modrinth) — files copied + sha-verified, server-only filtered;
   *   - a **CurseForge** zip (`manifest.json`) — its `files[]` become **replay**
   *     items (pinned under the BYO key; never re-hosted), `overrides/` copied.
   *
   * The archive is untrusted: `overrides/` unpack through the hardened extractor,
   * nothing lands in a protected path, and CurseForge bytes never enter the shared
   * store. (Prism import lands in Stage 7.)
   */
  async import(archive: string): Promise<ImportSummary> {
    const emit = (event: AnvilEvent): void => {
      this.progress.emit(event);
    };
    try {
      const paths = await resolvePaths(this.dir, this.#options);
      const store = new ContentStore({ root: paths.store });
      const registry = this.#registry();

      // A directory input is a Prism/MultiMC instance → re-identify its jars.
      const st = await stat(archive).catch(() => undefined);
      if (st?.isDirectory()) {
        const mrHttp = registry.get("modrinth")?.http ?? this.#gameHttp();
        const cfEntry = registry.get("curseforge");
        const modrinthApi = new ModrinthApi(mrHttp);
        const curseforgeApi =
          cfEntry?.http && this.#options.curseforgeKey
            ? new CurseForgeApi(cfEntry.http, this.#options.curseforgeKey)
            : undefined;
        const identify = new ApiIdentityResolver(modrinthApi, curseforgeApi);
        const result = await importPrism({
          prismDir: archive,
          instanceDir: this.dir,
          store,
          resolveGame: this.#importGameResolver(store),
          identify,
          emit,
        });
        return {
          files: result.modrinth + result.curseforge,
          overrides: result.local,
          warnings: result.warnings,
        };
      }

      // Peek at the archive to route: Modrinth (.mrpack) vs CurseForge zip.
      const archiveBytes = new Uint8Array(await readFile(archive));
      const isMrpack = (await readZipEntry(archiveBytes, "modrinth.index.json")) !== undefined;
      const isCfZip =
        !isMrpack && (await readZipEntry(archiveBytes, "manifest.json")) !== undefined;

      if (isCfZip) {
        const cfHttp = registry.get("curseforge")?.http ?? this.#gameHttp();
        const result = await importCurseForgeZip({
          archivePath: archive,
          instanceDir: this.dir,
          store,
          curseforgeHttp: cfHttp,
          ...(this.#options.curseforgeKey ? { curseforgeKey: this.#options.curseforgeKey } : {}),
          resolveGame: this.#importGameResolver(store),
          allowSource: this.#options.allowSource ?? defaultAllowSource,
          emit,
        });
        return { files: result.files, overrides: result.overrides, warnings: result.warnings };
      }

      const fileHttp = registry.get("url")?.http ?? this.#gameHttp();
      const result = await importMrpack({
        archivePath: archive,
        instanceDir: this.dir,
        store,
        fileHttp,
        resolveGame: this.#importGameResolver(store),
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

  /**
   * `anvil export` — write an `.mrpack` from the built instance. Copy items with a
   * rehostable URL become `files[]`, local items become `overrides/`, and
   * **CurseForge replay items are omitted with a clear warning** (the ToS forbids
   * re-hosting their bytes). The exporter reads only the shared store — it never
   * opens the replay cache.
   */
  async export(target: string): Promise<ExportResult> {
    const emit = (event: AnvilEvent): void => this.progress.emit(event);
    return this.#withErrors(async () => {
      const paths = await resolvePaths(this.dir, this.#options);
      const store = new ContentStore({ root: paths.store });
      const manifest = await readManifest(this.dir);
      const built = await readBuiltLock(this.dir);
      const lock = built ?? (await readInputLock(this.dir));
      const result = await exportMrpack({ manifest, lock, store, targetPath: target, emit });
      return {
        path: result.path,
        files: result.files,
        overrides: result.overrides,
        omitted: result.omitted,
        warnings: result.warnings,
      };
    });
  }

  // --- store maintenance (git gc / fsck) ----------------------------------

  /**
   * `anvil store gc` — mark-sweep unreachable objects from **both** object stores:
   *
   *   - the per-instance **VC object store** (`.anvil/objects/`): kept objects are
   *     the full ref-closure — every branch/tag/remote ref, `HEAD`/`ORIG_HEAD`/
   *     `MERGE_HEAD`, every reflog entry, and any in-progress `REBASE_STATE` — each
   *     expanded through its snapshot to the manifest/lock/ignore blobs **and the
   *     carried local blobs**, so switching to an old commit after a GC never hits
   *     a missing object;
   *   - the shared **content store**: the default store (`~/.anvil/store`) is SHARED
   *     across every instance on the machine, so the sweep roots at the **union of
   *     every registered instance's built lock** — read from the store-level
   *     instance registry (`<storeRoot>/instances.toml`) — plus this instance's
   *     reachable-commit locks and carried local content. A sweep in instance A can
   *     therefore never reclaim an object instance B's built lock still references.
   *
   * Safety: entries whose instance directory no longer exists are pruned (their
   * objects stop being rooted and become collectable); a registry that is present
   * but unreadable/corrupt makes GC **refuse to sweep** (a typed
   * `STORE_REGISTRY_CORRUPT`) rather than run with an under-counted root set. A
   * non-zero grace window ({@link DEFAULT_GC_GRACE_MS}) is a secondary guard against
   * reclaiming bytes a concurrent build just wrote but has not yet registered.
   */
  async gc(): Promise<GcResult> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    // The shared-store write lock serializes the destructive mark-sweep against a
    // concurrent GC and against a build's end-of-build registration (which also
    // takes the store lock); the per-instance lock keeps the VC prune consistent
    // with a concurrent build/pull on this instance.
    await ensureDir(paths.store);
    return this.#withErrors(() =>
      withLock(storeLockPath(paths.store), () =>
        withLock(instanceLockPath(this.dir), async () => {
          const anvilDir = join(this.dir, ".anvil");
          const vcStore = new VcObjectStore({ anvilDir });
          const refs = new Refs(anvilDir);

          // Read the instance registry FIRST, before ANY deletion (the VC prune or
          // the shared sweep). A corrupt/unreadable registry throws here so GC
          // refuses entirely rather than run with an under-counted cross-instance
          // root set and delete an object a live instance still references.
          const registry = await readInstanceRegistry(paths.store);

          // 1. VC object store: keep the full ref/reflog/in-progress closure + carried.
          const reach = await vcReachability(refs, vcStore, anvilDir);
          const vcPruned = await vcStore.prune(reach.keep);

          // 2. Shared store roots.
          const roots: Hash[] = [];

          // 2a. This instance's own built lock is always a root (belt-and-braces,
          //     even if a stale registry has not yet caught up to this instance).
          const built = await readBuiltLock(this.dir);
          if (built) {
            roots.push(...(await collectRoots(built, store)));
          }

          // 2b. The cross-instance union: root every OTHER registered instance's
          //     built lock; drop entries whose dir no longer exists (stale). A
          //     registered instance whose built lock is present-but-unparseable
          //     re-throws (readBuiltLockStrict) → refuse rather than under-root.
          const selfDir = resolve(this.dir);
          const survivors: InstanceRegistryEntry[] = [];
          let prunedStale = false;
          for (const entry of registry.instances) {
            if (entry.dir === selfDir) {
              continue; // refreshed from live state below
            }
            if (!(await pathExists(entry.dir))) {
              prunedStale = true; // stale: instance deleted → stop rooting it
              continue;
            }
            survivors.push(entry);
            const otherBuilt = await readBuiltLockStrict(entry.dir);
            if (otherBuilt) {
              roots.push(...(await collectRoots(otherBuilt, store)));
            }
          }

          // Persist a pruned + self-healed registry when the dir-set changed (a
          // stale entry dropped, or this instance was not yet registered), so
          // stale entries don't accumulate and a pre-registry build self-heals.
          const selfPresent = registry.instances.some((e) => e.dir === selfDir);
          if (prunedStale || (built && !selfPresent)) {
            const reconciled: InstanceRegistryEntry[] = built
              ? [
                  ...survivors,
                  {
                    dir: selfDir,
                    builtLockHash: `sha256:${hashBuffer(new TextEncoder().encode(canonicalJson(built)), "sha256").value}`,
                    updatedAt: (this.#env.now ?? (() => Date.now()))(),
                  },
                ]
              : survivors;
            await writeInstanceRegistry(paths.store, { version: 1, instances: reconciled });
          }

          // 2c. Reachable-commit locks + carried content (per-instance history).
          for (const lock of reach.commitLocks) {
            roots.push(...(await collectRoots(lock, store)));
          }
          roots.push(...reach.carriedContent);

          const result = await store.gc(roots, { graceMs: DEFAULT_GC_GRACE_MS });

          return {
            removed: result.removed + vcPruned.removed,
            freedBytes: result.freedBytes + vcPruned.freedBytes,
          };
        }),
      ),
    );
  }

  /** `anvil fsck` — re-hash every stored object and report content-address drift. */
  async fsck(): Promise<FsckResult> {
    const paths = await resolvePaths(this.dir, this.#options);
    const store = new ContentStore({ root: paths.store });
    const result = await store.fsck();
    return { ok: result.ok, problems: result.problems };
  }
}
