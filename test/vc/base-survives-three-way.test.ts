/**
 * The `[base]` block through a 3-way apply — merge, revert, and one rebase step.
 *
 * `game.from` makes two claims that are only meaningful together: the packages it
 * contributed carry `from_base = true`, and `[base]` records which pack they came
 * from. A lock holding one without the other is not a smaller truth, it is a
 * contradiction — the rows claim a base the file cannot name, while `anvil.toml`
 * still declares `game.from`.
 *
 * Every 3-way apply funnels through one worktree write, so all three verbs share
 * a single failure mode: drop `[base]` there and merge, revert and rebase each
 * produce that contradiction. A base-derived instance is also how a CurseForge
 * pack enters an instance, and `base.source` is what identifies it afterwards, so
 * the block going missing is not only a cosmetic loss of provenance.
 *
 * These tests drive the real `Anvil` verbs end to end and assert on the lock **as
 * written to disk**, since that file — not the in-memory value — is what a later
 * read, a build, or a consumer's policy check actually sees.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  type LockBase,
  type Lockfile,
  type Manifest,
  MrpackBaseSource,
  comparePackages,
  parseRef,
  readLock,
  readManifest,
  resolveManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import { PACK_LOADER, PACK_MC, baseResolverFor, baseWorld } from "../helpers/base-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { registryWith } from "../helpers/net.js";
import { FIXED_NOW, gamePackagesFor, resolvedLoaderLabel, version } from "../helpers/vc.js";

/** The pack's own members — these arrive as `from_base` packages, never as items. */
const PACK_MODS = [
  { slug: "alpha", projectId: "ALPHA", version: "1.0.0" },
  { slug: "beta", projectId: "BETA", version: "2.0.0" },
];

/** Mods that are NOT pack members, so a branch can add one as an instance item. */
const LOOSE_MODS = ["gamma", "delta"] as const;

type World = ReturnType<typeof baseWorld>;

interface BaseFixture {
  readonly dir: string;
  readonly world: World;
  readonly anvil: Anvil;
  /** Hand-write `anvil.toml` + a resolved `anvil.lock` for a base-derived manifest. */
  write(items: readonly string[]): Promise<Lockfile>;
}

/**
 * A VC fixture whose instance declares `game.from`. The lock is hand-written
 * (as the other VC tests do) so the hermetic game installer is never involved;
 * only the base pack and the loose mods are actually resolved.
 */
async function makeBaseFixture(dirs: string[]): Promise<BaseFixture> {
  const world = baseWorld({ mods: PACK_MODS });
  for (const slug of LOOSE_MODS) {
    const id = slug.toUpperCase();
    world.http.add({
      id,
      slug,
      title: slug,
      projectType: "mod",
      versions: [version(id, "1.0.0", [PACK_MC])],
    });
  }
  const dir = await mkTmp("vc-base-inst");
  const storeDir = await mkTmp("vc-base-store");
  dirs.push(dir, storeDir);
  const store = new ContentStore({ root: storeDir });
  const env: AnvilEnv = {
    registry: () => registryWith({ modrinth: world.http }),
    baseRegistry: () =>
      new Map([["modrinth", { source: new MrpackBaseSource(), http: world.http }]]),
    now: () => FIXED_NOW,
    author: "tester",
  };

  return {
    dir,
    world,
    anvil: new Anvil({ dir, storeDir, allowSource: () => true }, env),
    async write(items: readonly string[]): Promise<Lockfile> {
      const manifest: Manifest = {
        project: { name: "based", version: "1.0.0" },
        game: { minecraft: PACK_MC, loader: PACK_LOADER, from: world.from },
        items: items.map((ref) => ({ ref: parseRef(ref) })),
      };
      await writeManifest(dir, manifest);
      const disk = await readManifest(dir);
      const itemLock = await resolveManifest({
        manifest: disk,
        registry: registryWith({ modrinth: world.http }),
        allowSource: () => true,
        now: FIXED_NOW,
        baseDir: dir,
        store,
        resolveBase: baseResolverFor(world, dir, { now: FIXED_NOW, store }),
      });
      const label = resolvedLoaderLabel(disk.game.loader);
      const lock: Lockfile = {
        meta: {
          ...itemLock.meta,
          minecraft: disk.game.minecraft,
          loader: label,
          java: "runtime-test-21",
        },
        ...(itemLock.base ? { base: itemLock.base } : {}),
        resolved: [...itemLock.resolved, ...gamePackagesFor(disk.game.minecraft, label)].sort(
          comparePackages,
        ),
      };
      await writeLock(dir, lock);
      return lock;
    },
  };
}

