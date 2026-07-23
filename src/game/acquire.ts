/**
 * The build-time game acquirer: fetch the pinned game bytes a lock names into the
 * store, verifying every object against its pin on admission.
 *
 * Unlike copy items admitted at lock time, Mojang's game bytes are fetched at
 * build (the lock stays cheap metadata). For a manifest-driven placement it brings
 * the manifest first, then fans out its leaves:
 *   - `asset-tree`  → the index, then each object from `resources.download.minecraft.net`;
 *   - `runtime-tree`→ the JRE manifest, then each file from its `downloads.raw.url`.
 * Single-file objects (client jar, libraries, natives, loader jars) fetch straight
 * from their pinned `url`. The generated `version.json` (no url) must already be in
 * the store — it exists nowhere to fetch.
 */

import type { AnvilEvent } from "../events.js";
import { guardHop } from "../sources/index.js";
import type { ContentStore, RuntimeManifest } from "../store/index.js";
import { readAssetIndex, readRuntimeManifest } from "../store/index.js";
import { MissingObject } from "../types/errors.js";
import type { Hash, Http, LockPackage } from "../types/index.js";

/** Where Mojang serves asset objects: `<base>/<first-2-of-sha1>/<sha1>`. */
const RESOURCES_BASE = "https://resources.download.minecraft.net";

export interface GameAcquirerOptions {
  readonly store: ContentStore;
  /** HTTP client for all game fetches (Mojang, maven, resources CDN). */
  readonly http: Http;
  /** Override the asset-object CDN base (tests point this at a fixture host). */
  readonly resourcesBase?: string;
  readonly emit?: (event: AnvilEvent) => void;
}

export class GameAcquirer {
  readonly #store: ContentStore;
  readonly #http: Http;
  readonly #resourcesBase: string;
  readonly #emit?: (event: AnvilEvent) => void;

  constructor(options: GameAcquirerOptions) {
    this.#store = options.store;
    this.#http = options.http;
    this.#resourcesBase = (options.resourcesBase ?? RESOURCES_BASE).replace(/\/+$/, "");
    this.#emit = options.emit;
  }

  /** Fetch `url` and admit the bytes under `expected` (verified on admission). */
  async #fetchInto(url: string, expected: Hash, guarded: boolean): Promise<void> {
    if (await this.#store.has(expected)) {
      this.#emit?.({ type: "object:store", hash: expected, deduped: true });
      return;
    }
    this.#emit?.({ type: "object:fetch", hash: expected, received: 0 });
    const res = await this.#http.get(url, guarded ? { guard: guardHop } : {});
    await this.#store.putBuffer(res.body, expected.algo, expected);
    this.#emit?.({ type: "object:store", hash: expected, deduped: false });
  }

  async #bringManifest(pkg: LockPackage): Promise<void> {
    if (await this.#store.has(pkg.hash)) {
      return;
    }
    if (!pkg.url) {
      throw new MissingObject(pkg.hash, pkg.name);
    }
    await this.#fetchInto(pkg.url, pkg.hash, pkg.source === "url");
  }

  async #bringAssets(pkg: LockPackage): Promise<void> {
    await this.#bringManifest(pkg);
    const index = await readAssetIndex(this.#store, pkg.hash);
    for (const obj of Object.values(index.objects)) {
      const hash: Hash = { algo: "sha1", value: obj.hash };
      const url = `${this.#resourcesBase}/${obj.hash.slice(0, 2)}/${obj.hash}`;
      await this.#fetchInto(url, hash, false);
    }
  }

  async #bringRuntime(pkg: LockPackage): Promise<void> {
    await this.#bringManifest(pkg);
    const manifest: RuntimeManifest = await readRuntimeManifest(this.#store, pkg.hash);
    for (const entry of Object.values(manifest.files)) {
      if (entry.type !== "file") {
        continue;
      }
      const raw = entry.downloads.raw;
      const hash: Hash = { algo: "sha1", value: raw.sha1 };
      if (await this.#store.has(hash)) {
        continue;
      }
      if (!raw.url) {
        throw new MissingObject(hash, `runtime file of ${pkg.name}`);
      }
      await this.#fetchInto(raw.url, hash, false);
    }
  }

  async ensure(pkg: LockPackage): Promise<void> {
    switch (pkg.placement.method) {
      case "asset-tree":
        await this.#bringAssets(pkg);
        return;
      case "runtime-tree":
        await this.#bringRuntime(pkg);
        return;
      default: {
        if (await this.#store.has(pkg.hash)) {
          this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: true });
          return;
        }
        if (!pkg.url) {
          // A generated object (version.json) must already be present.
          throw new MissingObject(pkg.hash, pkg.name);
        }
        await this.#fetchInto(pkg.url, pkg.hash, pkg.source === "url");
      }
    }
  }
}
