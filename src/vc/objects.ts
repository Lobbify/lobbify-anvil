/**
 * The `.anvil/` version-control object model — anvil's own content-addressed
 * object store (NOT a git wrapper). Three object kinds, all **sha256-addressed**:
 *
 *   - `blob`     — raw bytes (a serialized manifest / lock / `.anvilignore`, or a
 *                  carried local-file byte stream).
 *   - `snapshot` — the tracked working-tree state: the manifest / lock / ignore
 *                  blobs plus the carried local-blob closure.
 *   - `commit`   — a snapshot + parents + a **generation number** (authoritative
 *                  for ordering) + display-only author/time + message + op.
 *
 * The single load-bearing rule (mandated by the Security section of the plan):
 * **the object id is the sha256 of the UNCOMPRESSED canonical encoding.** Objects
 * are stored zlib-compressed on disk to save space, but zlib output is not stable
 * across zlib/Node versions or platforms — so hashing the compressed bytes would
 * make a commit id host-dependent and break the "identical commit hash on Node
 * 20/22 and every OS" guarantee. We hash the uncompressed encoding; compression is
 * a storage detail the address never sees.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { hashBuffer, shardOf } from "../store/hash.js";
import { LockParseError } from "../types/errors.js";
import type { Hash } from "../types/index.js";

/** The three VC object kinds. */
export type VcObjectType = "blob" | "snapshot" | "commit";

/** The operation that produced a commit (display + audit; never trusted for ordering). */
export type CommitOp = "initial" | "commit" | "merge" | "rebase" | "revert" | "import";

/** One carried local blob: a tracked local/config file's bytes, kept self-contained. */
export interface CarriedBlob {
  /** The instance-relative POSIX target path the file materializes to. */
  readonly path: string;
  /** The VC blob object id holding the bytes. */
  readonly blob: Hash;
  /** The shared-store content hash (the lock pin) these bytes address to. */
  readonly content: Hash;
}

/** A snapshot object — the tracked working-tree state at a commit. */
export interface SnapshotObject {
  readonly type: "snapshot";
  /** Blob id of the canonical `anvil.toml`. */
  readonly manifest: Hash;
  /** Blob id of the canonical `anvil.lock`. */
  readonly lock: Hash;
  /** Blob id of the `.anvilignore` (an empty-content blob when none). */
  readonly ignore: Hash;
  /** The carried local-blob closure, sorted by path. */
  readonly carried: readonly CarriedBlob[];
}

/** A commit object. `gen` orders history; `time` is display-only (never trusted). */
export interface CommitObject {
  readonly type: "commit";
  readonly snapshot: Hash;
  /** Parent commit ids, first-parent first (empty for a root commit). */
  readonly parents: readonly Hash[];
  /** Generation number — 0 for a root, else 1 + max(parent gens). Authoritative. */
  readonly gen: number;
  /** Display-only author label. */
  readonly author: string;
  /** Display-only wall-clock (ms since epoch). NEVER used for ordering or LCA. */
  readonly time: number;
  readonly message: string;
  readonly op: CommitOp;
}

/** A blob object — arbitrary bytes. */
export interface BlobObject {
  readonly type: "blob";
  readonly bytes: Uint8Array;
}

export type VcObject = BlobObject | SnapshotObject | CommitObject;

const HEADER_PREFIX = "anvil-object:";

/** Render a hash as the compact `"algo:value"` string (VC objects are sha256). */
export function hashToString(hash: Hash): string {
  return `${hash.algo}:${hash.value}`;
}

/** Parse a `"sha256:hex"` string back to a {@link Hash} (VC ids are always sha256). */
export function hashFromString(raw: string, where = "vc object"): Hash {
  const idx = raw.indexOf(":");
  if (idx <= 0) {
    throw new LockParseError(`${where}: malformed hash "${raw}"`);
  }
  const algo = raw.slice(0, idx);
  const value = raw.slice(idx + 1);
  if (algo !== "sha256" && algo !== "sha1") {
    throw new LockParseError(`${where}: unexpected hash algorithm "${algo}"`);
  }
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new LockParseError(`${where}: hash value is not lowercase hex`);
  }
  return { algo, value };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Stable stringify: object keys sorted recursively, no whitespace (a stable, compact form). */
function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): JsonValue => {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(normalize);
    }
    if (typeof v === "object") {
      const out: { [k: string]: JsonValue } = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        const child = (v as Record<string, unknown>)[key];
        if (child !== undefined) {
          out[key] = normalize(child);
        }
      }
      return out;
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

/** The canonical body bytes for a non-blob object (sorted-key JSON). */
function structBody(obj: SnapshotObject | CommitObject): Uint8Array {
  if (obj.type === "snapshot") {
    return new TextEncoder().encode(
      canonicalJson({
        type: "snapshot",
        manifest: hashToString(obj.manifest),
        lock: hashToString(obj.lock),
        ignore: hashToString(obj.ignore),
        carried: [...obj.carried]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((c) => ({
            path: c.path,
            blob: hashToString(c.blob),
            content: hashToString(c.content),
          })),
      }),
    );
  }
  return new TextEncoder().encode(
    canonicalJson({
      type: "commit",
      snapshot: hashToString(obj.snapshot),
      parents: obj.parents.map(hashToString),
      gen: obj.gen,
      author: obj.author,
      time: obj.time,
      message: obj.message,
      op: obj.op,
    }),
  );
}

