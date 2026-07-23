import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  FixtureAcquirer,
  NetworkAcquirer,
  ShaMismatch,
  SsrfBlocked,
  buildInstance,
  currentPlatform,
} from "../../index.js";
import type { LockPackage } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  FakeBytes,
  fabricJar,
  makeScriptedHttp,
  registryWith,
  sha256hex,
  throwingHttp,
} from "../helpers/net.js";
import { makeScenario } from "../helpers/scenario.js";

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

describe("NetworkAcquirer (copy items get real fetch plans)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function freshStore() {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    return store;
  }

  it("fetches a modrinth copy item from its plan and admits it (verified)", async () => {
    const store = await freshStore();
    const bytes = fabricJar("mymod");
    const url = "https://cdn.modrinth.com/data/X/versions/Y/mymod.jar";
    const pkg = modPkg(bytes, url);
    const acq = new NetworkAcquirer({
      store,
      registry: registryWith({ modrinth: new FakeBytes().set(url, bytes) }),
    });
    await acq.ensure(pkg);
    expect(await store.has(pkg.hash)).toBe(true);
  });

  it("rejects bytes that do not match the pinned hash", async () => {
    const store = await freshStore();
    const url = "https://cdn.modrinth.com/data/X/versions/Y/mymod.jar";
    const pkg = modPkg(fabricJar("mymod"), url);
    // Serve DIFFERENT bytes than the pinned hash expects.
    const acq = new NetworkAcquirer({
      store,
      registry: registryWith({ modrinth: new FakeBytes().set(url, fabricJar("tampered")) }),
    });
    await expect(acq.ensure(pkg)).rejects.toBeInstanceOf(ShaMismatch);
  });

  it("copies a local file:// item", async () => {
    const store = await freshStore();
    const work = await mkTmp("local");
    dirs.push(work);
    const bytes = fabricJar("localmod");
    const path = join(work, "localmod.jar");
    await writeFile(path, Buffer.from(bytes));
    const pkg: LockPackage = {
      name: "localmod",
      kind: "mod",
      source: "local",
      hash: { algo: "sha256", value: sha256hex(bytes) },
      provenance: "copy",
      placement: { method: "link", target: "mods/localmod.jar" },
      size: bytes.byteLength,
      url: pathToFileURL(path).toString(),
    };
    const acq = new NetworkAcquirer({ store, registry: registryWith({}) });
    await acq.ensure(pkg);
    expect(await store.has(pkg.hash)).toBe(true);
  });

  it("re-applies the SSRF guard when fetching a url item", async () => {
    const store = await freshStore();
    const bytes = fabricJar("x");
    const url = "http://10.0.0.5/internal.jar";
    const pkg: LockPackage = { ...modPkg(bytes, url), source: "url", name: "x" };
    const scripted = makeScriptedHttp({ handler: () => ({ status: 200, body: bytes }) });
    const acq = new NetworkAcquirer({ store, registry: registryWith({ url: scripted.http }) });
    await expect(acq.ensure(pkg)).rejects.toBeInstanceOf(SsrfBlocked);
    expect(scripted.requests).toHaveLength(0);
  });

  it("a re-build off a populated store performs ZERO metadata lookups", async () => {
    // Seed the store from fixtures, then build with a registry whose HTTP throws.
    const { poolDir, lock } = await makeScenario();
    const instanceDir = await mkTmp("inst");
    const store = await freshStore();
    dirs.push(poolDir, instanceDir);
    const seed = new FixtureAcquirer(store, poolDir);
    for (const pkg of lock.resolved) {
      await seed.ensure(pkg);
    }
    const { http, calls } = throwingHttp();
    const acquire = new NetworkAcquirer({ store, registry: registryWith({ modrinth: http }) });
    const result = await buildInstance({
      instanceDir,
      lock,
      store,
      acquire,
      platform: currentPlatform(),
    });
    expect(result.objects).toBe(5);
    // Every object was already present → no source was ever consulted.
    expect(calls).toHaveLength(0);
  });
});
