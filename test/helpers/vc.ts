/**
 * Stage-5 (version control) test scaffolding — all offline. A VC test sets up an
 * instance by hand-writing an `anvil.toml` + a resolved `anvil.lock` (the item
 * pins come from {@link FakeModrinth}; the game install is a minimal stand-in, so
 * the tests never touch the Mojang installer), then drives the `Anvil` VC methods
 * with an injected fixture registry + a controllable clock.
 */

import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  type LockPackage,
  type Lockfile,
  type Manifest,
  type SourceRegistry,
  comparePackages,
  hashBuffer,
  parseRef,
  readManifest,
  resolveManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import { mkTmp } from "./fixtures.js";
import { FakeModrinth, fabricJar, registryWith } from "./net.js";

export const FIXED_NOW = Date.parse("2026-07-01T00:00:00Z");

/** A minimal Modrinth version record for the fake. */
export function version(
  projectId: string,
  ver: string,
  gameVersions: string[],
): {
  id: string;
  projectId: string;
  versionNumber: string;
  datePublished: string;
  loaders: string[];
  gameVersions: string[];
  filename: string;
  bytes: Uint8Array;
} {
  return {
    id: `${projectId}-${ver}`,
    projectId,
    versionNumber: ver,
    datePublished: "2026-06-01T00:00:00Z",
    loaders: ["fabric"],
    gameVersions,
    filename: `${projectId}-${ver}.jar`,
    bytes: fabricJar(`${projectId}-${ver}`),
  };
}

/** A Modrinth fake carrying a set of mods (each with its own game-version support). */
export function modWorld(
  mods: { slug: string; id: string; versions: ReturnType<typeof version>[] }[],
): FakeModrinth {
  const fake = new FakeModrinth();
  for (const m of mods) {
    fake.add({
      id: m.id,
      slug: m.slug,
      title: m.slug,
      projectType: "mod",
      versions: m.versions,
    });
  }
  return fake;
}

/**
 * The RESOLVED loader label a real `resolveGame` would emit (`"fabric" → "fabric
 * 0.19.9"`) — deliberately distinct from the unpinned manifest string, so tests
 * exercise the manifest-string-vs-resolved-label distinction `#gameFor` must honor.
 */
export function resolvedLoaderLabel(manifestLoader: string): string {
  const parts = manifestLoader.trim().split(/\s+/);
  const name = parts[0] ?? "vanilla";
  if (name === "vanilla") {
    return "vanilla";
  }
  return parts.length >= 2 ? manifestLoader : `${name} 0.19.9`;
}

/** A deterministic, minimal game-install package set for a `{minecraft, loader}`. */
export function gamePackagesFor(minecraft: string, loader: string): LockPackage[] {
  const hash = hashBuffer(new TextEncoder().encode(`client|${minecraft}|${loader}`), "sha256");
  return [
    {
      name: "minecraft-client",
      kind: "game",
      source: "mojang",
      version: minecraft,
      hash,
      provenance: "copy",
      placement: { method: "store-only" },
    },
  ];
}

export interface VcFixture {
  readonly dir: string;
  readonly storeDir: string;
  readonly store: ContentStore;
  readonly registry: () => SourceRegistry;
  readonly fake: FakeModrinth;
  /** Construct an `Anvil` bound to this fixture, with an optional clock override. */
  anvil(now?: () => number): Anvil;
  /** Hand-write `anvil.toml` + a resolved `anvil.lock` for a manifest. */
  writeLockFor(manifest: Manifest, now?: number): Promise<Lockfile>;
}

/** Spin up a fresh VC fixture: temp instance dir, temp shared store, fixture registry. */
export async function makeVcFixture(fake: FakeModrinth): Promise<VcFixture> {
  const dir = await mkTmp("vc-inst");
  const storeDir = await mkTmp("vc-store");
  const store = new ContentStore({ root: storeDir });
  const registry = (): SourceRegistry => registryWith({ modrinth: fake });

  const env = (now?: () => number): AnvilEnv => ({
    registry,
    now: now ?? (() => FIXED_NOW),
    author: "tester",
  });

  return {
    dir,
    storeDir,
    store,
    registry,
    fake,
    anvil(now?: () => number): Anvil {
      return new Anvil({ dir, storeDir, allowSource: () => true }, env(now));
    },
    async writeLockFor(manifest: Manifest, now = FIXED_NOW): Promise<Lockfile> {
      await writeManifest(dir, manifest);
      const disk = await readManifest(dir);
      const itemLock = await resolveManifest({
        manifest: disk,
        registry: registry(),
        allowSource: () => true,
        now,
        baseDir: dir,
        store,
      });
      // Mirror `resolveGame`: the lock records the RESOLVED loader label, which for
      // an unpinned manifest loader ("fabric") differs from the manifest string.
      const label = resolvedLoaderLabel(disk.game.loader);
      const game = gamePackagesFor(disk.game.minecraft, label);
      const lock: Lockfile = {
        meta: {
          ...itemLock.meta,
          minecraft: disk.game.minecraft,
          loader: label,
          java: "runtime-test-21",
        },
        resolved: [...itemLock.resolved, ...game].sort(comparePackages),
      };
      await writeLock(dir, lock);
      return lock;
    },
  };
}

/** A manifest builder: game base + a list of `source:id@ver` item refs. */
export function manifest(opts: {
  minecraft: string;
  loader?: string;
  items: string[];
}): Manifest {
  return {
    project: { name: "vc-pack", version: "1.0.0" },
    game: { minecraft: opts.minecraft, loader: opts.loader ?? "fabric 0.19.1" },
    items: opts.items.map((ref) => ({ ref: parseRef(ref) })),
  };
}
