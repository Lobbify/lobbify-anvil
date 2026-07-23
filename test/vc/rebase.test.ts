import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

/** A world with a single mod carrying three pinnable versions, for divergent edits. */
function dialWorld(): ReturnType<typeof modWorld> {
  return modWorld([
    {
      slug: "dial",
      id: "DIAL",
      versions: [
        version("DIAL", "1.0.0", ["26.2"]),
        version("DIAL", "2.0.0", ["26.2"]),
        version("DIAL", "3.0.0", ["26.2"]),
      ],
    },
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
    { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
    { slug: "gamma", id: "GAMMA", versions: [version("GAMMA", "3.0.0", ["26.2"])] },
  ]);
}

const anvilPath = (dir: string, ...rel: string[]): string => join(dir, ".anvil", ...rel);

describe("vc rebase: per-commit replay, crash-survivable state", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("replays non-conflicting commits onto another branch and re-parents them", async () => {
    const fx = await makeVcFixture(dialWorld());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("b0: alpha");
    await anvil.branch("feature");

    // main gains gamma; feature gains beta — different items, so the replay is clean.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:gamma"] }),
    );
    await anvil.commit("m1: add gamma");

    await anvil.switch("feature");
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("f1: add beta");

    const result = await anvil.rebase({ onto: "main" });
    expect(result.status).toBe("done");
    // The rebased tip has alpha + gamma (from onto) + beta (replayed).
    const m = await readManifest(fx.dir);
    expect(m.items).toHaveLength(3);
    expect(await pathExists(anvilPath(fx.dir, "REBASE_STATE"))).toBe(false);
  });

  it("GATE crash-mid-rebase + abort: pauses to REBASE_STATE, then --abort restores ORIG_HEAD", async () => {
    const fx = await makeVcFixture(dialWorld());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@1.0.0"] }));
    await anvil.commit("b0: dial 1");
    await anvil.branch("feature");

    // main sets dial=3, feature sets dial=2 — the same item to different values.
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@3.0.0"] }));
    await anvil.commit("m1: dial 3");

    await anvil.switch("feature");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@2.0.0"] }));
    const featureTip = await anvil.commit("f1: dial 2");

    // Rebase feature onto main → the dial edit conflicts (base 1 / ours 3 / theirs 2).
    const started = await anvil.rebase({ onto: "main" });
    expect(started.status).toBe("conflicts");
    expect(started.conflicts).toHaveLength(1);
    expect(started.remaining).toBe(1);

    // The state is on disk, and ORIG_HEAD records the pre-rebase tip.
    expect(await pathExists(anvilPath(fx.dir, "REBASE_STATE", "state.json"))).toBe(true);
    expect(await pathExists(anvilPath(fx.dir, "ORIG_HEAD"))).toBe(true);

    // Simulate a crash + restart: a FRESH Anvil instance recovers from REBASE_STATE.
    const restarted = fx.anvil();
    const aborted = await restarted.rebase({ abort: true });
    expect(aborted.status).toBe("aborted");

    // ORIG_HEAD (the original feature tip) is restored, and the state is cleared.
    const log = await restarted.log();
    expect(log[0]?.id.value).toBe(featureTip.id.value);
    expect((await restarted.log("feature"))[0]?.id.value).toBe(featureTip.id.value);
    expect(await pathExists(anvilPath(fx.dir, "REBASE_STATE"))).toBe(false);
    const m = await readManifest(fx.dir);
    expect(m.items[0]?.ref?.versionSpec).toEqual({ kind: "pin", version: "2.0.0" });
  });

  it("--skip drops the conflicting commit and finishes the rebase", async () => {
    const fx = await makeVcFixture(dialWorld());
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@1.0.0"] }));
    await anvil.commit("b0");
    await anvil.branch("feature");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@3.0.0"] }));
    await anvil.commit("m1: dial 3");
    await anvil.switch("feature");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@2.0.0"] }));
    await anvil.commit("f1: dial 2");

    expect((await anvil.rebase({ onto: "main" })).status).toBe("conflicts");
    const done = await anvil.rebase({ skip: true });
    expect(done.status).toBe("done");
    // With the only commit skipped, the branch is now exactly main (dial=3).
    const m = await readManifest(fx.dir);
    expect(m.items[0]?.ref?.versionSpec).toEqual({ kind: "pin", version: "3.0.0" });
  });
});
