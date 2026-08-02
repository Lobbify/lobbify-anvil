/**
 * LB-706 security gate — widening a local item's placement from
 * `<kind-dir>/<basename>` to its declared path re-opens the path-traversal
 * surface the extraction hardening closed. A manifest is untrusted input (it
 * arrives with a cloned pack), so a declared path must never place bytes outside
 * the instance root, and never inside a protected top-level entry.
 *
 * Two distinct outcomes, deliberately:
 *
 *   - **Outside the instance** (absolute, drive-letter, `..` past the root) is not
 *     an error — a manifest may legitimately reference a file outside the folder
 *     (`"../shared/mods/foo.jar"`). It simply declares no placement, so the item
 *     falls back to its kind directory and lands *inside* the instance anyway.
 *   - **Inside but protected** (`saves/`, `.anvil/`, `.anvilignore`) is refused at
 *     lock time. The kind-directory fallback would have quietly turned
 *     `saves/level.dat` into `config/level.dat`, which is the silent-relocation
 *     bug this ticket exists to kill.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContentStore,
  type Manifest,
  PathEscape,
  declaredPlacementTarget,
  resolveManifest,
} from "../../index.js";
import { safeJoin } from "../../src/internal/fs.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { fabricJar, registryWith } from "../helpers/net.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

/**
 * Whether `abs` is `root` itself or genuinely nested under it, asked of the
 * PLATFORM `path` module rather than a hardcoded separator (LB-825).
 *
 * On Windows `safeJoin` legitimately returns a backslash-separated,
 * drive-lettered absolute path (e.g. `C:\tmp\anvil-instance\options.txt`), so
 * a POSIX `startsWith(root + "/")` string check is false for well-contained
 * output — it asserts the test runner's platform, not containment. Resolving
 * both sides and comparing with the platform's own `path.sep` is correct on
 * every OS `safeJoin` runs on, and — unlike a bare `startsWith(root)` — the
 * trailing `sep` still refuses a sibling that merely shares `root`'s string
 * prefix (`/tmp/anvil-instance-evil-twin` is not under `/tmp/anvil-instance`).
 */
function isUnderRoot(root: string, abs: string): boolean {
  const normalizedRoot = resolve(root);
  return abs === normalizedRoot || abs.startsWith(normalizedRoot + sep);
}

