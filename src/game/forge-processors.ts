/**
 * Forge/NeoForge installer **processors** — Stage 9's build-time execution model.
 *
 * A Forge/NeoForge installer produces its patched client jar by running *processors*
 * (JVM programs — the binpatcher, installertools, jarsplitter, the SRG renamer) at
 * build time. Running them is arbitrary code execution driven by the installer you
 * asked to build — exactly like `git` runs hooks, `npm install` runs lifecycle
 * scripts, `docker build` runs a Dockerfile, and Gradle runs build logic.
 *
 * anvil follows the same, honest **trust-the-source** model: `anvil build` runs the
 * processors of the installer it was told to build, **by default**, using the pinned
 * per-platform JRE. The standalone tool is deliberately NOT a sandbox against its own
 * inputs — **only build instances from sources you trust** (see SECURITY.md). An
 * embedder that builds from UNTRUSTED sources is responsible for confinement, and
 * anvil gives it the seams to do so:
 *
 *   - the host-policy hook {@link AllowProcessor} (`allowProcessor`, default: allow) —
 *     deny a processor and the build stops with a typed {@link ProcessorRefused}
 *     before it runs;
 *   - the injectable {@link ProcessorRunner} seam — supply a runner that wraps the JVM
 *     in a real OS sandbox instead of the default {@link JvmProcessorRunner}, which
 *     just launches the pinned `java`.
 *
 * The sha256 pins on every processor jar / library / classpath dep are kept purely
 * for **reproducibility** (pin what you fetch so a rebuild is byte-identical) — they
 * are a determinism pin, NOT a trust gate. A processor's working directory is scoped
 * to the build scratch dir as ordinary **path hygiene** (so a normal build does not
 * scatter files), not as a security boundary.
 */

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { JreUnavailable, ProcessorRefused, ShaMismatch } from "../types/errors.js";
import type { AllowProcessor, Hash } from "../types/index.js";

// --- host policy + reproducibility pin -------------------------------------

/**
 * The default host-policy hook: **trust the source you build**. A standalone
 * `anvil build` allows every processor of the installer it was told to build. An
 * embedder integrating anvil to build from untrusted sources supplies its own
 * `allowProcessor` (or a restricting {@link ProcessorRunner}) instead.
 */
export const allowAllProcessors: AllowProcessor = () => true;

export interface ProcessorCheckInput {
  /** The processor jar's maven coordinate. */
  readonly coordinate: string;
  /** The maven host the jar was resolved from (provenance shown to the host hook). */
  readonly repo?: string;
  /** The processor jar's sha256 pin — a REPRODUCIBILITY pin, not a trust gate. */
  readonly pin: Hash;
  /**
   * The sha256 actually computed from the bytes about to run. When given and it
   * differs from `pin`, the build is not the reproducible one the lock describes —
   * a {@link ShaMismatch}. (The content-addressed store already guarantees this; the
   * check is a cheap, explicit determinism assertion.)
   */
  readonly actual?: Hash;
  /** Host-app policy hook (default {@link allowAllProcessors}). Deny → not run. */
  readonly consent: AllowProcessor;
}

/**
 * Decide whether a processor may run under the honest trust-the-source model.
 *
 * There is no built-in trust boundary here: the standalone tool runs the processors
 * of the installer you chose to build. Two things are checked, neither of which is a
 * security verdict anvil pretends to enforce against a malicious input:
 *
 *   1. **Reproducibility.** The jar must be sha256-pinned (so a rebuild fetches
 *      byte-identical bytes); a mismatch between the pin and the bytes about to run
 *      is a {@link ShaMismatch}.
 *   2. **Host policy.** The embedder's `allowProcessor` hook may deny a processor;
 *      it **defaults to allow** (trust the source). A deny is a {@link ProcessorRefused}.
 */
export function checkProcessorAllowed(input: ProcessorCheckInput): void {
  const { coordinate, repo, pin, actual, consent } = input;
  // (1) Reproducibility pin: an unpinned processor cannot be run deterministically.
  //     This is NOT a trust decision — see SECURITY.md.
  if (pin.algo !== "sha256" || !/^[0-9a-f]{64}$/.test(pin.value)) {
    throw new ProcessorRefused(
      coordinate,
      "processor jar is not sha256-pinned — a reproducibility pin is required to run it deterministically",
    );
  }
  // (2) The bytes about to run must match the pin (determinism/integrity).
  if (actual !== undefined && (actual.algo !== pin.algo || actual.value !== pin.value)) {
    throw new ShaMismatch(`installer processor ${coordinate}`, pin, actual);
  }
  // (3) Host policy — default allow (trust the source). An embedder may deny.
  const allowed = consent({ coordinate, sha256: pin.value, ...(repo ? { repo } : {}) });
  if (!allowed) {
    throw new ProcessorRefused(coordinate, "the host app's allowProcessor() policy denied it");
  }
}

// --- the JVM exec spec -----------------------------------------------------

/**
 * Practical limits a processor runs under. These are **build ergonomics** (don't hang
 * the build forever; cap the heap so a tool doesn't OOM the machine) — not a security
 * control.
 */
export interface ProcessorLimits {
  /** Wall-clock kill timeout (ms). */
  readonly timeoutMs: number;
  /** JVM heap cap (`-Xmx<n>m`). */
  readonly maxMemoryMb: number;
}

