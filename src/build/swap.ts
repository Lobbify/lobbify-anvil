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
 * The swap set only ever contains managed targets; `saves/` and everything the
 * {@link IgnoreSet} protects are never in it, so worlds are never moved or lost —
 * at any crash point, across recovery.
 */

import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FaultHook } from "../internal/faults.js";
import { fireFault } from "../internal/faults.js";
import { ensureDir, pathExists, removePath, renameInto } from "../internal/fs.js";
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

/**
 * Execute the swap: move-aside old, move-in new for each install; aside stale
 * removes; write `commit`; then delete the backups, the stage, and the journal.
 * Crashing anywhere leaves a journal that {@link recoverSwap} resolves.
 */
export async function journaledSwap(plan: SwapPlan): Promise<void> {
  const { instanceDir, stageId, ignore, fault } = plan;
  // Defense in depth: a protected target can never enter the swap set.
  const installs = plan.installs.filter((t) => !ignore.ignores(t));
  const removes = plan.removes.filter((t) => !ignore.ignores(t));

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

  await fireFault(fault, "swap:before-commit");
  await writeFsync(jPath, `${JSON.stringify({ t: "commit" })}\n`, "a");
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
  const first = JSON.parse(lines[0] as string) as SwapBegin;
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
    // Roll forward: every op completed before `commit` was written. Just clean up.
    await removePath(backupDir);
    await removePath(stageRoot);
    await unlink(jPath).catch(() => undefined);
    await fireFault(fault, "recover:forward-done");
    return "forward";
  }

  // Roll back to the pre-build state.
  const considered = [...new Set([...begin.installs, ...begin.removes])];
  for (const t of considered) {
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
      // Brand-new entry: undo any install that landed.
      if (await pathExists(instPath)) {
        await removePath(instPath);
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
