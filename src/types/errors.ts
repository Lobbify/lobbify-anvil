/**
 * The anvil error taxonomy.
 *
 * Every failure mode the library can surface is a named subclass of
 * {@link AnvilError} carrying a stable `code`. Stage 4 maps each code to an
 * actionable CLI message and a documented exit code; the library never throws a
 * bare `Error` for a known condition.
 */

import type { Hash, SourceKind } from "./core.js";

/** Base class for every typed anvil failure. Carries a stable machine `code`. */
export class AnvilError extends Error {
  /** Stable, screaming-snake machine code (e.g. `SHA_MISMATCH`). */
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    // `new.target.name` keeps the concrete subclass name after transpilation.
    this.name = new.target.name;
    this.code = code;
    // Restore the prototype chain for `instanceof` across the ES target boundary.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A source that requires an API key was asked to resolve without one.
 * CurseForge is BYO-key: the OSS tool never ships a key. Only an env-var
 * *reference* is ever stored — never the key itself.
 */
export class SourceKeyMissing extends AnvilError {
  readonly source: SourceKind;

  constructor(source: SourceKind, message?: string) {
    super(
      "SOURCE_KEY_MISSING",
      message ??
        `No API key is configured for the "${source}" source. Set the key via its environment variable and retry.`,
    );
    this.source = source;
  }
}

/**
 * No artifact satisfies the requested target — e.g. a loader/version combo with
 * no build, or a platform with no native (the mac-arm64 natives gap). We fail
 * loudly rather than silently substituting a wrong-arch or wrong-version file.
 */
export class UnsatisfiableTarget extends AnvilError {
  readonly target: string;
  readonly reason: string;

  constructor(target: string, reason: string) {
    super("UNSATISFIABLE_TARGET", `Cannot satisfy target "${target}": ${reason}`);
    this.target = target;
    this.reason = reason;
  }
}

/**
 * Fetched bytes did not hash to the pinned value. A hard stop: the store never
 * admits an object whose content-address does not match its declared hash.
 */
export class ShaMismatch extends AnvilError {
  readonly subject: string;
  readonly expected: Hash;
  readonly actual: Hash;

  constructor(subject: string, expected: Hash, actual: Hash) {
    super(
      "SHA_MISMATCH",
      `Hash mismatch for "${subject}": expected ${expected.algo}:${expected.value}, ` +
        `got ${actual.algo}:${actual.value}.`,
    );
    this.subject = subject;
    this.expected = expected;
    this.actual = actual;
  }
}

/** One demanded party wanting version A, another wanting an incompatible B. */
export interface ConflictDemand {
  /** Who demanded it (a root item name, or `@game`). */
  readonly by: string;
  /** What they demanded (a version, range, or spec string). */
  readonly demanded: string;
}

/**
 * The resolver (or a merge) found an irreconcilable version conflict for an
 * item. The message names who-demanded-what so the user can pick.
 */
export class ConflictError extends AnvilError {
  readonly item: string;
  readonly demands: readonly ConflictDemand[];

  constructor(item: string, demands: readonly ConflictDemand[]) {
    const detail = demands.map((d) => `${d.by} wants ${d.demanded}`).join("; ");
    super("CONFLICT", `Version conflict for "${item}": ${detail}.`);
    this.item = item;
    this.demands = demands;
  }
}

/**
 * A `pull`/`switch`/`merge` would require a non-fast-forward. Joiners only ever
 * fast-forward; divergent local commits are stashed to a `local/<ts>` branch,
 * never discarded.
 */
export class NonFastForward extends AnvilError {
  readonly ref: string;

  constructor(ref: string, message?: string) {
    super(
      "NON_FAST_FORWARD",
      message ??
        `Cannot fast-forward "${ref}": local history has diverged from the remote. Local commits will be preserved on a local branch.`,
    );
    this.ref = ref;
  }
}

/**
 * A link/rename would cross filesystem volumes (detected via `stat().dev`), so
 * reflink/hardlink is impossible and an atomic same-volume rename cannot be
 * guaranteed. The store/build layer falls back or re-plans the staging volume.
 */
export class CrossVolume extends AnvilError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string, message?: string) {
    super("CROSS_VOLUME", message ?? `Operation crosses filesystem volumes: "${from}" → "${to}".`);
    this.from = from;
    this.to = to;
  }
}

