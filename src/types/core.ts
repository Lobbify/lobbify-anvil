/**
 * The core type vocabulary — the contract every later stage implements against.
 *
 * These types are the spine of the whole design. The single most load-bearing
 * rule lives here: a hash is **always** a {@link Hash} `{algo, value}` — never a
 * bare string. The store is domain-partitioned (sha1 for the Mojang asset
 * domain, sha256 for everything anvil owns), so an algorithm-tagged hash is the
 * only safe currency.
 */

/** The two hash algorithms in play: sha256 canonical, sha1 for Mojang assets. */
export type HashAlgo = "sha1" | "sha256";

/**
 * A content hash — **always** an `{algo, value}` pair, never a bare string.
 * `value` is the lowercase hex digest. sha256 is canonical for everything anvil
 * owns; sha1 is used only for the Mojang `assets/objects/<xx>/<sha1>` domain.
 */
export interface Hash {
  readonly algo: HashAlgo;
  /** Lowercase hex digest. */
  readonly value: string;
}

/**
 * What a tracked item is. anvil infers this from the source and refuses to guess
 * an ambiguous kind. It maps 1:1 onto a placement folder (mods/, resourcepacks/,
 * shaderpacks/, datapacks/, …).
 */
export type ItemKind =
  | "game" // the Minecraft client jar itself
  | "loader" // the fabric/quilt/neoforge/forge loader
  | "library" // a game or loader library jar
  | "java" // the pinned JRE runtime
  | "mod"
  | "resourcepack"
  | "shaderpack"
  | "datapack"
  | "config"; // a config-override file

/** Where an item is fetched from. `mojang` is the implicit source for the game. */
export type SourceKind = "mojang" | "modrinth" | "curseforge" | "url" | "local";

/** Mojang's `os.name` vocabulary — the three build-target operating systems. */
export type OsName = "linux" | "osx" | "windows";

/**
 * A platform a package applies to. `os` is required; `arch` (a Node `process.arch`
 * value — `"x64"` | `"arm64"` | `"ia32"`) is optional and, when absent, matches any
 * arch on that OS. Per-OS natives and the per-platform JRE carry these so the build
 * installs exactly the artifact for the machine it runs on and never a wrong-arch one.
 */
export interface TargetTuple {
  readonly os: OsName;
  readonly arch?: string;
}

/**
 * How an object is materialized.
 *
 * - `copy` — an official/keyless blob (Mojang files, Modrinth jars, local files):
 *   cacheable and shareable, lives in the shared content store.
 * - `replay` — a CurseForge byte stream: per-CF-ToS it is re-installed from
 *   source on each client and materialized into a per-instance location the
 *   transfer/GC/export code physically cannot enumerate. Never re-hosted.
 */
export type Provenance = "copy" | "replay";

/**
 * A manifest version spec, resolved under a frozen clock at lock time.
 *
 * - `pin` — an exact version (`@1.4.0`).
 * - `range` — a semver-ish range (`@^1.4`).
 * - `latest` — explicit `@latest`, or omitted (latest-at-lock).
 */
export type VersionSpec =
  | { readonly kind: "pin"; readonly version: string }
  | { readonly kind: "range"; readonly range: string }
  | { readonly kind: "latest" };

/**
 * A parsed, but not-yet-resolved, reference to a manifest item —
 * the `source:id@version` grammar (or an explicit `{ path, kind }`).
 */
export interface ResolvedRef {
  readonly source: SourceKind;
  /** The source-local identifier (slug, project id, url, or path). */
  readonly id: string;
  readonly versionSpec: VersionSpec;
  /** An explicit kind override when the source cannot be trusted to infer it. */
  readonly kind?: ItemKind;
  /**
   * The instance-relative placement target this ref declares (a POSIX path, the
   * same currency as {@link Placement}'s `target` — not to be confused with
   * {@link LockPackage.targets}, which are platforms).
   *
   * Two ways this gets set, both validated by the same
   * `declaredPlacementTarget` guards:
   *
   *   - **Derived**, for a `local` ref only: a path-authored item names both
   *     where its bytes come from and where they belong —
   *     `"config/sodium/mixins.json"` is read from there and placed back
   *     there. The resolver derives this from the manifest path so nested
   *     paths round-trip and a root-level override is not swept into a kind
   *     directory.
   *   - **Explicit** (`ManifestItem.target`, any source — LB-720): a ref that
   *     carries no path of its own (every Modrinth/CurseForge/URL item, and a
   *     re-identified local jar) can still declare where it lands, separately
   *     from the id/version that names *what* it is. Every source honors it
   *     the same way `local` honors a derived one.
   *
   * Absent when the item declares no placement of its own: a non-local ref
   * with no explicit target, or a local path that resolves outside the
   * instance. Those fall back to `<kind-dir>/<basename>`.
   */
  readonly target?: string;
}

