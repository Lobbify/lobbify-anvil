/**
 * A cross-process advisory **file lock** — the per-instance `.anvil/lock` process
 * lock and the shared-store write lock.
 *
 * Two mutating operations on the same instance (two `build`s, a `build` racing a
 * `pull`, or a `gc` racing a build's dedup) must not interleave and corrupt the
 * atomic swap, the VC ref database, or the content store. Node has no portable
 * `flock`, so this is the standard robust pattern: an atomic `O_EXCL` lock file
 * carrying a unique token + the holder pid + a timestamp.
 *
 * **A live holder is never stolen from.** While a lock is held, a background
 * heartbeat refreshes its mtime, so a long-running op (a full game install +
 * hundreds of MB of downloads well past the steal window) keeps its lock fresh and
 * a contender never reclaims it out from under it. A lock is reclaimed only when it
 * is genuinely abandoned: the holder pid is dead (authoritative on the same host),
 * or — for a pid we cannot judge (a shared/network store from another host) — its
 * mtime has gone un-refreshed past the steal window (the heartbeat stopped, i.e.
 * the process died or hung). Release is **atomic**: we rename the lock aside under
 * our token and only unlink it if it is still ours, so we never delete a lock a
 * contender legitimately reclaimed and recreated.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LockBusy } from "../types/errors.js";
import { ensureDir } from "./fs.js";

/** A held lock; call {@link LockHandle.release} in a `finally`. */
export interface LockHandle {
  release(): Promise<void>;
}

export interface LockOptions {
  /** Max time to wait for the lock before giving up (ms). Default 15s. */
  readonly timeoutMs?: number;
  /**
   * Reclaim a lock whose holder is dead, or whose mtime has gone un-refreshed for
   * longer than this (ms). A live holder heartbeats its mtime, so this only fires
   * for a genuinely abandoned lock. Default 60s.
   */
  readonly staleMs?: number;
  /** Injected clock (tests). */
  readonly now?: () => number;
  /** Injected sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Disable the background mtime heartbeat (tests that assert steal-by-age with a
   * virtual clock). Production always heartbeats.
   */
  readonly heartbeat?: boolean;
}

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly time: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 60_000;
const POLL_MS = 50;

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True if a pid is definitely not a live process on this host. */
function pidIsDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
    return false;
  } catch (err) {
    // ESRCH → no such process; EPERM → alive but not ours (treat as alive).
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockRecord;
  } catch {
    return undefined;
  }
}

/**
 * Refresh the lock file's mtime periodically so a long, live hold is never seen as
 * stale. The timer is `unref`'d (never keeps the process alive) and best-effort
 * (a failed touch — e.g. the lock was reclaimed after a real hang — is ignored, so
 * the abandoned lock correctly ages out). Returns a stop function.
 */
function startHeartbeat(lockPath: string, staleMs: number): () => void {
  const interval = Math.max(1000, Math.floor(staleMs / 3));
  const timer = setInterval(() => {
    const t = new Date();
    void utimes(lockPath, t, t).catch(() => undefined);
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Acquire an advisory lock at `lockPath`. Waits (with backoff) for a live holder,
 * reclaims a stale one, and throws {@link LockBusy} on timeout.
 */
export async function acquireLock(lockPath: string, opts: LockOptions = {}): Promise<LockHandle> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? realSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const token = randomUUID();
  const record: LockRecord = { token, pid: process.pid, time: now() };
  const deadline = now() + timeoutMs;

  const wantHeartbeat = opts.heartbeat ?? true;
  const held = (): LockHandle => {
    const stop = wantHeartbeat ? startHeartbeat(lockPath, staleMs) : () => undefined;
    return {
      release: async () => {
        stop();
        await releaseLock(lockPath, token);
      },
    };
  };

  await ensureDir(dirname(lockPath));
  for (;;) {
    // Atomic create-if-absent: write a temp then O_EXCL-rename would still race, so
    // we use writeFile with the exclusive `wx` flag (fails if the file exists).
    try {
      await writeFile(lockPath, JSON.stringify({ ...record, time: now() }), { flag: "wx" });
      return held();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    // The lock exists — reclaim it ONLY if genuinely abandoned (dead holder, or a
    // pid we cannot judge whose heartbeat has stopped past the steal window). A
    // live holder heartbeats its mtime, so this never steals from an active op.
    const holder = await readRecord(lockPath);
    if (holder) {
      const dead = pidIsDead(holder.pid);
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = now() - (await stat(lockPath)).mtimeMs;
      } catch {
        // vanished between EEXIST and stat — loop and try to re-create.
      }
      // `dead` is authoritative on the same host. `ageMs > staleMs` only reclaims a
      // pid we cannot probe (a foreign-host lock on a shared store) whose heartbeat
      // has clearly stopped — never a fresh, heartbeating live holder.
      const stale = dead || ageMs > staleMs;
      if (stale) {
        // Steal atomically: move the stale file aside under our token, then retry.
        const aside = `${lockPath}.stale.${token}`;
        try {
          await rename(lockPath, aside);
          await rm(aside, { force: true });
        } catch {
          // someone else stole it first — just retry the create
        }
        continue;
      }
    }

    if (now() >= deadline) {
      throw new LockBusy(lockPath, holder ? `pid ${holder.pid}` : "another process");
    }
    await sleep(POLL_MS);
  }
}

/**
 * Release a lock **atomically**: rename it aside under our token (an atomic claim);
 * if the rename fails the file is already gone or was reclaimed, so it is not ours
 * to delete; if what we claimed is not ours, put it back. Only a file that is still
 * ours is unlinked — we never delete a lock a contender legitimately recreated.
 */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  const claimed = `${lockPath}.releasing.${token}`;
  try {
    await rename(lockPath, claimed);
  } catch {
    return; // gone or already reclaimed — nothing of ours to release
  }
  const holder = await readRecord(claimed);
  if (holder && holder.token !== token) {
    // We claimed a lock that had been reclaimed+recreated by someone else — restore
    // it (best-effort) rather than deleting their lock.
    await rename(claimed, lockPath).catch(() => undefined);
    return;
  }
  await rm(claimed, { force: true });
}

/** Run `fn` while holding the lock at `lockPath` (released in a `finally`). */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

/** The per-instance process lock path (`<instanceDir>/.anvil/lock`). */
export function instanceLockPath(instanceDir: string): string {
  return join(instanceDir, ".anvil", "lock");
}

/** The shared-store write-lock path (`<storeRoot>/lock`). */
export function storeLockPath(storeRoot: string): string {
  return join(storeRoot, "lock");
}
