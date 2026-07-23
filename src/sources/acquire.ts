/**
 * The network acquirer: fetch a pinned package's bytes at **build time** using
 * its source's {@link Source.plan} (which does no network I/O itself — it only
 * turns a lock row into a fetch instruction). This is how "copy items get real
 * fetch plans": a build on a fresh machine materializes Modrinth / URL / local
 * items straight from the lock.
 *
 * It fetches only what the lock already pins; the arrived bytes are verified
 * against the pinned hash before the store admits them (a mismatch is a hard
 * stop). The `url` source's fetch re-applies the SSRF guard. Game (Mojang) and
 * CurseForge acquisition are out of scope here (Stages 3 and 6).
 */

import { fileURLToPath } from "node:url";
import type { Acquirer } from "../build/acquire.js";
import type { AnvilEvent } from "../events.js";
import type { ContentStore } from "../store/index.js";
import { MissingObject } from "../types/errors.js";
import type { AllowSource, LockPackage, SourceContext } from "../types/index.js";
import type { SourceRegistry } from "./registry.js";
import { defaultAllowSource } from "./registry.js";
import { guardHop } from "./ssrf.js";

export interface NetworkAcquirerOptions {
  readonly store: ContentStore;
  readonly registry: SourceRegistry;
  readonly allowSource?: AllowSource;
  readonly curseforgeKey?: string;
  readonly emit?: (event: AnvilEvent) => void;
}

export class NetworkAcquirer implements Acquirer {
  readonly #store: ContentStore;
  readonly #registry: SourceRegistry;
  readonly #ctx: SourceContext;
  readonly #emit?: (event: AnvilEvent) => void;

  constructor(options: NetworkAcquirerOptions) {
    this.#store = options.store;
    this.#registry = options.registry;
    this.#emit = options.emit;
    this.#ctx = {
      offline: false,
      now: Date.now(),
      allowSource: options.allowSource ?? defaultAllowSource,
      ...(options.curseforgeKey ? { curseforgeKey: options.curseforgeKey } : {}),
    };
  }

  async ensure(pkg: LockPackage): Promise<void> {
    if (await this.#store.has(pkg.hash)) {
      this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: true });
      return;
    }
    const entry = this.#registry.get(pkg.source);
    if (!entry) {
      throw new MissingObject(pkg.hash, pkg.name);
    }
    const plan = entry.source.plan(pkg, this.#ctx);
    this.#emit?.({
      type: "object:fetch",
      hash: pkg.hash,
      received: 0,
      ...(plan.size !== undefined ? { total: plan.size } : {}),
    });

    if (plan.url.startsWith("file:")) {
      // Local item: copy the file, verifying the pinned hash on admission.
      await this.#store.putFile(fileURLToPath(plan.url), plan.expected.algo, plan.expected);
    } else {
      if (!entry.http) {
        throw new MissingObject(pkg.hash, pkg.name);
      }
      const guard = pkg.source === "url" ? { guard: guardHop } : {};
      const res = await entry.http.get(plan.url, {
        ...guard,
        ...(plan.headers ? { headers: plan.headers } : {}),
      });
      await this.#store.putBuffer(res.body, plan.expected.algo, plan.expected);
    }
    this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: false });
  }
}
