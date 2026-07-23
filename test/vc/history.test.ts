import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DirtyWorkingTree,
  LockStale,
  type Manifest,
  readManifest,
  writeManifest,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
    { slug: "gamma", id: "GAMMA", versions: [version("GAMMA", "3.0.0", ["26.2"])] },
  ]);
}

describe("vc history: commit / branch / switch / log", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("commits, branches, logs, and switches by hash-diff without touching saves/", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    const c1 = await anvil.commit("c1: alpha only");

    // A world appears between the two commits — it must survive a switch back.
    await mkdir(join(fx.dir, "saves", "world"), { recursive: true });
    await writeFile(join(fx.dir, "saves", "world", "level.dat"), "WORLD-BYTES");

    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    const c2 = await anvil.commit("c2: add beta");
    expect(c2.generation).toBe(c1.generation + 1);

    const log = await anvil.log();
    expect(log.map((e) => e.message)).toEqual(["c2: add beta", "c1: alpha only"]);
    // The newest commit's stat shows beta added on top of its parent.
    expect(log[0]?.stat.added.map((a) => a.key)).toEqual(["modrinth:beta"]);
    expect(log[0]?.refs).toContain("refs/heads/main");

    await anvil.branch("exp");

    // Switch to the first commit (detached): the manifest reverts to alpha-only...
    await anvil.switch(c1.id.value);
    const at1 = await readManifest(fx.dir);
    expect(at1.items).toHaveLength(1);
    // ...and the world (created after c1) is left completely untouched.
    expect(await pathExists(join(fx.dir, "saves", "world", "level.dat"))).toBe(true);
    expect(await readFile(join(fx.dir, "saves", "world", "level.dat"), "utf8")).toBe("WORLD-BYTES");
  });

  it("GATE dirty-refuse: switch refuses when the working tree has uncommitted changes", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    const c1 = await anvil.commit("c1");
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("c2");

    // Dirty the working tree: edit the manifest without re-locking/committing.
    const m = await readManifest(fx.dir);
    const dirtied: Manifest = {
      ...m,
      items: [
        ...m.items,
        { ref: { source: "modrinth", id: "gamma", versionSpec: { kind: "latest" } } },
      ],
    };
    await writeManifest(fx.dir, dirtied);

    await expect(anvil.switch(c1.id.value)).rejects.toBeInstanceOf(DirtyWorkingTree);
  });

  it("GATE index-is-manifest: commit refuses a lock stale vs the manifest", async () => {
    const fx = await makeVcFixture(world());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

    // Edit the manifest but do NOT re-lock → the lock is now stale.
    const m = await readManifest(fx.dir);
    await writeManifest(fx.dir, {
      ...m,
      items: [
        ...m.items,
        { ref: { source: "modrinth", id: "beta", versionSpec: { kind: "latest" } } },
      ],
    });
    await expect(anvil.commit("stale")).rejects.toBeInstanceOf(LockStale);
  });
});
