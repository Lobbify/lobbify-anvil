/**
 * The `RemoteTransport` — the sync-level view of a remote, built over a
 * {@link TreeIO}. It knows the on-disk layout of a served instance and exposes
 * exactly what `clone`/`pull`/`push` need:
 *
 *   - {@link RemoteTransport.fetchHead} — the tracked branch's tip commit id +
 *     the `anvil.toml` / `anvil.lock` / `.anvilignore` text at that tip;
 *   - {@link RemoteTransport.fetchVcObject} — a raw (zlib) VC object, for walking
 *     and importing the remote's commit history;
 *   - {@link RemoteTransport.fetchObject} — a **copy** content object from the
 *     remote's object endpoint (or `undefined`, when the joiner re-fetches from
 *     source instead);
 *   - {@link RemoteTransport.publish} — push the two files + VC history + the
 *     **copy-only** content objects (never a replay object) to a writable tree.
 *
 * A served tree lays the VC store out exactly as the local `.anvil/` does
 * (`.anvil/objects/<shard>/<id>`, `.anvil/refs/heads/<branch>`), so transferring
 * history is a verbatim byte copy the receiver re-verifies on arrival. **Replay
 * (CurseForge) bytes are never part of any of this** — they live under
 * `.anvil/replay-cache/`, which no layout path here names.
 */

import { shardOf } from "../store/hash.js";
import { PushNotSupported, RemoteError } from "../types/errors.js";
import type { Hash } from "../types/index.js";
import { hashFromString, hashToString } from "../vc/objects.js";
import type { RemoteDescriptor } from "./descriptor.js";
import { remoteBranch } from "./descriptor.js";
import type { TreeIO } from "./tree-io.js";

/** The remote's tracked-branch tip: the two source files + a commit pointer. */
export interface RemoteHead {
  /** The branch tip commit id, when the remote publishes VC history. */
  readonly commit?: Hash;
  readonly branch: string;
  readonly manifest: string;
  readonly lock: string;
  readonly ignore?: string;
}

/** One VC object to publish: its id + raw (zlib-compressed) on-disk bytes. */
export interface VcObjectBlob {
  readonly id: Hash;
  readonly raw: Uint8Array;
}

/** One copy content object to publish: its content hash + bytes. */
export interface ContentObjectBlob {
  readonly hash: Hash;
  readonly bytes: Uint8Array;
}

/** Everything a `push` writes to a remote. Replay objects are excluded by contract. */
export interface PublishInput {
  readonly branch: string;
  readonly commit?: Hash;
  readonly manifest: string;
  readonly lock: string;
  readonly ignore?: string;
  readonly vcObjects: readonly VcObjectBlob[];
  readonly contentObjects: readonly ContentObjectBlob[];
}

export interface RemoteTransport {
  readonly descriptor: RemoteDescriptor;
  /** Whether `publish` is available (a writable tree / git). */
  readonly pushable: boolean;
  /**
   * Whether the remote hosts a **content-object endpoint** (copy bytes). A
   * writable served directory does; a git remote does not (it carries the two
   * files + VC history only — joiners re-fetch content from source). A push never
   * includes replay bytes regardless.
   */
  readonly hostsContent: boolean;
  fetchHead(ref?: string): Promise<RemoteHead>;
  /** Raw (zlib) VC object bytes for `id`, or `undefined`. */
  fetchVcObject(id: Hash): Promise<Uint8Array | undefined>;
  /** A copy content object's bytes from the remote object endpoint, or `undefined`. */
  fetchObject(hash: Hash): Promise<Uint8Array | undefined>;
  /** Publish to a writable remote (throws if `pushable` is false). */
  publish(input: PublishInput): Promise<void>;
}

// --- served-tree layout ----------------------------------------------------

/** The relative path a VC object occupies in a served tree. */
export function vcObjectPath(id: Hash): string {
  return `.anvil/objects/${shardOf(id.value)}/${id.value}`;
}

/** The relative path a copy content object occupies in a served tree's endpoint. */
export function contentObjectPath(hash: Hash): string {
  return `objects-content/${hash.algo}/${shardOf(hash.value)}/${hash.value}`;
}

/** The relative path a branch ref occupies in a served tree. */
export function branchRefPath(branch: string): string {
  return `.anvil/refs/heads/${branch}`;
}

const decoder = new TextDecoder();

/** A `RemoteTransport` over any {@link TreeIO} (a dir or an http base). */
export class ServedTreeTransport implements RemoteTransport {
  readonly descriptor: RemoteDescriptor;
  readonly #io: TreeIO;

  constructor(descriptor: RemoteDescriptor, io: TreeIO) {
    this.descriptor = descriptor;
    this.#io = io;
  }

  get pushable(): boolean {
    return typeof this.#io.write === "function";
  }

  get hostsContent(): boolean {
    return this.pushable;
  }

  async fetchHead(ref?: string): Promise<RemoteHead> {
    const branch = remoteBranch(this.descriptor, ref);
    const manifestBytes = await this.#io.read("anvil.toml");
    const lockBytes = await this.#io.read("anvil.lock");
    if (!manifestBytes || !lockBytes) {
      throw new RemoteError(
        this.descriptor.name,
        "the remote does not serve an anvil.toml + anvil.lock (not an anvil instance?)",
      );
    }
    const ignoreBytes = await this.#io.read(".anvilignore");
    const commit = await this.#readBranch(branch);
    return {
      ...(commit ? { commit } : {}),
      branch,
      manifest: decoder.decode(manifestBytes),
      lock: decoder.decode(lockBytes),
      ...(ignoreBytes ? { ignore: decoder.decode(ignoreBytes) } : {}),
    };
  }

  async #readBranch(branch: string): Promise<Hash | undefined> {
    const bytes = await this.#io.read(branchRefPath(branch));
    if (!bytes) {
      return undefined;
    }
    const line = decoder.decode(bytes).trim();
    if (line.length === 0) {
      return undefined;
    }
    return hashFromString(line, `remote ref ${branch}`);
  }

  async fetchVcObject(id: Hash): Promise<Uint8Array | undefined> {
    return this.#io.read(vcObjectPath(id));
  }

  async fetchObject(hash: Hash): Promise<Uint8Array | undefined> {
    return this.#io.read(contentObjectPath(hash));
  }

  async publish(input: PublishInput): Promise<void> {
    const write = this.#io.write;
    if (!write) {
      throw new PushNotSupported(this.descriptor.name, this.descriptor.kind);
    }
    const put = (rel: string, bytes: Uint8Array) => write.call(this.#io, rel, bytes);
    const enc = new TextEncoder();
    // VC history + content objects first, so a reader that sees the advanced ref
    // can always resolve every object it points at (write refs last).
    for (const obj of input.vcObjects) {
      await put(vcObjectPath(obj.id), obj.raw);
    }
    for (const obj of input.contentObjects) {
      await put(contentObjectPath(obj.hash), obj.bytes);
    }
    await put("anvil.toml", enc.encode(input.manifest));
    await put("anvil.lock", enc.encode(input.lock));
    if (input.ignore !== undefined) {
      await put(".anvilignore", enc.encode(input.ignore));
    }
    if (input.commit) {
      await put(branchRefPath(input.branch), enc.encode(`${hashToString(input.commit)}\n`));
      await put(".anvil/HEAD", enc.encode(`ref: refs/heads/${input.branch}\n`));
    }
  }
}
