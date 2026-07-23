/**
 * Security batch — SSRF hardening + remote-lock provenance veto.
 *
 * Regression coverage for three hands-on findings:
 *
 *   - **F2** the SSRF guard is a property of the HTTP path (on by default) and of
 *     the acquire path, so EVERY source's byte download is vetted — not just
 *     `url`. A modrinth/generic download to an internal host is blocked.
 *   - **F3** `validateRemoteLock` DNS-resolves each row's hostname and rejects one
 *     that resolves to an internal IP — across a NON-`url` source, closing the
 *     "hostnames are vetted at fetch, but fetch only guarded `url`" bypass.
 *   - **F4** `validateRemoteLock` refuses a remote lock that carries `local`
 *     provenance or a `file://` URL — a remote author cannot make the puller read
 *     an arbitrary local path. Local sources stay valid for a *local* manifest.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  LocalSource,
  ModrinthSource,
  NetworkAcquirer,
  SourceNotAllowed,
  SsrfBlocked,
  validateRemoteLock,
} from "../../index.js";
import type { LockPackage, Lockfile, SourceContext } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  type ScriptedResponse,
  fabricJar,
  makeScriptedHttp,
  registryWith,
  sha1hex,
  sha256hex,
} from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
const okBytes = (bytes: Uint8Array): ScriptedResponse => ({ status: 200, body: bytes });

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

async function freshStore(label: string): Promise<ContentStore> {
  const store = new ContentStore({ root: await mkTmp(label) });
  dirs.push(store.root);
  return store;
}

function lockOf(pkg: LockPackage): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "0".repeat(64) },
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "j",
    },
    resolved: [pkg],
  };
}

// --- F2: the guard is a default property of the transport ------------------

describe("F2 — the SSRF guard is on by default in the HTTP transport", () => {
  it("blocks a request whose host resolves to loopback, with NO explicit guard", async () => {
    const s = makeScriptedHttp({
      handler: () => okBytes(new TextEncoder().encode("SECRET")),
      lookup: async () => ["127.0.0.1"], // public-looking host, internal address
    });
    await expect(s.http.get("https://mirror.example/file.jar")).rejects.toBeInstanceOf(SsrfBlocked);
    expect(s.requests).toHaveLength(0); // never dispatched
  });

  it("allows a request whose host resolves to a public address", async () => {
    const s = makeScriptedHttp({
      handler: () => okBytes(new TextEncoder().encode("OK")),
      lookup: async () => ["93.184.216.34"],
    });
    const res = await s.http.get("https://mirror.example/file.jar");
    expect(new TextDecoder().decode(res.body)).toBe("OK");
  });
});

// --- F2: the acquire path guards EVERY source, not just `url` --------------

describe("F2 — NetworkAcquirer guards every source's download, not just url", () => {
  function modPkg(bytes: Uint8Array, url: string): LockPackage {
    return {
      name: "mymod",
      kind: "mod",
      source: "modrinth",
      version: "1.0.0",
      hash: { algo: "sha256", value: sha256hex(bytes) },
      provenance: "copy",
      placement: { method: "link", target: "mods/mymod.jar" },
      size: bytes.byteLength,
      url,
    };
  }

  it("blocks a modrinth (non-url) copy download to an internal host", async () => {
    const store = await freshStore("sec-store-block");
    const bytes = fabricJar("x");
    // IP-literal internal host: caught regardless of the injected resolver.
    const pkg = modPkg(bytes, "http://10.0.0.5/internal.jar");
    const scripted = makeScriptedHttp({ handler: () => okBytes(bytes) });
    const acq = new NetworkAcquirer({ store, registry: registryWith({ modrinth: scripted.http }) });
    await expect(acq.ensure(pkg)).rejects.toBeInstanceOf(SsrfBlocked);
    expect(scripted.requests).toHaveLength(0); // never fetched
  });

  it("admits a modrinth copy download from a public host (no regression)", async () => {
    const store = await freshStore("sec-store-ok");
    const bytes = fabricJar("y");
    const pkg = modPkg(bytes, "https://cdn.modrinth.com/data/A/B/y.jar");
    const scripted = makeScriptedHttp({
      handler: () => okBytes(bytes),
      lookup: async () => ["93.184.216.34"],
    });
    const acq = new NetworkAcquirer({ store, registry: registryWith({ modrinth: scripted.http }) });
    await acq.ensure(pkg);
    expect(await store.has(pkg.hash)).toBe(true);
  });
});

// --- F2: ModrinthSource.resolve guards its own file download ----------------

describe("F2 — ModrinthSource.resolve guards the file download", () => {
  function modrinthHandler(cdnHost: string): {
    handler: (url: string) => ScriptedResponse;
  } {
    const bytes = fabricJar("sodium");
    const fileUrl = `https://${cdnHost}/sodium.jar`;
    const handler = (url: string): ScriptedResponse => {
      const path = new URL(url).pathname;
      if (path.endsWith("/version")) {
        return okBytes(
          enc([
            {
              id: "v1",
              project_id: "P",
              version_number: "1.0.0",
              date_published: "2026-06-01T00:00:00Z",
              loaders: ["fabric"],
              game_versions: ["26.2"],
              files: [
                {
                  hashes: { sha1: sha1hex(bytes) },
                  url: fileUrl,
                  filename: "sodium.jar",
                  primary: true,
                  size: bytes.byteLength,
                },
              ],
              dependencies: [],
            },
          ]),
        );
      }
      if (path.endsWith("/project/sodium")) {
        return okBytes(enc({ id: "P", slug: "sodium", title: "Sodium", project_type: "mod" }));
      }
      return okBytes(bytes); // the CDN download
    };
    return { handler };
  }

  function ctxWith(http: SourceContext["http"]): SourceContext {
    return {
      http,
      offline: false,
      now: NOW,
      allowSource: () => true,
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    };
  }

  it("blocks when the download host resolves to an internal IP (api host stays public)", async () => {
    const { handler } = modrinthHandler("cdn.internal.test");
    const scripted = makeScriptedHttp({
      handler,
      lookup: async (host) => (host === "cdn.internal.test" ? ["127.0.0.1"] : ["93.184.216.34"]),
    });
    await expect(
      new ModrinthSource().resolve(
        { source: "modrinth", id: "sodium", versionSpec: { kind: "latest" } },
        ctxWith(scripted.http),
      ),
    ).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it("resolves when the download host is public", async () => {
    const { handler } = modrinthHandler("cdn.public.test");
    const scripted = makeScriptedHttp({ handler, lookup: async () => ["93.184.216.34"] });
    const { pkg } = await new ModrinthSource().resolve(
      { source: "modrinth", id: "sodium", versionSpec: { kind: "latest" } },
      ctxWith(scripted.http),
    );
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.source).toBe("modrinth");
  });
});

// --- F3: remote-lock DNS pre-vet across a non-url source -------------------

describe("F3 — validateRemoteLock DNS-vetoes an internal hostname (non-url source)", () => {
  const modrinthRow = (url: string): LockPackage => ({
    name: "totally-legit",
    kind: "mod",
    source: "modrinth",
    version: "1.0.0",
    hash: { algo: "sha256", value: "0".repeat(64) },
    provenance: "copy",
    placement: { method: "link", target: "mods/legit.jar" },
    url,
  });

  it("rejects a modrinth row whose hostname resolves to a blocked IP", async () => {
    const lock = lockOf(modrinthRow("https://mirror.evil.test/legit.jar"));
    const resolveHost = async (host: string): Promise<readonly string[]> =>
      host === "mirror.evil.test" ? ["169.254.169.254"] : ["93.184.216.34"];
    await expect(validateRemoteLock(lock, () => true, resolveHost)).rejects.toBeInstanceOf(
      SsrfBlocked,
    );
  });

  it("accepts a modrinth row whose hostname resolves to a public IP", async () => {
    const lock = lockOf(modrinthRow("https://cdn.modrinth.com/legit.jar"));
    await expect(
      validateRemoteLock(
        lock,
        () => true,
        async () => ["93.184.216.34"],
      ),
    ).resolves.toBeUndefined();
  });

  it("defers an unresolvable / empty-resolving host to the fetch-time guard (no raw error)", async () => {
    // An unresolvable host is NOT the resolve-to-internal attack (that needs a
    // successful resolution to an internal IP). Validation defers to the
    // authoritative fetch-time guard rather than throwing a raw DNS error / failing
    // a clone whose objects may already be cached.
    const empty = lockOf(modrinthRow("https://ghost.test/legit.jar"));
    await expect(
      validateRemoteLock(
        empty,
        () => true,
        async () => [],
      ),
    ).resolves.toBeUndefined();

    const throwing = lockOf(modrinthRow("https://nxdomain.test/legit.jar"));
    await expect(
      validateRemoteLock(
        throwing,
        () => true,
        async () => {
          throw new Error("ENOTFOUND");
        },
      ),
    ).resolves.toBeUndefined();
  });
});

// --- F4: remote lock may not carry local/file provenance -------------------

describe("F4 — validateRemoteLock vetoes local/file provenance in a remote lock", () => {
  const publicResolver = async (): Promise<readonly string[]> => ["93.184.216.34"];

  it("rejects a source:local row (arbitrary local-file read on the puller)", async () => {
    const pkg: LockPackage = {
      name: "evil",
      kind: "mod",
      source: "local",
      hash: { algo: "sha256", value: "0".repeat(64) },
      provenance: "copy",
      placement: { method: "link", target: "mods/evil.jar" },
      url: "file:///etc/passwd",
    };
    await expect(
      validateRemoteLock(lockOf(pkg), () => true, publicResolver),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
  });

  it("rejects a file:// URL smuggled onto a non-local source", async () => {
    const pkg: LockPackage = {
      name: "evil",
      kind: "mod",
      source: "url",
      hash: { algo: "sha256", value: "0".repeat(64) },
      provenance: "copy",
      placement: { method: "link", target: "mods/evil.jar" },
      url: "file:///home/victim/.ssh/id_rsa",
    };
    await expect(
      validateRemoteLock(lockOf(pkg), () => true, publicResolver),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
  });

  it("rejects a case-variant FILE:// URL (scheme is case-insensitive)", async () => {
    const pkg: LockPackage = {
      name: "evil",
      kind: "mod",
      source: "url",
      hash: { algo: "sha256", value: "0".repeat(64) },
      provenance: "copy",
      placement: { method: "link", target: "mods/evil.jar" },
      url: "FILE:///etc/shadow",
    };
    await expect(
      validateRemoteLock(lockOf(pkg), () => true, publicResolver),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
  });

  it("rejects a source:local row even with no url", async () => {
    const pkg: LockPackage = {
      name: "evil",
      kind: "mod",
      source: "local",
      hash: { algo: "sha256", value: "0".repeat(64) },
      provenance: "copy",
      placement: { method: "link", target: "mods/evil.jar" },
    };
    await expect(
      validateRemoteLock(lockOf(pkg), () => true, publicResolver),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
  });

  it("a purely-LOCAL manifest still accepts local sources (no regression)", async () => {
    // The veto is ONLY at the remote boundary — LocalSource.resolve is unaffected.
    const work = await mkTmp("f4-local");
    const store = await freshStore("f4-store");
    dirs.push(work);
    const jarPath = join(work, "mymod.jar");
    await writeFile(jarPath, Buffer.from(fabricJar("mymod")));
    const ctx: SourceContext = { offline: false, now: NOW, allowSource: () => true, store };
    const { pkg } = await new LocalSource().resolve(
      { source: "local", id: jarPath, versionSpec: { kind: "latest" } },
      ctx,
    );
    expect(pkg.source).toBe("local");
    expect(pkg.url?.startsWith("file:")).toBe(true);
    expect(await store.has(pkg.hash)).toBe(true);
  });
});
