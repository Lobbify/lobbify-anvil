/**
 * The advisory file lock — the per-instance `.anvil/lock` + shared-store write
 * lock primitive. Covers acquire/release, contention (→ LockBusy), stale reclaim,
 * and release-on-throw.
 */

import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockBusy } from "../../index.js";
import { acquireLock, withLock } from "../../src/internal/lock.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) {
    await rmTmp(d);
  }
  dirs.length = 0;
});

/** A virtual clock whose sleep advances it (deterministic, instant). */
function virtualClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number): Promise<void> => {
      clock += ms;
    },
  };
}

describe("file lock", () => {
  it("acquires, holds exclusively, and releases", async () => {
    const dir = await mkTmp("lock");
    dirs.push(dir);
    const path = join(dir, "lock");
    const handle = await acquireLock(path);
    // The lock file exists while held.
    await expect(readFile(path)).resolves.toBeTruthy();
    await handle.release();
    await expect(readFile(path)).rejects.toBeTruthy();
  });

  it("a second acquire on a live lock times out with LockBusy", async () => {
    const dir = await mkTmp("lock2");
    dirs.push(dir);
    const path = join(dir, "lock");
    const held = await acquireLock(path);
    const vc = virtualClock();
    await expect(
      acquireLock(path, { timeoutMs: 500, staleMs: 10_000, now: vc.now, sleep: vc.sleep }),
    ).rejects.toBeInstanceOf(LockBusy);
    await held.release();
  });

  it("reclaims a stale lock whose holder pid is dead", async () => {
    const dir = await mkTmp("lock3");
    dirs.push(dir);
    const path = join(dir, "lock");
    // A leftover lock from a long-dead process.
    await writeFile(path, JSON.stringify({ token: "old", pid: 999_999, time: 0 }), { flag: "wx" });
    const handle = await acquireLock(path, { timeoutMs: 1000 });
    const record = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(record.pid).toBe(process.pid); // we now hold it
    await handle.release();
  });

  it("reclaims an abandoned lock (old mtime, heartbeat stopped) even if the pid looks alive", async () => {
    const dir = await mkTmp("lock5");
    dirs.push(dir);
    const path = join(dir, "lock");
    // A lock left by *this* live pid, but whose heartbeat has stopped — its mtime
    // is ancient. It must be reclaimed by the age gate (a hung/abandoned holder).
    await writeFile(path, JSON.stringify({ token: "old", pid: process.pid, time: 0 }), {
      flag: "wx",
    });
    const past = new Date(Date.now() - 120_000);
    await utimes(path, past, past);
    const handle = await acquireLock(path, { timeoutMs: 1000, staleMs: 1000, heartbeat: false });
    const record = JSON.parse(await readFile(path, "utf8")) as { token: string };
    expect(record.token).not.toBe("old"); // we reclaimed it
    await handle.release();
  });

  it("does NOT reclaim a fresh live lock (a heartbeating holder is left alone)", async () => {
    const dir = await mkTmp("lock6");
    dirs.push(dir);
    const path = join(dir, "lock");
    // A fresh lock held by a live pid — a contender with even a tiny stale window
    // must not steal it (its mtime is current), so it times out instead.
    await writeFile(path, JSON.stringify({ token: "live", pid: process.pid, time: Date.now() }), {
      flag: "wx",
    });
    const vc = virtualClock();
    await expect(
      acquireLock(path, { timeoutMs: 300, staleMs: 1, now: vc.now, sleep: vc.sleep }),
    ).rejects.toBeInstanceOf(LockBusy);
    // The original live lock is untouched.
    expect((JSON.parse(await readFile(path, "utf8")) as { token: string }).token).toBe("live");
  });

  it("withLock releases even when the body throws", async () => {
    const dir = await mkTmp("lock4");
    dirs.push(dir);
    const path = join(dir, "lock");
    await expect(
      withLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The lock was released despite the throw — a fresh acquire succeeds instantly.
    const handle = await acquireLock(path, { timeoutMs: 100 });
    await handle.release();
  });
});
