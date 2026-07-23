/**
 * The `.anvil/` ref database — the pointers into the commit graph.
 *
 *   - `HEAD`         — symbolic (`ref: refs/heads/<name>`) or detached (a commit id).
 *   - `ORIG_HEAD`    — the pre-operation HEAD, so `merge`/`rebase --abort` can restore it.
 *   - `MERGE_HEAD`   — the other side of an in-progress merge (an in-flight-op marker GC roots).
 *   - `refs/heads|tags|remotes/…` — the branch / tag / remote-tracking pointers.
 *   - `packed-refs`  — loose refs collapsed into one file (read as a fallback).
 *   - `logs/…`       — the reflog: an append-only audit of every ref movement.
 *
 * All ref files hold a single `"sha256:<hex>"` line (self-describing, matching the
 * lock's hash form). Writes are atomic (`tmp → rename`).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { Hash } from "../types/index.js";
import { hashFromString, hashToString } from "./objects.js";

/** A parsed HEAD: symbolic (points at a branch) or detached (a direct commit). */
export interface HeadState {
  /** The branch ref name (`refs/heads/main`) when HEAD is symbolic. */
  readonly symbolic?: string;
  /** The commit id when HEAD is detached. */
  readonly detached?: Hash;
}

/** One reflog entry. */
export interface ReflogEntry {
  readonly old?: Hash;
  readonly next: Hash;
  readonly who: string;
  /** Display-only wall-clock (ms). */
  readonly time: number;
  readonly message: string;
}

const ZERO = "0".repeat(64);

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** The ref database rooted at an instance's `.anvil/` directory. */
export class Refs {
  readonly #dir: string;

  constructor(anvilDir: string) {
    this.#dir = anvilDir;
  }

  #path(rel: string): string {
    return join(this.#dir, rel);
  }

  // --- HEAD ----------------------------------------------------------------

