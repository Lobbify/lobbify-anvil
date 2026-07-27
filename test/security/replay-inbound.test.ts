/**
 * LB-722 CRITICAL — the RECEIVE side. A joiner must not be handed CurseForge
 * bytes, and must not become a re-host for them.
 *
 * The send side (admission + the push gate) does not help here. A publisher
 * running an older anvil, or a hand-built remote, can serve history whose tracked
 * set carries a superseded replay jar. On the joiner:
 *
 *   - the replay-path ledger is EMPTY — `clone` materializes before it ever runs
 *     a build, and the build is the only thing that writes the ledger;
 *   - the replay cache is EMPTY — the joiner has never fetched those bytes;
 *
 * so every local-state check answers "nothing to see" at exactly the moment it
 * matters. The only authority available is the incoming history's own locks,
 * whose `provenance: "replay"` rows pin the bytes by content hash. That is what
 * `importHistory` screens against, and it is why the check is byte-level rather
 * than path-level.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  type Hash,
  type LockPackage,
  type Lockfile,
  type Manifest,
  RemoteError,
  ReplayCache,
  type SnapshotObject,
  VcObjectStore,
  canonicalJson,
  comparePackages,
  encodeObject,
  hashBuffer,
  idOfEncoding,
  parseRef,
  writeLock,
  writeManifest,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeModrinth, fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const OLD_BYTES = fabricJar("jei-1.19.2");
const NEW_BYTES = fabricJar("jei-1.20.1");
const OLD_TARGET = "mods/jei-1.19.2.jar";
const NEW_TARGET = "mods/jei-1.20.1.jar";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

function blobIdOf(bytes: Uint8Array): Hash {
  return idOfEncoding(encodeObject({ type: "blob", bytes }));
}

async function allFileNames(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else {
        out.push(entry.name);
      }
    }
  };
  await walk(root);
  return out;
}

function manifestFor(target: string): Manifest {
  return {
    project: { name: "cf-pack", version: "1.0.0" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1" },
    items: [{ ref: parseRef(`curseforge:238222@${target === OLD_TARGET ? 5000 : 6000}`) }],
  };
}

function replayRow(target: string, bytes: Uint8Array, file: number): LockPackage {
  return {
    name: "jei",
    kind: "mod",
    source: "curseforge",
    version: target,
    hash: hashOf(bytes, "sha256"),
    provenance: "replay",
    placement: { method: "link", target },
    size: bytes.byteLength,
    project: 238222,
    file,
  };
}

function lockFor(manifest: Manifest, row: LockPackage): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256"),
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "j",
    },
    resolved: [row].sort(comparePackages),
  };
}

interface Party {
  readonly dir: string;
  readonly storeDir: string;
  readonly store: ContentStore;
  readonly anvil: Anvil;
  readonly vcStore: VcObjectStore;
}

async function makeParty(label: string): Promise<Party> {
  const dir = await mkTmp(label);
  const storeDir = await mkTmp(`${label}-store`);
  dirs.push(dir, storeDir);
  const env: AnvilEnv = {
    registry: () => registryWith({ modrinth: new FakeModrinth() }),
    now: () => NOW,
    author: label,
    resolveHost: async () => ["93.184.216.34"],
  };
  return {
    dir,
    storeDir,
    store: new ContentStore({ root: storeDir }),
    anvil: new Anvil({ dir, storeDir, allowSource: () => true }, env),
    vcStore: new VcObjectStore({ anvilDir: join(dir, ".anvil") }),
  };
}

/**
 * A publisher whose history is exactly the shape LB-722 produces: an older commit
 * whose lock pins the old jar, then a bump, then a commit that TRACKS the old jar
 * as an undeclared file. Built by hand, because current anvil refuses to author
 * it — which is the point: the joiner has no control over what a remote serves.
 */
