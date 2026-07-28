import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  ContentStore,
  type Manifest,
  PathEscape,
  SourceNotAllowed,
  SsrfBlocked,
  UnsatisfiableTarget,
  pinsFromLock,
  resolveManifest,
  serializeLock,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  FakeModrinth,
  fabricJar,
  makeScriptedHttp,
  registryWith,
  throwingHttp,
} from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

function modrinthVersion(id: string, projectId: string, version: string, deps?: unknown) {
  return {
    id,
    projectId,
    versionNumber: version,
    datePublished: "2026-06-01T00:00:00Z",
    loaders: ["fabric"],
    gameVersions: ["26.2"],
    filename: `${projectId}-${version}.jar`,
    bytes: fabricJar(`${projectId}-${version}`),
    ...(deps ? { dependencies: deps as [] } : {}),
  };
}

/** Two independent mods, alpha + beta. */
function twoModWorld(): FakeModrinth {
  return new FakeModrinth()
    .add({
      id: "ALPHA",
      slug: "alpha",
      title: "Alpha",
      projectType: "mod",
      versions: [modrinthVersion("alpha-v1", "ALPHA", "1.0.0")],
    })
    .add({
      id: "BETA",
      slug: "beta",
      title: "Beta",
      projectType: "mod",
      versions: [modrinthVersion("beta-v1", "BETA", "2.0.0")],
    });
}

