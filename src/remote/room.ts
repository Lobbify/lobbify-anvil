/**
 * The **Lobbify room** remote transport — the integration seam for a `lobby://`
 * remote. The actual room server is **external** (owned by the Lobbify backend),
 * so this transport wires the seam without embedding that protocol:
 *
 *   - **reads** go through a served-tree view over an injected {@link RoomClient}
 *     `read(relPath)` (the host app maps a `lobby://<host>/<room>` address to its
 *     own fetch); the default maps `lobby://…` → `https://…` and reads over the
 *     supplied SSRF-guarded {@link Http}.
 *   - **publishing is publish-on-build**: a room is updated by the *host* app when
 *     it builds, not by the standalone tool. `push` therefore routes to an
 *     injected {@link RoomClient.publish} seam, or fails with a clear message
 *     naming the host-app responsibility.
 *
 * Two policy invariants the seam enforces, per the plan:
 *   - a room build applies the host `allowSource` policy (wired by the caller);
 *   - a room **never carries a CurseForge key** — replay-under-an-org-key is a
 *     separate legal dependency; the OSS tool stays BYO-key and a room build drops
 *     any configured key (enforced where the room transport is constructed).
 */

import { RemoteError } from "../types/errors.js";
import type { Http } from "../types/index.js";
import type { Hash } from "../types/index.js";
import type { RemoteDescriptor } from "./descriptor.js";
import type { PublishInput, RemoteHead, RemoteTransport } from "./transport.js";
import { ServedTreeTransport } from "./transport.js";
import { HttpTreeIO } from "./tree-io.js";

/** The host-app seam the room transport reads/publishes through. */
export interface RoomClient {
  /** Read a served-tree relative path from the room, or `undefined` if absent. */
  read(relPath: string): Promise<Uint8Array | undefined>;
  /** Publish a build to the room (present ⇒ this client can push). */
  publish?(input: PublishInput): Promise<void>;
}

export interface RoomTransportOptions {
  readonly descriptor: RemoteDescriptor;
  /** The host-app room client; defaults to an http reader over `lobby://`→`https://`. */
  readonly client?: RoomClient;
  /** The http client used by the default (http) room reader. */
  readonly http?: Http;
}

/** Map a `lobby://host/path` address to an `https://host/path` base URL. */
export function roomHttpBase(url: string): string {
  return url.replace(/^lobby:\/\//i, "https://");
}

export class RoomTransport implements RemoteTransport {
  readonly descriptor: RemoteDescriptor;
  readonly #client: RoomClient;
  readonly #served: ServedTreeTransport;

  constructor(opts: RoomTransportOptions) {
    this.descriptor = opts.descriptor;
    if (opts.client) {
      this.#client = opts.client;
    } else {
      if (!opts.http) {
        throw new RemoteError(
          opts.descriptor.name,
          "a lobby:// room needs a room client or an http client to read from",
        );
      }
      const io = new HttpTreeIO(roomHttpBase(opts.descriptor.url), opts.http);
      this.#client = { read: (rel) => io.read(rel) };
    }
    // A served view over the room client's read seam (read-only reads reuse the
    // exact served-tree layout the host app publishes to).
    this.#served = new ServedTreeTransport(this.descriptor, {
      read: (rel) => this.#client.read(rel),
    });
  }

  get pushable(): boolean {
    return typeof this.#client.publish === "function";
  }

  readonly hostsContent = false;

  fetchHead(ref?: string): Promise<RemoteHead> {
    return this.#served.fetchHead(ref);
  }

  fetchVcObject(id: Hash): Promise<Uint8Array | undefined> {
    return this.#served.fetchVcObject(id);
  }

  fetchObject(_hash: Hash): Promise<Uint8Array | undefined> {
    // A room re-serves content per-client from source; it hosts no object endpoint.
    return Promise.resolve(undefined);
  }

  async publish(input: PublishInput): Promise<void> {
    if (!this.#client.publish) {
      throw new RemoteError(
        this.descriptor.name,
        "a Lobbify room is published on build by the host app — the standalone tool cannot push to it",
      );
    }
    // A room never carries content or replay bytes over the wire.
    await this.#client.publish({ ...input, contentObjects: [] });
  }
}