async function publishPoisonedHistory(host: Party, remoteDir: string): Promise<void> {
  // Commit 1 — the old version is a declared, lock-owned replay item.
  const oldManifest = manifestFor(OLD_TARGET);
  await writeManifest(host.dir, oldManifest);
  await writeLock(host.dir, lockFor(oldManifest, replayRow(OLD_TARGET, OLD_BYTES, 5000)));
  await new ReplayCache({ instanceDir: host.dir }).putBuffer(OLD_BYTES, hashOf(OLD_BYTES, "sha256"));
  await mkdir(join(host.dir, "mods"), { recursive: true });
  await writeFile(join(host.dir, OLD_TARGET), Buffer.from(OLD_BYTES));
  const c1 = await host.anvil.commit("c1: jei 1.19.2");

  // Commit 2 — bumped. The old jar is stranded on disk and no lock names it, so
  // an anvil without the admission guard records it as an undeclared file. The
  // tracked entry is forged directly for exactly that reason.
  const newManifest = manifestFor(NEW_TARGET);
  await writeManifest(host.dir, newManifest);
  await writeLock(host.dir, lockFor(newManifest, replayRow(NEW_TARGET, NEW_BYTES, 6000)));
  await writeFile(join(host.dir, NEW_TARGET), Buffer.from(NEW_BYTES));
  const c2 = await host.anvil.commit("c2: bump to 1.20.1");

  const commit = await host.vcStore.getCommit(c2.id);
  const snap = await host.vcStore.getSnapshot(commit.snapshot);
  const poisoned: SnapshotObject = {
    ...snap,
    tracked: [
      ...snap.tracked,
      { path: OLD_TARGET, blob: await host.vcStore.putBlob(OLD_BYTES) },
    ],
  };
  const poisonedCommit = await host.vcStore.put({
    ...commit,
    snapshot: await host.vcStore.put(poisoned),
    message: "c3: recorded by an older anvil",
    gen: commit.gen + 1,
    parents: [c2.id],
  });
  expect(c1.id.value).not.toBe(poisonedCommit.value);

  // Serve it as a plain directory remote, bypassing `push` (whose gate would
  // refuse). A joiner has no say in how a remote came to hold what it holds.
  const { Refs } = await import("../../src/vc/refs.js");
  const refs = new Refs(join(host.dir, ".anvil"));
  const branch = (await refs.currentBranch()) ?? "refs/heads/main";
  await refs.writeRef(branch, poisonedCommit);
  const { ServedTreeTransport } = await import("../../src/remote/transport.js");
  const { directoryIo } = await import("../../src/remote/transport.js");
  const transport = new ServedTreeTransport(
    { name: "src", kind: "dir", url: remoteDir },
    directoryIo(remoteDir),
  );
  const objects: { id: Hash; raw: Uint8Array }[] = [];
  const seen = new Set<string>();
  const collect = async (id: Hash): Promise<void> => {
    if (seen.has(id.value)) {
      return;
    }
    seen.add(id.value);
    const raw = await host.vcStore.readRaw(id);
    if (raw) {
      objects.push({ id, raw });
    }
  };
  const stack: Hash[] = [poisonedCommit];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) {
      continue;
    }
    await collect(id);
    const c = await host.vcStore.getCommit(id);
    await collect(c.snapshot);
    const s = await host.vcStore.getSnapshot(c.snapshot);
    for (const b of [s.manifest, s.lock, s.ignore]) {
      await collect(b);
    }
    for (const t of s.tracked) {
      await collect(t.blob);
    }
    for (const p of c.parents) {
      stack.push(p);
    }
  }
  await transport.publish({
    branch: "main",
    commit: poisonedCommit,
    manifest: JSON.stringify(newManifest),
    lock: (await import("../../index.js")).serializeLock(
      lockFor(newManifest, replayRow(NEW_TARGET, NEW_BYTES, 6000)),
    ),
    vcObjects: objects,
    contentObjects: [],
  });
}

describe("LB-722 CRITICAL — clone never writes CurseForge bytes into a joiner", () => {
  it("GATE inbound-clone: the joiner gets no jar, no blob, and cannot re-publish it", async () => {
    const host = await makeParty("lb722-host");
    const remoteDir = await mkTmp("lb722-served");
    dirs.push(remoteDir);
    await publishPoisonedHistory(host, remoteDir);
    // The poisoned object really is on the wire — otherwise this proves nothing.
    expect(await allFileNames(remoteDir)).toContain(blobIdOf(OLD_BYTES).value);

    const joiner = await makeParty("lb722-joiner");
    const warnings: string[] = [];
    joiner.anvil.progress.on((e) => {
      if (e.type === "warning") {
        warnings.push(e.message);
      }
    });
    // A joiner has neither of the local signals: no ledger, no replay cache.
    expect(await pathExists(join(joiner.dir, ".anvil", "refs", "replay-paths"))).toBe(false);
    expect(await pathExists(join(joiner.dir, ".anvil", "replay-cache"))).toBe(false);

    await joiner.anvil.clone(remoteDir, { offline: true }).catch(() => undefined);

    // 1. The CurseForge jar is not written into the joiner's instance.
    expect(await pathExists(join(joiner.dir, OLD_TARGET))).toBe(false);
    // 2. Its bytes are not in the joiner's object store either, so the joiner is
    //    not holding CurseForge content it never had a key for.
    expect(await joiner.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
    expect(await allFileNames(join(joiner.dir, ".anvil", "objects"))).not.toContain(
      blobIdOf(OLD_BYTES).value,
    );
    // 3. The refusal is reported, not silent.
    expect(warnings.some((w) => w.toLowerCase().includes("replay"))).toBe(true);
  });

  it("GATE no-onward-rehost: the joiner cannot push the history it declined to store", async () => {
    const host = await makeParty("lb722-host2");
    const remoteDir = await mkTmp("lb722-served2");
    dirs.push(remoteDir);
    await publishPoisonedHistory(host, remoteDir);

    const joiner = await makeParty("lb722-joiner2");
    await joiner.anvil.clone(remoteDir, { offline: true }).catch(() => undefined);

    // Forwarding the poisoned history to a third party must fail loudly rather
    // than publish a snapshot pointing at an object the joiner does not have.
    const thirdParty = await mkTmp("lb722-third");
    dirs.push(thirdParty);
    await joiner.anvil.addRemote("onward", thirdParty);
    await expect(joiner.anvil.push("onward")).rejects.toBeInstanceOf(RemoteError);
    expect(await allFileNames(thirdParty)).not.toContain(blobIdOf(OLD_BYTES).value);
  });
});
