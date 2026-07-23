/**
 * Terminal capability detection — the single decision point for whether the TUI
 * renders the **interactive Ink app** (colorful, live) or the **plain fallback**
 * (no ANSI, pipe/CI-safe). Everything is injectable so tests are deterministic:
 * pass an explicit `env` + stream `isTTY` flags rather than reading `process`.
 *
 * The rule the plan mandates: fall back to plain rendering when `!isTTY` or
 * `NO_COLOR` is set (CI + pipes still work), and never emit ANSI in that mode.
 */

/** The minimal stream shape the detector inspects (a `tty.WriteStream` subset). */
export interface StreamLike {
  readonly isTTY?: boolean;
}

/** What the terminal can do — the branch inputs for the whole TUI. */
export interface Capabilities {
  /** ANSI color is permitted (a TTY without `NO_COLOR`, or forced). */
  readonly color: boolean;
  /** Box-drawing / block glyphs are safe (else fall back to ASCII). */
  readonly unicode: boolean;
  /** Mount the interactive Ink app (a real TTY on both stdin + stdout, not CI). */
  readonly interactive: boolean;
}

export interface DetectOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdout?: StreamLike;
  readonly stdin?: StreamLike;
  readonly platform?: NodeJS.Platform;
}

/** The env var, if present, forces color on (`FORCE_COLOR!=0`) or off (`=0`). */
function forceColor(env: Readonly<Record<string, string | undefined>>): boolean | undefined {
  const raw = env.FORCE_COLOR;
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return true;
}

/**
 * `NO_COLOR` disables color when present and **non-empty**, per the no-color.org
 * spec ("regardless of its value"). An empty string is treated as unset.
 */
function noColor(env: Readonly<Record<string, string | undefined>>): boolean {
  return typeof env.NO_COLOR === "string" && env.NO_COLOR !== "";
}

/** A conservative CI probe — any of the common CI markers forces the plain path. */
function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.CI || env.CONTINUOUS_INTEGRATION || env.BUILD_NUMBER || env.GITHUB_ACTIONS);
}

/**
 * Compute the terminal capabilities. `NO_COLOR` and a non-TTY stdout both force
 * the plain, no-ANSI path; `FORCE_COLOR` can override the TTY check for color but
 * never fakes interactivity (Ink still needs a real stdin TTY for key input).
 */
export function detectCapabilities(opts: DetectOptions = {}): Capabilities {
  const env = opts.env ?? {};
  const stdout = opts.stdout ?? {};
  const stdin = opts.stdin ?? {};
  const platform = opts.platform ?? "linux";

  const stdoutTty = stdout.isTTY === true;
  const stdinTty = stdin.isTTY === true;
  const forced = forceColor(env);
  const disabled = noColor(env) || forced === false;

  const color = !disabled && (forced === true || stdoutTty);
  // A single deliberately-off signal (ANVIL_ASCII / TERM=dumb) drops to ASCII.
  const unicode =
    !env.ANVIL_ASCII &&
    env.TERM !== "dumb" &&
    !(platform === "win32" && env.WT_SESSION === undefined && env.TERM_PROGRAM === undefined);
  // Interactive requires real TTYs on BOTH ends, color allowed, and not CI.
  const interactive = stdoutTty && stdinTty && !disabled && !isCi(env);

  return { color, unicode, interactive };
}
