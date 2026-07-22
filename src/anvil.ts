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

import type { AnvilEvent, ProgressListener } from "./events.js";
import { NotImplemented } from "./types/errors.js";
import type { AnvilOptions, Hash, Lockfile, ManifestItem } from "./types/index.js";

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

/** Result of a {@link Anvil.verify} / `fsck`-style reconciliation. */
export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/** A structural diff between two manifests/locks/instances. */
export interface DiffResult {
  readonly added: readonly ManifestItem[];
  readonly removed: readonly ManifestItem[];
  readonly changed: readonly ManifestItem[];
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

  /** The typed progress bus. Prefer {@link on} or `for await` over reaching in. */
  readonly progress = new ProgressBus();

  constructor(options: AnvilOptions) {
    this.#options = options;
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

  // --- resolve + build (uv lock / docker build) ---------------------------
  //
  // Every method below is `async` so it returns a *rejected* promise (never a
  // synchronous throw) — the same contract callers get once bodies land.

  /** `anvil lock` — resolve the manifest and freeze the lockfile. */
  async lock(_options?: LockOptions): Promise<Lockfile> {
    throw new NotImplemented("Anvil.lock");
  }

  /** `anvil build` — install a launch-ready instance from the lock, atomically. */
  async build(_options?: BuildOptions): Promise<BuildResult> {
    throw new NotImplemented("Anvil.build");
  }

  /** `anvil verify` — check the materialized instance matches the lock. */
  async verify(): Promise<VerifyResult> {
    throw new NotImplemented("Anvil.verify");
  }

  /** `anvil diff` — compare manifests / locks / instances. */
  async diff(_from?: string, _to?: string): Promise<DiffResult> {
    throw new NotImplemented("Anvil.diff");
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

  /** `anvil import` — adopt an `.mrpack` / CurseForge zip / Prism instance. */
  async import(_archive: string): Promise<void> {
    throw new NotImplemented("Anvil.import");
  }

  /** `anvil export` — write an `.mrpack` (CF replay items omitted, with a warning). */
  async export(_target: string): Promise<void> {
    throw new NotImplemented("Anvil.export");
  }

  // --- store maintenance (git gc / fsck) ----------------------------------

  /** `anvil store gc` — prune unreachable objects from the content store. */
  async gc(): Promise<GcResult> {
    throw new NotImplemented("Anvil.gc");
  }

  /** `anvil fsck` — verify content-store integrity. */
  async fsck(): Promise<FsckResult> {
    throw new NotImplemented("Anvil.fsck");
  }
}
