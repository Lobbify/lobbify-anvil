import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type Hash,
  type LockPackage,
  UnsatisfiableTarget,
  UnsupportedInstaller,
  parseForgePlan,
  resolveForge,
  selectForgeVersion,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeForgeFixtures } from "../helpers/forge.js";
import { sha256hex } from "../helpers/net.js";

const DUMMY_CLIENT: Hash = { algo: "sha1", value: "e".repeat(40) };
const COMPONENT = "java-runtime-epsilon";

describe("selectForgeVersion — version resolution (pin | latest | recommended | omitted)", () => {
  it("omitted spec resolves to recommended (newest stable, skipping -beta)", async () => {
    const fx = makeForgeFixtures();
    expect(
      await selectForgeVersion("neoforge", fx.minecraft, undefined, fx.endpoints, fx.http),
    ).toBe(fx.recommended);
  });

  it("latest resolves to the newest overall (incl. a -beta)", async () => {
    const fx = makeForgeFixtures();
    expect(
      await selectForgeVersion("neoforge", fx.minecraft, "latest", fx.endpoints, fx.http),
    ).toBe(fx.latest);
  });

  it("an explicit pin resolves to exactly that version", async () => {
    const fx = makeForgeFixtures();
    expect(
      await selectForgeVersion("neoforge", fx.minecraft, "26.2.0", fx.endpoints, fx.http),
    ).toBe("26.2.0");
  });

  it("filters out builds for a different Minecraft version", async () => {
    const fx = makeForgeFixtures();
    // 26.1.4 is a build for MC 26.1, not 26.2 → not selectable under recommended.
    await expect(
      selectForgeVersion("neoforge", fx.minecraft, "26.1.4", fx.endpoints, fx.http),
    ).rejects.toThrow(UnsatisfiableTarget);
  });

  it("a non-existent pin throws UnsatisfiableTarget", async () => {
    const fx = makeForgeFixtures();
    await expect(
      selectForgeVersion("neoforge", fx.minecraft, "99.9.9", fx.endpoints, fx.http),
    ).rejects.toThrow(UnsatisfiableTarget);
  });

  it("Forge uses the promotions feed for recommended", async () => {
    const fx = makeForgeFixtures({ flavor: "forge" });
    expect(
      await selectForgeVersion("forge", fx.minecraft, "recommended", fx.endpoints, fx.http),
    ).toBe(fx.recommended);
  });

  it("refuses a legacy (pre-profile) installer with a clear typed error", async () => {
    const fx = makeForgeFixtures();
    // Overwrite the installer with a jar missing install_profile.json / version.json.
    const { makeZip } = await import("../helpers/zip.js");
    fx.http.put(
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/26.2.5/neoforge-26.2.5-installer.jar",
      new Uint8Array(makeZip([{ name: "README.txt", data: "legacy" }])),
    );
    await expect(
      resolveForge({
        flavor: "neoforge",
        loaderVersion: "26.2.5",
        minecraft: fx.minecraft,
        http: fx.http,
        endpoints: fx.endpoints,
      }),
    ).rejects.toThrow(UnsupportedInstaller);
  });
});

describe("resolveForge — deterministic sha256 pinning + install plan", () => {
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
    const fx = makeForgeFixtures();
    const r = await resolveForge({
      flavor: "neoforge",
      loaderVersion: fx.recommended,
      minecraft: fx.minecraft,
      http: fx.http,
      store,
      endpoints: fx.endpoints,
    });
    const plan = await r.finalizePlan(DUMMY_CLIENT, COMPONENT);
    return { r, plan, store, fx };
  }

  it("pins the installer + every library + processor jar by sha256 into the store", async () => {
    const { r, store, fx } = await resolve();
    const byName = new Map(r.packages.map((p) => [p.name, p] as const));

    const installer = byName.get(`neoforge-installer-${fx.recommended}`) as LockPackage;
    expect(installer.placement.method).toBe("store-only");
    expect(installer.hash.algo).toBe("sha256");
    expect(await store.has(installer.hash)).toBe(true);

    const proc = byName.get(fx.processorCoord) as LockPackage;
    expect(proc.placement.method).toBe("store-only");
    const procBytes = (await fx.http.get(proc.url as string)).body;
    expect(proc.hash).toEqual({ algo: "sha256", value: sha256hex(procBytes) });

    // The universal jar is a fetched game library — a link into libraries/.
    const universal = [...byName.values()].find(
      (p) => p.name.endsWith(":universal") && p.placement.method === "link",
    ) as LockPackage;
    const uniBytes = (await fx.http.get(universal.url as string)).body;
    expect(universal.hash).toEqual({ algo: "sha256", value: sha256hex(uniBytes) });
  });

  it("emits a forge-build plan package whose outputs are the produced libs", async () => {
    const { plan, store, fx } = await resolve();
    expect(plan.placement.method).toBe("forge-build");
    if (plan.placement.method !== "forge-build") {
      throw new Error("unreachable");
    }
    expect(plan.placement.outputs).toContain(fx.producedPath);
    expect(await store.has(plan.hash)).toBe(true);

    const parsed = parseForgePlan(await readFile(store.objectPath(plan.hash)));
    expect(parsed.outputs).toContain(fx.producedPath);
    expect(parsed.processors[0]?.mainClass).toBe("com.example.binarypatcher.ConsoleTool");
    expect(parsed.bindings.PATCHED?.kind).toBe("output");
    expect(parsed.bindings.BINPATCH?.kind).toBe("installerFile");
    expect(parsed.bindings.SIDE).toEqual({ kind: "literal", value: "client" });
    expect(parsed.installerEntries).toContain("data/client.lzma");
  });

  it("GATE — determinism: two independent resolves pin a byte-identical plan", async () => {
    const a = await resolve();
    const b = await resolve();
    // The plan blob is content-addressed; identical fixtures → identical hash.
    expect(a.plan.hash).toEqual(b.plan.hash);
    // …and the fetched-library pins match too.
    const aProc = a.r.packages.find((p) => p.name === a.fx.processorCoord)?.hash;
    const bProc = b.r.packages.find((p) => p.name === b.fx.processorCoord)?.hash;
    expect(aProc).toEqual(bProc);
  });
});
