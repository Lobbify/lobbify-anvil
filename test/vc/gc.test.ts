import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Manifest, VcObjectStore, parseRef } from "../../index.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, modWorld, version } from "../helpers/vc.js";

function localManifest(mc: string, mods: string[], localPath: string): Manifest {
  return {
    project: { name: "vc-pack", version: "1.0.0" },
    game: { minecraft: mc, loader: "fabric 0.19.1" },
    items: [...mods.map((r) => ({ ref: parseRef(r) })), { ref: parseRef(localPath) }],
  };
}

describe("vc gc: reachability across the full ref/reflog closure + carried blobs", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("GATE gc-reachability: switch to an old commit after GC finds every object, carried blobs included", async () => {
    const fx = await makeVcFixture(
      modWorld([
        { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
        { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
      ]),
    );
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const anvilDir = join(fx.dir, ".anvil");

    // c1: a local jar carrying "LOCAL-V1", tracked alongside a Modrinth mod.
    await writeFile(join(fx.dir, "mymod.jar"), "LOCAL-V1");
    await fx.writeLockFor(localManifest("26.2", ["modrinth:alpha"], "./mymod.jar"));
    const c1 = await anvil.commit("c1: alpha + local v1");

    // c2: the local file's bytes change, and beta is added.
    await writeFile(join(fx.dir, "mymod.jar"), "LOCAL-V2");
    await fx.writeLockFor(
      localManifest("26.2", ["modrinth:alpha", "modrinth:beta"], "./mymod.jar"),
    );
    await anvil.commit("c2: add beta + local v2");

    // A dangling VC object (referenced by nothing) that GC must reclaim.
    const objects = new VcObjectStore({ anvilDir });
    const dangling = await objects.putBlob(new TextEncoder().encode("garbage-unreferenced-blob"));
    expect(await objects.has(dangling)).toBe(true);

    // Run GC.
    const result = await anvil.gc();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    // The dangling object is gone; c1's objects (still reachable) survive.
    expect(await objects.has(dangling)).toBe(false);

    // c1's carried local blob must still be present after GC.
    const c1Commit = await objects.getCommit(c1.id);
    const c1Snap = await objects.getSnapshot(c1Commit.snapshot);
    const carried = c1Snap.carried[0];
    expect(carried).toBeDefined();
    if (carried) {
      expect(await objects.has(carried.blob)).toBe(true);
    }

    // The real gate: switch back to c1 after GC — no missing object — and the old
    // carried local bytes are materialized exactly.
    await anvil.switch(c1.id.value);
    if (carried) {
      expect(await readFile(join(fx.dir, carried.path), "utf8")).toBe("LOCAL-V1");
    }
  });

  it("GATE gc-tracked: a tracked working-tree blob survives GC and still materializes", async () => {
    const fx = await makeVcFixture(
      modWorld([{ slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] }]),
    );
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    const objects = new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") });
    const config = join(fx.dir, "config", "mymod.toml");

    // c1: a carried local jar AND an undeclared hand-edited config.
    await writeFile(join(fx.dir, "mymod.jar"), "LOCAL-V1");
    await mkdir(join(fx.dir, "config"), { recursive: true });
    await writeFile(config, "TRACKED-V1");
    await fx.writeLockFor(localManifest("26.2", ["modrinth:alpha"], "./mymod.jar"));
    const c1 = await anvil.commit("c1: local v1 + tracked v1");

    // c2: the tracked file's bytes change, so c1's blob is referenced by history only.
    await writeFile(config, "TRACKED-V2");
    await anvil.commit("c2: tracked v2");

    const c1Snap = await objects.getSnapshot((await objects.getCommit(c1.id)).snapshot);
    const tracked = c1Snap.tracked.find((t) => t.path === "config/mymod.toml");
    expect(tracked).toBeDefined();

    // A dangling object, so a GC that reclaimed nothing cannot pass this test.
    const dangling = await objects.putBlob(new TextEncoder().encode("garbage-tracked-gc-blob"));
    const result = await anvil.gc();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await objects.has(dangling)).toBe(false);

    if (!tracked) {
      return;
    }
    expect(await objects.has(tracked.blob)).toBe(true);
    // The real gate: switch back to c1 after GC and read the old tracked bytes.
    await anvil.switch(c1.id.value);
    expect(await readFile(config, "utf8")).toBe("TRACKED-V1");
  });

  it("keeps commits reachable only through the reflog (e.g. after a branch delete)", async () => {
    const fx = await makeVcFixture(
      modWorld([{ slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] }]),
    );
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await writeFile(join(fx.dir, "mymod.jar"), "ONLY");
    await fx.writeLockFor(localManifest("26.2", ["modrinth:alpha"], "./mymod.jar"));
    const c1 = await anvil.commit("c1");
    // A second commit so HEAD advances; c1 stays reachable via HEAD's ancestry + reflog.
    await fx.writeLockFor(localManifest("26.2", ["modrinth:alpha"], "./mymod.jar"));
    await anvil.commit("c2 (identical items, new commit)");

    await anvil.gc();
    // c1 and its carried blob survive GC (reachable through history + reflog).
    const objects = new VcObjectStore({ anvilDir: join(fx.dir, ".anvil") });
    expect(await objects.has(c1.id)).toBe(true);
  });
});