/**
 * The UNCOMPRESSED canonical encoding of an object: a type header line followed by
 * the body. This is exactly the byte sequence whose sha256 is the object id — the
 * bytes compression must never influence.
 */
export function encodeObject(obj: VcObject): Uint8Array {
  const header = new TextEncoder().encode(`${HEADER_PREFIX}${obj.type}\n`);
  const body = obj.type === "blob" ? obj.bytes : structBody(obj);
  const out = new Uint8Array(header.byteLength + body.byteLength);
  out.set(header, 0);
  out.set(body, header.byteLength);
  return out;
}

/** The object id of an already-encoded object — sha256 of the uncompressed bytes. */
export function idOfEncoding(encoded: Uint8Array): Hash {
  return hashBuffer(encoded, "sha256");
}

/** The object id of an object — sha256 of its uncompressed canonical encoding. */
export function idOf(obj: VcObject): Hash {
  return idOfEncoding(encodeObject(obj));
}

function decodeObject(encoded: Uint8Array): VcObject {
  const nl = encoded.indexOf(0x0a); // first '\n'
  if (nl < 0) {
    throw new LockParseError("vc object: missing header");
  }
  const header = new TextDecoder().decode(encoded.subarray(0, nl));
  if (!header.startsWith(HEADER_PREFIX)) {
    throw new LockParseError(`vc object: bad header "${header}"`);
  }
  const type = header.slice(HEADER_PREFIX.length) as VcObjectType;
  const body = encoded.subarray(nl + 1);
  if (type === "blob") {
    return { type: "blob", bytes: new Uint8Array(body) };
  }
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  if (type === "snapshot") {
    const carriedRaw = Array.isArray(parsed.carried) ? parsed.carried : [];
    return {
      type: "snapshot",
      manifest: hashFromString(String(parsed.manifest), "snapshot.manifest"),
      lock: hashFromString(String(parsed.lock), "snapshot.lock"),
      ignore: hashFromString(String(parsed.ignore), "snapshot.ignore"),
      carried: carriedRaw.map((c) => {
        const e = c as Record<string, unknown>;
        return {
          path: String(e.path),
          blob: hashFromString(String(e.blob), "snapshot.carried.blob"),
          content: hashFromString(String(e.content), "snapshot.carried.content"),
        };
      }),
    };
  }
  if (type === "commit") {
    const parentsRaw = Array.isArray(parsed.parents) ? parsed.parents : [];
    return {
      type: "commit",
      snapshot: hashFromString(String(parsed.snapshot), "commit.snapshot"),
      parents: parentsRaw.map((p) => hashFromString(String(p), "commit.parent")),
      gen: Number(parsed.gen),
      author: String(parsed.author),
      time: Number(parsed.time),
      message: String(parsed.message),
      op: String(parsed.op) as CommitOp,
    };
  }
  throw new LockParseError(`vc object: unknown type "${type}"`);
}

/** Options for {@link VcObjectStore}. */
export interface VcObjectStoreOptions {
  /** The `.anvil/` directory this store lives under. */
  readonly anvilDir: string;
  /**
   * zlib compression level (0–9). Storage-only — it can NEVER change an object
   * id, since ids are sha256 of the uncompressed encoding. Exposed so a test can
   * prove that invariant by round-tripping at two levels.
   */
  readonly compressionLevel?: number;
}

/**
 * The VC object store under `.anvil/objects/`. Writes are atomic (`tmp → rename`),
 * objects are zlib-compressed on disk and land `0444` (immutable), and reads
 * inflate + re-verify the content address. The address is always the sha256 of the
 * uncompressed encoding, so compression is invisible to identity.
 */
export class VcObjectStore {
  readonly #objectsDir: string;
  readonly #level: number;

  constructor(opts: VcObjectStoreOptions) {
    this.#objectsDir = join(opts.anvilDir, "objects");
    this.#level = opts.compressionLevel ?? 6;
  }

  get objectsDir(): string {
    return this.#objectsDir;
  }

  #pathOf(hash: Hash): string {
    return join(this.#objectsDir, shardOf(hash.value), hash.value);
  }

