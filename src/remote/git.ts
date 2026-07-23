/**
 * The **git** remote transport. A git remote is a repository whose working tree
 * *is* the instance — `anvil.toml`, `anvil.lock`, `.anvilignore`, and the tracked
 * `.anvil/` VC history (objects + refs). anvil never re-implements git plumbing:
 * it shells out to the `git` binary through an injectable {@link GitRunner}
 * (so the whole transport is unit-testable with a fake runner and, in production,
 * exercised by the 2-client device e2e).
 *
 * Reads go through a persistent shallow **working clone** under
 * `.anvil/remotes/<name>/`; a {@link ServedTreeTransport} over that clone supplies
 * `fetchHead` / `fetchVcObject`. Content objects are **not** in a git remote (it
 * carries the two files + history only — joiners re-fetch content from source), so
 * `fetchObject` is always a miss and a push never writes content or replay bytes.
 */

import { join } from "node:path";
import { pathExists } from "../internal/fs.js";
import { RemoteError } from "../types/errors.js";
import type { Hash } from "../types/index.js";
import type { RemoteDescriptor } from "./descriptor.js";
import { remoteBranch } from "./descriptor.js";
import type { PublishInput, RemoteHead, RemoteTransport } from "./transport.js";
import { ServedTreeTransport } from "./transport.js";
import { DirTreeIO } from "./tree-io.js";

/** Run a `git` subcommand in `cwd`; resolve stdout, reject on a non-zero exit. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** The default runner: `git <args>` via `child_process.execFile`. */
export function defaultGitRunner(): GitRunner {
  return async (args, cwd) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      const { stdout } = await run("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      throw new RemoteError("git", `\`git ${args.join(" ")}\` failed: ${(err as Error).message}`);
    }
  };
}

export interface GitTransportOptions {
  readonly descriptor: RemoteDescriptor;
  /** Where working clones live (defaults to `<instanceDir>/.anvil/remotes`). */
  readonly clonesDir: string;
  /** The git author identity used for push commits. */
  readonly author?: { name: string; email: string };
  readonly git?: GitRunner;
}

export class GitTransport implements RemoteTransport {
  readonly descriptor: RemoteDescriptor;
  readonly #clonesDir: string;
  readonly #git: GitRunner;
  readonly #author: { name: string; email: string };
  #served?: ServedTreeTransport;

  constructor(opts: GitTransportOptions) {
    this.descriptor = opts.descriptor;
    this.#clonesDir = opts.clonesDir;
    this.#git = opts.git ?? defaultGitRunner();
    this.#author = opts.author ?? { name: "anvil", email: "anvil@lobbify.games" };
  }

  readonly pushable = true;
  readonly hostsContent = false;

  #cloneDir(): string {
    return join(this.#clonesDir, this.descriptor.name);
  }

  /** Ensure a fresh working clone of the tracked branch, and return a served view. */
  async #ensure(ref?: string): Promise<ServedTreeTransport> {
    const branch = remoteBranch(this.descriptor, ref);
    const dir = this.#cloneDir();
    if (await pathExists(join(dir, ".git"))) {
      await this.#git(["fetch", "origin", branch], dir);
      await this.#git(["checkout", branch], dir).catch(() =>
        this.#git(["checkout", "-B", branch, `origin/${branch}`], dir),
      );
      await this.#git(["reset", "--hard", `origin/${branch}`], dir);
    } else {
      await this.#git(
        ["clone", "--depth", "1", "--branch", branch, this.descriptor.url, dir],
        this.#clonesDir,
      );
    }
    this.#served = new ServedTreeTransport(this.descriptor, new DirTreeIO(dir));
    return this.#served;
  }

  async fetchHead(ref?: string): Promise<RemoteHead> {
    return (await this.#ensure(ref)).fetchHead(ref);
  }

  async fetchVcObject(id: Hash): Promise<Uint8Array | undefined> {
    return (this.#served ?? (await this.#ensure())).fetchVcObject(id);
  }

  async fetchObject(_hash: Hash): Promise<Uint8Array | undefined> {
    // A git remote never hosts content objects — the joiner re-fetches from source.
    return undefined;
  }

  async publish(input: PublishInput): Promise<void> {
    const served = await this.#ensure(input.branch);
    // Write the two files + VC history into the clone (never content objects).
    await served.publish({ ...input, contentObjects: [] });
    const dir = this.#cloneDir();
    await this.#git(["add", "-A"], dir);
    await this.#git(
      [
        "-c",
        `user.name=${this.#author.name}`,
        "-c",
        `user.email=${this.#author.email}`,
        "commit",
        "--allow-empty",
        "-m",
        `anvil: publish ${input.branch}`,
      ],
      dir,
    );
    await this.#git(["push", "origin", `HEAD:${input.branch}`], dir);
  }
}
