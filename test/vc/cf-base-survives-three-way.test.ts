/**
 * LB-897 — the CurseForge counterpart to `base-survives-three-way.test.ts`.
 *
 * That file proves the `[base]` block survives merge/revert/rebase, built
 * entirely on a Modrinth `.mrpack` base (`base-pack.ts` / `MrpackBaseSource`).
 * Every other file in `test/vc/` is Modrinth-only too. That is a real gap, not
 * just a missing label: `src/base/cf-base.ts` and `src/base/mrpack-base.ts`
 * disagree on the one field that carries CurseForge's replay-never-rehosted ToS
 * invariant —
 *
 *   - `mrpack-base.ts` emits every member `provenance: "copy"`
 *   - `cf-base.ts` emits every member `provenance: "replay"`
 *
 * — so a Modrinth-only fixture asserts on a field whose value never varies: a
 * bug that drops or flips `provenance` for a base member during the VC re-lock
 * (`overlayBase`, shared by every commit/merge/revert/rebase) is invisible to
 * every existing VC test, because `"copy"` is what a passing run and a broken
 * run both produce. `base-survives-three-way.test.ts` itself never even reads
 * `provenance` off a survived package — only the `[base]` header block.
 *
 * These tests are that file's structure (merge / revert / rebase), rebuilt on
 * `cfPackWorld`/`CurseForgeBaseSource`, with an explicit check that every
 * surviving base member still carries `provenance: "replay"` (and the rest of
 * the replay shape: a `project`/`file` pin, no rehostable `url`) after each
 * verb. Mutation-tested: flipping `overlayBase`'s survivor row to
 * `provenance: "copy"` reds this file's new assertions and nothing else in the
 * base-pack suite (see LB-897 commit message / team notes for the run).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  CurseForgeBaseSource,
  type LockBase,
  type LockPackage,
  type Lockfile,
  type Manifest,
  comparePackages,
  parseRef,
  readLock,
  readManifest,
  resolveManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import {
  CF_PACK_LOADER,
  CF_PACK_MC,
  type CfMemberSpec,
  type CfPackWorld,
  cfBaseResolverFor,
  cfPackWorld,
} from "../helpers/cf-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";
import { FIXED_NOW, gamePackagesFor, resolvedLoaderLabel } from "../helpers/vc.js";

const CF_KEY = "TEST-CF-KEY";

/** The pack's own members — these arrive as `from_base` packages, never as items. */
const PACK_MODS: readonly CfMemberSpec[] = [
  { projectID: 900001, fileID: 910001, slug: "alpha" },
  { projectID: 900002, fileID: 910002, slug: "beta" },
];

/** Mods that are NOT pack members, so a branch can add one as an instance item. */
const LOOSE_MODS = [
  { projectID: 900003, fileID: 910003, slug: "gamma" },
  { projectID: 900004, fileID: 910004, slug: "delta" },
] as const;

interface CfBaseFixture {
  readonly dir: string;
  readonly world: CfPackWorld;
  readonly anvil: Anvil;
  /** Hand-write `anvil.toml` + a resolved `anvil.lock` for a base-derived manifest. */
  write(items: readonly string[]): Promise<Lockfile>;
}

/**
 * A VC fixture whose instance declares a CurseForge `game.from`. The lock is
 * hand-written (as the Modrinth VC tests do) so the hermetic game installer is
 * never involved; only the base pack and the loose mods are actually resolved,
 * through {@link FakeCurseForge} — no network, no real API key.
 */
