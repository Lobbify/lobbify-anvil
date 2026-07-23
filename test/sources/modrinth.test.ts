import { afterEach, describe, expect, it } from "vitest";
import { ContentStore, ModrinthSource, ShaMismatch } from "../../index.js";
import type { Http, HttpResult, SourceContext } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeModrinth, fabricJar, sha1hex } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");

function ctxWith(http: Http, store?: ContentStore): SourceContext {
  return {
    http,
    offline: false,
    now: NOW,
    allowSource: () => true,
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    ...(store ? { store } : {}),
  };
}

describe("ModrinthSource", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  function world() {
    const bytesOld = fabricJar("sodium-old");
    const bytesNew = fabricJar("sodium-new");
    const fake = new FakeModrinth().add({
      id: "AANobbMI",
      slug: "sodium",
      title: "Sodium",
      projectType: "mod",
      versions: [
        {
          id: "v-old",
          projectId: "AANobbMI",
          versionNumber: "0.5.0",
          datePublished: "2026-06-01T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: ["26.2"],
          filename: "sodium-0.5.0.jar",
          bytes: bytesOld,
        },
        {
          id: "v-future",
          projectId: "AANobbMI",
          versionNumber: "0.6.0",
          datePublished: "2026-08-01T00:00:00Z", // after the frozen clock
          loaders: ["fabric"],
          gameVersions: ["26.2"],
          filename: "sodium-0.6.0.jar",
          bytes: bytesNew,
        },
      ],
    });
    return { fake, bytesOld };
  }

  it("resolves latest under the frozen clock and pins sha256, ignoring future versions", async () => {
    const { fake, bytesOld } = world();
    const store = new ContentStore({ root: await mkTmp("store") });
    dirs.push(store.root);
    const { pkg } = await new ModrinthSource().resolve(
      { source: "modrinth", id: "sodium", versionSpec: { kind: "latest" } },
      ctxWith(fake, store),
    );
    // 0.6.0 is published after NOW → latest-at-lock is 0.5.0.
    expect(pkg.version).toBe("0.5.0");
    expect(pkg.name).toBe("sodium");
    expect(pkg.kind).toBe("mod");
    expect(pkg.source).toBe("modrinth");
    expect(pkg.provenance).toBe("copy");
    expect(pkg.placement).toEqual({ method: "link", target: "mods/sodium-0.5.0.jar" });
    expect(pkg.hash.algo).toBe("sha256");
    // The bytes were admitted to the store at lock time.
    expect(await store.has(pkg.hash)).toBe(true);
    void bytesOld;
  });

  it("resolves an explicit pin", async () => {
    const { fake } = world();
    const { pkg } = await new ModrinthSource().resolve(
      { source: "modrinth", id: "sodium", versionSpec: { kind: "pin", version: "0.6.0" } },
      ctxWith(fake),
    );
    expect(pkg.version).toBe("0.6.0");
  });

  it("cross-checks Modrinth's attested sha1 and rejects tampered bytes", async () => {
    const realBytes = fabricJar("tampered");
    const tampered: Http = {
      async get(url: string): Promise<HttpResult> {
        const u = new URL(url);
        if (u.pathname.endsWith("/version")) {
          const body = new TextEncoder().encode(
            JSON.stringify([
              {
                id: "v1",
                project_id: "P",
                version_number: "1.0.0",
                date_published: "2026-01-01T00:00:00Z",
                loaders: ["fabric"],
                game_versions: ["26.2"],
                files: [
                  {
                    hashes: { sha1: sha1hex(new Uint8Array([1, 2, 3])) }, // wrong sha1
                    url: "https://cdn.modrinth.com/tampered.jar",
                    filename: "tampered.jar",
                    primary: true,
                    size: realBytes.byteLength,
                  },
                ],
                dependencies: [],
              },
            ]),
          );
          return { status: 200, headers: {}, url, body };
        }
        if (u.pathname.endsWith("/project/tampered")) {
          return {
            status: 200,
            headers: {},
            url,
            body: new TextEncoder().encode(
              JSON.stringify({ id: "P", slug: "tampered", title: "T", project_type: "mod" }),
            ),
          };
        }
        return { status: 200, headers: {}, url, body: realBytes };
      },
    };
    await expect(
      new ModrinthSource().resolve(
        { source: "modrinth", id: "tampered", versionSpec: { kind: "latest" } },
        ctxWith(tampered),
      ),
    ).rejects.toBeInstanceOf(ShaMismatch);
  });

  it("surfaces required deps via a single batched /versions call", async () => {
    const libBytes = fabricJar("lib");
    const fake = new FakeModrinth()
      .add({
        id: "ROOT",
        slug: "root-mod",
        title: "Root",
        projectType: "mod",
        versions: [
          {
            id: "root-v1",
            projectId: "ROOT",
            versionNumber: "1.0.0",
            datePublished: "2026-01-01T00:00:00Z",
            loaders: ["fabric"],
            gameVersions: ["26.2"],
            filename: "root-1.0.0.jar",
            bytes: fabricJar("root"),
            dependencies: [{ version_id: "lib-v1", dependency_type: "required" }],
          },
        ],
      })
      .add({
        id: "LIB",
        slug: "lib",
        title: "Lib",
        projectType: "mod",
        versions: [
          {
            id: "lib-v1",
            projectId: "LIB",
            versionNumber: "2.0.0",
            datePublished: "2026-01-01T00:00:00Z",
            loaders: ["fabric"],
            gameVersions: ["26.2"],
            filename: "lib-2.0.0.jar",
            bytes: libBytes,
          },
        ],
      });
    const { dependencies } = await new ModrinthSource().resolve(
      { source: "modrinth", id: "root-mod", versionSpec: { kind: "latest" } },
      ctxWith(fake),
    );
    expect(dependencies).toEqual([
      { source: "modrinth", id: "LIB", versionSpec: { kind: "pin", version: "2.0.0" } },
    ]);
    expect(fake.calls.some((u) => u.includes("/versions?ids="))).toBe(true);
  });
});
