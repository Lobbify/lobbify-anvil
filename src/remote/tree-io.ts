/**
 * `TreeIO` — the byte-level read/(optional-)write surface a served instance tree
 * is reached through. It abstracts *where* a remote lives so the transport logic
 * (fetch head, walk VC history, transfer objects, publish) is written once:
 *
 *   - {@link DirTreeIO}  — a local directory (a `file://` remote, a shared/mounted
 *     dir, or a git working clone). Read + write → a push target.
 *   - {@link HttpTreeIO} — a static `http(s)` base. Read-only, SSRF-guarded.
 *
 * All paths are **instance-relative POSIX** (`anvil.lock`, `.anvil/objects/ab/<id>`)
 * so a served tree is byte-for-byte the same shape whether it lives on disk or
 * behind a URL.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { guardHop } from "../sources/ssrf.js";
import { HttpError } from "../types/errors.js";
import type { Http } from "../types/index.js";

/** A remote tree's byte surface. `write` present ⇒ the remote is a push target. */
export interface TreeIO {
  /** Read a relative path's bytes, or `undefined` when it does not exist. */
  read(relPath: string): Promise<Uint8Array | undefined>;
  /** Write a relative path's bytes (create parents). Absent ⇒ read-only remote. */
  write?(relPath: string, bytes: Uint8Array): Promise<void>;
}

/** A served tree backed by a local directory (read + write). */
export class DirTreeIO implements TreeIO {
  readonly #base: string;

  constructor(baseDir: string) {
    this.#base = baseDir;
  }

  #abs(relPath: string): string {
    // Reject traversal: the relPath is anvil-internal (never user input), but a
    // defensive check keeps a served tree from ever reaching outside its base.
    if (relPath.split(/[/\\]/).includes("..")) {
      throw new HttpError(relPath, "refusing a '..' path in a served tree");
    }
    return join(this.#base, ...relPath.split("/"));
  }

  async read(relPath: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#abs(relPath)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async write(relPath: string, bytes: Uint8Array): Promise<void> {
    const dest = this.#abs(relPath);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);
  }
}

/** A served tree backed by a static `http(s)` base — read-only, SSRF-guarded. */
export class HttpTreeIO implements TreeIO {
  readonly #base: string;
  readonly #http: Http;

  constructor(baseUrl: string, http: Http) {
    // Normalize to a base with exactly one trailing slash for URL joining.
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#http = http;
  }

  async read(relPath: string): Promise<Uint8Array | undefined> {
    const url = `${this.#base}/${relPath}`;
    try {
      const res = await this.#http.get(url, { guard: guardHop });
      return res.body;
    } catch (err) {
      // A 404 is "absent"; anything else (incl. an SSRF veto) propagates.
      if (err instanceof HttpError && err.status === 404) {
        return undefined;
      }
      throw err;
    }
  }
  // No `write` — a static http remote is read-only (a `pull` source, never a
  // `push` target).
}