/**
 * An archive entry or a placement target resolves outside its allowed root, or is
 * an absolute/drive-letter path, a `..` traversal, or a symlink/hardlink entry.
 * The one hardened check behind {@link https://en.wikipedia.org/wiki/Zip_Slip zip-slip}
 * safety and the "`saves/` is never touched" placement guarantee.
 */
export class PathEscape extends AnvilError {
  readonly subject: string;
  readonly reason: string;

  constructor(subject: string, reason: string) {
    super("PATH_ESCAPE", `Refusing unsafe path "${subject}": ${reason}.`);
    this.subject = subject;
    this.reason = reason;
  }
}

/**
 * An archive exceeded a decompression bound (entry count or total uncompressed
 * bytes) — a decompression-bomb guard on every untrusted extraction site.
 */
export class DecompressionBomb extends AnvilError {
  constructor(message: string) {
    super("DECOMPRESSION_BOMB", message);
  }
}

/**
 * An offline build (or a `store-only`/`asset-tree` placement) needs an object the
 * populated store does not contain. We fail clearly on the first missing object
 * rather than reaching for the network in an offline build.
 */
export class MissingObject extends AnvilError {
  readonly hash: Hash;

  constructor(hash: Hash, subject?: string) {
    super(
      "MISSING_OBJECT",
      `Required object ${hash.algo}:${hash.value}${subject ? ` for "${subject}"` : ""} is not present in the store.`,
    );
    this.hash = hash;
  }
}

/** A build preflight check failed (e.g. insufficient free disk space). */
export class PreflightFailed extends AnvilError {
  constructor(message: string) {
    super("PREFLIGHT_FAILED", message);
  }
}

/**
 * Startup swap-journal recovery could not reconcile the instance to a consistent
 * old-or-new state. A last-resort error — recovery is designed to always succeed.
 */
export class SwapRecoveryFailed extends AnvilError {
  constructor(message: string) {
    super("SWAP_RECOVERY_FAILED", message);
  }
}

/**
 * The `allowSource` policy gate denied a ref. Evaluated **before any network
 * I/O**, so a malicious manifest cannot trigger a fetch to a source the embedder
 * has not trusted — this is the malicious-remote veto surface.
 */
export class SourceNotAllowed extends AnvilError {
  readonly source: SourceKind;
  readonly id: string;

  constructor(source: SourceKind, id: string) {
    super(
      "SOURCE_NOT_ALLOWED",
      `The source policy refused "${source}:${id}". The host app's allowSource() did not permit this source.`,
    );
    this.source = source;
    this.id = id;
  }
}

/**
 * The SSRF guard blocked a `url`-source target: a non-`http(s)` scheme, or a host
 * that resolves to a loopback / RFC1918 / link-local / cloud-metadata address.
 * Enforced on the initial request and re-validated on **every** redirect hop.
 */
export class SsrfBlocked extends AnvilError {
  readonly url: string;
  readonly reason: string;

  constructor(url: string, reason: string) {
    super("SSRF_BLOCKED", `Refusing to fetch "${url}": ${reason}.`);
    this.url = url;
    this.reason = reason;
  }
}

/**
 * A CurseForge **replay** item cannot be fetched: the keyed
 * `/files/{id}/download-url` endpoint returned `null` (the author disabled
 * third-party downloads) or the CDN answered `403`. Per the CF ToS the bytes are
 * **never** copied from anywhere else — we surface a clear, actionable error and
 * stop. The user must obtain the file through the CurseForge app/site.
 */
export class ReplayUnavailable extends AnvilError {
  readonly item: string;
  readonly reason: string;