/** A raw manifest item, before resolution: either a source ref or a local path. */
export interface ManifestItem {
  /** A `source:id@ver` reference. Mutually exclusive with `path`. */
  readonly ref?: ResolvedRef;
  /** A local file path. Mutually exclusive with `ref`. */
  readonly path?: string;
  /** An explicit kind, when the source/path cannot be trusted to infer it. */
  readonly kind?: ItemKind;
  /**
   * Where this item is **placed**, when that differs from where its bytes are
   * **read**. Instance-relative POSIX, the same currency as {@link ResolvedRef}'s
   * `target`.
   *
   * A `path` item normally names both at once — `"config/sodium/mixins.json"` is
   * read from there and built back there. That breaks down for a **tracked copy**:
   * an imported override's bytes live at `.anvil/overrides/<path>` from the moment
   * `import` writes them, while the file belongs at `<path>` in the built tree. The
   * pack-relative path alone cannot express that, and a manifest that names it as
   * the read location describes a file that does not exist until a build has run.
   *
   * So the two halves are separable: `path` is the read location, `target` is the
   * placement. Declaring it is what keeps such a manifest self-consistent before
   * any build, and it is validated by the same {@link declaredPlacementTarget}
   * guards a derived target passes — an explicit field is attacker-controlled
   * independently of the read path, so it gets the stricter, not the looser, check.
   *
   * A `ref` item may declare it too (LB-720): a Modrinth/CurseForge/URL item, or
   * a re-identified local jar, carries no path of its own for the resolver to
   * derive a placement from, so without this field it is always placed by kind —
   * a re-identified jar imported from a subdirectory (Fabric's
   * `mods/<mc-version>/` convention, for one) would flatten on every re-lock.
   * `refForItem` carries this onto the resolved ref's own `target`, and every
   * `Source` honors it exactly as `local` honors a derived one.
   */
  readonly target?: string;
}

/**
 * A host-app policy hook. Given a resolved ref, decide whether anvil may fetch
 * from it. Evaluated **before any network I/O**. This is the SSRF/allowlist gate
 * and the seam where an embedder (e.g. Lobbify) enforces which sources it trusts.
 */
export type AllowSource = (ref: ResolvedRef) => boolean;

/**
 * The identity of a Forge/NeoForge installer processor shown to the host-app policy
 * hook before it runs.
 */
export interface ProcessorIdentity {
  /** The processor jar's maven coordinate (`group:artifact:version[:classifier]`). */
  readonly coordinate: string;
  /** The maven repository host the jar was resolved from, when known. */
  readonly repo?: string;
  /** The processor jar's sha256 (a reproducibility pin, not a trust token). */
  readonly sha256: string;
}

/**
 * A host-app policy hook for Forge/NeoForge installer processors. Running a
 * processor is arbitrary code execution driven by the installer you chose to build —
 * anvil follows the **trust-the-source** model (like `git` hooks, `npm install`
 * scripts, `docker build`, Gradle), so this **defaults to allow**. It is the seam
 * where an embedder building from UNTRUSTED sources denies (returns `false`) a
 * processor before it runs — see SECURITY.md. Modeled on {@link AllowSource}.
 */
export type AllowProcessor = (proc: ProcessorIdentity) => boolean;

