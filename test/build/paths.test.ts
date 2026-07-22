import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

// A couple of cases assert POSIX-absolute config paths (not absolute on Windows).
// The resolution-order logic is OS-agnostic; these two run on Linux/macOS.
const posixIt = it.skipIf(process.platform === "win32");

describe("path mapping resolution order", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("defaults store to ~/.anvil/store and instance to the dir", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    const paths = await resolvePaths(dir, { dir });
    expect(paths.store).toBe(join(homedir(), ".anvil", "store"));
    expect(paths.instance).toBe(dir);
  });

  posixIt("reads [paths] from .anvil/config.toml when no option overrides", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil"), { recursive: true });
    await writeFile(
      join(dir, ".anvil", "config.toml"),
      '[paths]\nstore = "/srv/anvil-store"\nassets = "/srv/mc/assets"\n',
    );
    const paths = await resolvePaths(dir, { dir });
    expect(paths.store).toBe("/srv/anvil-store");
    expect(paths.assets).toBe("/srv/mc/assets");
  });

  posixIt("lets explicit options win over config.toml (options > config > default)", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil"), { recursive: true });
    await writeFile(join(dir, ".anvil", "config.toml"), '[paths]\nstore = "/from/config"\n');
    const paths = await resolvePaths(dir, {
      dir,
      storeDir: "/from/options",
      paths: { assets: "/opt/assets" },
    });
    expect(paths.store).toBe("/from/options");
    expect(paths.assets).toBe("/opt/assets");
  });

  it("resolves a relative config path against the instance dir", async () => {
    const dir = await mkTmp("inst");
    dirs.push(dir);
    await mkdir(join(dir, ".anvil"), { recursive: true });
    await writeFile(join(dir, ".anvil", "config.toml"), '[paths]\nstore = "local-store"\n');
    const paths = await resolvePaths(dir, { dir });
    expect(paths.store).toBe(join(dir, "local-store"));
  });
});
