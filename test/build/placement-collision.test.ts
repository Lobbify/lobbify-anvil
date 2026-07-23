import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type Hash,
  type LockPackage,
  type Lockfile,
  type Manifest,
  PlacementCollision,
  StoreOnlyAcquirer,
  assertNoPlacementCollisions,
  buildInstance,
  currentPlatform,
  hashBuffer,
  parseRef,
  resolveManifest,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeBytes, fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const h = (s: string): Hash => hashBuffer(new TextEncoder().encode(s), "sha256");

/** A minimal single-file `link` package for collision unit tests. */
function linkPkg(opts: {
  name: string;
  source: LockPackage["source"];
  target: string;
  content: string;
  url?: string;
}): LockPackage {
  return {
    name: opts.name,
    kind: "mod",
    source: opts.source,
    hash: h(opts.content),
    provenance: "copy",
    placement: { method: "link", target: opts.target },
    ...(opts.url ? { url: opts.url } : {}),
  };
}

describe("assertNoPlacementCollisions (F5 unit)", () => {
  it("throws PlacementCollision when two distinct items link to the same target, naming both", () => {
    const pkgs = [
      linkPkg({ name: "sodium", source: "modrinth", target: "mods/sodium.jar", content: "A" }),
      linkPkg({
        name: "sodium",
        source: "url",
        target: "mods/sodium.jar",
        content: "B",
        url: "https://mirror.example.com/sodium.jar",
      }),
    ];
    let caught: unknown;
    try {
      assertNoPlacementCollisions(pkgs);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlacementCollision);
    const collision = caught as PlacementCollision;
    expect(collision.code).toBe("PLACEMENT_COLLISION");
    expect(collision.target).toBe("mods/sodium.jar");
    expect(collision.items).toHaveLength(2);
    // Both colliding items are named (deterministic, sorted).
    expect(collision.items).toEqual([
      "modrinth:sodium",
      "url:https://mirror.example.com/sodium.jar",
    ]);
    expect(collision.message).toContain("mods/sodium.jar");
  });

  it("is order-independent: the same collision reports the same pair regardless of input order", () => {
    const a = linkPkg({
      name: "sodium",
      source: "modrinth",
      target: "mods/sodium.jar",
      content: "A",
    });
    const b = linkPkg({
      name: "sodium",
      source: "url",
      target: "mods/sodium.jar",
      content: "B",
      url: "https://mirror.example.com/sodium.jar",
    });
    const first = (() => {
      try {
        assertNoPlacementCollisions([a, b]);
      } catch (e) {
        return (e as PlacementCollision).items;
      }
    })();
    const second = (() => {
      try {
        assertNoPlacementCollisions([b, a]);
      } catch (e) {
        return (e as PlacementCollision).items;
      }
    })();
    expect(first).toEqual(second);
  });

  it("does NOT flag the normal distinct-target case", () => {
    const pkgs = [
      linkPkg({ name: "sodium", source: "modrinth", target: "mods/sodium.jar", content: "A" }),
      linkPkg({ name: "lithium", source: "modrinth", target: "mods/lithium.jar", content: "B" }),
    ];
    expect(() => assertNoPlacementCollisions(pkgs)).not.toThrow();
  });

  it("does NOT flag a single package (a re-lock of the same single item)", () => {
    const one = [
      linkPkg({ name: "sodium", source: "modrinth", target: "mods/sodium.jar", content: "A" }),
    ];
    expect(() => assertNoPlacementCollisions(one)).not.toThrow();
  });

  it("does NOT flag identical bytes at the same target (harmless duplicate, not an overwrite)", () => {
    const pkgs = [
      linkPkg({
        name: "sodium",
        source: "url",
        target: "mods/sodium.jar",
        content: "SAME",
        url: "https://a/sodium.jar",
      }),
      linkPkg({
        name: "sodium",
        source: "url",
        target: "mods/sodium.jar",
        content: "SAME",
        url: "https://b/sodium.jar",
      }),
    ];
    expect(() => assertNoPlacementCollisions(pkgs)).not.toThrow();
  });

  it("does NOT flag two non-link placements sharing a target dir (only single-file links collide)", () => {
    const pkgs: LockPackage[] = [
      {
        name: "natives-a",
        kind: "library",
        source: "mojang",
        hash: h("A"),
        provenance: "copy",
        placement: { method: "extract", targetDir: "natives" },
      },
      {
        name: "natives-b",
        kind: "library",
        source: "mojang",
        hash: h("B"),
        provenance: "copy",
        placement: { method: "extract", targetDir: "natives" },
      },
    ];
    expect(() => assertNoPlacementCollisions(pkgs)).not.toThrow();
  });
});

describe("resolver rejects placement collisions at lock time (F5 integration)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  function urlManifest(urls: string[]): Manifest {
    return {
      project: { name: "p", version: "1" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: urls.map((u) => ({ ref: parseRef(u) })),
    };
  }

  it("two url items with different URLs but the same basename → PlacementCollision", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const urlA = "https://a.example.com/sodium.jar";
    const urlB = "https://b.example.com/sodium.jar";
    const http = new FakeBytes().set(urlA, fabricJar("A")).set(urlB, fabricJar("B"));

    let caught: unknown;
    try {
      await resolveManifest({
        manifest: urlManifest([`url:${urlA}`, `url:${urlB}`]),
        registry: registryWith({ url: http }),
        allowSource: () => true,
        now: NOW,
        store,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlacementCollision);
    const collision = caught as PlacementCollision;
    expect(collision.target).toBe("mods/sodium.jar");
    expect(collision.items).toEqual([`url:${urlA}`, `url:${urlB}`]);
  });

  it("distinct basenames resolve cleanly (no false positive)", async () => {
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const urlA = "https://a.example.com/sodium.jar";
    const urlB = "https://b.example.com/lithium.jar";
    const http = new FakeBytes().set(urlA, fabricJar("A")).set(urlB, fabricJar("B"));
    const lock = await resolveManifest({
      manifest: urlManifest([`url:${urlA}`, `url:${urlB}`]),
      registry: registryWith({ url: http }),
      allowSource: () => true,
      now: NOW,
      store,
    });
    expect(lock.resolved).toHaveLength(2);
  });
});

describe("build pipeline is the last line of defense (F5 integration)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("a hand-edited/imported lock with a colliding link fails the build (before any placement)", async () => {
    const instanceDir = await mkTmp("inst");
    const storeDir = await mkTmp("store");
    dirs.push(instanceDir, storeDir);
    const store = new ContentStore({ root: storeDir }); // empty — collision must fire first
    const lock: Lockfile = {
      meta: {
        version: 1,
        manifestHash: h("manifest"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "runtime-test-21",
      },
      resolved: [
        linkPkg({ name: "sodium", source: "modrinth", target: "mods/sodium.jar", content: "A" }),
        linkPkg({
          name: "sodium",
          source: "url",
          target: "mods/sodium.jar",
          content: "B",
          url: "https://x/sodium.jar",
        }),
      ],
    };
    await expect(
      buildInstance({
        instanceDir,
        lock,
        store,
        acquire: new StoreOnlyAcquirer(store),
        platform: currentPlatform(),
      }),
    ).rejects.toBeInstanceOf(PlacementCollision);
  });
});
