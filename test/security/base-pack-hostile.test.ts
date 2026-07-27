/**
 * A base pack is attacker-controlled data that gets to describe several hundred
 * files and where each of them lands. `game.from` is a new place that data enters
 * the system, so each thing a hostile pack could try gets an explicit test.
 *
 * The one that is not a bounds check: **a base can never displace something the
 * instance declared.** That is not enforced by a guard but by the overlay's
 * precedence rule, which is why it is asserted here alongside the guards.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, type Manifest, SourceNotAllowed, resolveManifest } from "../../index.js";
import { PACK_MC, baseManifest, baseResolverFor, baseWorld } from "../helpers/base-pack.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const HONEST = [{ slug: "alpha", projectId: "ALPHA", version: "1.0.0" }];

describe("a hostile base pack", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function tmp(prefix: string): Promise<string> {
    const d = await mkTmp(prefix);
    dirs.push(d);
    return d;
  }

  async function lockIt(
    world: ReturnType<typeof baseWorld>,
    manifest: Manifest,
    opts: { instanceDir?: string; allowSource?: () => boolean } = {},
  ) {
    const instanceDir = opts.instanceDir ?? (await tmp("inst"));
    const store = new ContentStore({ root: await tmp("store") });
    const lock = await resolveManifest({
      manifest,
      registry: registryWith({ modrinth: world.http }),
      allowSource: opts.allowSource ?? (() => true),
      now: NOW,
      baseDir: instanceDir,
      store,
      resolveBase: baseResolverFor(world, instanceDir, {
        now: NOW,
        store,
        ...(opts.allowSource ? { allowSource: opts.allowSource } : {}),
      }),
    });
    return { lock, instanceDir };
  }

  it("cannot write into saves/ — the member is skipped, the world is untouched", async () => {
    const world = baseWorld({
      mods: HONEST,
      extraFiles: [
        {
          path: "saves/MyWorld/level.dat",
          bytes: new TextEncoder().encode("hostile-world"),
          mirror: "https://cdn.modrinth.com/data/EVIL/versions/EVILV/level.dat",
        },
      ],
    });
    const instanceDir = await tmp("inst");
    await mkdir(join(instanceDir, "saves", "MyWorld"), { recursive: true });
    await writeFile(join(instanceDir, "saves", "MyWorld", "level.dat"), "mine");

    const { lock } = await lockIt(world, baseManifest(world.from), { instanceDir });
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target.startsWith("saves/"),
      ),
    ).toBe(false);
    expect(await readFile(join(instanceDir, "saves", "MyWorld", "level.dat"), "utf8")).toBe("mine");
  });

  it("cannot write into .anvil/ via a member path", async () => {
    const world = baseWorld({
      mods: HONEST,
      extraFiles: [
        {
          path: ".anvil/config.toml",
          bytes: new TextEncoder().encode("hostile"),
          mirror: "https://cdn.modrinth.com/data/EVIL/versions/EVILV/config.toml",
        },
      ],
    });
    const { lock } = await lockIt(world, baseManifest(world.from));
    expect(
      lock.resolved.some(
        (p) => p.placement.method === "link" && p.placement.target.startsWith(".anvil"),
      ),
    ).toBe(false);
  });

  it("cannot traverse out of the instance with a ../ member path", async () => {
    const world = baseWorld({
      mods: HONEST,
      extraFiles: [
        {
          path: "../../escaped.jar",
          bytes: fabricJar("escaped"),
          mirror: "https://cdn.modrinth.com/data/EVIL/versions/EVILV/escaped.jar",
        },
      ],
    });
    const { lock } = await lockIt(world, baseManifest(world.from));
    for (const pkg of lock.resolved) {
      if (pkg.placement.method === "link") {
        expect(pkg.placement.target).not.toContain("..");
      }
    }
    expect(lock.resolved).toHaveLength(1); // only the honest mod
  });

  it("cannot zip-slip out of overrides/", async () => {
    const world = baseWorld({
      mods: HONEST,
      malicious: [{ name: "overrides/../../escape.txt", data: "pwned" }],
    });
    await expect(lockIt(world, baseManifest(world.from))).rejects.toThrow();
  });

  it("cannot plant a symlink through overrides/", async () => {
    const world = baseWorld({
      mods: HONEST,
      malicious: [{ name: "overrides/link", type: "symlink", linkTarget: "/etc/passwd" }],
    });
    await expect(lockIt(world, baseManifest(world.from))).rejects.toThrow();
  });

  it("cannot serve bytes that disagree with the hash it declared", async () => {
    const world = baseWorld({
      mods: HONEST,
      extraFiles: [
        {
          path: "mods/liar.jar",
          bytes: fabricJar("liar"),
          mirror: "https://cdn.modrinth.com/data/EVIL/versions/EVILV/liar.jar",
          declaredSha512: "0".repeat(128),
        },
      ],
    });
    await expect(lockIt(world, baseManifest(world.from))).rejects.toThrow(/sha512/i);
  });

  it("cannot reach a mirror the host policy refuses, and is stopped before the fetch", async () => {
    const world = baseWorld({ mods: HONEST });
    // Allow the pack itself; refuse its members. A policy that only ever sees
    // `url` refs could not express this — the gate is shown the recovered
    // Modrinth identity.
    const allow = (ref: { source: string; id: string }): boolean =>
      !(ref.source === "modrinth" && ref.id === "alpha");
    const instanceDir = await tmp("inst");
    const store = new ContentStore({ root: await tmp("store") });
    await expect(
      resolveManifest({
        manifest: baseManifest(world.from),
        registry: registryWith({ modrinth: world.http }),
        allowSource: () => true,
        now: NOW,
        baseDir: instanceDir,
        store,
        resolveBase: baseResolverFor(world, instanceDir, {
          now: NOW,
          store,
          allowSource: allow as never,
        }),
      }),
    ).rejects.toThrow(SourceNotAllowed);
  });

  it("cannot shadow a file the instance declared — the instance always wins", async () => {
    const world = baseWorld({
      mods: HONEST,
      overrides: [{ path: "config/tuning.toml", data: "pack-owns-this\n" }],
    });
    const instanceDir = await tmp("inst");
    await mkdir(join(instanceDir, "config"), { recursive: true });
    await writeFile(join(instanceDir, "config", "tuning.toml"), "mine\n");
    const manifest: Manifest = {
      ...baseManifest(world.from),
      items: [{ path: "./config/tuning.toml", kind: "config" }],
    };
    const { lock } = await lockIt(world, manifest, { instanceDir });
    const tuning = lock.resolved.filter(
      (p) => p.placement.method === "link" && p.placement.target === "config/tuning.toml",
    );
    expect(tuning).toHaveLength(1);
    expect(tuning[0]?.fromBase).toBeUndefined();
  });

  it("declares its own Minecraft version, and cannot lie its way into another", async () => {
    const world = baseWorld({ mods: HONEST, minecraft: "26.1" });
    await expect(
      lockIt(world, {
        ...baseManifest(world.from),
        game: { minecraft: PACK_MC, loader: "fabric 0.19.1", from: world.from },
      }),
    ).rejects.toThrow(/Minecraft/);
  });
});
