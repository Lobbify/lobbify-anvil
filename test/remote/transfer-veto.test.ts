/**
 * Stage-7 gate — object-transfer integrity + the untrusted-remote veto.
 *
 *   - **sha-verify-on-arrival**: a corrupted remote object is rejected on arrival,
 *     never built (no "build anyway").
 *   - **malicious-remote veto**: a remote that pins a legit item to a hostile URL
 *     is vetoed — `allowSource` sees the resolved URL (a policy veto), and an
 *     internal-address literal trips the SSRF guard — before any byte is fetched.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type LockPackage,
  type Lockfile,
  type Manifest,
  ShaMismatch,
  SourceNotAllowed,
  SsrfBlocked,
  serializeLock,
  writeManifest,
} from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeInstance, modWorldOf, writeAndLock } from "../helpers/remote.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

/** Recursively list absolute file paths under `root`. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const rec = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await rec(p);
      } else {
        out.push(p);
      }
    }
  };
  await rec(root);
  return out;
}

describe("sha-verify-on-arrival — a corrupted mirror is rejected, never built", () => {
  it("a corrupted remote content object fails the pull with ShaMismatch", async () => {
    const fake = modWorldOf(3);
    const host = await makeInstance(fake, "sv-host");
    const joiner = await makeInstance(fake, "sv-joiner");
    const remoteDir = await mkTmp("sv-remote");
    dirs.push(host.dir, host.storeDir, joiner.dir, joiner.storeDir, remoteDir);

    await writeAndLock(host, ["modrinth:mod0", "modrinth:mod1", "modrinth:mod2"]);
    const hostAnvil = host.anvil();
    await hostAnvil.build();
    await hostAnvil.commit("base");
    // Push to a writable directory remote (populates the content endpoint).
    await hostAnvil.addRemote("dst", remoteDir);
    await hostAnvil.push("dst");

    // Corrupt one object in the remote content endpoint.
    const endpointFiles = await walk(join(remoteDir, "objects-content"));
    expect(endpointFiles.length).toBeGreaterThan(0);
    await writeFile(endpointFiles[0] as string, "CORRUPTED-MIRROR-BYTES");

    // The joiner clones → fetches from the endpoint → the corrupted object is
    // rejected on arrival (never rebuilt from source, never "built anyway").
    await expect(joiner.anvil().clone(remoteDir)).rejects.toBeInstanceOf(ShaMismatch);
  });
});

/** Hand-write a served remote whose lock pins one url item at `hostileUrl`. */
async function writeHostileRemote(remoteDir: string, hostileUrl: string): Promise<void> {
  const manifest: Manifest = {
    project: { name: "evil-pack", version: "1.0.0" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [{ ref: { source: "url", id: hostileUrl, versionSpec: { kind: "latest" } } }],
  };
  const pkg: LockPackage = {
    name: "totally-legit-mod",
    kind: "mod",
    source: "url",
    hash: { algo: "sha256", value: "0".repeat(64) },
    provenance: "copy",
    placement: { method: "link", target: "mods/legit.jar" },
    url: hostileUrl,
  };
  const lock: Lockfile = {
    meta: {
      version: 1,
      manifestHash: { algo: "sha256", value: "0".repeat(64) },
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "j",
    },
    resolved: [pkg],
  };
  await writeManifest(remoteDir, manifest);
  await writeFile(join(remoteDir, "anvil.lock"), serializeLock(lock));
}

describe("malicious-remote veto — a hostile URL is refused before any fetch", () => {
  it("allowSource sees the resolved URL and vetoes it", async () => {
    const fake = modWorldOf(1);
    const joiner = await makeInstance(fake, "mv-joiner");
    const remoteDir = await mkTmp("mv-remote");
    dirs.push(joiner.dir, joiner.storeDir, remoteDir);

    await writeHostileRemote(remoteDir, "https://evil.example.com/backdoor.jar");
    // The host policy vetoes anything whose resolved URL hits evil.example.
    const anvil = joiner.anvil({ allowSource: (ref) => !ref.id.includes("evil.example") });
    await expect(anvil.clone(remoteDir)).rejects.toBeInstanceOf(SourceNotAllowed);
    // Nothing was built.
    await expect(readFile(join(joiner.dir, "anvil.lock"))).rejects.toBeTruthy();
  });

  it("an internal-address literal in the remote lock trips the SSRF guard", async () => {
    const fake = modWorldOf(1);
    const joiner = await makeInstance(fake, "mv-joiner2");
    const remoteDir = await mkTmp("mv-remote2");
    dirs.push(joiner.dir, joiner.storeDir, remoteDir);

    // A legit-looking item pinned to the cloud-metadata address.
    await writeHostileRemote(remoteDir, "http://169.254.169.254/latest/meta-data/mod.jar");
    await expect(joiner.anvil().clone(remoteDir)).rejects.toBeInstanceOf(SsrfBlocked);
  });
});