/**
 * How a materialized object lands in the instance tree. A discriminated union
 * executed by the placement executor.
 *
 * - `link` — link a single object to a target path (mod jar, resourcepack zip).
 * - `extract` — safe-extract an archive under a target dir (natives, overrides).
 * - `asset-tree` — materialize a Mojang asset index into the sha1 asset domain.
 * - `runtime-tree` — materialize a pinned Mojang java-runtime **per-platform
 *   manifest** (the store object under `hash`) into a JRE tree: files (preserving
 *   the executable bit), directories, and the mac-bundle symlinks it declares.
 *   Landed in Stage 3 for the pinned JRE.
 * - `store-only` — keep the object in the shared store but place nothing into the
 *   instance tree (e.g. a classpath library or client jar referenced by store
 *   path). Additive member landed in Stage 1 to complete the placement table.
 * - `forge-build` — the object under `hash` is a **generated Forge/NeoForge install
 *   plan** (the processor DAG + data bindings, pinned like any object). The build
 *   reads it, runs each installer processor (Stage 9; trust-the-source, see
 *   SECURITY.md) reusing the pinned JRE, and writes the produced files (the patched
 *   client jar +
 *   any generated libraries) to `outputs` — the complete, deterministic set of
 *   instance-relative paths the processors produce, declared at lock time so the
 *   atomic swap and the incremental delta see them as normal targets.
 */
export type Placement =
  | { readonly method: "link"; readonly target: string }
  | { readonly method: "extract"; readonly targetDir: string }
  | { readonly method: "asset-tree"; readonly indexTarget: string }
  | { readonly method: "runtime-tree"; readonly targetDir: string }
  | { readonly method: "forge-build"; readonly outputs: readonly string[] }
  | { readonly method: "store-only" };

/**
 * A fully-pinned entry in the lock. The lock is the **sole build input**: every
 * field needed to fetch, verify, and place an item byte-identically lives here.
 */
export interface LockPackage {
  readonly name: string;
  readonly kind: ItemKind;
  readonly source: SourceKind;
  /** Human-facing resolved version (absent for anonymous URL/local blobs). */
  readonly version?: string;
  /** The pinned content hash — the store key. */
  readonly hash: Hash;
  readonly provenance: Provenance;
  /** How this object is placed into the instance tree. */
  readonly placement: Placement;
  /**
   * Platform tuples this package applies to (absent = universal). The build's
   * preflight installs a package only when the host matches one of these. Per-OS
   * natives and the per-platform JRE carry a target so a single cross-platform
   * lock stays byte-identical everywhere while each machine gets only its own
   * natives/JRE — the one deliberately platform-varying part of an instance.
   */
  readonly targets?: readonly TargetTuple[];
  /** CurseForge project id (replay items only). */
  readonly project?: number;
  /** CurseForge file id (replay items only). */
  readonly file?: number;
  /** Direct download URL (url source, and the fetch hint for other sources). */
  readonly url?: string;
  /** Byte size, when known — used for transfer planning and bomb bounds. */
  readonly size?: number;
  /**
   * Present (and always `true`) when this package came from the manifest's
   * `game.from` **base pack** rather than from its own `items`. Absent for every
   * package of an instance that declares no base, so a base-less lock is
   * byte-identical to what it was before base packs existed.
   *
   * The flag is what makes two base-sharing instances cheap to compare: with
   * equal {@link LockBase.set} digests the whole flagged partition is known
   * identical without inspecting a single entry, so only the unflagged overlay
   * has to be diffed. See `ARCHITECTURE.md` → "Base packs".
   */
  readonly fromBase?: true;
}

/** The lock header. `version` gates the on-disk schema for migrations. */
export interface LockMeta {
  readonly version: 1;
  readonly manifestHash: Hash;
  readonly minecraft: string;
  /** e.g. `"fabric 0.19.1"` or `"vanilla"`. */
  readonly loader: string;
  /** The pinned JRE component id (e.g. `"runtime-gamma-21"`). */
  readonly java: string;
}

/**
 * The resolved identity of a manifest's `game.from` base pack, recorded in the
 * lock so the base is **never re-resolved at build time**. The build reads only
 * {@link Lockfile.resolved}; this block exists to identify the base and to make
 * a base-sharing pair of instances comparable without fetching a byte.
 */
export interface LockBase {
  /** The `game.from` string exactly as authored (`"modrinth:atm10@4.6"`). */
  readonly ref: string;
  readonly source: SourceKind;
  /** The source-local pack id (slug / project id) as resolved. */
  readonly id: string;
  /** The concrete pack version the ref resolved to under the frozen clock. */
  readonly version: string;
  /** The base distribution's own content pin (the `.mrpack` archive's sha256). */
  readonly archive: Hash;
  /**
   * A digest over the base's resolved member set **before** the instance layer
   * is applied. Two locks with the same `set` started from byte-identical base
   * members, whatever each instance then did on top.
   */
  readonly set: Hash;
  /** How many members the base contributed, before removals and overrides. */
  readonly members: number;
}