  /** Read HEAD (symbolic or detached); defaults to symbolic `refs/heads/main`. */
  async readHead(): Promise<HeadState> {
    const text = await readTextIfPresent(this.#path("HEAD"));
    if (text === undefined) {
      return { symbolic: "refs/heads/main" };
    }
    const line = text.trim();
    if (line.startsWith("ref:")) {
      return { symbolic: line.slice(4).trim() };
    }
    return { detached: hashFromString(line, "HEAD") };
  }

  /** Resolve HEAD to a commit id, or `undefined` when the branch is unborn. */
  async resolveHead(): Promise<Hash | undefined> {
    const head = await this.readHead();
    if (head.detached) {
      return head.detached;
    }
    if (head.symbolic) {
      return this.readRef(head.symbolic);
    }
    return undefined;
  }

  /** The branch ref name HEAD points at, or `undefined` when detached. */
  async currentBranch(): Promise<string | undefined> {
    return (await this.readHead()).symbolic;
  }

  /** Point HEAD at a branch (symbolic). */
  async setHeadSymbolic(refName: string): Promise<void> {
    await atomicWrite(this.#path("HEAD"), `ref: ${refName}\n`);
  }

  /** Point HEAD directly at a commit (detached). */
  async setHeadDetached(id: Hash): Promise<void> {
    await atomicWrite(this.#path("HEAD"), `${hashToString(id)}\n`);
  }

  // --- named refs (heads / tags / remotes) ---------------------------------

  /** Read a ref by full name (`refs/heads/main`); loose file first, then packed-refs. */
  async readRef(refName: string): Promise<Hash | undefined> {
    const loose = await readTextIfPresent(this.#path(refName));
    if (loose !== undefined) {
      return hashFromString(loose.trim(), refName);
    }
    const packed = await this.#readPacked();
    return packed.get(refName);
  }

  /** Write a ref by full name. */
  async writeRef(refName: string, id: Hash): Promise<void> {
    await atomicWrite(this.#path(refName), `${hashToString(id)}\n`);
  }

  /** Delete a ref (loose file and any packed entry). */
  async deleteRef(refName: string): Promise<void> {
    await rm(this.#path(refName), { force: true });
    const packed = await this.#readPacked();
    if (packed.delete(refName)) {
      await this.#writePacked(packed);
    }
  }

  /** Every ref under a prefix (`refs/heads`), name → id, loose ∪ packed. */
  async listRefs(prefix: string): Promise<Map<string, Hash>> {
    const out = new Map<string, Hash>();
    const packed = await this.#readPacked();
    for (const [name, id] of packed) {
      if (name === prefix || name.startsWith(`${prefix}/`)) {
        out.set(name, id);
      }
    }
    const root = this.#path(prefix);
    const walk = async (rel: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? posix.join(rel, e.name) : e.name;
        if (e.isDirectory()) {
          await walk(childRel);
        } else {
          const full = `${prefix}/${childRel}`;
          const id = await this.readRef(full);
          if (id) {
            out.set(full, id);
          }
        }
      }
    };
    await walk("");
    return out;
  }

  // --- ORIG_HEAD / MERGE_HEAD ---------------------------------------------

  async readOrigHead(): Promise<Hash | undefined> {
    return this.#readHashFile("ORIG_HEAD");
  }
  async writeOrigHead(id: Hash): Promise<void> {
    await atomicWrite(this.#path("ORIG_HEAD"), `${hashToString(id)}\n`);
  }
  async clearOrigHead(): Promise<void> {
    await rm(this.#path("ORIG_HEAD"), { force: true });
  }

  async readMergeHead(): Promise<Hash | undefined> {
    return this.#readHashFile("MERGE_HEAD");
  }
  async writeMergeHead(id: Hash): Promise<void> {
    await atomicWrite(this.#path("MERGE_HEAD"), `${hashToString(id)}\n`);
  }
  async clearMergeHead(): Promise<void> {
    await rm(this.#path("MERGE_HEAD"), { force: true });
  }

  async #readHashFile(rel: string): Promise<Hash | undefined> {
    const text = await readTextIfPresent(this.#path(rel));
    return text === undefined ? undefined : hashFromString(text.trim(), rel);
  }

  // --- packed-refs ---------------------------------------------------------

  async #readPacked(): Promise<Map<string, Hash>> {
    const out = new Map<string, Hash>();
    const text = await readTextIfPresent(this.#path("packed-refs"));
    if (text === undefined) {
      return out;
    }
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      const sp = line.indexOf(" ");
      if (sp <= 0) {
        continue;
      }
      out.set(line.slice(sp + 1).trim(), hashFromString(line.slice(0, sp), "packed-refs"));
    }
    return out;
  }

  async #writePacked(map: ReadonlyMap<string, Hash>): Promise<void> {
    const names = [...map.keys()].sort();
    const lines = ["# pack-refs with: peeled fully-peeled sorted"];
    for (const name of names) {
      const id = map.get(name);
      if (id) {
        lines.push(`${hashToString(id)} ${name}`);
      }
    }
    await atomicWrite(this.#path("packed-refs"), `${lines.join("\n")}\n`);
  }

  /** Fold every loose ref under `refs/` into `packed-refs`, removing the loose files. */
  async packRefs(): Promise<void> {
    const packed = await this.#readPacked();
    for (const prefix of ["refs/heads", "refs/tags", "refs/remotes"]) {
      for (const [name, id] of await this.listRefs(prefix)) {
        packed.set(name, id);
        await rm(this.#path(name), { force: true });
      }
    }
    await this.#writePacked(packed);
  }

  // --- reflog --------------------------------------------------------------

  /** Append a reflog entry for a ref movement. */
  async appendReflog(
    refName: string,
    old: Hash | undefined,
    next: Hash,
    who: string,
    message: string,
    time: number = Date.now(),
  ): Promise<void> {
    const safeWho = who.replace(/[\t\n ]+/g, "-") || "anvil";
    const safeMessage = message.replace(/[\t\n]+/g, " ");
    const line = `${old ? old.value : ZERO} ${next.value} ${safeWho} ${time}\t${safeMessage}\n`;
    await this.#appendLog(join("logs", refName), line);
  }

  async #appendLog(rel: string, line: string): Promise<void> {
    const path = this.#path(rel);
    await mkdir(dirname(path), { recursive: true });
    const existing = (await readTextIfPresent(path)) ?? "";
    await writeFile(path, existing + line);
  }

  /** Read a ref's reflog, oldest → newest. */
  async readReflog(refName: string): Promise<ReflogEntry[]> {
    const text = await readTextIfPresent(this.#path(join("logs", refName)));
    if (text === undefined) {
      return [];
    }
    const out: ReflogEntry[] = [];
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) {
        continue;
      }
      const tab = raw.indexOf("\t");
      const meta = (tab >= 0 ? raw.slice(0, tab) : raw).split(" ");
      const message = tab >= 0 ? raw.slice(tab + 1) : "";
      const oldHex = meta[0] ?? ZERO;
      const nextHex = meta[1] ?? ZERO;
      const time = Number(meta[meta.length - 1] ?? "0");
      out.push({
        ...(oldHex !== ZERO ? { old: { algo: "sha256", value: oldHex } } : {}),
        next: { algo: "sha256", value: nextHex },
        who: meta.slice(2, -1).join(" "),
        time: Number.isFinite(time) ? time : 0,
        message,
      });
    }
    return out;
  }

  /** Every commit id ever referenced by any reflog (for GC reachability). */
  async allReflogHashes(): Promise<Hash[]> {
    const out: Hash[] = [];
    const seen = new Set<string>();
    const collect = async (refName: string): Promise<void> => {
      for (const e of await this.readReflog(refName)) {
        for (const h of [e.old, e.next]) {
          if (h && !seen.has(h.value)) {
            seen.add(h.value);
            out.push(h);
          }
        }
      }
    };
    await collect("HEAD");
    for (const prefix of ["refs/heads", "refs/tags", "refs/remotes"]) {
      for (const name of (await this.listRefs(prefix)).keys()) {
        await collect(name);
      }
    }
    return out;
  }
}
