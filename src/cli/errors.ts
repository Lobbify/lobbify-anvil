/**
 * The CLI error surface: a stable, documented exit-code table + an actionable
 * human renderer.
 *
 * Every {@link AnvilError} code maps to a fixed exit code so scripts and CI can
 * branch on failures, and to a one-line hint telling the user how to fix it. The
 * library throws typed errors; this module is the sole place the CLI turns them
 * into a message + an exit status. Keep the table append-only — a shipped exit
 * code is an API.
 */

import { AnvilError } from "../types/errors.js";

/** Success. */
export const EXIT_OK = 0;
/** A generic / unknown `AnvilError`, or a usage error. */
export const EXIT_ERROR = 1;
/** An unexpected non-`AnvilError` (a bug) — mirrors sysexits `EX_SOFTWARE`. */
export const EXIT_INTERNAL = 70;

/**
 * Stable exit codes per error taxonomy code. Documented in README.md and part of
 * the CLI's scripting contract — only ever append, never renumber.
 */
export const EXIT_CODES: Readonly<Record<string, number>> = {
  MANIFEST_INVALID: 3,
  LOCK_INVALID: 4,
  SOURCE_NOT_ALLOWED: 5,
  SOURCE_KEY_MISSING: 6,
  SSRF_BLOCKED: 7,
  CONFLICT: 8,
  UNSATISFIABLE_TARGET: 9,
  SHA_MISMATCH: 10,
  MISSING_OBJECT: 11,
  PATH_ESCAPE: 12,
  DECOMPRESSION_BOMB: 13,
  HTTP_ERROR: 14,
  CROSS_VOLUME: 15,
  PREFLIGHT_FAILED: 16,
  SWAP_RECOVERY_FAILED: 17,
  NON_FAST_FORWARD: 18,
  KIND_INFERENCE_FAILED: 19,
  NOT_IMPLEMENTED: 20,
  REMOTE_NOT_FOUND: 21,
  REMOTE_ERROR: 22,
  PUSH_NOT_SUPPORTED: 23,
  VC_STATE: 24,
  NO_COMPATIBLE_VERSION: 25,
  LOCK_BUSY: 26,
  LOCK_MISSING: 27,
  NETWORK_ERROR: 28,
};

/** An actionable hint per error code — what the user should do next. */
const HINTS: Readonly<Record<string, string>> = {
  MANIFEST_INVALID: "check anvil.toml — the [project]/[game] tables and each item reference.",
  LOCK_INVALID: "the anvil.lock is malformed or an unsupported version — re-run `anvil lock`.",
  SOURCE_NOT_ALLOWED: "this source is vetoed by the host policy; allow it or remove the item.",
  SOURCE_KEY_MISSING:
    "set the source's API key env var (CurseForge: CURSEFORGE_API_KEY) and retry.",
  SSRF_BLOCKED: "the URL resolves to an internal/metadata address; use a public https URL.",
  CONFLICT: "two items demand incompatible versions — pin one, or drop/`lock --upgrade` it.",
  UNSATISFIABLE_TARGET:
    "no artifact matches — check the version/loader/platform, or pin explicitly.",
  SHA_MISMATCH:
    "the downloaded bytes don't match the pin — re-run, or re-`lock` if upstream moved.",
  MISSING_OBJECT:
    "an object is absent from the store; run `anvil build` online (drop `--offline`).",
  PATH_ESCAPE: "an archive/placement path escaped the instance root — the input is unsafe.",
  DECOMPRESSION_BOMB: "the archive exceeds anvil's entry/size bounds — it is likely malicious.",
  HTTP_ERROR: "a network request failed — check connectivity, the URL, or any HTTP(S)_PROXY.",
  CROSS_VOLUME: "the store and instance are on different volumes; co-locate them or set storeDir.",
  PREFLIGHT_FAILED: "a build precondition failed (e.g. free disk space) — resolve it and retry.",
  SWAP_RECOVERY_FAILED: "the swap journal could not be reconciled — inspect `.anvil/` and re-run.",
  NON_FAST_FORWARD: "local history diverged; your commits are preserved on a local/ branch.",
  KIND_INFERENCE_FAILED: "anvil can't tell the item's kind — set an explicit `kind` for it.",
  NOT_IMPLEMENTED: "this capability lands in a later stage — see the roadmap in README.md.",
  REMOTE_NOT_FOUND: "no such remote — add one with `anvil remote add <name> <url>`.",
  REMOTE_ERROR: "the remote could not be reached or is not an anvil instance — check the URL.",
  PUSH_NOT_SUPPORTED: "this remote is read-only — push to a git remote or a writable directory.",
  VC_STATE: "a version-control operation is in an unexpected state — check `anvil log`.",
  NO_COMPATIBLE_VERSION: "an item has no version compatible with the merged game — pin or drop it.",
  LOCK_BUSY: "another anvil process holds the instance/store lock — retry once it finishes.",
  LOCK_MISSING: "resolve the manifest first — run `anvil lock`, then retry.",
  NETWORK_ERROR:
    "the host could not be reached — check your connection, DNS, or any HTTP(S)_PROXY.",
};

/** The exit code for an error code (unknown codes fall back to {@link EXIT_ERROR}). */
export function exitCodeFor(code: string): number {
  return EXIT_CODES[code] ?? EXIT_ERROR;
}

/** A stream that accepts written strings — the CLI context's stdout/stderr. */
export interface WritableLike {
  write(chunk: string): void;
}

/**
 * Render an error to the appropriate stream and return its exit code. In `json`
 * mode a single `{ ok: false, error }` object goes to stdout; otherwise a plain
 * `error: …` (+ hint) goes to stderr.
 */
export function renderError(
  err: unknown,
  streams: { stdout: WritableLike; stderr: WritableLike },
  json: boolean,
): number {
  if (err instanceof AnvilError) {
    const exitCode = exitCodeFor(err.code);
    const hint = HINTS[err.code];
    if (json) {
      streams.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: { code: err.code, message: err.message, exitCode, ...(hint ? { hint } : {}) },
        })}\n`,
      );
    } else {
      streams.stderr.write(`error: ${err.message}\n`);
      if (hint) {
        streams.stderr.write(`  hint: ${hint}\n`);
      }
    }
    return exitCode;
  }
  // An unexpected error is a bug — surface it distinctly (never swallow it).
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    streams.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message, exitCode: EXIT_INTERNAL },
      })}\n`,
    );
  } else {
    streams.stderr.write(`error: unexpected failure: ${message}\n`);
    streams.stderr.write("  hint: this is a bug — please report it with the command you ran.\n");
  }
  return EXIT_INTERNAL;
}
