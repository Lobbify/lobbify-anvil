/**
 * LB-722 — each rule in the replay guard chain, exercised **alone**.
 *
 * The chain is deliberately layered: admission refuses the bytes, the transfer
 * refuses them on arrival, `materialize` refuses to write them, and `push`
 * refuses to forward them. Layering is what makes it hold when one layer's
 * precondition is absent — but it also means an end-to-end test passes with any
 * single layer removed, so a suite made only of end-to-end tests measures the
 * chain and never a link. Mutation runs said so directly: with the whole suite
 * green, `push`'s pin rule, `push`'s ledger rule, `materialize`'s pin rule and
 * `clone`'s ledger claim could each be deleted and nothing failed. Each of them
 * was covered — by a scenario where a *different* rule also fired.
 *
 * So every test here removes the preconditions of every rule but one, and each
 * fails if that one rule is deleted. The scenarios are narrower than the
 * end-to-end gates in `replay-provenance-tracking.test.ts` and
 * `replay-inbound.test.ts` on purpose; those stay as the proof that the layers
 * compose.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  Anvil,
  type AnvilEnv,
  ContentStore,
  type Hash,
  type LockPackage,
  LockParseError,
  type Lockfile,
  type Manifest,
  Refs,
  RemoteError,
  type SnapshotObject,
  VcObjectStore,
  canonicalJson,
  encodeObject,
  hashBuffer,
  idOfEncoding,
  recordReplayPaths,
  serializeLock,
  writeLock,
  writeManifest,
} from "../../index.js";
import { pathExists } from "../../src/internal/fs.js";
import { materializeSnapshot } from "../../src/vc/snapshot.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FakeModrinth, fabricJar, registryWith } from "../helpers/net.js";

const NOW = Date.parse("2026-07-01T00:00:00Z");
const CF_BYTES = fabricJar("jei-1.19.2");
const CF_TARGET = "mods/jei-1.19.2.jar";

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

function lockWith(rows: readonly LockPackage[]): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: hashOf(new Uint8Array([1]), "sha256"),
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "j",
    },
    resolved: [...rows],
  };
}

function replayRow(bytes: Uint8Array, target: string): LockPackage {
  return {
    name: "jei",
    kind: "mod",
    source: "curseforge",
    hash: hashOf(bytes, "sha256"),
    provenance: "replay",
    placement: { method: "link", target },
    project: 238222,
    file: 5000,
  };
}

function copyRow(bytes: Uint8Array, target: string): LockPackage {
  return {
    name: "sodium",
    kind: "mod",
    source: "modrinth",
    hash: hashOf(bytes, "sha256"),
    provenance: "copy",
    placement: { method: "link", target },
  };
}

interface Party {
  readonly dir: string;
  readonly anvil: Anvil;
  readonly vcStore: VcObjectStore;
  readonly sharedStore: ContentStore;
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
    anvil: new Anvil({ dir, storeDir, allowSource: () => true }, env),
    vcStore: new VcObjectStore({ anvilDir: join(dir, ".anvil") }),
    sharedStore: new ContentStore({ root: storeDir }),
  };
}

/** A snapshot carrying `lock` verbatim plus a tracked set, all blobs admitted. */
async function snapshotWith(
  vcStore: VcObjectStore,
  lock: Lockfile | undefined,
  tracked: readonly { path: string; bytes: Uint8Array; store?: boolean }[],
): Promise<SnapshotObject> {
  const empty = await vcStore.putBlob(new Uint8Array());
  const lockBlob = lock
    ? await vcStore.putBlob(new TextEncoder().encode(serializeLock(lock)))
    : empty;
  const entries: { path: string; blob: Hash }[] = [];
  for (const t of tracked) {
    entries.push({
      path: t.path,
      // `store: false` forges the shape a refused import leaves behind: a tracked
      // entry naming an object that is deliberately not in this store.
      blob: t.store === false ? blobIdOf(t.bytes) : await vcStore.putBlob(t.bytes),
    });
  }
  return {
    type: "snapshot",
    manifest: empty,
    lock: lockBlob,
    ignore: empty,
    carried: [],
    tracked: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

describe("LB-722 — materialize's pin rule, with no local state to fall back on", () => {
  it("GATE pin-rule-alone: a snapshot's OWN lock is enough to refuse its tracked bytes", async () => {
    // No replay cache and no ledger, so the local veto cannot fire and the caller
    // passes neither `replayPins` nor `refusedBlobs`. The only thing left that can
    // refuse these bytes is the pin the snapshot's own lock carries — which is
    // exactly the state a `switch` back to a commit authored by an older anvil
    // reaches on a machine that has since been rebuilt.
    const p = await makeParty("lb722-pin-alone");
    expect(await pathExists(join(p.dir, ".anvil", "replay-cache"))).toBe(false);
    expect(await pathExists(join(p.dir, ".anvil", "refs", "replay-paths"))).toBe(false);

    const snapshot = await snapshotWith(p.vcStore, lockWith([replayRow(CF_BYTES, CF_TARGET)]), [
      { path: "config/ok.toml", bytes: new TextEncoder().encode("SAFE") },
      { path: CF_TARGET, bytes: CF_BYTES },
    ]);
    const warnings: string[] = [];
    await materializeSnapshot({
      instanceDir: p.dir,
      snapshot,
      vcStore: p.vcStore,
      sharedStore: p.sharedStore,
      onWarn: (m) => warnings.push(m),
    });

    expect(await pathExists(join(p.dir, CF_TARGET))).toBe(false);
    expect(warnings.some((w) => w.includes(CF_TARGET))).toBe(true);
    // The positive control: the rest of the same snapshot materialized normally.
    expect(await readFile(join(p.dir, "config", "ok.toml"), "utf8")).toBe("SAFE");
  });

  it("GATE no-copy-over-veto: a tracked file matching a COPY row's pin is still written", async () => {
    // The pin set must hold `provenance: "replay"` rows and nothing else. Pinning
    // every row instead turns an ordinary duplicate — a user's second copy of a
    // Modrinth jar the lock also names — into a file version control silently
    // refuses to restore. That is the same silent-loss class this ticket exists
    // to close, arriving from the other direction.
    const p = await makeParty("lb722-copy-row");
    const dup = fabricJar("sodium-0.5.0");
    const snapshot = await snapshotWith(p.vcStore, lockWith([copyRow(dup, "mods/sodium.jar")]), [
      { path: "mods/my-second-copy.jar", bytes: dup },
    ]);
    await materializeSnapshot({
      instanceDir: p.dir,
      snapshot,
      vcStore: p.vcStore,
      sharedStore: p.sharedStore,
    });
    expect(await pathExists(join(p.dir, "mods", "my-second-copy.jar"))).toBe(true);
  });
});

describe("LB-722 — the push gate's three rules, each on its own", () => {
  /** Move the current branch onto a forged commit carrying `snapshot`. */
  async function commitForged(p: Party, snapshot: SnapshotObject): Promise<void> {
    const snapshotId = await p.vcStore.put(snapshot);
    const commit = await p.vcStore.put({
      type: "commit" as const,
      snapshot: snapshotId,
      parents: [],
      gen: 0,
      author: "older-anvil",
      time: NOW,
      message: "recorded before the admission guard existed",
      op: "commit" as const,
    });
    const refs = new Refs(join(p.dir, ".anvil"));
    await refs.writeRef("refs/heads/main", commit);
    await refs.setHeadSymbolic("refs/heads/main");
  }

  /**
   * Push to a fresh directory remote. The two source files have to be real: a
   * directory remote hosts content objects, so `push` parses the on-disk lock
   * after the gate has had its say.
   */
  async function pushTo(p: Party, label: string): Promise<unknown> {
    const remoteDir = await mkTmp(label);
    dirs.push(remoteDir);
    await writeFile(join(p.dir, "anvil.toml"), "");
    await writeFile(join(p.dir, "anvil.lock"), serializeLock(lockWith([])));
    await p.anvil.addRemote("dst", remoteDir);
    return p.anvil.push("dst");
  }

  it("GATE push-rule-pins-alone: refused by the history's own pins, with NO ledger", async () => {
    const p = await makeParty("lb722-push-pins");
    // The blob is present (rule 1 cannot fire) and no ledger exists (rule 3
    // cannot fire), so only the pin rule can refuse this push.
    await commitForged(
      p,
      await snapshotWith(p.vcStore, lockWith([replayRow(CF_BYTES, CF_TARGET)]), [
        { path: CF_TARGET, bytes: CF_BYTES },
      ]),
    );
    expect(await pathExists(join(p.dir, ".anvil", "refs", "replay-paths"))).toBe(false);
    expect(await p.vcStore.has(blobIdOf(CF_BYTES))).toBe(true);

    await expect(pushTo(p, "lb722-push-pins-remote")).rejects.toBeInstanceOf(RemoteError);
  });

  it("GATE push-rule-ledger-alone: refused by the local ledger, with NO pin in history", async () => {
    const p = await makeParty("lb722-push-ledger");
    // This machine recorded the path as having held CurseForge content, but the
    // history's locks no longer say so — the state a lock rewrite leaves behind.
    await recordReplayPaths(p.dir, [lockWith([replayRow(CF_BYTES, CF_TARGET)])]);
    // The committed lock names nothing, so the pin rule has nothing to match, and
    // the bytes at the claimed path are not even the CurseForge ones.
    await commitForged(
      p,
      await snapshotWith(p.vcStore, undefined, [
        { path: CF_TARGET, bytes: new TextEncoder().encode("not the cf jar") },
      ]),
    );

    await expect(pushTo(p, "lb722-push-ledger-remote")).rejects.toBeInstanceOf(RemoteError);
  });

  it("GATE push-rule-missing-alone: refused because the tracked object is absent", async () => {
    const p = await makeParty("lb722-push-missing");
    // No ledger, no replay row anywhere — only the shape a refused import leaves:
    // a tracked entry whose object was never stored.
    await commitForged(
      p,
      await snapshotWith(p.vcStore, undefined, [
        { path: CF_TARGET, bytes: CF_BYTES, store: false },
      ]),
    );
    expect(await pathExists(join(p.dir, ".anvil", "refs", "replay-paths"))).toBe(false);
    expect(await p.vcStore.has(blobIdOf(CF_BYTES))).toBe(false);

    await expect(pushTo(p, "lb722-push-missing-remote")).rejects.toBeInstanceOf(RemoteError);
  });

  it("an ordinary tracked file publishes normally — the gate is not a blanket refusal", async () => {
    const p = await makeParty("lb722-push-clean");
    await commitForged(
      p,
      await snapshotWith(p.vcStore, lockWith([copyRow(fabricJar("sodium"), "mods/sodium.jar")]), [
        { path: "config/ok.toml", bytes: new TextEncoder().encode("SAFE") },
      ]),
    );
    await expect(pushTo(p, "lb722-push-clean-remote")).resolves.toBeDefined();
  });
});

describe("LB-722 — how a path is SPELLED changes no gate's answer", () => {
  // A tracked path arrives from a remote, so its spelling is attacker-chosen. The
  // regression that motivates this: `mods//jei.jar` once defeated both the
  // exclusion set and the push gate, because each folded with its own rule list
  // rather than by decomposition.
  // `[label, the canonical target the replay row claims, how the snapshot spells it]`.
  // The Unicode case needs its own target: `"mods/jei-1.19.2.jar".normalize("NFD")`
  // is the identical string, since NFD only differs on composed characters, so
  // reusing the ASCII target there would test nothing at all.
  const ACCENTED = "mods/café.jar";
  const SPELLINGS: readonly (readonly [string, string, string])[] = [
    ["a doubled separator", CF_TARGET, "mods//jei-1.19.2.jar"],
    ["a leading dot segment", CF_TARGET, "./mods/jei-1.19.2.jar"],
    ["an interior dot segment", CF_TARGET, "mods/./jei-1.19.2.jar"],
    ["a backslash separator", CF_TARGET, "mods\\jei-1.19.2.jar"],
    ["a trailing separator", CF_TARGET, "mods/jei-1.19.2.jar/"],
    ["mixed case", CF_TARGET, "MODS/JEI-1.19.2.JAR"],
    ["a decomposed Unicode form", ACCENTED.normalize("NFC"), ACCENTED.normalize("NFD")],
    ["a composed Unicode form", ACCENTED.normalize("NFD"), ACCENTED.normalize("NFC")],
  ];

  for (const [label, target, spelling] of SPELLINGS) {
    it(`GATE spelling-materialize (${label}): the bytes are refused anyway`, async () => {
      // Content-keyed, so spelling cannot matter — but that is the claim, and an
      // untested claim about a bypass class is what let the last one through.
      const p = await makeParty("lb722-spell-mat");
      const snapshot = await snapshotWith(p.vcStore, lockWith([replayRow(CF_BYTES, target)]), [
        { path: spelling, bytes: CF_BYTES },
        { path: "config/ok.toml", bytes: new TextEncoder().encode("SAFE") },
      ]);
      await materializeSnapshot({
        instanceDir: p.dir,
        snapshot,
        vcStore: p.vcStore,
        sharedStore: p.sharedStore,
      });
      for (const form of [spelling.normalize("NFC"), spelling.normalize("NFD"), target]) {
        expect(await pathExists(join(p.dir, form)), form).toBe(false);
      }
      // The positive control: an ordinary entry in the same snapshot was written,
      // so the refusal above is a decision and not a materialize that did nothing.
      expect(await readFile(join(p.dir, "config", "ok.toml"), "utf8")).toBe("SAFE");
    });

    it(`GATE spelling-degraded (${label}): the no-cache verdict still matches`, async () => {
      // The pin rule cannot fire (these are not the pinned bytes) and there is no
      // replay cache, so the only thing left is the ledger-backed verdict — the
      // one path-keyed decision `materialize` makes, and therefore the one a
      // spelling bypass would actually reach on the receive side.
      const p = await makeParty("lb722-spell-degraded");
      await recordReplayPaths(p.dir, [lockWith([replayRow(CF_BYTES, target)])]);
      expect(await pathExists(join(p.dir, ".anvil", "replay-cache"))).toBe(false);

      const warnings: string[] = [];
      await materializeSnapshot({
        instanceDir: p.dir,
        snapshot: await snapshotWith(p.vcStore, undefined, [
          { path: spelling, bytes: new TextEncoder().encode("not the cf jar") },
          { path: "config/ok.toml", bytes: new TextEncoder().encode("SAFE") },
        ]),
        vcStore: p.vcStore,
        sharedStore: p.sharedStore,
        onWarn: (m) => warnings.push(m),
      });

      for (const form of [spelling.normalize("NFC"), spelling.normalize("NFD"), target]) {
        expect(await pathExists(join(p.dir, form)), form).toBe(false);
      }
      expect(warnings.length).toBe(1);
      expect(await readFile(join(p.dir, "config", "ok.toml"), "utf8")).toBe("SAFE");
    });

    it(`GATE spelling-push (${label}): the ledger rule still matches`, async () => {
      // The push gate's ledger rule IS path-keyed, so this is the one that a
      // spelling bypass would actually reach. The bytes are deliberately not the
      // CurseForge ones, so only the ledger rule can refuse.
      const p = await makeParty("lb722-spell-push");
      await recordReplayPaths(p.dir, [lockWith([replayRow(CF_BYTES, target)])]);
      const snapshotId = await p.vcStore.put(
        await snapshotWith(p.vcStore, undefined, [
          { path: spelling, bytes: new TextEncoder().encode("not the cf jar") },
        ]),
      );
      const commit = await p.vcStore.put({
        type: "commit" as const,
        snapshot: snapshotId,
        parents: [],
        gen: 0,
        author: "older-anvil",
        time: NOW,
        message: "a path spelled to dodge the gate",
        op: "commit" as const,
      });
      const refs = new Refs(join(p.dir, ".anvil"));
      await refs.writeRef("refs/heads/main", commit);
      await refs.setHeadSymbolic("refs/heads/main");

      const remoteDir = await mkTmp("lb722-spell-push-remote");
      dirs.push(remoteDir);
      await writeFile(join(p.dir, "anvil.toml"), "");
      await writeFile(join(p.dir, "anvil.lock"), serializeLock(lockWith([])));
      await p.anvil.addRemote("dst", remoteDir);
      await expect(p.anvil.push("dst")).rejects.toBeInstanceOf(RemoteError);
    });
  }

  it("a genuinely different path is NOT caught — the folding is not over-broad", async () => {
    // The mirror of the above. If every spelling matched, the gate would be a
    // prefix match on `mods/` and the tests above would prove nothing.
    const p = await makeParty("lb722-spell-neg");
    await recordReplayPaths(p.dir, [lockWith([replayRow(CF_BYTES, CF_TARGET)])]);
    const snapshotId = await p.vcStore.put(
      await snapshotWith(p.vcStore, undefined, [
        { path: "mods/jei-1.19.2.jar.disabled", bytes: new TextEncoder().encode("mine") },
      ]),
    );
    const commit = await p.vcStore.put({
      type: "commit" as const,
      snapshot: snapshotId,
      parents: [],
      gen: 0,
      author: "tester",
      time: NOW,
      message: "a file of the user's own, at a neighbouring path",
      op: "commit" as const,
    });
    const refs = new Refs(join(p.dir, ".anvil"));
    await refs.writeRef("refs/heads/main", commit);
    await refs.setHeadSymbolic("refs/heads/main");

    const remoteDir = await mkTmp("lb722-spell-neg-remote");
    dirs.push(remoteDir);
    await writeFile(join(p.dir, "anvil.toml"), "");
    await writeFile(join(p.dir, "anvil.lock"), serializeLock(lockWith([])));
    await p.anvil.addRemote("dst", remoteDir);
    await expect(p.anvil.push("dst")).resolves.toBeDefined();
  });
});

describe("LB-722 — a merge never carries in a tracked entry the transfer refused", () => {
  it("GATE merge-drops-missing: the other side's un-stored entry is dropped, out loud", async () => {
    // `mergeTrackedSets` unions two tracked sets by path and re-screens neither.
    // After a `pull` that declined to store CurseForge bytes, the other branch's
    // snapshot names an object this store does not have — so a merge would mint
    // a fresh commit re-asserting exactly the entry the transfer just refused,
    // and that commit can be neither materialized nor published.
    const p = await makeParty("lb722-merge");
    const manifest: Manifest = {
      project: { name: "pack", version: "1.0.0" },
      game: { minecraft: "26.2", loader: "fabric 0.19.1" },
      items: [],
    };
    const lock = lockWith([]);
    const fresh: Lockfile = {
      ...lock,
      meta: {
        ...lock.meta,
        manifestHash: hashBuffer(new TextEncoder().encode(canonicalJson(manifest)), "sha256"),
      },
    };
    await writeManifest(p.dir, manifest);
    await writeLock(p.dir, fresh);
    await writeFile(join(p.dir, "options.txt"), "fov:70");
    const c1 = await p.anvil.commit("c1");
    await p.anvil.branch("theirs");

    // `theirs` gains a commit tracking an object that is deliberately absent —
    // the exact shape `importHistory` leaves behind when it refuses a blob.
    const c1Commit = await p.vcStore.getCommit(c1.id);
    const c1Snap = await p.vcStore.getSnapshot(c1Commit.snapshot);
    const poisoned: SnapshotObject = {
      ...c1Snap,
      tracked: [...c1Snap.tracked, { path: CF_TARGET, blob: blobIdOf(CF_BYTES) }].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    };
    const theirTip = await p.vcStore.put({
      ...c1Commit,
      snapshot: await p.vcStore.put(poisoned),
      parents: [c1.id],
      gen: c1Commit.gen + 1,
      message: "theirs: an entry a transfer refused to store",
    });
    await new Refs(join(p.dir, ".anvil")).writeRef("refs/heads/theirs", theirTip);
    expect(await p.vcStore.has(blobIdOf(CF_BYTES))).toBe(false);

    // Diverge locally so the merge is a real 3-way, not a fast-forward.
    await writeFile(join(p.dir, "config.txt"), "ours");
    await p.anvil.commit("c2: ours");

    const result = await p.anvil.merge("theirs");
    expect(result.warnings.some((w) => w.includes(CF_TARGET))).toBe(true);

    const merged = result.committed;
    expect(merged).toBeDefined();
    const mergedCommit = await p.vcStore.getCommit(
      merged?.id ?? { algo: "sha256", value: "0".repeat(64) },
    );
    const mergedSnap = await p.vcStore.getSnapshot(mergedCommit.snapshot);
    expect(mergedSnap.tracked.map((t) => t.path)).not.toContain(CF_TARGET);
    // Our own file survived the merge — the drop is targeted, not a wipe.
    expect(mergedSnap.tracked.map((t) => t.path)).toContain("config.txt");
  });
});

describe("LB-722 — decodeRaw verifies before it hands bytes to a screening decision", () => {
  it("GATE decode-verify: bytes that do not hash to the id they arrive under are refused", async () => {
    // `decodeRaw` exists so an inbound object can be inspected without being
    // stored. A screening decision taken on unverified bytes is a decision about
    // bytes nobody has authenticated, so the address check is part of the gate
    // rather than a nicety `importRaw` can be trusted to repeat later.
    const p = await makeParty("lb722-decode");
    const honest = new TextEncoder().encode("the object this id names");
    const id = await p.vcStore.putBlob(honest);
    const impostor = deflateSync(encodeObject({ type: "blob", bytes: CF_BYTES }));

    expect(() => p.vcStore.decodeRaw(id, impostor)).toThrow(LockParseError);
    expect(() => p.vcStore.decodeRaw(id, impostor)).toThrow(/content-address verification/);
    // The honest object still round-trips, so this is a check and not a refusal.
    expect(
      p.vcStore.decodeRaw(id, deflateSync(encodeObject({ type: "blob", bytes: honest }))),
    ).toEqual(honest);
  });
});
