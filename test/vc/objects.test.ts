import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommitObject,
  type Hash,
  type SnapshotObject,
  VcObjectStore,
  encodeObject,
  idOf,
  idOfEncoding,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const sha256hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function buildCommit(store: VcObjectStore): Promise<{ commit: CommitObject; id: Hash }> {
  const manifestBlob = await store.putBlob(new TextEncoder().encode("[project]\nname = 'p'\n"));
  const lockBlob = await store.putBlob(new TextEncoder().encode("version = 1\n"));
  const ignoreBlob = await store.putBlob(new Uint8Array());
  const snapshot: SnapshotObject = {
    type: "snapshot",
    manifest: manifestBlob,
    lock: lockBlob,
    ignore: ignoreBlob,
    carried: [],
    tracked: [],
  };
  const snapId = await store.put(snapshot);
  const commit: CommitObject = {
    type: "commit",
    snapshot: snapId,
    parents: [],
    gen: 0,
    author: "tester",
    time: 123,
    message: "hello",
    op: "initial",
  };
  const id = await store.put(commit);
  return { commit, id };
}

describe("vc object model", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function store(level?: number): Promise<VcObjectStore> {
    const anvilDir = await mkTmp("vc-obj");
    dirs.push(anvilDir);
    return new VcObjectStore({
      anvilDir,
      ...(level !== undefined ? { compressionLevel: level } : {}),
    });
  }

  it("GATE hash-uncompressed: the commit id is the sha256 of the UNCOMPRESSED encoding", async () => {
    const s = await store();
    const { commit, id } = await buildCommit(s);
    // The id must equal the sha256 of the uncompressed canonical encoding...
    const encoded = encodeObject(commit);
    expect(id.value).toBe(sha256hex(encoded));
    expect(idOf(commit).value).toBe(id.value);
    // ...and must NOT equal the sha256 of the compressed on-disk bytes.
    const onDisk = await readFile(join(s.objectsDir, id.value.slice(0, 2), id.value));
    expect(sha256hex(new Uint8Array(onDisk))).not.toBe(id.value);
  });

  it("GATE hash-uncompressed: the commit id is identical across compression levels", async () => {
    const lo = await store(1);
    const hi = await store(9);
    const a = await buildCommit(lo);
    const b = await buildCommit(hi);
    // Same logical object → identical content address, regardless of zlib level.
    expect(a.id.value).toBe(b.id.value);
    // The compressed bytes on disk DO differ (proving compression happened)...
    const loBytes = await readFile(join(lo.objectsDir, a.id.value.slice(0, 2), a.id.value));
    const hiBytes = await readFile(join(hi.objectsDir, b.id.value.slice(0, 2), b.id.value));
    expect(Buffer.compare(loBytes, hiBytes)).not.toBe(0);
    // ...yet both inflate back to the identical object.
    expect(await lo.get(a.id)).toEqual(await hi.get(b.id));
  });

  it("round-trips every object kind and re-verifies the content address on read", async () => {
    const s = await store();
    const blobId = await s.putBlob(new TextEncoder().encode("carried bytes"));
    expect(new TextDecoder().decode(await s.getBlobBytes(blobId))).toBe("carried bytes");
    const { commit, id } = await buildCommit(s);
    const read = await s.getCommit(id);
    expect(read).toEqual(commit);
  });

  it("dedups an identical object (idempotent put)", async () => {
    const s = await store();
    const a = await buildCommit(s);
    const b = await buildCommit(s);
    expect(a.id.value).toBe(b.id.value);
    let count = 0;
    for await (const _ of s.list()) {
      count += 1;
    }
    // blob(manifest) + blob(lock) + blob(ignore) + snapshot + commit = 5 objects.
    expect(count).toBe(5);
  });

  it("idOfEncoding matches idOf for a hand-encoded object", async () => {
    const commit: CommitObject = {
      type: "commit",
      snapshot: { algo: "sha256", value: "a".repeat(64) },
      parents: [],
      gen: 0,
      author: "x",
      time: 0,
      message: "m",
      op: "initial",
    };
    expect(idOfEncoding(encodeObject(commit)).value).toBe(idOf(commit).value);
  });
});