function manifestWith(path: string, kind?: "mod" | "config"): Manifest {
  return {
    project: { name: "p", version: "1.0.0" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [{ path, ...(kind ? { kind } : {}) }],
  };
}

describe("declaredPlacementTarget — the placement half of the path guard", () => {
  it("keeps an in-instance path verbatim, normalizing separators and no-op segments", () => {
    expect(declaredPlacementTarget("options.txt")).toBe("options.txt");
    expect(declaredPlacementTarget("./config/a/b/c.toml")).toBe("config/a/b/c.toml");
    expect(declaredPlacementTarget("config//a///b.toml")).toBe("config/a/b.toml");
    expect(declaredPlacementTarget("config\\a\\b.toml")).toBe("config/a/b.toml");
    // An inner `..` that stays inside is folded, never passed through — so the
    // result carries no traversal segment for safeJoin to have to catch later.
    expect(declaredPlacementTarget("config/x/../a.toml")).toBe("config/a.toml");
    expect(declaredPlacementTarget("./a/./b/c.jar")).toBe("a/b/c.jar");
  });

  it("declares NO placement for anything that resolves outside the instance", () => {
    for (const outside of [
      "../escape.txt",
      "../../etc/passwd",
      "a/../../b.txt",
      "a/b/../../../c.txt",
      "/etc/passwd",
      "/",
      "\\\\server\\share\\evil.txt",
      "C:\\Windows\\system32\\evil.dll",
      "C:relative.txt",
      "c:/lower/drive.txt",
      "",
      ".",
      "./",
      "..",
    ]) {
      expect(declaredPlacementTarget(outside), outside).toBeUndefined();
    }
  });

  it("REFUSES a protected top-level target rather than silently re-homing it", () => {
    for (const protectedPath of [
      "saves/level.dat",
      "saves/world/region/r.0.0.mca",
      "SAVES/level.dat", // NTFS/APFS are case-insensitive — fold like safeJoin
      "Saves/level.dat",
      "./saves/x",
      "saves/../saves/x",
      ".anvil/config.toml",
      ".anvil/refs/built",
      ".anvilignore",
      "config/../saves/level.dat", // folds back INTO a protected top
    ]) {
      expect(() => declaredPlacementTarget(protectedPath), protectedPath).toThrow(PathEscape);
    }
  });

  it("refuses a NUL byte (the classic truncation trick)", () => {
    expect(() => declaredPlacementTarget("config/a\0.toml")).toThrow(PathEscape);
    expect(() => declaredPlacementTarget("saves\0/x")).toThrow(PathEscape);
  });

  it("agrees with safeJoin: every target it returns is placeable, and stays under the root", () => {
    const root = "/tmp/anvil-instance";
    for (const p of ["options.txt", "config/a/b/c.toml", "config/x/../a.toml", "mods/sub/m.jar"]) {
      const target = declaredPlacementTarget(p);
      expect(target).toBeDefined();
      // safeJoin is the build-time enforcement; it must accept what we hand it.
      const abs = safeJoin(root, target as string);
      expect(isUnderRoot(root, abs), `${abs} is not under ${root}`).toBe(true);
    }
  });

  it("isUnderRoot itself goes red for a genuine escape (negative control for the check above)", () => {
    // Not routed through safeJoin: safeJoin's job is to THROW on an escaping
    // input rather than return one, and that refusal is already covered by
    // the "declares NO placement" and PathEscape tests above. This test is
    // about the containment CHECK, not the guard — proving isUnderRoot can
    // actually observe an escape, so the assertion it replaced above is not
    // silently vacuous on any platform.
    const root = "/tmp/anvil-instance";
    expect(isUnderRoot(root, resolve(root, "options.txt"))).toBe(true);
    // A sibling directory that merely shares root's string prefix — the
    // classic `startsWith(root)`-without-separator bug class.
    expect(isUnderRoot(root, resolve("/tmp/anvil-instance-evil-twin/options.txt"))).toBe(false);
    // A path with no relation to root at all.
    expect(isUnderRoot(root, resolve("/etc/passwd"))).toBe(false);
  });
});

describe("resolveManifest — a hostile manifest cannot place bytes outside the instance", () => {
  async function fixture(): Promise<{ instanceDir: string; store: ContentStore }> {
    const instanceDir = await mkTmp("trav-inst");
    const store = new ContentStore({ root: await mkTmp("trav-store") });
    dirs.push(instanceDir, store.root);
    return { instanceDir, store };
  }

  const resolveOpts = { registry: registryWith({}), allowSource: () => true, now: Date.now() };

  it("refuses a manifest item that targets saves/ (PathEscape, no lock produced)", async () => {
    const { instanceDir, store } = await fixture();
    // The file exists — the refusal is about the declared PLACEMENT, not a
    // missing read, so this must fail even when everything else would succeed.
    await mkdir(join(instanceDir, "saves"), { recursive: true });
    await writeFile(join(instanceDir, "saves", "level.dat"), "PRECIOUS WORLD");

    await expect(
      resolveManifest({
        ...resolveOpts,
        manifest: manifestWith("saves/level.dat", "config"),
        baseDir: instanceDir,
        store,
      }),
    ).rejects.toBeInstanceOf(PathEscape);

    // And the world is untouched.
    expect(await readFile(join(instanceDir, "saves", "level.dat"), "utf8")).toBe("PRECIOUS WORLD");
  });

  it("refuses a manifest item that targets .anvil/", async () => {
    const { instanceDir, store } = await fixture();
    await mkdir(join(instanceDir, ".anvil"), { recursive: true });
    await writeFile(join(instanceDir, ".anvil", "config.toml"), "[paths]\n");
    await expect(
      resolveManifest({
        ...resolveOpts,
        manifest: manifestWith(".anvil/config.toml", "config"),
        baseDir: instanceDir,
        store,
      }),
    ).rejects.toBeInstanceOf(PathEscape);
  });

  it("places a file from OUTSIDE the instance by kind — inside the instance, never at its own path", async () => {
    const { instanceDir, store } = await fixture();
    const outside = await mkTmp("trav-outside");
    dirs.push(outside);
    await writeFile(join(outside, "evil.jar"), fabricJar("evil"));
    // Both spellings of "outside": an absolute path, and a `..` that walks out of
    // the instance and back down into a sibling directory.
    const relativeEscape = `../${basename(outside)}/evil.jar`;

    for (const declared of [join(outside, "evil.jar"), relativeEscape]) {
      const lock = await resolveManifest({
        ...resolveOpts,
        manifest: manifestWith(declared, "mod"),
        baseDir: instanceDir,
        store,
      });
      const pkg = lock.resolved[0];
      expect(pkg?.placement).toEqual({ method: "link", target: "mods/evil.jar" });
      // The build-time guard accepts it and it stays under the instance root.
      expect(() => safeJoin(instanceDir, "mods/evil.jar")).not.toThrow();
    }
  });

  it("preserves a nested in-instance path exactly (the round-trip the ticket is about)", async () => {
    const { instanceDir, store } = await fixture();
    await mkdir(join(instanceDir, "config", "a", "b"), { recursive: true });
    await writeFile(join(instanceDir, "config", "a", "b", "c.toml"), "nested = true\n");

    const lock = await resolveManifest({
      ...resolveOpts,
      manifest: manifestWith("./config/a/b/c.toml", "config"),
      baseDir: instanceDir,
      store,
    });
    expect(lock.resolved[0]?.placement).toEqual({
      method: "link",
      target: "config/a/b/c.toml",
    });
  });
});
