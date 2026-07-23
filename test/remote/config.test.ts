/**
 * Stage-7 — the `.anvil/config.toml` remote table. Adding/removing a remote
 * preserves a hand-authored `[paths]` table; kind inference + resolution behave.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRemote,
  inferRemoteKind,
  listRemotes,
  makeDescriptor,
  readConfig,
  removeRemote,
  resolveRemote,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

describe("remote kind inference", () => {
  it("infers git / room / url from the URL shape", () => {
    expect(inferRemoteKind("https://github.com/a/b.git")).toBe("git");
    expect(inferRemoteKind("git@github.com:a/b.git")).toBe("git");
    expect(inferRemoteKind("git+https://x/y")).toBe("git");
    expect(inferRemoteKind("lobby://host/room-abc")).toBe("room");
    expect(inferRemoteKind("https://example.com/pack")).toBe("url");
    expect(inferRemoteKind("/srv/shared/pack")).toBe("url");
    expect(inferRemoteKind("file:///srv/pack")).toBe("url");
  });
});

describe(".anvil/config.toml remote table", () => {
  it("adding/removing a remote preserves a hand-authored [paths] table", async () => {
    const dir = await mkTmp("cfg");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil"), { recursive: true });
    await writeFile(
      join(dir, ".anvil", "config.toml"),
      '[paths]\nstore = "./my-store"\nassets = "/shared/assets"\n',
    );

    await addRemote(dir, makeDescriptor("origin", "https://example.com/pack", { ref: "main" }));
    let config = await readConfig(dir);
    expect(config.paths?.store).toBe("./my-store");
    expect(config.paths?.assets).toBe("/shared/assets");
    expect(config.remotes.map((r) => r.name)).toEqual(["origin"]);
    expect(config.remotes[0]?.kind).toBe("url");
    expect(config.remotes[0]?.ref).toBe("main");

    // A second remote coexists; resolveRemote finds `origin` by convention.
    await addRemote(dir, makeDescriptor("mirror", "https://mirror.example.com/pack"));
    expect((await listRemotes(dir)).map((r) => r.name).sort()).toEqual(["mirror", "origin"]);
    expect((await resolveRemote(dir))?.name).toBe("origin");
    expect((await resolveRemote(dir, "mirror"))?.name).toBe("mirror");

    // Removing one keeps the paths + the other remote.
    expect(await removeRemote(dir, "mirror")).toBe(true);
    config = await readConfig(dir);
    expect(config.paths?.store).toBe("./my-store");
    expect(config.remotes.map((r) => r.name)).toEqual(["origin"]);
    expect(await removeRemote(dir, "does-not-exist")).toBe(false);
  });
});
