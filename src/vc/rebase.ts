/**
 * `.anvil/REBASE_STATE/` — the crash-survivable state of an in-progress rebase.
 *
 * A rebase replays a run of commits one at a time, each as an item-delta apply +
 * a per-step re-lock. The branch ref is NOT moved until the rebase finishes, so a
 * crash leaves the branch exactly where it started; all progress lives here in
 * `state.json`, atomically rewritten before each step. On restart the operation is
 * resumable (`--continue` / `--skip`) or reversible (`--abort` restores `ORIG_HEAD`).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../internal/fs.js";
import type { Hash } from "../types/index.js";
import { hashFromString, hashToString } from "./objects.js";

/** The persisted state of an in-progress rebase. */
export interface RebaseState {
  /** The commit being rebased onto (the new base). */
  readonly onto: Hash;
  /** The original branch tip, restored by `--abort`. */
  readonly origHead: Hash;
  /** The branch ref being rebased (`refs/heads/topic`). */
  readonly branch: string;
  /** The current rebased tip (starts at `onto`, advances per applied step). */
  readonly tip: Hash;
  /** Remaining original commits to replay, oldest → newest. */
  readonly todo: readonly Hash[];
  /** Newly-created rebased commits, in order. */
  readonly done: readonly Hash[];
  /** The commit whose replay is paused on a conflict (if any). */
  readonly current?: Hash;
}

function stateDir(anvilDir: string): string {
  return join(anvilDir, "REBASE_STATE");
}

function statePath(anvilDir: string): string {
  return join(stateDir(anvilDir), "state.json");
}

/** True when a rebase is in progress. */
export async function rebaseInProgress(anvilDir: string): Promise<boolean> {
  return pathExists(statePath(anvilDir));
}

/** Read the in-progress rebase state, or `undefined`. */
export async function readRebaseState(anvilDir: string): Promise<RebaseState | undefined> {
  let text: string;
  try {
    text = await readFile(statePath(anvilDir), "utf8");
  } catch {
    return undefined;
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  return {
    onto: hashFromString(String(raw.onto), "rebase.onto"),
    origHead: hashFromString(String(raw.origHead), "rebase.origHead"),
    branch: String(raw.branch),
    tip: hashFromString(String(raw.tip), "rebase.tip"),
    todo: (raw.todo as string[]).map((h) => hashFromString(h, "rebase.todo")),
    done: (raw.done as string[]).map((h) => hashFromString(h, "rebase.done")),
    ...(raw.current ? { current: hashFromString(String(raw.current), "rebase.current") } : {}),
  };
}

/** Atomically (re)write the rebase state. */
export async function writeRebaseState(anvilDir: string, state: RebaseState): Promise<void> {
  const dir = stateDir(anvilDir);
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(
    {
      onto: hashToString(state.onto),
      origHead: hashToString(state.origHead),
      branch: state.branch,
      tip: hashToString(state.tip),
      todo: state.todo.map(hashToString),
      done: state.done.map(hashToString),
      ...(state.current ? { current: hashToString(state.current) } : {}),
    },
    null,
    2,
  );
  const tmp = join(dir, `state.${randomUUID()}.tmp`);
  await writeFile(tmp, payload);
  await rename(tmp, statePath(anvilDir));
}

/** Every commit id referenced by the in-progress rebase (for GC reachability). */
export function rebaseStateHashes(state: RebaseState): Hash[] {
  const out = [state.onto, state.origHead, state.tip, ...state.todo, ...state.done];
  if (state.current) {
    out.push(state.current);
  }
  return out;
}

/** Clear the rebase state directory. */
export async function clearRebaseState(anvilDir: string): Promise<void> {
  await rm(stateDir(anvilDir), { recursive: true, force: true });
}
