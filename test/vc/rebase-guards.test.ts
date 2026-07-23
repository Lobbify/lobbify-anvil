import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VcStateError } from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { rmTmp } from "../helpers/fixtures.js";
import { type VcFixture, makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

/** A single mod with three pinnable versions, so a rebase can be forced to conflict. */
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
  ]);
}

const anvilPath = (dir: string, ...rel: string[]): string => join(dir, ".anvil", ...rel);

/**
 * Drive `feature` into a PAUSED rebase onto `main`: base dial=1, main dial=3,
 * feature dial=2 — the same item to different values conflicts on the replay, so
 * the rebase stops with `REBASE_STATE` on disk and the branch ref still at the
 * pre-rebase tip. This is the exact hazardous window F-VCS41 must fence.
 */
async function pausedRebase(): Promise<VcFixture> {
  const fx = await makeVcFixture(dialWorld());
  const anvil = fx.anvil();

  await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@1.0.0"] }));
  await anvil.commit("b0: dial 1");
  await anvil.branch("feature");
  await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@3.0.0"] }));
  await anvil.commit("m1: dial 3");
  await anvil.switch("feature");
  await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@2.0.0"] }));
  await anvil.commit("f1: dial 2");

  const started = await anvil.rebase({ onto: "main" });
  expect(started.status).toBe("conflicts");
  expect(await pathExists(anvilPath(fx.dir, "REBASE_STATE", "state.json"))).toBe(true);
  return fx;
}

describe("vc: mutating ops are refused mid-rebase (F-VCS41)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("commit() refuses while a rebase is in progress, with the typed rebase error", async () => {
    const fx = await pausedRebase();
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await expect(anvil.commit("should be refused")).rejects.toMatchObject({
      code: "VC_STATE",
    });
    await expect(anvil.commit("should be refused")).rejects.toBeInstanceOf(VcStateError);
    await expect(anvil.commit("should be refused")).rejects.toThrow(/rebase is in progress/i);
  });

  it("branch() refuses while a rebase is in progress", async () => {
    const fx = await pausedRebase();
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await expect(anvil.branch("new-branch")).rejects.toBeInstanceOf(VcStateError);
    await expect(anvil.branch("new-branch")).rejects.toThrow(/rebase is in progress/i);
    // The branch must NOT have been created despite the refusal.
    expect(await pathExists(anvilPath(fx.dir, "refs", "heads", "new-branch"))).toBe(false);
  });

  it("revert() and switch() are also refused mid-rebase", async () => {
    const fx = await pausedRebase();
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    await expect(anvil.revert("HEAD")).rejects.toBeInstanceOf(VcStateError);
    await expect(anvil.switch("main")).rejects.toBeInstanceOf(VcStateError);
  });

  it("commit() and branch() succeed normally once the rebase is aborted", async () => {
    const fx = await pausedRebase();
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    // Aborting clears REBASE_STATE and restores the original feature tip.
    const aborted = await anvil.rebase({ abort: true });
    expect(aborted.status).toBe("aborted");
    expect(await pathExists(anvilPath(fx.dir, "REBASE_STATE"))).toBe(false);

    // A fresh re-lock of the restored tree, then commit + branch work again.
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:dial@2.0.0"] }));
    const committed = await anvil.commit("post-abort commit");
    expect(committed.id.value).toBeTruthy();
    const branched = await anvil.branch("post-abort-branch");
    expect(branched.id.value).toBe(committed.id.value);
  });
});
