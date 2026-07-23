/**
 * Stage-7 — transport branches: a writable directory is a push target; a static
 * `http(s)` remote is read-only (a clear `PushNotSupported`); a `lobby://` room
 * reads through its client seam and publishes on-build (or refuses clearly).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirTreeIO,
  type Http,
  type HttpResult,
  HttpTreeIO,
  type PublishInput,
  PushNotSupported,
  type RoomClient,
  RoomTransport,
  ServedTreeTransport,
  makeDescriptor,
  makeTransport,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

/** A fake http serving fixed bytes per relative path off a base. */
function fakeStaticHttp(base: string, files: Record<string, string>): Http {
  return {
    async get(url: string): Promise<HttpResult> {
      const rel = url.slice(base.length + 1);
      const body = files[rel];
      if (body === undefined) {
        const { HttpError } = await import("../../index.js");
        throw new HttpError(url, "not found", 404);
      }
      return { status: 200, headers: {}, url, body: new TextEncoder().encode(body) };
    },
  };
}

const MANIFEST =
  '[project]\nname = "p"\nversion = "1.0.0"\n\n[game]\nminecraft = "26.2"\nloader = "fabric 0.19.1"\n\nitems = []\n';
const LOCK =
  '# anvil.lock\nversion = 1\n\n[meta]\nminecraft = "26.2"\nloader = "fabric 0.19.1"\njava = "j"\nmanifest_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"\n';

describe("transport pushability", () => {
  it("a writable directory remote is a push target; hostsContent is true", async () => {
    const dir = await mkTmp("dir-remote");
    dirs.push(dir);
    const t = makeTransport(makeDescriptor("origin", dir), { clonesDir: dir });
    expect(t.pushable).toBe(true);
    expect(t.hostsContent).toBe(true);
  });

  it("a static http remote is read-only — publish throws PushNotSupported", async () => {
    const base = "https://static.example.com/pack";
    const http = fakeStaticHttp(base, { "anvil.toml": MANIFEST, "anvil.lock": LOCK });
    const descriptor = makeDescriptor("origin", base);
    expect(descriptor.kind).toBe("url");
    const t = makeTransport(descriptor, { http });
    expect(t.pushable).toBe(false);
    expect(t.hostsContent).toBe(false);
    // It can still be read from (a pull source)…
    const head = await t.fetchHead();
    expect(head.manifest).toContain("minecraft");
    // …but never pushed to.
    await expect(
      t.publish({
        branch: "main",
        manifest: MANIFEST,
        lock: LOCK,
        vcObjects: [],
        contentObjects: [],
      }),
    ).rejects.toBeInstanceOf(PushNotSupported);
  });
});

describe("lobby:// room seam", () => {
  it("reads through the room client and publishes on-build through the seam", async () => {
    const served: Record<string, Uint8Array> = {
      "anvil.toml": new TextEncoder().encode(MANIFEST),
      "anvil.lock": new TextEncoder().encode(LOCK),
    };
    let published: PublishInput | undefined;
    const client: RoomClient = {
      async read(rel) {
        return served[rel];
      },
      async publish(input) {
        published = input;
      },
    };
    const t = new RoomTransport({
      descriptor: makeDescriptor("room", "lobby://host/room-1"),
      client,
    });
    expect(t.pushable).toBe(true);
    const head = await t.fetchHead();
    expect(head.lock).toContain("meta");

    await t.publish({
      branch: "main",
      manifest: MANIFEST,
      lock: LOCK,
      vcObjects: [],
      contentObjects: [
        { hash: { algo: "sha256", value: "a".repeat(64) }, bytes: new Uint8Array([1]) },
      ],
    });
    // A room never carries content bytes over the wire — the seam receives none.
    expect(published?.contentObjects).toEqual([]);
  });

  it("a room without a publish seam refuses to push with a clear message", async () => {
    const client: RoomClient = {
      async read() {
        return undefined;
      },
    };
    const t = new RoomTransport({
      descriptor: makeDescriptor("room", "lobby://host/room-2"),
      client,
    });
    expect(t.pushable).toBe(false);
    await expect(
      t.publish({ branch: "main", manifest: "", lock: "", vcObjects: [], contentObjects: [] }),
    ).rejects.toThrow(/published on build/);
  });
});

/** A tiny compile-time exercise that the tree-io classes are exported + usable. */
describe("tree-io exports", () => {
  it("DirTreeIO reads what it writes; HttpTreeIO wraps a base", async () => {
    const dir = await mkTmp("tree");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil"), { recursive: true });
    await writeFile(join(dir, "anvil.toml"), "hello");
    const io = new DirTreeIO(dir);
    expect(new TextDecoder().decode((await io.read("anvil.toml")) as Uint8Array)).toBe("hello");
    expect(await io.read("missing")).toBeUndefined();
    // A ServedTreeTransport over it is pushable.
    const t = new ServedTreeTransport(makeDescriptor("o", dir), io);
    expect(t.pushable).toBe(true);
    // HttpTreeIO is read-only (no write method).
    const http = new HttpTreeIO("https://x/y", {
      async get() {
        return { status: 200, headers: {}, url: "", body: new Uint8Array() };
      },
    });
    expect((http as { write?: unknown }).write).toBeUndefined();
  });
});
