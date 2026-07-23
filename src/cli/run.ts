/**
 * The CLI runner. Builds the clipanion `Cli`, registers the commands + builtins,
 * and runs them against a context. `runCli` is the single entry both the bin
 * (`src/cli/index.ts`) and the offline test harness call, so the exact same code
 * path is exercised in tests as in production — only the injected `makeAnvil`
 * factory (and the streams) differ.
 */

import type { Writable } from "node:stream";
import { Builtins, Cli } from "clipanion";
import { COMMANDS } from "./commands.js";
import type { AnvilCliContext } from "./context.js";
import { defaultMakeAnvil } from "./context.js";

/** The CLI version. Kept in sync with package.json "version". */
export const VERSION = "0.1.0";

/** Build the fully-registered CLI (commands + help/version builtins). */
export function buildCli(): Cli<AnvilCliContext> {
  const cli = new Cli<AnvilCliContext>({
    binaryLabel: "lobbify-anvil",
    binaryName: "lobbify-anvil",
    binaryVersion: VERSION,
  });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  for (const CommandClass of COMMANDS) {
    cli.register(CommandClass);
  }
  return cli;
}

/** Overrides for {@link runCli} — the streams, cwd/env, and the `Anvil` factory. */
export interface RunCliOverrides {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly makeAnvil?: AnvilCliContext["makeAnvil"];
}

/** Run the CLI over `argv`, returning the process exit code (never exits). */
export async function runCli(
  argv: readonly string[],
  overrides: RunCliOverrides = {},
): Promise<number> {
  const cli = buildCli();
  const context: AnvilCliContext = {
    stdin: process.stdin,
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    // clipanion drives its own help/usage coloring off this; our command output
    // never uses it. Monochrome when streams are captured (tests), else full.
    colorDepth: overrides.stdout ? 1 : 8,
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    makeAnvil: overrides.makeAnvil ?? defaultMakeAnvil,
  };
  return cli.run([...argv], context);
}
