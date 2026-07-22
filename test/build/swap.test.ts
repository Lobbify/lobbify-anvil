import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IgnoreSet, PathEscape, journaledSwap, recoverSwap } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

async function pathExistsIn(root: string, rel: string): Promise<boolean> {
  try {
    await access(join(root, ...rel.split("/")));
    return true;
  } catch {
    return false;
  }
}

// Focused unit coverage for the journaled swap; the full crash matrix lives in
// crash.test.ts (driven through the build pipeline).
describe("journaled swap", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function seed(stageId: string): Promise<string> {
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    await mkdir(join(instanceDir, "mods"), { recursive: true });
    await writeFile(join(instanceDir, "mods", "m.jar"), "OLD");
    const stageTarget = join(instanceDir, ".anvil", `stage-${stageId}`, "mods");
    await mkdir(stageTarget, { recursive: true });
    await writeFile(join(stageTarget, "m.jar"), "NEW");
    return instanceDir;
  }

  it("installs the new target and cleans up stage/backup/journal", async () => {
    const stageId = "test-stage-1";
    const instanceDir = await seed(stageId);
    await journaledSwap({
      instanceDir,
      stageId,
      installs: ["mods/m.jar"],
      removes: [],
      ignore: new IgnoreSet([]),
    });
    expect(await readFile(join(instanceDir, "mods", "m.jar"), "utf8")).toBe("NEW");
    expect(await pathExistsIn(instanceDir, ".anvil/swap.journal")).toBe(false);
    expect(await pathExistsIn(instanceDir, `.anvil/stage-${stageId}`)).toBe(false);
    expect(await pathExistsIn(instanceDir, `.anvil/swap-backup-${stageId}`)).toBe(false);
  });

  it("rolls back to the old target when killed before commit", async () => {
    const stageId = "test-stage-2";
    const instanceDir = await seed(stageId);
    const fault = (point: string): void => {
      if (point === "swap:before-commit") {
        throw new Error("kill");
      }
    };
    await expect(
      journaledSwap({
        instanceDir,
        stageId,
        installs: ["mods/m.jar"],
        removes: [],
        ignore: new IgnoreSet([]),
        fault,
      }),
    ).rejects.toThrow("kill");

    const outcome = await recoverSwap(instanceDir);
    expect(outcome).toBe("back");
    expect(await readFile(join(instanceDir, "mods", "m.jar"), "utf8")).toBe("OLD");
    expect(await pathExistsIn(instanceDir, ".anvil/swap.journal")).toBe(false);
  });

  it("refuses a '..' target that would escape the instance root", async () => {
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    await expect(
      journaledSwap({
        instanceDir,
        stageId: "escape",
        installs: ["../evil.jar"],
        removes: [],
        ignore: new IgnoreSet([]),
      }),
    ).rejects.toBeInstanceOf(PathEscape);
    // Nothing journaled: no swap.journal was created.
    expect(await pathExistsIn(instanceDir, ".anvil/swap.journal")).toBe(false);
  });

  it("treats a torn/corrupt begin line as clean instead of wedging recovery", async () => {
    const instanceDir = await mkTmp("inst");
    dirs.push(instanceDir);
    await mkdir(join(instanceDir, ".anvil"), { recursive: true });
    await writeFile(join(instanceDir, ".anvil", "swap.journal"), '{"t":"begin","stageId":"x"'); // truncated
    const outcome = await recoverSwap(instanceDir);
    expect(outcome).toBe("clean");
    expect(await pathExistsIn(instanceDir, ".anvil/swap.journal")).toBe(false);
  });

  it("rolls forward (keeps new) when committed but interrupted before cleanup", async () => {
    const stageId = "test-stage-3";
    const instanceDir = await seed(stageId);
    const fault = (point: string): void => {
      if (point === "swap:after-commit") {
        throw new Error("kill");
      }
    };
    await expect(
      journaledSwap({
        instanceDir,
        stageId,
        installs: ["mods/m.jar"],
        removes: [],
        ignore: new IgnoreSet([]),
        fault,
      }),
    ).rejects.toThrow("kill");

    const outcome = await recoverSwap(instanceDir);
    expect(outcome).toBe("forward");
    expect(await readFile(join(instanceDir, "mods", "m.jar"), "utf8")).toBe("NEW");
    expect(await pathExistsIn(instanceDir, ".anvil/swap.journal")).toBe(false);
  });
});