/** The fully-resolved, hash-pinned lockfile — deterministic and diff-friendly. */
export interface Lockfile {
  readonly meta: LockMeta;
  /** The resolved `game.from` base, when the manifest declares one. */
  readonly base?: LockBase;
  readonly resolved: readonly LockPackage[];
}

/** The human-authored game base for a manifest. */
export interface GameSpec {
  readonly minecraft: string;
  /** `fabric <ver>` | `quilt <ver>` | `neoforge <ver>` | `forge <ver>` | `vanilla`. */
  readonly loader: string;
  /**
   * Start from an existing pack (`modrinth:cobblemon-pack@1.4.0`). The pack's
   * members become the instance's base layer; `items` is the layer on top and
   * always wins. See `ARCHITECTURE.md` → "Base packs" for the precedence rules.
   */
  readonly from?: string;
  /**
   * Items this manifest drops. Each entry matches by **identity** (`modrinth:x`)
   * or by **placement path** (`"./config/x.toml"`), against the base's members
   * and this manifest's own `items`. An entry matching nothing is an error.
   */
  readonly remove?: readonly string[];
}

/** The human-authored manifest (`anvil.toml`) — portable, no machine paths. */
export interface Manifest {
  readonly project: {
    readonly name: string;
    readonly version: string;
    readonly summary?: string;
  };
  readonly game: GameSpec;
  readonly items: readonly ManifestItem[];
}

/**
 * A single byte-fetch instruction for a pinned package. Produced by a
 * {@link Source} from a {@link LockPackage} with **no network I/O**; the actual
 * transfer verifies the arrived bytes against `expected` before the store
 * admits them.
 */
export interface FetchPlan {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The hash the arrived bytes must match, or the store rejects them. */
  readonly expected: Hash;
  readonly size?: number;
  readonly provenance: Provenance;
}

/**
 * A resolved request/redirect hop, surfaced to the SSRF guard **before** the
 * request is dispatched. `addresses` are the DNS-resolved IPs the connection
 * will actually use (empty when the host is an IP literal), so the guard vets
 * the real target — not just the hostname — closing the DNS-rebinding hole.
 */
export interface HttpHop {
  readonly url: string;
  readonly host: string;
  readonly addresses: readonly string[];
}

/** A completed HTTP GET result: status, headers, the final URL, and the body. */
export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The final URL after any redirects were followed. */
  readonly url: string;
  readonly body: Uint8Array;
}

/** Options for an {@link Http} GET. */
export interface HttpGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Per-hop SSRF guard: invoked with the initial request **and every redirect
   * target** before dispatch; throwing aborts the fetch. The `url` source passes
   * the internal-address validator here, so a redirect to an internal host is
   * rejected on the hop that introduces it.
   */
  readonly guard?: (hop: HttpHop) => void | Promise<void>;
  /** Cap on bytes buffered into memory — a decompression/response-bomb bound. */
  readonly maxBytes?: number;
}

/**
 * The per-source rate-limited HTTP client a {@link Source} uses at **lock time**
 * (never during a build — the lock is the sole build input). Each source owns
 * its own client so the token bucket and User-Agent are scoped per source.
 */
export interface Http {
  get(url: string, options?: HttpGetOptions): Promise<HttpResult>;
  /**
   * A JSON POST — used only by the batch identity endpoints (Modrinth
   * `version_files`, CurseForge `fingerprints`) the Prism importer re-identifies
   * jars through. Optional: a client that only ever GETs (every `Source` at lock
   * time, every build-time fetch) need not implement it. When absent, a caller
   * that needs a POST falls back to a per-item GET or fails clearly.
   */
  post?(url: string, body: Uint8Array, options?: HttpGetOptions): Promise<HttpResult>;
}

/** The outcome of admitting bytes to the store: the content hash + a dedup flag. */
export interface PutOutcome {
  readonly hash: Hash;
  readonly deduped: boolean;
}