  constructor(item: string, reason: string) {
    super(
      "REPLAY_UNAVAILABLE",
      `CurseForge file for "${item}" cannot be downloaded programmatically: ${reason}. Per the CurseForge Terms of Service the bytes are never re-hosted or copied from elsewhere — obtain this file through the CurseForge app or website, or choose a project whose author allows API downloads.`,
    );
    this.item = item;
    this.reason = reason;
  }
}

/**
 * A source could not infer an item's kind and refuses to guess (e.g. a `.zip`
 * that could be a resourcepack, datapack, or shader). The caller must pin the
 * kind explicitly. A clear lock error rather than a wrong placement folder.
 */
export class KindInferenceFailed extends AnvilError {
  readonly subject: string;

  constructor(subject: string, reason: string) {
    super(
      "KIND_INFERENCE_FAILED",
      `Cannot determine the kind of "${subject}": ${reason}. Set an explicit kind for this item.`,
    );
    this.subject = subject;
  }
}

/** A network request failed (non-2xx after retries, or a transport error). */
export class HttpError extends AnvilError {
  readonly url: string;
  readonly status?: number;

  constructor(url: string, message: string, status?: number) {
    super("HTTP_ERROR", `Request to "${url}" failed: ${message}`);
    this.url = url;
    this.status = status;
  }
}

/** The `anvil.toml` manifest was malformed or referenced an unknown source. */
export class ManifestError extends AnvilError {
  constructor(message: string) {
    super("MANIFEST_INVALID", message);
  }
}

/** An `anvil.lock` on disk was malformed or carried an unsupported schema version. */
export class LockParseError extends AnvilError {
  constructor(message: string) {
    super("LOCK_INVALID", message);
  }
}

/**
 * A `commit` was refused because the lock is stale relative to the manifest (a
 * re-`lock` is due), or a snapshot's carried local bytes could not be found. The
 * manifest is the index: we never snapshot a manifest/lock pair that disagree.
 */
export class LockStale extends AnvilError {
  constructor(message: string) {
    super("LOCK_STALE", message);
  }
}

/**
 * A `switch` (or other history-moving op) was refused because the working tree has
 * uncommitted changes that would be lost. Commit or discard them first.
 */
export class DirtyWorkingTree extends AnvilError {
  constructor(message?: string) {
    super(
      "DIRTY_WORKING_TREE",
      message ??
        "the working tree has uncommitted changes — commit or discard them before switching",
    );
  }
}

/** A branch / tag / commit reference could not be resolved to a commit. */
export class UnknownRef extends AnvilError {
  readonly ref: string;

  constructor(ref: string, message?: string) {
    super("UNKNOWN_REF", message ?? `no such branch, tag, or commit: "${ref}"`);
    this.ref = ref;
  }
}

/**
 * A version-control invariant was violated: a merge/rebase started while one is
 * already in progress, a `--continue` with nothing to continue, or unrelated
 * histories with no common ancestor.
 */
export class VcStateError extends AnvilError {
  constructor(message: string) {
    super("VC_STATE", message);
  }
}

/**
 * A phase-2 secondary conflict during a merge/rebase re-lock: an item has no
 * version compatible with the merged game (e.g. a Minecraft bump orphaned a mod).
 * Surfaced as a first-class conflict — the merge/rebase does not commit.
 */
export class NoCompatibleVersion extends AnvilError {
  readonly item: string;

  constructor(item: string, reason: string) {
    super("NO_COMPATIBLE_VERSION", `No compatible version for "${item}": ${reason}.`);
    this.item = item;
  }
}

/**
 * A configured remote name could not be resolved (no `[remote.<name>]` in the
 * instance's `.anvil/config.toml`), or a `pull`/`push` was run with no remotes
 * configured at all.
 */
export class RemoteNotFound extends AnvilError {
  readonly remote: string;

  constructor(remote: string, message?: string) {
    super(
      "REMOTE_NOT_FOUND",
      message ??
        `no remote named "${remote}" is configured — add one with \`anvil remote add ${remote} <url>\`.`,
    );
    this.remote = remote;
  }
}

