import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  GameAcquirer,
  type Lockfile,
  PathEscape,
  ProcessorRefused,
  buildInstance,
  comparePackages,
  currentPlatform,
  resolveGame,
} from "../../index.js";
import type { AllowProcessor } from "../../index.js";
import { listFiles, mkTmp, rmTmp, treeManifest } from "../helpers/fixtures.js";
import { FakeProcessorRunner, makeForgeFixtures } from "../helpers/forge.js";
import { makeGameFixtures, mojangOptions, resourcesBase } from "../helpers/game.js";

const MC = "26.2";

interface BuildOut {
  readonly dir: string;
  readonly storeDir: string;
  readonly runner: FakeProcessorRunner;
  readonly lock: Lockfile;
}

async function resolveAndBuildForge(
  opts: {
    processorCoord?: string;
    allowProcessor?: AllowProcessor;
    evilDataValue?: string;
    exitCode?: number;
  } = {},
): Promise<BuildOut> {
  const storeDir = await mkTmp("store");
  const instanceDir = await mkTmp("inst");
  const store = new ContentStore({ root: storeDir });
  const gameFx = makeGameFixtures();
  const forgeFx = makeForgeFixtures({
    ...(opts.processorCoord ? { processorCoord: opts.processorCoord } : {}),
    ...(opts.evilDataValue ? { evilDataValue: opts.evilDataValue } : {}),
  });

  const game = await resolveGame({
    minecraft: MC,
    loader: `neoforge ${forgeFx.recommended}`,
    mojangHttp: gameFx.http,
    loaderHttp: forgeFx.http,
    store,
    mojangOptions,
    forgeEndpoints: forgeFx.endpoints,
  });
  const lock: Lockfile = {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "00" },
      minecraft: MC,
      loader: game.loader,
      java: game.java,
    },
    resolved: [...game.packages].sort(comparePackages),
  };

  const runner = new FakeProcessorRunner(
    opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {},
  );
  const acquire = new GameAcquirer({ store, http: gameFx.http, resourcesBase });
  await buildInstance({
    instanceDir,
    lock,
    store,
    acquire,
    platform: currentPlatform(),
    processorRunner: runner,
    ...(opts.allowProcessor ? { allowProcessor: opts.allowProcessor } : {}),
  });
  return { dir: instanceDir, storeDir, runner, lock };
}

describe("Forge/NeoForge — end-to-end resolve → lock → build (sandboxed processors)", () => {
  const dirs: string[] = [];
  const track = (r: BuildOut): BuildOut => {
    dirs.push(r.dir, r.storeDir);
    return r;
  };
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("materializes a launch-ready instance: vanilla client, universal lib, processor-produced client lib, version.json", async () => {
    const forgeFx = makeForgeFixtures();
    const out = track(await resolveAndBuildForge());
    const files = await listFiles(out.dir);
    const id = `neoforge-${forgeFx.recommended}`;
    // The version profile + vanilla client jar are in place.
    expect(files).toContain(`versions/${id}/${id}.json`);
    expect(files).toContain(`versions/${id}/${id}.jar`);
    // The fetched Forge universal library is linked in.
    expect(files).toContain(
      `libraries/net/neoforged/neoforge/${forgeFx.recommended}/neoforge-${forgeFx.recommended}-universal.jar`,
    );
    // The sandboxed processors PRODUCED the patched client library.
    expect(files).toContain(forgeFx.producedPath);
    const produced = await readFile(join(out.dir, forgeFx.producedPath), "utf8");
    expect(produced).toMatch(/^forge-processor-output:/);
    // The pinned JRE + assets still materialize as for any install.
    expect(files.some((f) => f.startsWith("runtime/"))).toBe(true);
    expect(files).toContain("assets/indexes/26.json");
  });

  it("hands each processor a constrained, network-denied, scoped spec", async () => {
    const out = track(await resolveAndBuildForge());
    expect(out.runner.specs).toHaveLength(1);
    const spec = out.runner.specs[0];
    expect(spec?.network).toBe(false);
    expect(spec?.env).toEqual({}); // no inherited env / secrets
    expect(spec?.readRoots.length).toBeGreaterThan(0);
    expect(spec?.writeRoots.length).toBeGreaterThan(0);
    // Every path arg sits under a scratch read root (the sandbox scoping).
    for (const arg of spec?.args ?? []) {
      if (arg.startsWith("/") || /^[a-zA-Z]:[/\\]/.test(arg)) {
        const underRoot = (spec?.readRoots ?? []).some((r) => arg.startsWith(r));
        expect(underRoot).toBe(true);
      }
    }
  });

  it("GATE — determinism: two independent resolve+build cycles → byte-identical tree", async () => {
    const a = track(await resolveAndBuildForge());
    const b = track(await resolveAndBuildForge());
    const [ma, mb] = await Promise.all([treeManifest(a.dir), treeManifest(b.dir)]);
    expect(ma).toBe(mb);
    expect(ma.length).toBeGreaterThan(0);
  });

  it("REFUSES a non-official processor under default-deny consent (RCE gate at build)", async () => {
    await expect(resolveAndBuildForge({ processorCoord: "com.evil:pwn:6.6.6" })).rejects.toThrow(
      ProcessorRefused,
    );
  });

  it("an explicit host consent hook can admit a non-official processor", async () => {
    const out = track(
      await resolveAndBuildForge({
        processorCoord: "com.thirdparty:tool:1.0",
        allowProcessor: (p) => p.coordinate === "com.thirdparty:tool:1.0",
      }),
    );
    // It ran (produced the output) under explicit consent.
    const forgeFx = makeForgeFixtures({ processorCoord: "com.thirdparty:tool:1.0" });
    expect(await listFiles(out.dir)).toContain(forgeFx.producedPath);
  });

  it("REJECTS a zip-slip / path-escape installer-data entry", async () => {
    await expect(
      resolveAndBuildForge({ evilDataValue: "/../../../../etc/cron.d/pwn" }),
    ).rejects.toThrow(PathEscape);
  });
});
