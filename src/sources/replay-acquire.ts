/**
 * The **replay acquirer** — build-time, per-client fetch of a CurseForge item's
 * bytes into the per-instance {@link ReplayCache}, **never** the shared store.
 *
 * This is the build-side half of the replay-never-rehosted invariant. For a
 * `provenance: "replay"` lock row it:
 *   1. resolves a **fresh** keyed `download-url` under the user's own key (a
 *      replay lock carries no rehostable URL — the URL is per-fetch);
 *   2. downloads the bytes and admits them to the replay cache, which verifies
 *      the sha256 against the lock's pin **before** they land (a mismatch is a
 *      hard {@link ShaMismatch} stop — the bytes never enter the build);
 *   3. a `null` download-url or a `403` → a clear {@link ReplayUnavailable};
 *      the bytes are never copied from anywhere else.
 *
 * The bytes go to the {@link ReplayCache} (under `.anvil/replay-cache/`), which
 * the shared store, GC, transfer, and export code physically cannot enumerate.
 */

import type { Acquirer } from "../build/acquire.js";
import type { AnvilEvent } from "../events.js";
import type { ReplayCache } from "../store/replay-cache.js";
import {
  MissingObject,
  ReplayUnavailable,
  SourceKeyMissing,
  UnsatisfiableTarget,
} from "../types/errors.js";
import type { Http, LockPackage } from "../types/index.js";
import { CurseForgeApi, replayDownloadReason } from "./curseforge.js";
import { guardHop } from "./ssrf.js";

const MAX_FILE_BYTES = 512 * 1024 * 1024;

export interface ReplayAcquirerOptions {
  readonly replayCache: ReplayCache;
  /** The CurseForge HTTP client (absent → any replay fetch fails clearly). */
  readonly http?: Http;
  /** BYO CurseForge key; absent → a typed {@link SourceKeyMissing}, never a skip. */
  readonly curseforgeKey?: string;
  /** CurseForge API base override (mirror / offline fixtures). */
  readonly baseUrl?: string;
  /** Offline build: use only the already-cached replay bytes; never re-fetch. */
  readonly offline?: boolean;
  readonly emit?: (event: AnvilEvent) => void;
}

/** Acquire `replay`-provenance objects into the per-instance replay cache. */
export class ReplayAcquirer implements Acquirer {
  readonly #cache: ReplayCache;
  readonly #http?: Http;
  readonly #key?: string;
  readonly #baseUrl?: string;
  readonly #offline: boolean;
  readonly #emit?: (event: AnvilEvent) => void;

  constructor(opts: ReplayAcquirerOptions) {
    this.#cache = opts.replayCache;
    this.#http = opts.http;
    this.#key = opts.curseforgeKey;
    this.#baseUrl = opts.baseUrl;
    this.#offline = opts.offline ?? false;
    this.#emit = opts.emit;
  }

  async ensure(pkg: LockPackage): Promise<void> {
    // A hard invariant guard: this acquirer only handles replay/CurseForge rows.
    if (pkg.provenance !== "replay") {
      throw new UnsatisfiableTarget(
        pkg.name,
        "the replay acquirer only handles replay-provenance packages",
      );
    }
    if (pkg.source !== "curseforge" || pkg.project === undefined || pkg.file === undefined) {
      throw new UnsatisfiableTarget(
        pkg.name,
        "a replay package must carry a CurseForge project id + file id",
      );
    }

    // Already fetched into this instance's replay cache → reuse (dedup).
    if (await this.#cache.has(pkg.hash)) {
      this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: true });
      return;
    }

    if (this.#offline) {
      // Replay bytes live per-instance; offline cannot re-fetch them.
      throw new MissingObject(pkg.hash, `${pkg.name} (replay item, not in the local replay cache)`);
    }
    if (!this.#key) {
      throw new SourceKeyMissing("curseforge");
    }
    if (!this.#http) {
      throw new UnsatisfiableTarget(pkg.name, "no CurseForge HTTP client configured for replay");
    }

    const api = new CurseForgeApi(this.#http, this.#key, this.#baseUrl);
    this.#emit?.({ type: "replay:start", name: pkg.name });

    const url = await api.getDownloadUrl(pkg.project, pkg.file);
    if (!url) {
      throw new ReplayUnavailable(
        pkg.name,
        "the author disabled third-party API downloads for this file",
      );
    }

    this.#emit?.({
      type: "replay:fetch",
      name: pkg.name,
      received: 0,
      ...(pkg.size !== undefined ? { total: pkg.size } : {}),
    });

    let bytes: Uint8Array;
    try {
      // Re-apply the SSRF guard on the CDN URL (defense-in-depth on a keyed URL).
      const res = await this.#http.get(url, { guard: guardHop, maxBytes: MAX_FILE_BYTES });
      bytes = res.body;
    } catch (err) {
      // Surface the failure WITHOUT the resolved CDN URL (never leak it).
      throw new ReplayUnavailable(pkg.name, replayDownloadReason(err));
    }

    // The cache verifies sha256 against the pin BEFORE the object lands — a
    // mismatch throws ShaMismatch and nothing enters the build.
    await this.#cache.putBuffer(bytes, pkg.hash);
    this.#emit?.({ type: "replay:done", name: pkg.name });
  }
}