  async has(hash: Hash): Promise<boolean> {
    try {
      await stat(this.#pathOf(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** Admit an object; returns its content-address id. Dedups when already present. */
  async put(obj: VcObject): Promise<Hash> {
    const encoded = encodeObject(obj);
    const id = idOfEncoding(encoded);
    const dest = this.#pathOf(id);
    if (await this.has(id)) {
      return id;
    }
    const compressed = deflateSync(encoded, { level: this.#level });
    const tmpDir = join(this.#objectsDir, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.tmp`);
    await writeFile(tmp, compressed);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(tmp, dest);
    } catch (err) {
      if (await this.has(id)) {
        await rm(tmp, { force: true });
        return id;
      }
      throw err;
    }
    await chmod(dest, 0o444).catch(() => undefined);
    return id;
  }

  /** Admit raw bytes as a blob object; returns the blob id. */
  async putBlob(bytes: Uint8Array): Promise<Hash> {
    return this.put({ type: "blob", bytes });
  }

  /**
   * Read an object's raw **on-disk (zlib-compressed) bytes**, for transferring VC
   * history to a remote verbatim (no decode/re-encode round-trip). Returns
   * `undefined` when the object is absent.
   */
  async readRaw(hash: Hash): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#pathOf(hash)));
    } catch {
      return undefined;
    }
  }

  /**
   * Import an object received from a remote by its raw on-disk (zlib-compressed)
   * bytes, **verifying the content address on arrival** (inflate → re-hash the
   * uncompressed encoding → reject a mismatch). This is the VC-layer half of
   * sha-verify-on-arrival: a corrupted/hostile mirror can never inject an object
   * under a hash it does not actually hash to. Dedups when already present.
   */
  async importRaw(id: Hash, compressed: Uint8Array): Promise<void> {
    if (await this.has(id)) {
      return;
    }
    let encoded: Uint8Array;
    try {
      encoded = new Uint8Array(inflateSync(compressed));
    } catch (err) {
      throw new LockParseError(
        `remote VC object ${hashToString(id)} is not valid zlib (${(err as Error).message})`,
      );
    }
    const actual = idOfEncoding(encoded);
    if (actual.value !== id.value) {
      throw new LockParseError(
        `remote VC object ${hashToString(id)} failed content-address verification ` +
          `(bytes hash to ${actual.value})`,
      );
    }
    const dest = this.#pathOf(id);
    const tmpDir = join(this.#objectsDir, "tmp");
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.tmp`);
    await writeFile(tmp, compressed);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(tmp, dest);
    } catch (err) {
      if (await this.has(id)) {
        await rm(tmp, { force: true });
        return;
      }
      throw err;
    }
    await chmod(dest, 0o444).catch(() => undefined);
  }

  /** Read + inflate + decode the object at `hash`, re-verifying its content address. */
  async get(hash: Hash): Promise<VcObject> {
    const compressed = await readFile(this.#pathOf(hash));
    const encoded = new Uint8Array(inflateSync(compressed));
    const actual = idOfEncoding(encoded);
    if (actual.value !== hash.value) {
      throw new LockParseError(
        `vc object ${hashToString(hash)} is corrupt (content hashes to ${actual.value})`,
      );
    }
    return decodeObject(encoded);
  }

  /** Read a commit object (asserting its type). */
  async getCommit(hash: Hash): Promise<CommitObject> {
    const obj = await this.get(hash);
    if (obj.type !== "commit") {
      throw new LockParseError(`expected a commit at ${hashToString(hash)}, got ${obj.type}`);
    }
    return obj;
  }

  /** Read a snapshot object (asserting its type). */
  async getSnapshot(hash: Hash): Promise<SnapshotObject> {
    const obj = await this.get(hash);
    if (obj.type !== "snapshot") {
      throw new LockParseError(`expected a snapshot at ${hashToString(hash)}, got ${obj.type}`);
    }
    return obj;
  }

  /** Read a blob object's bytes (asserting its type). */
  async getBlobBytes(hash: Hash): Promise<Uint8Array> {
    const obj = await this.get(hash);
    if (obj.type !== "blob") {
      throw new LockParseError(`expected a blob at ${hashToString(hash)}, got ${obj.type}`);
    }
    return obj.bytes;
  }

  /** Every stored object id (for GC). */
  async *list(): AsyncGenerator<Hash> {
    let shards: string[];
    try {
      shards = await readdir(this.#objectsDir);
    } catch {
      return;
    }
    for (const shard of shards.sort()) {
      if (shard === "tmp") {
        continue;
      }
      let names: string[];
      try {
        names = await readdir(join(this.#objectsDir, shard));
      } catch {
        continue;
      }
      for (const value of names.sort()) {
        yield { algo: "sha256", value };
      }
    }
  }

  /** Sweep unreachable objects, keeping exactly the ids in `keep`. */
  async prune(keep: ReadonlySet<string>): Promise<{ removed: number; freedBytes: number }> {
    let removed = 0;
    let freedBytes = 0;
    for await (const id of this.list()) {
      if (keep.has(id.value)) {
        continue;
      }
      const p = this.#pathOf(id);
      let size = 0;
      try {
        size = (await stat(p)).size;
      } catch {
        continue;
      }
      await chmod(p, 0o644).catch(() => undefined);
      try {
        await rm(p, { force: true });
        removed += 1;
        freedBytes += size;
      } catch {
        // best-effort
      }
    }
    return { removed, freedBytes };
  }
}
