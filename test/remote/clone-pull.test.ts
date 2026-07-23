/**
 * Stage-7 gate — clone + content-addressed pull + fast-forward-on-divergence.
 *
 * These are the flagship remote-sync guarantees: a joiner clones a served
 * instance and builds it; a later `pull` transfers **only the objects a
 * package-level lock diff changed**; and when local history has diverged the
 * local commits are **preserved on a `local/<ts>` branch** while the pack is
 * fast-forwarded and `saves/` is left untouched.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTmp } from "../helpers/fixtures.js";
import { bumpMod, makeInstance, modWorldOf, writeAndLock } from "../helpers/remote.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

async function sha(dir: string, rel: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(await readFile(join(dir, rel)))
    .digest("hex");
}

async function modFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, "mods"))).sort();
  } catch {
    return [];
  }
}

describe("clone + content-addressed pull", () => {
  it("a 40-item pack, host bumps 1 mod → exactly 1 object transfers, the rest stay linked", async () => {
    const fake = modWorldOf(40);
    const host = await makeInstance(fake, "host");
    const joiner = await makeInstance(fake, "joiner");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    const items = Array.from({ length: 40 }, (_, i) => `modrinth:mod${i}`);
    await writeAndLock(host, items);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("initial 40-mod pack");

    // Joiner clones + builds in place (re-fetching all 40 mods from source).
    const cloneResult = await joiner.anvil().clone(host.dir);
    expect(cloneResult.objects).toBe(40);
    expect((await modFiles(joiner.dir)).length).toBe(40);

    // Snapshot the 39 unchanged mods on the joiner before the pull.
    const unchanged = Array.from({ length: 39 }, (_, i) => `mods/mod${i + 1}-1.0.0.jar`);
    const before = new Map<string, string>();
    for (const rel of unchanged) {
      before.set(rel, await sha(joiner.dir, rel));
    }

    // Host bumps exactly one mod, rebuilds, commits.
    bumpMod(fake, "mod0", "2.0.0");
    await writeAndLock(host, ["modrinth:mod0@2.0.0", ...items.slice(1)]);
    await hostAnvil.build();
    await hostAnvil.commit("bump mod0 → 2.0.0");

    // Joiner pulls: fast-forward + build. EXACTLY ONE object transfers.
    const pull = await joiner.anvil().pull();
    expect(pull.upToDate).toBe(false);
    expect(pull.fastForwarded).toBe(1);
    expect(pull.objects).toBe(1); // content-addressed: only the bumped mod moved

    // The 39 unchanged mods are byte-for-byte identical (stayed linked).
    for (const rel of unchanged) {
      expect(await sha(joiner.dir, rel)).toBe(before.get(rel));
    }
    // The bumped mod is now the new version; the old file is gone.
    const after = await modFiles(joiner.dir);
    expect(after).toContain("mod0-2.0.0.jar");
    expect(after).not.toContain("mod0-1.0.0.jar");
    expect(after.length).toBe(40);
  });

  it("pulling with nothing new is a no-op (up to date)", async () => {
    const fake = modWorldOf(3);
    const host = await makeInstance(fake, "host2");
    const joiner = await makeInstance(fake, "joiner2");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1", "modrinth:mod2"]);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("base");

    await joiner.anvil().clone(host.dir);
    const pull = await joiner.anvil().pull();
    expect(pull.upToDate).toBe(true);
    expect(pull.fastForwarded).toBe(0);
    expect(pull.objects).toBe(0);
  });
});

describe("fast-forward on divergence — local work is never discarded", () => {
  it("a joiner with a local commit pulls → local preserved on local/<ts>, pack FF'd, saves/ intact", async () => {
    const fake = modWorldOf(3);
    const host = await makeInstance(fake, "host3");
    const joiner = await makeInstance(fake, "joiner3");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1"]);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("base");

    // Joiner clones the base, then does its own local commit (adds mod2).
    await joiner.anvil().clone(host.dir);
    await writeAndLock(joiner, ["modrinth:mod0", "modrinth:mod1", "modrinth:mod2"]);
    const joinerAnvil = joiner.anvil();
    await joinerAnvil.build();
    await joinerAnvil.commit("local: add mod2");

    // The joiner has a world save that must survive the pull untouched.
    await mkdir(join(joiner.dir, "saves", "myworld"), { recursive: true });
    const savePath = join(joiner.dir, "saves", "myworld", "level.dat");
    await writeFile(savePath, "PRECIOUS-WORLD-BYTES");

    // Host advances on a DIVERGENT line (removes mod1).
    await writeAndLock(host, ["modrinth:mod0"]);
    await hostAnvil.build();
    await hostAnvil.commit("host: drop mod1");

    // Joiner pulls: histories diverged → local commit stashed, pack fast-forwarded.
    const pull = await joiner.anvil().pull();
    expect(pull.stashedTo).toBeDefined();
    expect(pull.stashedTo).toMatch(/^local\//);

    // The local commit is preserved on the stash branch.
    const stashLog = await joiner.anvil().log(pull.stashedTo);
    expect(stashLog.some((e) => e.message === "local: add mod2")).toBe(true);

    // The pack was fast-forwarded to the host tip (mod1 removed, mod2 gone).
    const mods = await modFiles(joiner.dir);
    expect(mods).toContain("mod0-1.0.0.jar");
    expect(mods).not.toContain("mod1-1.0.0.jar");
    expect(mods).not.toContain("mod2-1.0.0.jar");

    // saves/ is byte-for-byte intact.
    expect(await readFile(savePath, "utf8")).toBe("PRECIOUS-WORLD-BYTES");
  });
});
