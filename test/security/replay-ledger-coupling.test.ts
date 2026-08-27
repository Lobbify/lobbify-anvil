/**
 * The replay cache is a **switch**, and this file is the guard on it (LB-879).
 *
 * `ReplayVeto` has two instruments for the question "are these bytes CurseForge
 * content": a content check against the per-instance replay cache, and the union
 * ledger at `.anvil/refs/replay-paths`. Exactly one boolean picks between them —
 * {@link ReplayCache.established} — and the direction that bites is that making
 * it **true retires the ledger for the whole instance**. The ledger is the only
 * instrument that still works once the cache has been deleted, so a cache that
 * exists without holding the bytes is a ToS hole: a superseded CurseForge jar at
 * a claimed path stops being refused and becomes an ordinary tracked file that
 * `commit` records and `push` ships.
 *
 * Nothing in the shape of the code said so. The coupling lived in one expression
 * inside `replay-provenance.ts`, while the place a contributor would introduce a
 * new producer — anywhere that creates `.anvil/replay-cache/` — is a different
 * file that never mentions the ledger at all.
 *
 * These assertions are deliberately NOT a description of today's behaviour. They
 * fire on the *change*:
 *
 *   1. a new `src/` file starts touching the replay cache → the allowlist fails,
 *      and says what the author has to think about before adding a line to it;
 *   2. the switch stops being asked of the cache type → the derivation test fails;
 *   3. a cache that holds nothing starts counting as established → the
 *      behavioural pins fail.
 *
 * (1) is the load-bearing one. It is a source scan, so it is a proxy: a file
 * cannot create the cache directory without naming either the path literal or
 * the type, so naming is a superset of creating. It is coarse on purpose —
 * bouncing a comment is cheap, and missing a producer is not.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ReplayCache, ReplayVeto, recordReplayPaths } from "../../index.js";
import type { Lockfile } from "../../index.js";
import { replayDigestsOf } from "../../src/store/replay-provenance.js";
import { hashOf, mkTmp, rmTmp } from "../helpers/fixtures.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

/**
 * Every `src/` file allowed to name the replay cache, and why it needs to.
 *
 * ## Adding a line here is the acknowledgement. Before you do:
 *
 * If your file only *reads* the cache (`has`, `materialize`, `objectPath`), it
 * changes nothing about the switch — say so in the reason and carry on.
 *
 * If your file can cause the cache to come into **existence** — `ensureDir`,
 * `mkdir`, an extract or copy under `.anvil/`, scaffolding a new instance,
 * restoring a clone — then it silently disables the path ledger for every
 * instance it touches. That is a behaviour change to replay admission, not a
 * layout detail, and it needs the same scrutiny as editing `verdict()` itself.
 * Pre-creating the directory to "prepare" an instance is the specific mistake:
 * it makes the cache look established while holding nothing.
 */
const REPLAY_CACHE_FILES: Record<string, string> = {
  "store/replay-cache.ts": "owns the directory and the `established` switch",
  "store/replay-provenance.ts": "asks the switch; owns the ledger and the verdict",
  "store/placement.ts": "materializes a replay item from the cache (read-only)",
  "store/index.ts": "re-exports the type",
  "sources/replay-acquire.ts": "the only admitting producer — `putBuffer` on verified bytes",
  "build/pipeline.ts": "threads the cache into placement; warns on the degraded state",
  "build/refs.ts": "comment: replay bytes are not shared-store GC roots",
  "remote/transport.ts": "comment: no layout path here names the replay cache",
  "sources/curseforge.ts": "comment: CF bytes go to the cache, never the shared store",
  "anvil.ts": "constructs the per-instance cache and hands it to build/commit",
  "import/pack-common.ts":
    "names it only in a doc comment, explaining why trackedSubdir is a closed " +
    "allowlist (LB-922) that refuses it — never creates or reads it",
};

const NAMES_CACHE = /replay-cache|REPLAY_CACHE_DIRNAME|ReplayCache|replayCache/;

/** Every `.ts` file under `src/`, as `/`-joined paths relative to `src/`. */
async function srcFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.name.endsWith(".ts")) {
        out.push(relative(SRC_ROOT, p).split(sep).join("/"));
      }
    }
  }
  await walk(SRC_ROOT);
  return out.sort();
}

const ADDED_HINT = [
  "If this file only reads the cache, add it to REPLAY_CACHE_FILES with that as its",
  "reason. If it can CREATE the directory, that is a change to replay admission for",
  "every instance it touches — justify it there explicitly.",
].join(" ");

const REMOVED_HINT =
  "no longer touches the replay cache — drop the stale REPLAY_CACHE_FILES entries " +
  "so the allowlist keeps meaning something.";

const REPROBED_HINT = "ReplayVeto is probing the replay-cache directory directly again.";

const WHY_IT_MATTERS =
  "Creating `.anvil/replay-cache/` flips ReplayVeto's switch: the content check " +
  "takes over and the `.anvil/refs/replay-paths` ledger stops being consulted for " +
  "that instance. A cache that exists but holds nothing therefore turns a refused " +
  "CurseForge jar into a tracked, pushable file. See the doc on " +
  "`REPLAY_CACHE_FILES` in this file, and `ReplayCache.established`.";

