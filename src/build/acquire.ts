/**
 * Acquisition — ensure the objects a lock names are present in the store before
 * materialization. Stage 1 is offline: the network `Source` fetch lands in
 * Stage 3. Two acquirers here:
 *
 *   - {@link FixtureAcquirer} — the "stubbed fetch": copy pinned bytes from a
 *     local content-addressed fixtures dir (`<fixtures>/<algo>/<value>`) into the
 *     store, verifying the hash on admission. Also pulls an `asset-tree`'s named
 *     assets.
 *   - {@link StoreOnlyAcquirer} — assume a populated store; fail clearly on the
 *     first missing object (the `--offline` contract).
 */

import { join } from "node:path";
import type { AnvilEvent } from "../events.js";
import type { ContentStore } from "../store/index.js";
import { treeLeaves } from "../store/index.js";
import { MissingObject } from "../types/errors.js";
import type { Hash, LockPackage } from "../types/index.js";

/** Ensure a pinned package's object (and any dependent objects) are in the store. */
export interface Acquirer {
  ensure(pkg: LockPackage): Promise<void>;
}

type Emit = (event: AnvilEvent) => void;

/**
 * Bring the leaf objects a manifest-driven placement fans out: an `asset-tree`'s
 * assets and a `runtime-tree`'s JRE files. The manifest object (`pkg.hash`) must
 * already be in the store — the caller brings it first.
 */
async function ensureTreeLeaves(
  store: ContentStore,
  pkg: LockPackage,
  bring: (hash: Hash, subject: string) => Promise<void>,
): Promise<void> {
  for (const hash of await treeLeaves(store, pkg)) {
    await bring(hash, `leaf of ${pkg.name}`);
  }
}

/** Copies pinned bytes from a local fixtures pool into the store (offline fetch stub). */
export class FixtureAcquirer implements Acquirer {
  readonly #store: ContentStore;
  readonly #fixturesDir: string;
  readonly #emit?: Emit;

  constructor(store: ContentStore, fixturesDir: string, emit?: Emit) {
    this.#store = store;
    this.#fixturesDir = fixturesDir;
    this.#emit = emit;
  }

  #fixturePath(hash: Hash): string {
    return join(this.#fixturesDir, hash.algo, hash.value);
  }

  async #bring(hash: Hash, subject: string): Promise<void> {
    if (await this.#store.has(hash)) {
      this.#emit?.({ type: "object:store", hash, deduped: true });
      return;
    }
    this.#emit?.({ type: "object:fetch", hash, received: 0 });
    try {
      const { deduped } = await this.#store.putFile(this.#fixturePath(hash), hash.algo, hash);
      this.#emit?.({ type: "object:store", hash, deduped });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MissingObject(hash, subject);
      }
      throw err;
    }
  }

  async ensure(pkg: LockPackage): Promise<void> {
    await this.#bring(pkg.hash, pkg.name);
    await ensureTreeLeaves(this.#store, pkg, (h, s) => this.#bring(h, s));
  }
}

/** Assumes a populated store; errors on the first missing object (offline build). */
export class StoreOnlyAcquirer implements Acquirer {
  readonly #store: ContentStore;
  readonly #emit?: Emit;

  constructor(store: ContentStore, emit?: Emit) {
    this.#store = store;
    this.#emit = emit;
  }

  async #require(hash: Hash, subject: string): Promise<void> {
    if (!(await this.#store.has(hash))) {
      throw new MissingObject(hash, subject);
    }
    this.#emit?.({ type: "object:store", hash, deduped: true });
  }

  async ensure(pkg: LockPackage): Promise<void> {
    await this.#require(pkg.hash, pkg.name);
    await ensureTreeLeaves(this.#store, pkg, (h, s) => this.#require(h, s));
  }
}
