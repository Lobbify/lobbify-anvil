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