/**
 * A transport-level failure talking to a remote: the served tree is missing its
 * `anvil.toml`/`anvil.lock`, a `git` invocation failed, or a published VC object
 * was unreadable. Distinct from an `HttpError` (a single request) — it names the
 * remote-sync operation that could not complete.
 */
export class RemoteError extends AnvilError {
  readonly remote: string;

  constructor(remote: string, message: string) {
    super("REMOTE_ERROR", `remote "${remote}": ${message}`);
    this.remote = remote;
  }
}

/**
 * A `push` was attempted against a remote that is not a push target — a static
 * `url`/`http(s)` remote is **read-only** (it serves a manifest + lock but cannot
 * receive one). Push to a `git` remote, a writable local directory, or publish
 * through a Lobbify room instead. A clear, typed refusal — never a silent no-op.
 */
export class PushNotSupported extends AnvilError {
  readonly remote: string;

  constructor(remote: string, kind: string, message?: string) {
    super(
      "PUSH_NOT_SUPPORTED",
      message ??
        `remote "${remote}" (${kind}) is read-only and cannot be pushed to. Push to a git remote or a writable local directory, or publish via a Lobbify room.`,
    );
    this.remote = remote;
  }
}

/**
 * A per-instance / shared-store advisory file lock could not be acquired within
 * the timeout — another anvil process is operating on the same instance or store.
 * A clear, retryable signal rather than a corrupting concurrent mutation.
 */
export class LockBusy extends AnvilError {
  constructor(lockPath: string, holder: string) {
    super(
      "LOCK_BUSY",
      `could not acquire the lock "${lockPath}" — it is held by ${holder}. Another anvil process is operating on this instance/store; retry when it finishes.`,
    );
  }
}

/**
 * Two DISTINCT resolved items place their single file at the SAME target path in
 * the built instance. The resolver dedups by *identity* (`source:id`), never by
 * placement target, so two different items that share a basename (e.g. a Modrinth
 * `sodium.jar` and a `url` `sodium.jar`, or two mods from different sources) would
 * both `link` onto `mods/sodium.jar` — one silently overwriting the other while
 * the lock still lists BOTH. That is a silently-wrong build, so we fail loudly and
 * name the colliding items and their shared target. Detected order-independently
 * (deterministic across runs) at lock time and again at build time.
 */
export class PlacementCollision extends AnvilError {
  readonly target: string;
  readonly items: readonly string[];

  constructor(target: string, items: readonly string[]) {
    const named = items.map((i) => `"${i}"`).join(" and ");
    super(
      "PLACEMENT_COLLISION",
      `Placement target collision at "${target}": ${named} both resolve to the same path in the built instance — one would silently overwrite the other. Remove or rename one of them, or pin a source/version whose file has a distinct name.`,
    );
    this.target = target;
    this.items = items;
  }
}

/**
 * The shared-store instance registry (`<storeRoot>/instances.toml`) — the record
 * of every instance that roots the GC mark-sweep — is present but unreadable or
 * malformed. GC **refuses to sweep** on this error: it cannot confidently
 * enumerate the roots, and sweeping with an under-counted root set would delete
 * objects a live instance still references. Fix or remove the registry file (a
 * subsequent successful `build` re-creates it) and re-run `gc`.
 */
export class StoreRegistryCorrupt extends AnvilError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(
      "STORE_REGISTRY_CORRUPT",
      `The shared-store instance registry "${path}" is unreadable (${reason}). GC refuses to sweep rather than risk deleting objects a live instance still references — repair or remove this file and retry.`,
    );
    this.path = path;
  }
}

/**
 * A stubbed capability that Stage 0 has typed but not yet implemented. Every
 * public `Anvil` method throws this until its owning stage lands.
 */
export class NotImplemented extends AnvilError {
  readonly feature: string;

  constructor(feature: string) {
    super("NOT_IMPLEMENTED", `"${feature}" is not implemented yet (Stage 0 scaffold).`);
    this.feature = feature;
  }
}