/**
 * The minimal store-admission surface a {@link Source} uses to cache the bytes
 * it hashed at lock time, so a subsequent build finds them already present. The
 * `ContentStore` satisfies this structurally; keeping it an interface here keeps
 * the type spine decoupled from the store implementation.
 */
export interface ObjectSink {
  has(hash: Hash): Promise<boolean>;
  putBuffer(data: Uint8Array, algo: HashAlgo, expected?: Hash): Promise<PutOutcome>;
  putFile(src: string, algo: HashAlgo, expected?: Hash): Promise<PutOutcome>;
}

/**
 * Ambient context handed to a {@link Source}: the per-source rate-limited HTTP
 * client, the frozen lock clock, the offline flag, the BYO CurseForge key (a
 * reference, never serialized), the `allowSource` policy gate, and the store the
 * source admits hashed bytes into.
 */
export interface SourceContext {
  /** The per-source rate-limited HTTP client (absent for the local source). */
  readonly http?: Http;
  readonly offline: boolean;
  /**
   * The frozen lock clock (ms since epoch). A `latest`/omitted spec resolves to
   * the newest artifact published at or before this instant, so "latest-at-lock"
   * is deterministic across re-runs of the same lock.
   */
  readonly now: number;
  /** BYO CurseForge key. Never serialized into lock/config/events/logs. */
  readonly curseforgeKey?: string;
  readonly allowSource: AllowSource;
  /** Where a source admits the bytes it hashed at lock time (copy provenance). */
  readonly store?: ObjectSink;
  /**
   * The game target from the manifest — a source filters its artifacts by the
   * Minecraft version and (for mods) the loader.
   */
  readonly game?: {
    readonly minecraft: string;
    /** The raw loader string (`"fabric 0.19.1"`, `"vanilla"`). */
    readonly loader?: string;
  };
}

/**
 * The result of resolving one ref: the fully-pinned package plus any **required**
 * transitive dependencies to enqueue. Optional and embedded (jar-in-jar) deps are
 * excluded by the source before they reach here.
 */
export interface ResolveResult {
  readonly pkg: LockPackage;
  readonly dependencies?: readonly ResolvedRef[];
}

/**
 * The source abstraction: resolve a manifest ref to a fully-pinned lock package
 * (may hit the network) plus its required transitive deps, and plan the byte
 * fetch for a pinned package (never hits the network). Modrinth / CurseForge /
 * URL / local each implement this.
 */
export interface Source {
  readonly kind: SourceKind;
  /** Resolve a ref to a fully-pinned package (+ required deps). May do network I/O. */
  resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult>;
  /** Produce the byte-fetch plan for an already-pinned package. No network I/O. */
  plan(pkg: LockPackage, ctx: SourceContext): FetchPlan;
}

/**
 * Machine-local path remapping (from `.anvil/config.toml`). Lets anvil write the
 * heavy shared categories into dirs you already have — including an existing
 * `.minecraft/assets`, which already *is* a content-addressed sha1 store.
 */
export interface PathMapping {
  readonly assets?: string;
  readonly libraries?: string;
  readonly runtime?: string;
}

/**
 * Constructor options for the {@link Source}-agnostic `Anvil` class. A host app
 * (e.g. Lobbify) builds one of these per instance and calls methods directly.
 */
export interface AnvilOptions {
  /** The folder-instance root — this directory *is* the `.minecraft`. */
  readonly dir: string;
  /** Machine-local category remapping for the shared store. */
  readonly paths?: PathMapping;
  /** The shared content store root (defaults to `~/.anvil/store`). */
  readonly storeDir?: string;
  /** BYO CurseForge key. Kept in memory only; never serialized. */
  readonly curseforgeKey?: string;
  /** Host-app source policy. Defaults to allow-all for the standalone CLI. */
  readonly allowSource?: AllowSource;
  /**
   * Host-app policy hook for Forge/NeoForge installer processors, which execute
   * build code from the installer you build (trust-the-source; see SECURITY.md).
   * **Defaults to allow.** An embedder building from untrusted sources returns
   * `false` here to block a processor, and/or injects a confining processor runner.
   */
  readonly allowProcessor?: AllowProcessor;
  /** Build purely from the populated store; error on the first missing object. */
  readonly offline?: boolean;
  /** Explicit proxy override; otherwise `HTTP(S)_PROXY` env is honored. */
  readonly httpProxy?: string;
}
