import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  CurseForgeSource,
  ReplayUnavailable,
  ShaMismatch,
  SourceKeyMissing,
  UnsatisfiableTarget,
  curseforgeFingerprint,
} from "../../index.js";
import type { Http, SourceContext } from "../../index.js";
import { FakeCurseForge } from "../helpers/curseforge.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

function ctx(http: Http, opts: { key?: string; store?: ContentStore } = {}): SourceContext {
  return {
    http,
    offline: false,
    now: NOW,
    allowSource: () => true,
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    ...(opts.key !== undefined ? { curseforgeKey: opts.key } : {}),
    ...(opts.store ? { store: opts.store } : {}),
  };
}

describe("curseforgeFingerprint (murmur2, CF variant)", () => {
  it("is deterministic and whitespace-insensitive (CF's normalization)", () => {
    const a = new TextEncoder().encode('{"id":"x","v":1}');
    const withWs = new TextEncoder().encode('{ "id": "x",\n\t"v": 1 }\r\n');
    // Same content modulo tab/LF/CR/space → identical fingerprint.
    expect(curseforgeFingerprint(a)).toBe(curseforgeFingerprint(withWs));
    // Deterministic.
    expect(curseforgeFingerprint(a)).toBe(curseforgeFingerprint(a.slice()));
  });

  it("is a 32-bit unsigned integer and sensitive to content", () => {
    const fp = curseforgeFingerprint(new Uint8Array([1, 2, 3, 4, 5]));
    expect(Number.isInteger(fp)).toBe(true);
    expect(fp).toBeGreaterThanOrEqual(0);
    expect(fp).toBeLessThanOrEqual(0xffffffff);
    expect(curseforgeFingerprint(new Uint8Array([1, 2, 3, 4, 5]))).not.toBe(
      curseforgeFingerprint(new Uint8Array([1, 2, 3, 4, 6])),
    );
  });
});