function twoModManifest(): Manifest {
  return {
    project: { name: "p", version: "1" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [
      { ref: { source: "modrinth", id: "alpha", versionSpec: { kind: "latest" } } },
      { ref: { source: "modrinth", id: "beta", versionSpec: { kind: "latest" } } },
    ],
  };
}

describe("resolver", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function freshStore(): Promise<ContentStore> {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    return store;
  }

  it("GATE determinism: same manifest + frozen clock → byte-identical lock (two runs)", async () => {
    const run = async () =>
      resolveManifest({
        manifest: twoModManifest(),
        registry: registryWith({ modrinth: twoModWorld() }),
        allowSource: () => true,
        now: NOW,
        baseDir: "/tmp",
        store: await freshStore(),
      });
    const a = serializeLock(await run());
    const b = serializeLock(await run());
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("GATE conflict: two roots demanding incompatible versions → error naming who-demanded-what", async () => {
    const fake = new FakeModrinth()
      .add({
        id: "R1",
        slug: "rootone",
        title: "Root One",
        projectType: "mod",
        versions: [
          modrinthVersion("r1-v1", "R1", "1.0.0", [
            { version_id: "lib-v2", dependency_type: "required" },
          ]),
        ],
      })
      .add({
        id: "R2",
        slug: "roottwo",
        title: "Root Two",
        projectType: "mod",
        versions: [
          modrinthVersion("r2-v1", "R2", "1.0.0", [
            { version_id: "lib-v3", dependency_type: "required" },
          ]),
        ],
      })
      .add({
        id: "LIB",
        slug: "lib",
        title: "Lib",
        projectType: "mod",
        versions: [
          modrinthVersion("lib-v2", "LIB", "2.0.0"),
          modrinthVersion("lib-v3", "LIB", "3.0.0"),
        ],
      });
    const manifest: Manifest = {
      project: { name: "p", version: "1" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [
        { ref: { source: "modrinth", id: "rootone", versionSpec: { kind: "latest" } } },
        { ref: { source: "modrinth", id: "roottwo", versionSpec: { kind: "latest" } } },
      ],
    };
    const err = await resolveManifest({
      manifest,
      registry: registryWith({ modrinth: fake }),
      allowSource: () => true,
      now: NOW,
      baseDir: "/tmp",
      store: await freshStore(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    const msg = (err as ConflictError).message;
    expect(msg).toContain("lib");
    expect(msg).toContain("rootone");
    expect(msg).toContain("roottwo");
    expect(msg).toContain("2.0.0");
    expect(msg).toContain("3.0.0");
  });

  it("GATE allowSource runs BEFORE any network I/O", async () => {
    const { http, calls } = throwingHttp();
    await expect(
      resolveManifest({
        manifest: twoModManifest(),
        registry: registryWith({ modrinth: http }),
        allowSource: () => false, // veto everything
        now: NOW,
        baseDir: "/tmp",
        store: await freshStore(),
      }),
    ).rejects.toBeInstanceOf(SourceNotAllowed);
    // The veto fired before the source's HTTP client was ever touched.
    expect(calls).toHaveLength(0);
  });

  it("GATE SSRF: a url item targeting an internal address is blocked", async () => {
    const scripted = makeScriptedHttp({ handler: () => ({ status: 200 }) });
    const manifest: Manifest = {
      project: { name: "p", version: "1" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [
        {
          ref: {
            source: "url",
            id: "http://169.254.169.254/latest/meta-data",
            versionSpec: { kind: "latest" },
          },
        },
      ],
    };
    await expect(
      resolveManifest({
        manifest,
        registry: registryWith({ url: scripted.http }),
        allowSource: () => true,
        now: NOW,
        baseDir: "/tmp",
        store: await freshStore(),
      }),
    ).rejects.toBeInstanceOf(SsrfBlocked);
    // Blocked before the request was dispatched.
    expect(scripted.requests).toHaveLength(0);
  });

  it("GATE lockedPins: re-resolve one item, all others emerge byte-identical", async () => {
    const store = await freshStore();
    const lock1 = await resolveManifest({
      manifest: twoModManifest(),
      registry: registryWith({ modrinth: twoModWorld() }),
      allowSource: () => true,
      now: NOW,
      baseDir: "/tmp",
      store,
    });
    const pins = pinsFromLock(lock1);
    const fake2 = twoModWorld();
    const lock2 = await resolveManifest({
      manifest: twoModManifest(),
      registry: registryWith({ modrinth: fake2 }),
      allowSource: () => true,
      now: NOW,
      baseDir: "/tmp",
      store,
      lockedPins: pins,
      upgrade: new Set(["alpha"]),
    });
    const b1 = lock1.resolved.find((p) => p.name === "beta");
    const b2 = lock2.resolved.find((p) => p.name === "beta");
    // beta was untouched → byte-identical pin.
    expect(b2).toEqual(b1);
    // beta was never re-fetched; only alpha was re-resolved.
    expect(fake2.calls.some((u) => u.includes("/project/beta"))).toBe(false);
    expect(fake2.calls.some((u) => u.includes("/project/alpha"))).toBe(true);
  });

  it("re-locking with all pins and no upgrade performs ZERO metadata lookups", async () => {
    const store = await freshStore();
    const lock1 = await resolveManifest({
      manifest: twoModManifest(),
      registry: registryWith({ modrinth: twoModWorld() }),
      allowSource: () => true,
      now: NOW,
      baseDir: "/tmp",
      store,
    });
    // A throwing HTTP client proves no network call is made when every key is pinned.
    const { http, calls } = throwingHttp();
    const lock2 = await resolveManifest({
      manifest: twoModManifest(),
      registry: registryWith({ modrinth: http }),
      allowSource: () => true,
      now: NOW,
      baseDir: "/tmp",
      lockedPins: pinsFromLock(lock1),
    });
    expect(calls).toHaveLength(0);
    expect(serializeLock(lock2)).toBe(serializeLock(lock1));
  });

  it("offline resolution of a fresh (unpinned) ref fails clearly", async () => {
    await expect(
      resolveManifest({
        manifest: twoModManifest(),
        registry: registryWith({ modrinth: throwingHttp().http }),
        allowSource: () => true,
        now: NOW,
        baseDir: "/tmp",
        offline: true,
      }),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  // --- LB-719: an explicitly declared placement target -----------------------
  //
  // A declared target is attacker-controlled independently of the read path, so
  // it gets the same guards a derived target does — and never the kind-directory
  // fallback, which would turn a refused placement into a silent relocation.

  /** An instance dir holding one tracked file at `.anvil/overrides/tracked.txt`. */
  async function instanceWithTrackedFile(): Promise<string> {
    const dir = await mkTmp("tgt-inst");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil", "overrides"), { recursive: true });
    await writeFile(join(dir, ".anvil", "overrides", "tracked.txt"), "tracked bytes\n");
    return dir;
  }

  function manifestWithTarget(target: string): Manifest {
    return {
      project: { name: "p", version: "1" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [{ path: ".anvil/overrides/tracked.txt", kind: "config", target }],
    };
  }

  async function resolveWithTarget(target: string, baseDir: string) {
    return resolveManifest({
      manifest: manifestWithTarget(target),
      registry: registryWith({}),
      allowSource: () => true,
      now: NOW,
      baseDir,
      store: await freshStore(),
    });
  }

  it("LB-719: a declared target places the tracked file where it says", async () => {
    const dir = await instanceWithTrackedFile();
    const lock = await resolveWithTarget("config/deep/settings.txt", dir);
    expect(lock.resolved.find((p) => p.source === "local")?.placement).toEqual({
      method: "link",
      target: "config/deep/settings.txt",
    });
  });

  it("LB-719: a declared target under a protected top is REFUSED (never relocated)", async () => {
    const dir = await instanceWithTrackedFile();
    for (const evil of ["saves/world/level.dat", ".anvil/objects/x", ".anvilignore"]) {
      await expect(resolveWithTarget(evil, dir)).rejects.toBeInstanceOf(PathEscape);
    }
  });

  it("LB-719: a declared target escaping the instance is REFUSED, not placed by kind", async () => {
    const dir = await instanceWithTrackedFile();
    // Falling back to `<kind-dir>/<basename>` here is the tempting move and the
    // wrong one: the manifest stated a placement, so ignoring it relocates the
    // file silently instead of refusing an illegal one.
    for (const evil of ["../../etc/passwd", "/etc/passwd", "..", "./"]) {
      await expect(resolveWithTarget(evil, dir)).rejects.toBeInstanceOf(PathEscape);
    }
  });

  it("LB-719: a reader that ignores `target` REFUSES the item rather than misplacing it", async () => {
    // `target` is an addition to a published format, and an older anvil drops
    // unknown keys — which is the field's one real hazard. It lands safely here
    // only because the read path it pairs with is inside `.anvil/`: strip the
    // target and what is left is an item claiming a protected placement, which
    // has always been refused. The failure mode is a hard error on a manifest it
    // cannot honor, not a file quietly written somewhere else.
    const dir = await instanceWithTrackedFile();
    const manifest: Manifest = {
      project: { name: "p", version: "1" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [{ path: ".anvil/overrides/tracked.txt", kind: "config" }], // target dropped
    };
    await expect(
      resolveManifest({
        manifest,
        registry: registryWith({}),
        allowSource: () => true,
        now: NOW,
        baseDir: dir,
        store: await freshStore(),
      }),
    ).rejects.toBeInstanceOf(PathEscape);
  });

  it("LB-719: a missing tracked file still fails LOUDLY — never a silent drop", async () => {
    const dir = await mkTmp("tgt-gone");
    dirs.push(dir);
    // No `.anvil/overrides/tracked.txt` at all. Tolerating this is the patch the
    // ticket refused: the item would vanish from the lock, and the next build
    // would delete the file from the instance without a word.
    await expect(resolveWithTarget("config/settings.txt", dir)).rejects.toThrow(/ENOENT|tracked/);
  });
});
