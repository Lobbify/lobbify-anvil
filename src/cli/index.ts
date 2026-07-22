#!/usr/bin/env node
/**
 * The `lobbify-anvil` CLI bin — a thin skin over the library.
 *
 * NOTE: the bin is installed as `lobbify-anvil` (NOT bare `anvil`, which would
 * collide with Foundry's `anvil`). Users may add their own `anvil` alias.
 *
 * Stage 0 ships a minimal stub with no command logic and no clipanion/ink
 * dependency — those land in Stage 4 (CLI) and Stage 8 (TUI). The real CLI will
 * remain logic-free: it only parses args and calls `Anvil` methods.
 */

// Kept in sync with package.json "version". Read from disk in a later stage.
const VERSION = "0.1.0";

function main(argv: readonly string[]): number {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`lobbify-anvil ${VERSION}\n`);
    return 0;
  }

  process.stderr.write(
    [
      `lobbify-anvil ${VERSION}`,
      "",
      "The CLI is not implemented yet — this is the Stage 0 scaffold.",
      "Library API:  import { Anvil } from '@lobbify/anvil'",
      "Roadmap:      see README.md (MVP = Stages 0–4).",
      "",
    ].join("\n"),
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