/**
 * Assert the post-op `[base]` still makes the same claim as the pre-op one.
 *
 * Field by field before the whole-object compare, so the failure names which part
 * of the pin was lost — and guarded by a `toBeDefined` on both sides, so "neither
 * lock has a base" can never read as agreement.
 */
function expectBaseIntact(actual: LockBase | undefined, expected: LockBase | undefined): void {
  expect(expected, "the fixture is not base-derived — the test proves nothing").toBeDefined();
  expect(actual, "the [base] block did not survive the 3-way apply").toBeDefined();
  expect(actual?.ref).toBe(expected?.ref);
  expect(actual?.source).toBe(expected?.source);
  expect(actual?.id).toBe(expected?.id);
  expect(actual?.version).toBe(expected?.version);
  expect(actual?.archive).toEqual(expected?.archive);
  expect(actual?.set).toEqual(expected?.set);
  expect(actual?.members).toBe(expected?.members);
  expect(actual).toEqual(expected);
}

/** The two halves of the one claim: `[base]` on disk, and rows that cite it. */
async function expectLockAgreesWithManifest(dir: string): Promise<void> {
  const text = await readFile(join(dir, "anvil.lock"), "utf8");
  const manifest = await readManifest(dir);
  expect(manifest.game.from, "the merged manifest lost game.from").toBeDefined();
  expect(text).toContain("[base]");
  expect(text).toContain("from_base = true");
}

describe("the [base] block through a 3-way apply", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("survives a merge", async () => {
    const fx = await makeBaseFixture(dirs);
    const before = await fx.write([]);
    expect(before.base?.members).toBe(PACK_MODS.length);
    await fx.anvil.commit("b0: the base pack");
    await fx.anvil.branch("side");

    await fx.write(["modrinth:gamma"]);
    await fx.anvil.commit("ours: add gamma");

    await fx.anvil.switch("side");
    await fx.write(["modrinth:delta"]);
    await fx.anvil.commit("theirs: add delta");

    await fx.anvil.switch("main");
    const result = await fx.anvil.merge("side");
    expect(result.conflicts).toEqual([]);
    expect(result.committed, "no merge commit — the write path never ran").toBeDefined();
    expect(result.fastForward).toBe(false);

    const after = await readLock(fx.dir);
    expectBaseIntact(after.base, before.base);
    await expectLockAgreesWithManifest(fx.dir);
  });

  it("survives a revert", async () => {
    const fx = await makeBaseFixture(dirs);
    const before = await fx.write([]);
    await fx.anvil.commit("b0: the base pack");

    await fx.write(["modrinth:gamma"]);
    const target = await fx.anvil.commit("c1: add gamma");

    const result = await fx.anvil.revert(target.id.value);
    expect(result.conflicts).toEqual([]);
    expect(result.committed, "no revert commit — the write path never ran").toBeDefined();

    const after = await readLock(fx.dir);
    // The revert undid the item, so the base is the only thing left to lose.
    expect(after.resolved.some((p) => p.name === "gamma")).toBe(false);
    expectBaseIntact(after.base, before.base);
    await expectLockAgreesWithManifest(fx.dir);
  });

  it("survives a rebase", async () => {
    const fx = await makeBaseFixture(dirs);
    const before = await fx.write([]);
    await fx.anvil.commit("b0: the base pack");
    await fx.anvil.branch("feature");

    await fx.write(["modrinth:gamma"]);
    await fx.anvil.commit("m1: add gamma");

    await fx.anvil.switch("feature");
    await fx.write(["modrinth:delta"]);
    await fx.anvil.commit("f1: add delta");

    const result = await fx.anvil.rebase({ onto: "main" });
    expect(result.status).toBe("done");
    expect(result.conflicts).toEqual([]);

    const after = await readLock(fx.dir);
    // The replayed step really did run: the rebased tip carries both branches' items.
    expect(after.resolved.filter((p) => p.name === "gamma" || p.name === "delta").length).toBe(2);
    expectBaseIntact(after.base, before.base);
    await expectLockAgreesWithManifest(fx.dir);
  });
});
