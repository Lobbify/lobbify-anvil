/**
 * The journaled atomic swap — the second hard invariant.
 *
 * A build materializes the changed targets into `.anvil/stage-<id>` on the same
 * volume as the instance, then swaps them into place through a write-ahead
 * journal (`.anvil/swap.journal`): for each target, move the old aside into a
 * backup, then move the new in. A single `commit` line is the linearization
 * point. On startup, {@link recoverSwap} reconciles any interrupted swap to a
 * consistent state — **fully old** (no commit) or **fully new** (commit present)
 * — never a half-installed Frankenstein.
 *
 * Durability: the journal file *and* every directory it renames through are
 * `fsync`ed so the ordering survives a power loss — the renames are made durable
 * before the `commit` line is, so a recovered instance never rolls forward onto
 * renames that never hit disk. The swap set only ever contains validated,
 * non-protected targets, so `saves/` (and everything the {@link IgnoreSet}
 * protects, case-insensitively) is never moved or lost, at any crash point.
 */

import { open, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { FaultHook } from "../internal/faults.js";
import { fireFault } from "../internal/faults.js";
import { ensureDir, pathExists, removePath, renameInto, safeJoin } from "../internal/fs.js";
import { fsyncDir } from "../store/atomic.js";
import { SwapRecoveryFailed } from "../types/errors.js";
import type { IgnoreSet } from "./anvilignore.js";

const JOURNAL_NAME = "swap.journal";

interface SwapBegin {
  readonly t: "begin";
  readonly stageId: string;
  /** Relative target paths to install (a staged source exists for each). */
  readonly installs: readonly string[];
  /** Relative target paths to delete (stale from the previous build). */
  readonly removes: readonly string[];
  /** Subset of installs∪removes that existed in the instance when the swap began. */
  readonly hadOld: readonly string[];
}

export interface SwapPlan {
  readonly instanceDir: string;
  readonly stageId: string;
  readonly installs: readonly string[];
  readonly removes: readonly string[];
  readonly ignore: IgnoreSet;
  readonly fault?: FaultHook;
}

function anvilDir(instanceDir: string): string {
  return join(instanceDir, ".anvil");
}
function journalPath(instanceDir: string): string {
  return join(anvilDir(instanceDir), JOURNAL_NAME);
}
function stageRootOf(instanceDir: string, stageId: string): string {
  return join(anvilDir(instanceDir), `stage-${stageId}`);
}
function backupDirOf(instanceDir: string, stageId: string): string {
  return join(anvilDir(instanceDir), `swap-backup-${stageId}`);
}

async function writeFsync(path: string, data: string, flag: "w" | "a"): Promise<void> {
  const fh = await open(path, flag);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** The directories whose entries the swap mutates — fsynced before `commit`. */
function affectedDirs(
  instanceDir: string,
  backupDir: string,
  stageRoot: string,
  installs: readonly string[],
  removes: readonly string[],
): string[] {
  const dirs = new Set<string>([anvilDir(instanceDir), instanceDir]);
  for (const t of installs) {
    dirs.add(dirname(join(instanceDir, t)));
    dirs.add(dirname(join(backupDir, t)));
    dirs.add(dirname(join(stageRoot, t)));
  }
  for (const t of removes) {
    dirs.add(dirname(join(instanceDir, t)));
    dirs.add(dirname(join(backupDir, t)));
  }
  return [...dirs];
}

/** Remove now-empty parent dirs of a rolled-back brand-new target, up to the instance. */
async function pruneEmptyParents(instanceDir: string, relTarget: string): Promise<void> {
  const root = resolve(instanceDir);
  let dir = dirname(join(instanceDir, relTarget));
  while (resolve(dir) !== root && resolve(dir).startsWith(root + sep)) {
    try {
      await rmdir(dir); // fails (ENOTEMPTY/ENOENT) if it still holds anything → stop
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * Execute the swap: move-aside old, move-in new for each install; aside stale
 * removes; write `commit`; then delete the backups, the stage, and the journal.
 * Crashing anywhere leaves a journal that {@link recoverSwap} resolves.
 */
export async function journaledSwap(plan: SwapPlan): Promise<void> {
  const { instanceDir, stageId, ignore, fault } = plan;
  // Defense in depth: a protected target can never enter the swap set...
  const installs = plan.installs.filter((t) => !ignore.ignores(t));
  const removes = plan.removes.filter((t) => !ignore.ignores(t));
  // ...and every target must resolve safely under the instance (rejects `..`,
  // absolute, drive-letter, protected, and colon-bearing paths — remove targets
  // come from the previous built lock, which is otherwise unvalidated).
  // `rejectColon: true` (LB-827): every target here is a lock-derived placement,
  // never a file that already exists in the user's own instance tree.
  for (const t of [...installs, ...removes]) {
    safeJoin(instanceDir, t, { rejectColon: true });
  }

  const stageRoot = stageRootOf(instanceDir, stageId);
  const backupDir = backupDirOf(instanceDir, stageId);
  const jPath = journalPath(instanceDir);

  const considered = [...new Set([...installs, ...removes])];
  const hadOld: string[] = [];
  for (const t of considered) {
    if (await pathExists(join(instanceDir, t))) {
      hadOld.push(t);
    }
  }

  await ensureDir(anvilDir(instanceDir));
  const begin: SwapBegin = { t: "begin", stageId, installs, removes, hadOld };
  await writeFsync(jPath, `${JSON.stringify(begin)}\n`, "w");
  await fsyncDir(anvilDir(instanceDir)); // journal entry durable before any rename
  await fireFault(fault, "swap:begin");

  for (const t of installs) {
    await fireFault(fault, `swap:before-aside:${t}`);
    if (await pathExists(join(instanceDir, t))) {
      await renameInto(join(instanceDir, t), join(backupDir, t));
      await fireFault(fault, `swap:after-aside:${t}`);
    }
    await renameInto(join(stageRoot, t), join(instanceDir, t));
    await fireFault(fault, `swap:after-install:${t}`);
  }

  for (const t of removes) {
    await fireFault(fault, `swap:before-remove:${t}`);
    if (await pathExists(join(instanceDir, t))) {
      await renameInto(join(instanceDir, t), join(backupDir, t));
      await fireFault(fault, `swap:after-remove:${t}`);
    }
  }

  // Make every rename durable BEFORE the commit line becomes durable, so a
  // recovered instance can never roll forward onto renames that never landed.
  for (const d of affectedDirs(instanceDir, backupDir, stageRoot, installs, removes)) {
    await fsyncDir(d);
  }
  await fireFault(fault, "swap:before-commit");
  await writeFsync(jPath, `${JSON.stringify({ t: "commit" })}\n`, "a");
  await fsyncDir(anvilDir(instanceDir)); // commit durable → linearization point
  await fireFault(fault, "swap:after-commit");

  await removePath(backupDir);
  await removePath(stageRoot);
  await unlink(jPath).catch(() => undefined);
  await fireFault(fault, "swap:after-cleanup");
}

function parseJournal(text: string): { begin: SwapBegin; committed: boolean } | undefined {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  let first: SwapBegin;
  try {
    first = JSON.parse(lines[0] as string) as SwapBegin;
  } catch {
    // A torn `begin` line (power loss mid-write) means no rename ran — the safe
    // reading is "clean". Never let it wedge every future build.
    return undefined;
  }
  if (first.t !== "begin") {
    return undefined;
  }
  const committed = lines.some((l) => {
    try {
      return (JSON.parse(l) as { t: string }).t === "commit";
    } catch {
      return false;
    }
  });
  return { begin: first, committed };
}

/**
 * Resolve a target safely, or `undefined` if it escapes the instance root (used
 * only during journal rollback, so `t` is the same lock-derived swap target
 * `journaledSwap` already validated at build time — `rejectColon: true` for the
 * same reason, LB-827).
 */
function safeTarget(instanceDir: string, t: string): string | undefined {
  try {
    return safeJoin(instanceDir, t, { rejectColon: true });
  } catch {
    return undefined;
  }
}

/**
 * Reconcile any interrupted swap on startup. Idempotent: it inspects the journal
 * and actual disk state, then rolls forward (commit present → keep new) or back
 * (no commit → restore old), and clears the stage/backup/journal.
 */
export async function recoverSwap(
  instanceDir: string,
  fault?: FaultHook,
): Promise<"clean" | "forward" | "back"> {
  const jPath = journalPath(instanceDir);
  let text: string;
  try {
    text = await readFile(jPath, "utf8");
  } catch {
    return "clean"; // no interrupted swap
  }
  const parsed = parseJournal(text);
  if (!parsed) {
    await unlink(jPath).catch(() => undefined);
    return "clean";
  }
  const { begin, committed } = parsed;
  const stageRoot = stageRootOf(instanceDir, begin.stageId);
  const backupDir = backupDirOf(instanceDir, begin.stageId);

  if (committed) {
    // Roll forward: every op completed (and was fsynced) before `commit`. Clean up.
    await removePath(backupDir);
    await removePath(stageRoot);
    await unlink(jPath).catch(() => undefined);
    await fireFault(fault, "recover:forward-done");
    return "forward";
  }

  // Roll back to the pre-build state.
  const considered = [...new Set([...begin.installs, ...begin.removes])];
  for (const t of considered) {
    if (safeTarget(instanceDir, t) === undefined) {
      continue; // never operate on an out-of-instance path from a tampered journal
    }
    const instPath = join(instanceDir, t);
    const backupPath = join(backupDir, t);
    if (await pathExists(backupPath)) {
      if (await pathExists(instPath)) {
        await removePath(instPath); // a new install (or partial) over the asided old
      }
      try {
        await renameInto(backupPath, instPath); // restore old
      } catch (err) {
        throw new SwapRecoveryFailed(`could not restore "${t}" during rollback: ${String(err)}`);
      }
    } else if (!begin.hadOld.includes(t)) {
      // Brand-new entry: undo any install that landed, then prune empty parents
      // so the tree is left exactly as it was before the build.
      if (await pathExists(instPath)) {
        await removePath(instPath);
        await pruneEmptyParents(instanceDir, t);
      }
    }
    // else: had an old, no backup → aside never ran → old is still in place; leave it.
  }
  await removePath(stageRoot);
  await removePath(backupDir);
  await unlink(jPath).catch(() => undefined);
  await fireFault(fault, "recover:back-done");
  return "back";
}

/** True when an interrupted swap journal is present. */
export async function hasPendingSwap(instanceDir: string): Promise<boolean> {
  return pathExists(journalPath(instanceDir));
}

export { stageRootOf, backupDirOf, JOURNAL_NAME };
