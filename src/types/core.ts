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
}

/** A raw manifest item, before resolution: either a source ref or a local path. */
export interface ManifestItem {
  /** A `source:id@ver` reference. Mutually exclusive with `path`. */
  readonly ref?: ResolvedRef;
  /** A local file path. Mutually exclusive with `ref`. */
  readonly path?: string;
  /** An explicit kind, when the source/path cannot be trusted to infer it. */
  readonly kind?: ItemKind;
}

/**
 * A host-app policy hook. Given a resolved ref, decide whether anvil may fetch
 * from it. Evaluated **before any network I/O**. This is the SSRF/allowlist gate
 * and the seam where an embedder (e.g. Lobbify) enforces which sources it trusts.
 */
export type AllowSource = (ref: ResolvedRef) => boolean;

/**
 * How a materialized object lands in the instance tree. A discriminated union
 * executed by the placement executor.
 *
 * - `link` — link a single object to a target path (mod jar, resourcepack zip).
 * - `extract` — safe-extract an archive under a target dir (natives, overrides).
 * - `asset-tree` — materialize a Mojang asset index into the sha1 asset domain.
 * - `store-only` — keep the object in the shared store but place nothing into the
 *   instance tree (e.g. a classpath library or client jar referenced by store
 *   path). Additive member landed in Stage 1 to complete the placement table.
 */
export type Placement =
  | { readonly method: "link"; readonly target: string }
  | { readonly method: "extract"; readonly targetDir: string }
  | { readonly method: "asset-tree"; readonly indexTarget: string }
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
  /** CurseForge project id (replay items only). */
  readonly project?: number;
  /** CurseForge file id (replay items only). */
  readonly file?: number;
  /** Direct download URL (url source, and the fetch hint for other sources). */
  readonly url?: string;
  /** Byte size, when known — used for transfer planning and bomb bounds. */
  readonly size?: number;
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

/** The fully-resolved, hash-pinned lockfile — deterministic and diff-friendly. */
export interface Lockfile {
  readonly meta: LockMeta;
  readonly resolved: readonly LockPackage[];
}

/** The human-authored game base for a manifest. */
export interface GameSpec {
  readonly minecraft: string;
  /** `fabric <ver>` | `quilt <ver>` | `neoforge <ver>` | `forge <ver>` | `vanilla`. */
  readonly loader: string;
  /** Start from an existing pack (`modrinth:cobblemon-pack@1.4.0`). */
  readonly from?: string;
  /** Items the base pack ships that this manifest drops. */
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
  /** Build purely from the populated store; error on the first missing object. */
  readonly offline?: boolean;
  /** Explicit proxy override; otherwise `HTTP(S)_PROXY` env is honored. */
  readonly httpProxy?: string;
}