describe("CurseForgeSource.resolve", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  function world() {
    const bytes = fabricJar("cf-mod");
    const fake = new FakeCurseForge().add({
      modId: 238222,
      slug: "jei",
      name: "Just Enough Items",
      classId: 6, // Mc Mods → mod
      files: [
        {
          id: 5000,
          displayName: "JEI 1.0.0",
          fileName: "jei-1.0.0.jar",
          fileDate: "2026-06-01T00:00:00Z",
          gameVersions: ["26.2", "Fabric"],
          bytes,
        },
      ],
    });
    return { fake, bytes };
  }

  it("fails CLOSED without a key (SourceKeyMissing) — never a silent skip", async () => {
    const { fake } = world();
    await expect(
      new CurseForgeSource().resolve(
        { source: "curseforge", id: "238222", versionSpec: { kind: "latest" } },
        ctx(fake), // no key
      ),
    ).rejects.toBeInstanceOf(SourceKeyMissing);
  });

  it("pins sha256 + replay provenance with project/file and NO rehostable url", async () => {
    const { fake, bytes } = world();
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const { pkg } = await new CurseForgeSource().resolve(
      { source: "curseforge", id: "238222", versionSpec: { kind: "latest" } },
      ctx(fake, { key: "cf-test-key", store }),
    );
    expect(pkg.source).toBe("curseforge");
    expect(pkg.provenance).toBe("replay");
    expect(pkg.kind).toBe("mod"); // classId 6
    expect(pkg.project).toBe(238222);
    expect(pkg.file).toBe(5000);
    expect(pkg.hash.algo).toBe("sha256");
    expect(pkg.hash.value).toBe(
      await import("node:crypto").then((c) => c.createHash("sha256").update(bytes).digest("hex")),
    );
    expect(pkg.placement).toEqual({ method: "link", target: "mods/jei-1.0.0.jar" });
    // THE replay invariant at the lock layer: no rehostable url is pinned.
    expect(pkg.url).toBeUndefined();
    // And CF bytes were NOT admitted to the shared store at resolve time.
    expect(await store.has(pkg.hash)).toBe(false);
    // The request was keyed.
    expect(fake.apiKeys).toContain("cf-test-key");
  });

  it("maps classIds → kinds (resourcepack / shaderpack / datapack)", async () => {
    for (const [classId, kind, dir] of [
      [12, "resourcepack", "resourcepacks"],
      [6552, "shaderpack", "shaderpacks"],
      [6945, "datapack", "datapacks"],
    ] as const) {
      const bytes = fabricJar(`cf-${kind}`);
      const fake = new FakeCurseForge().add({
        modId: 1000 + classId,
        slug: `pack-${kind}`,
        classId,
        files: [
          {
            id: 7000 + classId,
            fileName: "pack.zip",
            gameVersions: ["26.2"],
            bytes,
          },
        ],
      });
      const { pkg } = await new CurseForgeSource().resolve(
        { source: "curseforge", id: String(1000 + classId), versionSpec: { kind: "latest" } },
        ctx(fake, { key: "k" }),
      );
      expect(pkg.kind).toBe(kind);
      expect(pkg.placement).toEqual({ method: "link", target: `${dir}/pack.zip` });
    }
  });

  it("surfaces ONLY required deps (relationType 3); excludes embedded/optional", async () => {
    const fake = new FakeCurseForge().add({
      modId: 100,
      slug: "root",
      classId: 6,
      files: [
        {
          id: 900,
          fileName: "root.jar",
          gameVersions: ["26.2", "Fabric"],
          bytes: fabricJar("root"),
          dependencies: [
            { modId: 200, relationType: 3 }, // required → kept
            { modId: 201, relationType: 2 }, // optional → dropped
            { modId: 202, relationType: 1 }, // embedded → dropped
            { modId: 203, relationType: 5 }, // incompatible → dropped
          ],
        },
      ],
    });
    const { dependencies } = await new CurseForgeSource().resolve(
      { source: "curseforge", id: "100", versionSpec: { kind: "latest" } },
      ctx(fake, { key: "k" }),
    );
    expect(dependencies).toEqual([
      { source: "curseforge", id: "200", versionSpec: { kind: "latest" } },
    ]);
  });

  it("cross-checks the attested sha1 and rejects tampered bytes (ShaMismatch)", async () => {
    const bytes = fabricJar("tamper");
    const fake = new FakeCurseForge().add({
      modId: 300,
      slug: "tamper",
      classId: 6,
      files: [
        {
          id: 3000,
          fileName: "t.jar",
          gameVersions: ["26.2", "Fabric"],
          bytes,
          badSha1: "0000000000000000000000000000000000000000",
        },
      ],
    });
    await expect(
      new CurseForgeSource().resolve(
        { source: "curseforge", id: "300", versionSpec: { kind: "latest" } },
        ctx(fake, { key: "k" }),
      ),
    ).rejects.toBeInstanceOf(ShaMismatch);
  });

  it("cross-checks the murmur2 fingerprint and rejects an index/bytes mismatch", async () => {
    const fake = new FakeCurseForge().add({
      modId: 301,
      slug: "fp",
      classId: 6,
      files: [
        {
          id: 3010,
          fileName: "fp.jar",
          gameVersions: ["26.2", "Fabric"],
          bytes: fabricJar("fp"),
          badFingerprint: 123456789,
        },
      ],
    });
    await expect(
      new CurseForgeSource().resolve(
        { source: "curseforge", id: "301", versionSpec: { kind: "latest" } },
        ctx(fake, { key: "k" }),
      ),
    ).rejects.toBeInstanceOf(ShaMismatch);
  });

  it("surfaces a disabled download (null download-url) as ReplayUnavailable at lock", async () => {
    const fake = new FakeCurseForge().add({
      modId: 400,
      slug: "disabled",
      classId: 6,
      files: [
        {
          id: 4000,
          fileName: "d.jar",
          gameVersions: ["26.2", "Fabric"],
          bytes: fabricJar("d"),
          downloadDisabled: true,
        },
      ],
    });
    await expect(
      new CurseForgeSource().resolve(
        { source: "curseforge", id: "400", versionSpec: { kind: "latest" } },
        ctx(fake, { key: "k" }),
      ),
    ).rejects.toBeInstanceOf(ReplayUnavailable);
  });

  it("rejects a non-numeric project reference with a clear error", async () => {
    const { fake } = world();
    await expect(
      new CurseForgeSource().resolve(
        { source: "curseforge", id: "not-a-number", versionSpec: { kind: "latest" } },
        ctx(fake, { key: "k" }),
      ),
    ).rejects.toBeInstanceOf(UnsatisfiableTarget);
  });

  it("plan() refuses — replay bytes never travel the shared-store fetch path", () => {
    const pkg = {
      name: "jei",
      kind: "mod" as const,
      source: "curseforge" as const,
      hash: { algo: "sha256" as const, value: "ab" },
      provenance: "replay" as const,
      placement: { method: "link" as const, target: "mods/jei.jar" },
      project: 238222,
      file: 5000,
    };
    expect(() => new CurseForgeSource().plan(pkg, ctx(new FakeCurseForge(), { key: "k" }))).toThrow(
      UnsatisfiableTarget,
    );
  });
});
