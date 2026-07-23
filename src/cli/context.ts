/**
 * The CLI's clipanion context. It extends the base (stdin/stdout/stderr) with the
 * process `cwd` + `env` and a `makeAnvil` factory. Production passes
 * {@link defaultMakeAnvil}; tests inject a factory that constructs an
 * {@link Anvil} bound to offline fixtures — the seam that keeps the whole CLI
 * runnable hermetically without a public option for it.
 */

import type { BaseContext } from "clipanion";
import { Anvil } from "../anvil.js";
import type { AnvilOptions } from "../types/index.js";

export interface AnvilCliContext extends BaseContext {
  /** The working directory the CLI resolves instance paths against. */
  readonly cwd: string;
  /** The process environment (store dir, API keys, proxy). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Construct the `Anvil` a command operates through. */
  readonly makeAnvil: (options: AnvilOptions) => Anvil;
}

/** The production factory: a plain `Anvil` on the real network. */
export function defaultMakeAnvil(options: AnvilOptions): Anvil {
  return new Anvil(options);
}