/** Conservative defaults; a build may tighten them. */
export const DEFAULT_PROCESSOR_LIMITS: ProcessorLimits = {
  timeoutMs: 5 * 60_000,
  maxMemoryMb: 2048,
};

/**
 * A JVM launch request for one processor: the pinned java binary, the jar + classpath
 * deps (part of the trusted source), the resolved args, and the scratch-scoped working
 * directory. Handed to a {@link ProcessorRunner}.
 */
export interface ProcessorExecSpec {
  /** Human id (the processor coordinate) for diagnostics. */
  readonly subject: string;
  /** The pinned per-platform JRE `java` binary — reused, NEVER an ambient `java`. */
  readonly javaBin: string;
  /** The processor jar. */
  readonly jar: string;
  /** The jar's declared `Main-Class` (extracted + pinned at lock time). */
  readonly mainClass: string;
  /** Classpath entries — the processor's trusted classpath deps. */
  readonly classpath: readonly string[];
  /** Program arguments — path tokens already resolved into the scratch dir. */
  readonly args: readonly string[];
  /** Working directory — scoped to the build scratch dir (path hygiene). */
  readonly cwd: string;
  /**
   * The environment handed to the JVM. Defaults to empty: a build tool that reads
   * ambient env would be non-deterministic, so anvil hands processors a minimal env
   * for **reproducibility**, not as a secrets-scrubbing security control.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
}

export interface BuildExecSpecInput {
  readonly subject: string;
  readonly javaBin: string;
  readonly jar: string;
  readonly mainClass: string;
  readonly classpath: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly limits?: ProcessorLimits;
  /** Extra env; defaults to an empty environment (reproducibility). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Assemble a {@link ProcessorExecSpec} for one processor. */
export function buildExecSpec(input: BuildExecSpecInput): ProcessorExecSpec {
  const limits = input.limits ?? DEFAULT_PROCESSOR_LIMITS;
  return {
    subject: input.subject,
    javaBin: input.javaBin,
    jar: input.jar,
    mainClass: input.mainClass,
    classpath: input.classpath,
    args: input.args,
    cwd: input.cwd,
    env: input.env ?? {},
    timeoutMs: limits.timeoutMs,
    maxMemoryMb: limits.maxMemoryMb,
  };
}

// --- the JVM boundary ------------------------------------------------------

export interface ProcessorRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The JVM launch seam. A processor runs by handing a {@link ProcessorExecSpec} to a
 * runner. The standalone tool uses {@link JvmProcessorRunner} (a plain launcher);
 * tests inject a fake that records the spec and simulates the output; **an embedder
 * building from untrusted sources injects a runner that wraps the JVM in a real OS
 * sandbox** — that is where confinement belongs under the trust-the-source model.
 */
export interface ProcessorRunner {
  run(spec: ProcessorExecSpec): Promise<ProcessorRunResult>;
}

export interface JvmProcessorRunnerOptions {
  /** Injected process spawner (undefined → node:child_process). Test seam. */
  readonly spawn?: ProcessorSpawn;
  /** Injected existence probe for the java binary. Test seam. */
  readonly exists?: (path: string) => boolean;
}

/** The minimal spawn surface the runner needs (node:child_process satisfies it). */
export type ProcessorSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeout: number;
  },
) => Promise<ProcessorRunResult>;

/**
 * The default processor runner: it launches the pinned `java` with the processor's
 * jar + classpath, main class, and resolved args, in the scratch working dir, with a
 * heap cap and a kill timeout. It does **not** confine the process — under the
 * trust-the-source model that is correct for a standalone build, and an embedder that
 * needs confinement supplies its own {@link ProcessorRunner}. The one thing it refuses
 * is an ambient `java`: the JVM is always the build's pinned per-platform JRE.
 */
export class JvmProcessorRunner implements ProcessorRunner {
  readonly #spawn: ProcessorSpawn;
  readonly #exists: (path: string) => boolean;

  constructor(options: JvmProcessorRunnerOptions = {}) {
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#exists = options.exists ?? defaultExists;
  }

  async run(spec: ProcessorExecSpec): Promise<ProcessorRunResult> {
    if (!this.#exists(spec.javaBin)) {
      throw new JreUnavailable(`the pinned java binary "${spec.javaBin}" is not present`);
    }
    const cp = [spec.jar, ...spec.classpath].join(sep === "\\" ? ";" : ":");
    const javaArgs = [
      `-Xmx${spec.maxMemoryMb}m`,
      "-Djava.awt.headless=true",
      "-cp",
      cp,
      spec.mainClass,
      ...spec.args,
    ];
    return this.#spawn(spec.javaBin, javaArgs, {
      cwd: spec.cwd,
      env: spec.env,
      timeout: spec.timeoutMs,
    });
  }
}

/** Default existence probe (real filesystem). */
function defaultExists(path: string): boolean {
  return existsSync(path);
}

/** Default spawner over node:child_process, enforcing the kill timeout. */
const defaultSpawn: ProcessorSpawn = async (command, args, options) => {
  const { spawn } = await import("node:child_process");
  return new Promise<ProcessorRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      timeout: options.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
};
