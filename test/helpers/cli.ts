/**
 * The offline CLI harness. It runs the *real* `runCli` end to end, but injects an
 * {@link AnvilEnv} bound to the hermetic game fixtures + fake Modrinth/URL HTTP,
 * and captures stdout/stderr — so `init → add → lock → build → verify` (and
 * `import`) exercise the whole CLI → Anvil path without touching the network.
 */

import { Writable } from "node:stream";
import { Anvil } from "../../index.js";
import type { AnvilEnv } from "../../index.js";
import { runCli } from "../../src/cli/run.js";
import { loaderMetaBase, makeGameFixtures, mojangOptions, resourcesBase } from "./game.js";
import { FakeBytes, FakeModrinth, registryWith } from "./net.js";

function collect(sink: string[]): Writable {
  return new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      sink.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      cb();
    },
  });
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OfflineCli {
  readonly modrinth: FakeModrinth;
  readonly urlBytes: FakeBytes;
  readonly env: AnvilEnv;
  run(
    argv: readonly string[],
    over?: { env?: Record<string, string | undefined> },
  ): Promise<RunResult>;
}

/** Build an offline CLI bound to `cwd` (the instance) + `storeDir` (the store). */
export function makeOfflineCli(opts: { cwd: string; storeDir: string }): OfflineCli {
  const modrinth = new FakeModrinth();
  const urlBytes = new FakeBytes();
  const game = makeGameFixtures();
  const env: AnvilEnv = {
    registry: () => registryWith({ modrinth, url: urlBytes }),
    gameHttp: () => game.http,
    mojangOptions,
    loaderMetaBase,
    resourcesBase,
  };
  const run = async (
    argv: readonly string[],
    over: { env?: Record<string, string | undefined> } = {},
  ): Promise<RunResult> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      cwd: opts.cwd,
      env: { ANVIL_STORE_DIR: opts.storeDir, ...over.env },
      stdout: collect(out),
      stderr: collect(err),
      makeAnvil: (options) => new Anvil(options, env),
    });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };
  return { modrinth, urlBytes, env, run };
}