async function makeCfBaseFixture(dirs: string[]): Promise<CfBaseFixture> {
  const world = cfPackWorld({ members: PACK_MODS });
  for (const m of LOOSE_MODS) {
    world.http.add({
      modId: m.projectID,
      slug: m.slug,
      classId: 6, // Mc Mods
      files: [
        {
          id: m.fileID,
          fileName: `${m.slug}-${m.fileID}.jar`,
          displayName: `${m.slug}-${m.fileID}.jar`,
          gameVersions: [CF_PACK_MC],
          bytes: fabricJar(m.slug),
        },
      ],
    });
  }
  const dir = await mkTmp("vc-cf-base-inst");
  const storeDir = await mkTmp("vc-cf-base-store");
  dirs.push(dir, storeDir);
  const store = new ContentStore({ root: storeDir });
  const env: AnvilEnv = {
    registry: () => registryWith({ curseforge: world.http }),
    baseRegistry: () =>
      new Map([["curseforge", { source: new CurseForgeBaseSource(), http: world.http }]]),
    now: () => FIXED_NOW,
    author: "tester",
  };

  return {
    dir,
    world,
    anvil: new Anvil({ dir, storeDir, allowSource: () => true, curseforgeKey: CF_KEY }, env),
    async write(items: readonly string[]): Promise<Lockfile> {
      const manifest: Manifest = {
        project: { name: "cf-based", version: "1.0.0" },
        game: { minecraft: CF_PACK_MC, loader: CF_PACK_LOADER, from: world.from },
        items: items.map((ref) => ({ ref: parseRef(ref) })),
      };
      await writeManifest(dir, manifest);
      const disk = await readManifest(dir);
      const itemLock = await resolveManifest({
        manifest: disk,
        registry: registryWith({ curseforge: world.http }),
        allowSource: () => true,
        now: FIXED_NOW,
        baseDir: dir,
        store,
        curseforgeKey: CF_KEY,
        resolveBase: cfBaseResolverFor(world, dir, {
          now: FIXED_NOW,
          store,
          curseforgeKey: CF_KEY,
        }),
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
 * Mirrors `base-survives-three-way.test.ts`'s `expectBaseIntact`.
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

/**
 * The actual regression this file exists to catch: every surviving base-member
 * ROW, not just the `[base]` header, still carries the CurseForge replay shape —
 * `provenance: "replay"`, a `(project, file)` pin, and no rehostable `url`.
 *
 * `count` guards against a vacuous pass: an empty `fromBase` partition (e.g. the
 * fixture silently resolving zero pack members) would make `.every(...)` true
 * for the wrong reason.
 */
function expectBaseMembersAreReplay(resolved: readonly LockPackage[], count: number): void {
  const baseMembers = resolved.filter((p) => p.fromBase === true);
  expect(baseMembers, "no fromBase rows survived — this test asserts nothing").toHaveLength(count);
  for (const pkg of baseMembers) {
    expect(pkg.source).toBe("curseforge");
    expect(pkg.provenance, `${pkg.name}: base member lost replay provenance`).toBe("replay");
    expect(pkg.project).toBeTypeOf("number");
    expect(pkg.file).toBeTypeOf("number");
    expect(pkg.url, `${pkg.name}: a replay row must never pin a rehostable url`).toBeUndefined();
  }
}

/** The two halves of the one claim: `[base]` on disk, and rows that cite it. */
async function expectLockAgreesWithManifest(dir: string): Promise<void> {
  const text = await readFile(join(dir, "anvil.lock"), "utf8");
  const manifest = await readManifest(dir);
  expect(manifest.game.from, "the merged manifest lost game.from").toBeDefined();
  expect(text).toContain("[base]");
  expect(text).toContain("from_base = true");
  // The replay shape is visible on disk too — no `url = ` line for a base member.
  expect(text).toContain('provenance = "replay"');
}

describe("the [base] block through a 3-way apply — CurseForge base (LB-897)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("survives a merge, replay provenance intact on every base member", async () => {
    const fx = await makeCfBaseFixture(dirs);
    const before = await fx.write([]);
    expect(before.base?.members).toBe(PACK_MODS.length);
    expectBaseMembersAreReplay(before.resolved, PACK_MODS.length);
    await fx.anvil.commit("b0: the base pack");
    await fx.anvil.branch("side");

    await fx.write(["curseforge:900003@910003"]); // gamma
    await fx.anvil.commit("ours: add gamma");

    await fx.anvil.switch("side");
    await fx.write(["curseforge:900004@910004"]); // delta
    await fx.anvil.commit("theirs: add delta");

    await fx.anvil.switch("main");
    const result = await fx.anvil.merge("side");
    expect(result.conflicts).toEqual([]);
    expect(result.committed, "no merge commit — the write path never ran").toBeDefined();
    expect(result.fastForward).toBe(false);

    const after = await readLock(fx.dir);
    expectBaseIntact(after.base, before.base);
    expectBaseMembersAreReplay(after.resolved, PACK_MODS.length);
    await expectLockAgreesWithManifest(fx.dir);
  });

  it("survives a revert, replay provenance intact on every base member", async () => {
    const fx = await makeCfBaseFixture(dirs);
    const before = await fx.write([]);
    await fx.anvil.commit("b0: the base pack");

    await fx.write(["curseforge:900003@910003"]); // gamma
    const target = await fx.anvil.commit("c1: add gamma");

    const result = await fx.anvil.revert(target.id.value);
    expect(result.conflicts).toEqual([]);
    expect(result.committed, "no revert commit — the write path never ran").toBeDefined();

    const after = await readLock(fx.dir);
    // The revert undid the item, so the base is the only thing left to lose.
    expect(after.resolved.some((p) => p.name === "gamma")).toBe(false);
    expectBaseIntact(after.base, before.base);
    expectBaseMembersAreReplay(after.resolved, PACK_MODS.length);
    await expectLockAgreesWithManifest(fx.dir);
  });

  it("survives a rebase, replay provenance intact on every base member", async () => {
    const fx = await makeCfBaseFixture(dirs);
    const before = await fx.write([]);
    await fx.anvil.commit("b0: the base pack");
    await fx.anvil.branch("feature");

    await fx.write(["curseforge:900003@910003"]); // gamma
    await fx.anvil.commit("m1: add gamma");

    await fx.anvil.switch("feature");
    await fx.write(["curseforge:900004@910004"]); // delta
    await fx.anvil.commit("f1: add delta");

    const result = await fx.anvil.rebase({ onto: "main" });
    expect(result.status).toBe("done");
    expect(result.conflicts).toEqual([]);

    const after = await readLock(fx.dir);
    // The replayed step really did run: the rebased tip carries both branches' items.
    expect(after.resolved.filter((p) => p.name === "gamma" || p.name === "delta").length).toBe(2);
    expectBaseIntact(after.base, before.base);
    expectBaseMembersAreReplay(after.resolved, PACK_MODS.length);
    await expectLockAgreesWithManifest(fx.dir);
  });
});
