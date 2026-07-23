/**
 * Content-addressed **object transfer** for `clone`/`pull`, and the untrusted-lock
 * **veto** that gates it.
 *
 * ## The transfer policy (per the plan)
 *
 * For a **copy** object the build needs and the local store lacks:
 *   1. **local store** — already present ⇒ nothing to transfer (the "rest stay
 *      linked" case: only the changed objects move);
 *   2. **remote object endpoint** — fetch the bytes from the remote, verifying the
 *      sha **on arrival** (the store admits them only if they hash to the pin);
 *   3. **re-fetch from source** — else fall back to the normal build acquirer,
 *      which re-fetches the object from its origin (Modrinth/URL/Mojang), again
 *      sha-verified on admission.
 *
 * A **replay** (CurseForge) object is *never* transferred: it routes to the
 * per-client {@link ReplayAcquirer} through the base acquirer, re-fetched under
 * the user's own key into the instance replay cache. No endpoint path here can
 * ever carry a replay object — this acquirer only reaches the remote endpoint for
 * `provenance === "copy"`.
 *
 * ## The veto (untrusted remote lock)
 *
 * A remote publishes the lock, so it is **untrusted**: {@link validateRemoteLock}
 * runs the host `allowSource` policy — and the SSRF scheme/IP checks — against the
 * **resolved URL** of every transferable item *before any byte is fetched*, so a
 * remote that pins a legit id to a hostile URL is vetoed up front.
 */

import { isIP } from "node:net";
import type { Acquirer } from "../build/acquire.js";
import type { AnvilEvent } from "../events.js";
import { assertHttpScheme, isBlockedIp } from "../sources/ssrf.js";
import type { ContentStore } from "../store/index.js";
import { SourceNotAllowed, SsrfBlocked } from "../types/errors.js";
import type { AllowSource, LockPackage, Lockfile } from "../types/index.js";
import type { RemoteTransport } from "./transport.js";

/**
 * Vet a **pulled** (untrusted) lock before transferring anything from it: the host
 * `allowSource` policy — and the SSRF scheme / IP-literal checks — see the
 * resolved URL of every non-replay item that carries one. A vetoed source or a
 * hostile URL throws before a single byte is fetched. Replay rows carry no
 * rehostable URL by construction; one that does is a ToS-violating lock and is
 * rejected.
 */
export function validateRemoteLock(lock: Lockfile, allowSource: AllowSource): void {
  for (const pkg of lock.resolved) {
    if (pkg.provenance === "replay") {
      if (pkg.url !== undefined) {
        // A replay row must never pin a rehostable URL — a remote that ships one
        // is trying to smuggle a transfer path for CurseForge bytes.
        throw new SourceNotAllowed(
          pkg.source,
          `${pkg.name} (a replay item must not carry a rehostable url)`,
        );
      }
      continue;
    }
    if (pkg.url === undefined) {
      continue;
    }
    // The host policy sees the resolved URL as the ref id — a remote that pins a
    // legit project to a hostile URL is vetoed here.
    if (!allowSource({ source: pkg.source, id: pkg.url, versionSpec: { kind: "latest" } })) {
      throw new SourceNotAllowed(pkg.source, pkg.url);
    }
    // Scheme + IP-literal SSRF veto (the DNS-resolved veto for a *hostname* still
    // runs per-hop at fetch time; this catches a literal internal address pinned in
    // the lock up front). A non-IP hostname passes here and is vetted at fetch.
    if (pkg.url.startsWith("file:")) {
      continue; // a local file url — not a network fetch
    }
    const parsed = assertHttpScheme(pkg.url);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isBlockedIp(host)) {
      throw new SsrfBlocked(pkg.url, `host ${host} is an internal/reserved address`);
    }
  }
}

export interface RemotePullAcquirerOptions {
  readonly base: Acquirer;
  readonly transport: RemoteTransport;
  readonly store: ContentStore;
  readonly emit?: (event: AnvilEvent) => void;
}

/**
 * The `clone`/`pull` acquirer: **local store → remote object endpoint → source**
 * for copy objects; delegate everything else (replay, game) to the base acquirer.
 * A replay object never touches the endpoint path.
 */
export class RemotePullAcquirer implements Acquirer {
  readonly #base: Acquirer;
  readonly #transport: RemoteTransport;
  readonly #store: ContentStore;
  readonly #emit?: (event: AnvilEvent) => void;

  constructor(opts: RemotePullAcquirerOptions) {
    this.#base = opts.base;
    this.#transport = opts.transport;
    this.#store = opts.store;
    this.#emit = opts.emit;
  }

  async ensure(pkg: LockPackage): Promise<void> {
    // Only a single-file, non-game copy object is endpoint-eligible. Replay routes
    // to the per-client ReplayAcquirer through the base; game-install items
    // (`store-only` / `asset-tree` / `runtime-tree`, or the Mojang source) fan out
    // to leaf objects the endpoint cannot serve piecemeal, so they go to the base
    // acquirer (Mojang installer) untouched.
    if (pkg.provenance !== "copy" || pkg.placement.method !== "link" || pkg.source === "mojang") {
      await this.#base.ensure(pkg);
      return;
    }
    // 1. Already in the local store → nothing transfers (stays linked).
    if (await this.#store.has(pkg.hash)) {
      this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: true });
      return;
    }
    // 2. The remote object endpoint (copy only), verifying sha on arrival.
    if (this.#transport.hostsContent) {
      const bytes = await this.#transport.fetchObject(pkg.hash);
      if (bytes) {
        this.#emit?.({
          type: "object:fetch",
          hash: pkg.hash,
          received: bytes.byteLength,
          ...(pkg.size !== undefined ? { total: pkg.size } : {}),
        });
        // putBuffer verifies the bytes hash to the pin BEFORE admission — a
        // corrupted mirror is rejected here (ShaMismatch), never built.
        await this.#store.putBuffer(bytes, pkg.hash.algo, pkg.hash);
        this.#emit?.({ type: "object:store", hash: pkg.hash, deduped: false });
        return;
      }
    }
    // 3. Fall back to re-fetch-from-source (the base acquirer, sha-verified too).
    await this.#base.ensure(pkg);
  }
}
