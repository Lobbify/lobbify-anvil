/**
 * Stage-7 (remotes) test scaffolding — all offline. A "world" is a set of Modrinth
 * mods served by {@link FakeModrinth}; a host + joiner are each a real {@link Anvil}
 * over its own temp instance dir + temp shared store, wired to the same fake
 * registry (so a joiner genuinely re-fetches from source). Locks carry mods only —
 * no game install — so builds never touch the Mojang installer.
 */

import {
  Anvil,
  type AnvilEnv,
  type AnvilOptions,
  ContentStore,
  type Lockfile,
  type Manifest,
  type SourceRegistry,
  parseRef,
  readManifest,
  resolveManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import { mkTmp } from "./fixtures.js";
import { type FakeModrinth, registryWith } from "./net.js";
import { modWorld, version } from "./vc.js";

export const NOW = Date.parse("2026-07-01T00:00:00Z");

/** Build a FakeModrinth world of `n` single-version mods (`mod0`…`mod{n-1}`). */
export function modWorldOf(n: number, mc = "26.2"): FakeModrinth {
  const specs = Array.from({ length: n }, (_, i) => ({
    slug: `mod${i}`,
    id: `mod${i}`,
    versions: [version(`mod${i}`, "1.0.0", [mc])],
  }));
  return modWorld(specs);
}

/** Add a fresh version of an existing mod (so the host can "bump" it). */
export function bumpMod(fake: FakeModrinth, slug: string, ver: string, mc = "26.2"): void {
  fake.add({
    id: slug,
    slug,
    title: slug,
    projectType: "mod",
    versions: [version(slug, "1.0.0", [mc]), version(slug, ver, [mc])],
  });
}

export interface Instance {
  readonly dir: string;
  readonly storeDir: string;
  readonly store: ContentStore;
  readonly registry: () => SourceRegistry;
  anvil(opts?: Partial<AnvilOptions>): Anvil;
}

/** Spin up an instance (temp dir + temp store) wired to a fake registry. */
export async function makeInstance(fake: FakeModrinth, label: string): Promise<Instance> {
  const dir = await mkTmp(label);
  const storeDir = await mkTmp(`${label}-store`);
  const store = new ContentStore({ root: storeDir });
  const registry = (): SourceRegistry => registryWith({ modrinth: fake });
  // Hermetic DNS for the untrusted-lock pre-vet: every host resolves to a benign
  // public address, so clone/pull validation never touches the real network.
  const env: AnvilEnv = {
    registry,
    now: () => NOW,
    author: "tester",
    resolveHost: async () => ["93.184.216.34"],
  };
  return {
    dir,
    storeDir,
    store,
    registry,
    anvil(opts?: Partial<AnvilOptions>): Anvil {
      return new Anvil({ dir, storeDir, allowSource: () => true, ...opts }, env);
    },
  };
}

/** Write `anvil.toml` (mod refs) + resolve a mods-only `anvil.lock`. */
export async function writeAndLock(
  inst: Instance,
  items: readonly string[],
  loader = "fabric 0.19.1",
): Promise<Lockfile> {
  const manifest: Manifest = {
    project: { name: "pack", version: "1.0.0" },
    game: { minecraft: "26.2", loader },
    items: items.map((i) => ({ ref: parseRef(i) })),
  };
  await writeManifest(inst.dir, manifest);
  const disk = await readManifest(inst.dir);
  const lock = await resolveManifest({
    manifest: disk,
    registry: inst.registry(),
    allowSource: () => true,
    now: NOW,
    baseDir: inst.dir,
    store: inst.store,
  });
  await writeLock(inst.dir, lock);
  return lock;
}
