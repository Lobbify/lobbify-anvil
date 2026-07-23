import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, ShaMismatch, resolveGame } from "../../index.js";
import type { LockPackage } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import {
  COMPONENT,
  FABRIC_LOADER,
  MC,
  loaderMetaBase,
  makeGameFixtures,
  mojangOptions,
} from "../helpers/game.js";
import { sha1hex, sha256hex } from "../helpers/net.js";

describe("pinning — the lock pins concrete shas; drift is detectable", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  async function resolve() {
    const storeDir = await mkTmp("store");
    dirs.push(storeDir);
    const store = new ContentStore({ root: storeDir });
    const { http } = makeGameFixtures();
    const game = await resolveGame({
      minecraft: MC,
      loader: `fabric ${FABRIC_LOADER}`,
      mojangHttp: http,
      loaderHttp: http,
      store,
      mojangOptions,
      loaderMetaBase,
    });
    return { game, store, http };
  }

  it("pins the JRE by its per-platform manifest sha1 (not just the component name)", async () => {
    const { game, http } = await resolve();
    const jre = game.packages.find(
      (p) => p.name === `java-runtime:${COMPONENT}:linux`,
    ) as LockPackage;
    // The pin IS the manifest's content address — a Mojang re-roll changes it.
    const manifestBytes = (await http.get(jre.url as string)).body;
    expect(jre.hash).toEqual({ algo: "sha1", value: sha1hex(manifestBytes) });
    // …and that manifest carries the concrete per-file shas (transitive drift too).
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(manifest.files["bin/java"].downloads.raw.sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it("pins a Fabric loader library by its concrete sha256", async () => {
    const { game, http } = await resolve();
    const asm = game.packages.find((p) => p.name === "org.ow2.asm:asm:9.10.1") as LockPackage;
    const jarBytes = (await http.get(asm.url as string)).body;
    expect(asm.hash).toEqual({ algo: "sha256", value: sha256hex(jarBytes) });
  });

  it("the store rejects a drifted JRE leaf on admission (sha mismatch)", async () => {
    const { store, http, game } = await resolve();
    const jre = game.packages.find(
      (p) => p.name === `java-runtime:${COMPONENT}:linux`,
    ) as LockPackage;
    const manifest = JSON.parse(new TextDecoder().decode((await http.get(jre.url as string)).body));
    const declared: string = manifest.files["bin/java"].downloads.raw.sha1;
    // A byte-flipped ("re-rolled") leaf can never be admitted under the pinned sha1.
    await expect(
      store.putBuffer(new TextEncoder().encode("TAMPERED"), "sha1", {
        algo: "sha1",
        value: declared,
      }),
    ).rejects.toThrow(ShaMismatch);
  });
});
