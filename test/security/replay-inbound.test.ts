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

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  DirTreeIO,
  type Hash,
  type LockPackage,
  type Lockfile,
  type Manifest,
  RemoteError,
  ReplayCache,
  ServedTreeTransport,
  type SnapshotObject,
  VcObjectStore,
  canonicalJson,
  comparePackages,
  encodeObject,
  hashBuffer,
  idOfEncoding,
  parseRef,
  readReplayPaths,
  serializeLock,
  serializeManifest,
  writeLock,
  writeManifest,
} from "../../index.js";
import { foldPath, pathExists } from "../../src/internal/fs.js";
import { Refs } from "../../src/vc/refs.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeModrinth, fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const OLD_BYTES = fabricJar("jei-1.19.2");
const NEW_BYTES = fabricJar("jei-1.20.1");
const OLD_TARGET = "mods/jei-1.19.2.jar";
const NEW_TARGET = "mods/jei-1.20.1.jar";

/**
 * The positive control, carried in the SAME poisoned snapshot as the CurseForge
 * jar. Without it, "the jar is not on disk" is satisfied by a clone that fell
 * over before materialize ever ran — which is precisely how this clone ends
 * (the build needs a CurseForge key nobody has). This file proves materialize
 * reached the tracked loop and wrote what it was allowed to write, so the jar's
 * absence is a refusal rather than an abort.
 */
const BENIGN_TARGET = "config/notes.txt";
const BENIGN_BYTES = new TextEncoder().encode("a hand-edited config the joiner SHOULD receive\n");

/**
 * A tracked file at the CURRENT replay item's own placement target, holding bytes
 * that are not the pinned ones — a recompressed or patched jar, say.
 *
 * No pin in the incoming history matches it, so neither the transfer's screen nor
 * `materialize`'s pin rule can refuse it. What refuses it is the path claim
 * `clone` records from the remote lock before it writes anything, which is the
 * only reason that claim exists: the build that would otherwise record it runs
 * after `materialize`, so without it the ledger is empty for the whole inbound
 * write.
 */
const TAMPERED_BYTES = fabricJar("jei-1.20.1-recompressed");

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

/** Serve `tip` (and everything it reaches) as a plain directory remote. */
async function serve(host: Party, remoteDir: string, tip: Hash, manifest: Manifest): Promise<void> {
  // Published by writing the tree directly, bypassing `push` — whose gate would
  // refuse. A joiner has no say in how a remote came to hold what it holds.
  const transport = new ServedTreeTransport(
    { name: "src", kind: "url", url: remoteDir },
    new DirTreeIO(remoteDir),
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
  const stack: Hash[] = [tip];
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
    commit: tip,
    manifest: serializeManifest(manifest),
    lock: serializeLock(lockFor(manifest, replayRow(NEW_TARGET, NEW_BYTES, 6000))),
    vcObjects: objects,
    contentObjects: [],
  });
}

/**
 * A publisher whose history is exactly the shape LB-722 produces: an older commit
 * whose lock pins the old jar, then a bump, then a commit that TRACKS the old jar
 * as an undeclared file. Built by hand, because current anvil refuses to author
 * it — which is the point: the joiner has no control over what a remote serves.
 *
 * Returns the clean tip and the poisoned one so a caller can serve the clean
 * history first and poison the remote afterwards, which is what a joiner that
 * already cloned once experiences: a fast-forward `pull`, not a fresh `clone`.
 */
async function buildPoisonedHistory(
  host: Party,
): Promise<{ clean: Hash; poisoned: Hash; manifest: Manifest }> {
  // Commit 1 — the old version is a declared, lock-owned replay item.
  const oldManifest = manifestFor(OLD_TARGET);
  await writeManifest(host.dir, oldManifest);
  await writeLock(host.dir, lockFor(oldManifest, replayRow(OLD_TARGET, OLD_BYTES, 5000)));
  await new ReplayCache({ instanceDir: host.dir }).putBuffer(
    OLD_BYTES,
    hashOf(OLD_BYTES, "sha256"),
  );
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
      { path: BENIGN_TARGET, blob: await host.vcStore.putBlob(BENIGN_BYTES) },
      { path: OLD_TARGET, blob: await host.vcStore.putBlob(OLD_BYTES) },
      { path: NEW_TARGET, blob: await host.vcStore.putBlob(TAMPERED_BYTES) },
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  const poisonedCommit = await host.vcStore.put({
    ...commit,
    snapshot: await host.vcStore.put(poisoned),
    message: "c3: recorded by an older anvil",
    gen: commit.gen + 1,
    parents: [c2.id],
  });
  expect(c1.id.value).not.toBe(poisonedCommit.value);

  const refs = new Refs(join(host.dir, ".anvil"));
  const branch = (await refs.currentBranch()) ?? "refs/heads/main";
  await refs.writeRef(branch, poisonedCommit);
  return { clean: c2.id, poisoned: poisonedCommit, manifest: newManifest };
}

