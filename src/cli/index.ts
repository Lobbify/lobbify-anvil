#!/usr/bin/env node
/**
 * The `lobbify-anvil` CLI bin — a thin skin over the `Anvil` library.
 *
 * NOTE: the bin is installed as `lobbify-anvil` (NOT bare `anvil`, which would
 * collide with Foundry's `anvil`). Users may add their own `anvil` alias.
 *
 * All command logic lives in `commands.ts` (parse → call one `Anvil` method →
 * render) and the library behind it. This file only bridges `process` to the
 * runner and maps the returned exit code onto the process.
 */

import { runCli } from "./run.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 70;
  });