describe("LB-879 — the replay cache is a ledger switch, and new producers must say so", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("no src/ file touches the replay cache without being on the allowlist", async () => {
    const touching: string[] = [];
    for (const rel of await srcFiles()) {
      if (NAMES_CACHE.test(await readFile(join(SRC_ROOT, rel), "utf8"))) {
        touching.push(rel);
      }
    }
    const allowed = Object.keys(REPLAY_CACHE_FILES).sort();
    const added = touching.filter((f) => !(f in REPLAY_CACHE_FILES));
    const removed = allowed.filter((f) => !touching.includes(f));

    expect(
      added,
      `${added.join(", ")} started touching the replay cache. ${WHY_IT_MATTERS} ${ADDED_HINT}`,
    ).toEqual([]);
    expect(removed, `${removed.join(", ")} ${REMOVED_HINT}`).toEqual([]);
  });

  it("the switch is asked of the cache type, never probed as a bare directory", async () => {
    const src = await readFile(join(SRC_ROOT, "store/replay-provenance.ts"), "utf8");
    // `writeTemp` creates `<root>/tmp/` before it has hashed anything, so probing
    // the root let a FAILED admission retire the ledger. Keeping the question on
    // `ReplayCache` is what puts the constraint in front of a future producer.
    expect(src).toMatch(/cache\.established\(\)/);
    expect(src, `${REPROBED_HINT} ${WHY_IT_MATTERS}`).not.toMatch(/pathExists\([^)]*\.root\)/);
  });

  // --- behavioural pins: "established" must mean bytes landed, not mkdir ------

  const CF_BYTES = Buffer.from("curseforge-jar-bytes");
  const CLAIMED = "mods/jei.jar";

  function lockClaiming(target: string): Lockfile {
    return {
      meta: {
        version: 1,
        manifestHash: hashOf(Buffer.from("m"), "sha256"),
        minecraft: "26.2",
        loader: "fabric 0.19.1",
        java: "j",
      },
      resolved: [
        {
          name: "jei",
          kind: "mod",
          source: "curseforge",
          version: "1.0.0",
          hash: hashOf(CF_BYTES, "sha256"),
          provenance: "replay",
          placement: { method: "link", target },
          project: 238222,
          file: 5000,
        },
      ],
    };
  }

  /** An instance whose ledger claims `mods/jei.jar` and whose cache is gone. */
  async function claimedInstance(label: string): Promise<string> {
    const instanceDir = await mkTmp(label);
    dirs.push(instanceDir);
    await recordReplayPaths(instanceDir, [lockClaiming(CLAIMED)]);
    return instanceDir;
  }

  it("a bare mkdir of the cache root does NOT retire the ledger", async () => {
    const instanceDir = await claimedInstance("ledger-mkdir");
    await mkdir(new ReplayCache({ instanceDir }).root, { recursive: true });

    const veto = await ReplayVeto.load(instanceDir);
    expect(veto.degraded).toBe(true);
    expect(await veto.verdict(CLAIMED, replayDigestsOf(CF_BYTES))).toBe("veto-unverified");
  });

  it("a FAILED admission does NOT retire the ledger (ShaMismatch is the tamper case)", async () => {
    const instanceDir = await claimedInstance("ledger-mismatch");
    const cache = new ReplayCache({ instanceDir });
    // `writeTemp` creates `<root>/tmp/` before hashing, and nothing ever sweeps
    // it, so this state is durable rather than transient.
    await expect(
      cache.putBuffer(CF_BYTES, hashOf(Buffer.from("what-the-lock-pinned"), "sha256")),
    ).rejects.toThrow();

    expect(await cache.established()).toBe(false);
    const veto = await ReplayVeto.load(instanceDir);
    expect(veto.degraded).toBe(true);
    expect(await veto.verdict(CLAIMED, replayDigestsOf(CF_BYTES))).toBe("veto-unverified");
  });

  it("a leftover temp file alone does NOT count as an established cache", async () => {
    const instanceDir = await claimedInstance("ledger-tmp");
    const cache = new ReplayCache({ instanceDir });
    await mkdir(join(cache.root, "tmp"), { recursive: true });
    await writeFile(join(cache.root, "tmp", "orphan.tmp"), CF_BYTES);

    expect(await cache.established()).toBe(false);
    expect((await ReplayVeto.load(instanceDir)).degraded).toBe(true);
  });

  it("NEGATIVE CONTROL: a real admission DOES establish the cache and hand over to the content check", async () => {
    const instanceDir = await claimedInstance("ledger-real");
    const cache = new ReplayCache({ instanceDir });
    await cache.putBuffer(CF_BYTES, hashOf(CF_BYTES, "sha256"));

    expect(await cache.established()).toBe(true);
    const veto = await ReplayVeto.load(instanceDir);
    expect(veto.degraded).toBe(false);
    // The cached bytes are vetoed on content, and a DIFFERENT file at the same
    // claimed path is tracked — the LB-822 over-exclusion this must never regress.
    expect(await veto.verdict(CLAIMED, replayDigestsOf(CF_BYTES))).toBe("veto");
    expect(await veto.verdict(CLAIMED, replayDigestsOf(Buffer.from("my own mod")))).toBe("track");
  });

  it("a sha1-pinned admission establishes it too (base-pack members pin sha1)", async () => {
    const instanceDir = await claimedInstance("ledger-sha1");
    const cache = new ReplayCache({ instanceDir });
    await cache.putBuffer(CF_BYTES, hashOf(CF_BYTES, "sha1"));
    expect(await cache.established()).toBe(true);
  });
});