/** Build the poisoned history and serve its poisoned tip in one step. */
async function publishPoisonedHistory(host: Party, remoteDir: string): Promise<void> {
  const built = await buildPoisonedHistory(host);
  await serve(host, remoteDir, built.poisoned, built.manifest);
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

    // The clone's BUILD fails (a CurseForge key nobody here has), long after the
    // history transfer and the materialize this test is about.
    await joiner.anvil.clone(remoteDir).catch(() => undefined);

    // 0. The positive control: the benign tracked file from the SAME snapshot IS
    //    written. Without this, every assertion below is also satisfied by a
    //    clone that died before materialize ran.
    expect(await readFile(join(joiner.dir, BENIGN_TARGET), "utf8")).toBe(
      new TextDecoder().decode(BENIGN_BYTES),
    );
    // 1. The CurseForge jar is not written into the joiner's instance.
    expect(await pathExists(join(joiner.dir, OLD_TARGET))).toBe(false);
    // 2. Its bytes are not in the joiner's object store either, so the joiner is
    //    not holding CurseForge content it never had a key for.
    expect(await joiner.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
    expect(await allFileNames(join(joiner.dir, ".anvil", "objects"))).not.toContain(
      blobIdOf(OLD_BYTES).value,
    );
    // 3. The refusal is reported, not silent — and reported per PATH, which only
    //    `materialize` can do. The transfer's own warning names no path, so this
    //    is what distinguishes "materialize declined to write it" from
    //    "materialize blew up on an object the transfer had already dropped".
    expect(warnings.some((w) => w.toLowerCase().includes("replay"))).toBe(true);
    expect(warnings.some((w) => w.includes(OLD_TARGET))).toBe(true);
    // 4. `clone` claims the remote lock's replay targets before it writes
    //    anything, so a tracked file sitting at the CURRENT replay item's target
    //    is refused too — even though its bytes match no pin in the history and
    //    the build that would otherwise record that path has not run yet.
    expect([...(await readReplayPaths(joiner.dir))]).toContain(foldPath(NEW_TARGET));
    expect(await pathExists(join(joiner.dir, NEW_TARGET))).toBe(false);
  });

  it("GATE no-onward-rehost: the joiner cannot push the history it declined to store", async () => {
    const host = await makeParty("lb722-host2");
    const remoteDir = await mkTmp("lb722-served2");
    dirs.push(remoteDir);
    await publishPoisonedHistory(host, remoteDir);

    const joiner = await makeParty("lb722-joiner2");
    await joiner.anvil.clone(remoteDir).catch(() => undefined);
    // The import already declined the bytes, so the joiner has nothing to forward.
    expect(await joiner.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);

    // Forwarding the poisoned history to a third party must fail loudly rather
    // than publish a snapshot pointing at an object the joiner does not have.
    const thirdParty = await mkTmp("lb722-third");
    dirs.push(thirdParty);
    await joiner.anvil.addRemote("onward", thirdParty);
    await expect(joiner.anvil.push("onward")).rejects.toBeInstanceOf(RemoteError);
    expect(await allFileNames(thirdParty)).not.toContain(blobIdOf(OLD_BYTES).value);
    // Nothing at all was published — a partial tree is a broken remote, not a
    // safe one, and the benign file must not have been shipped either.
    expect(await allFileNames(thirdParty)).not.toContain(blobIdOf(BENIGN_BYTES).value);
  });

  it("GATE inbound-pull: the same refusal holds on the pull path, not just clone", async () => {
    const host = await makeParty("lb722-host3");
    const remoteDir = await mkTmp("lb722-served3");
    dirs.push(remoteDir);
    await publishPoisonedHistory(host, remoteDir);

    // A joiner with an unborn HEAD that pulls takes `pullInstance`'s adopt-like
    // branch — a different call site from `clone`, with its own materialize.
    const joiner = await makeParty("lb722-joiner3");
    const warnings: string[] = [];
    joiner.anvil.progress.on((e) => {
      if (e.type === "warning") {
        warnings.push(e.message);
      }
    });
    await joiner.anvil.addRemote("origin", remoteDir);
    await joiner.anvil.pull("origin").catch(() => undefined);

    expect(await readFile(join(joiner.dir, BENIGN_TARGET), "utf8")).toBe(
      new TextDecoder().decode(BENIGN_BYTES),
    );
    expect(await pathExists(join(joiner.dir, OLD_TARGET))).toBe(false);
    expect(await joiner.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
    expect(warnings.some((w) => w.toLowerCase().includes("replay"))).toBe(true);
    expect(warnings.some((w) => w.includes(OLD_TARGET))).toBe(true);
  });

  it("GATE inbound-pull-ff: an established joiner fast-forwarding onto the poison is refused", async () => {
    // The common case, and a different `materializeSnapshot` call site from both
    // of the above: the joiner already has this pack, so `pull` takes the
    // fast-forward branch with a `previous` snapshot rather than adopting.
    const host = await makeParty("lb722-host4");
    const remoteDir = await mkTmp("lb722-served4");
    dirs.push(remoteDir);
    const built = await buildPoisonedHistory(host);

    // The remote serves clean history first; the joiner clones that.
    await serve(host, remoteDir, built.clean, built.manifest);
    const joiner = await makeParty("lb722-joiner4");
    const warnings: string[] = [];
    joiner.anvil.progress.on((e) => {
      if (e.type === "warning") {
        warnings.push(e.message);
      }
    });
    await joiner.anvil.clone(remoteDir).catch(() => undefined);
    expect(await pathExists(join(joiner.dir, OLD_TARGET))).toBe(false);

    // The remote is then poisoned, and the joiner pulls the update.
    await serve(host, remoteDir, built.poisoned, built.manifest);
    warnings.length = 0;
    await joiner.anvil.pull("origin").catch(() => undefined);

    expect(await readFile(join(joiner.dir, BENIGN_TARGET), "utf8")).toBe(
      new TextDecoder().decode(BENIGN_BYTES),
    );
    expect(await pathExists(join(joiner.dir, OLD_TARGET))).toBe(false);
    expect(await joiner.vcStore.has(blobIdOf(OLD_BYTES))).toBe(false);
    expect(warnings.some((w) => w.includes(OLD_TARGET))).toBe(true);
  });
});
