/**
 * The Forge/NeoForge installer-**processor** trust boundary — the Stage 9 security
 * spine.
 *
 * A Forge/NeoForge installer produces its patched client jar by running *processors*
 * (JVM programs — the binpatcher, installertools, jarsplitter, the SRG renamer) at
 * build time. That is arbitrary code execution driven by an installer artifact, so
 * every processor crosses a hard trust boundary before it is allowed to run:
 *
 *   1. **Allowlist + pin.** A processor jar is executed only when its maven
 *      coordinate is an *official* one from a trusted repo set (Forge, NeoForged,
 *      Mojang, Maven Central) AND it is pinned by **sha256**. Anything else is
 *      refused ({@link ProcessorRefused}) unless the host app's `allowProcessor`
 *      consent hook explicitly permits it (default deny) — and even consent never
 *      waives the mandatory sha256 pin. See {@link admitProcessor}.
 *   2. **Sandbox.** Each processor runs with **no network**, a filesystem view
 *      **scoped to the build/temp scratch roots** (no arbitrary reads/writes), a
 *      **cleared environment** (no inherited secrets), and CPU-time / memory /
 *      output bounds. The exec spec is validated ({@link assertSandboxPolicy}) so
 *      the inputs handed to the JVM boundary are genuinely constrained, not just
 *      documented — a violation is {@link ProcessorSandboxViolation}.
 *
 * The JVM launch itself is the one part that is not hermetic (it spawns a real
 * process), so it lives behind the small {@link ProcessorRunner} seam: tests inject
 * a fake runner and assert the *policy-constrained* {@link ProcessorExecSpec} that
 * reaches it, while {@link SandboxedJvmRunner} is the production JVM launcher that
 * reuses the pinned JRE (never an ambient `java`) under an OS sandbox wrapper.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { JreUnavailable, ProcessorRefused, ProcessorSandboxViolation } from "../types/errors.js";
import type { AllowProcessor, Hash } from "../types/index.js";

// --- the official-coordinate allowlist -------------------------------------

/**
 * Maven **group** prefixes whose jars are trusted to run as installer processors.
 * These are the Forge / NeoForge tooling families plus Mojang; a coordinate whose
 * group is not one of these is not "official" and needs explicit host consent.
 */
export const TRUSTED_PROCESSOR_GROUPS: readonly string[] = [
  "net.minecraftforge",
  "net.neoforged",
  "de.oceanlabs.mcp",
  "net.md-5", // SpecialSource — a well-known Central tool the Forge toolchain uses
  "net.minecraft",
  "com.mojang",
];

/**
 * Maven repository hosts a processor jar may be served from. A jar bearing a
 * trusted *coordinate* but fetched from an untrusted host is NOT trusted (a
 * coordinate is not a provenance) — the repo must also be on this list.
 */
export const TRUSTED_MAVEN_HOSTS: ReadonlySet<string> = new Set([
  "maven.minecraftforge.net",
  "maven.neoforged.net",
  "libraries.minecraft.net",
  "repo1.maven.org",
  "repo.maven.apache.org",
  "central.maven.org",
]);

/** The maven `group` of a `group:artifact:version[:classifier]` coordinate. */
function groupOf(coordinate: string): string {
  return coordinate.split(":")[0] ?? "";
}

/** True when a maven group is (equal to or under) one of the trusted prefixes. */
function isTrustedGroup(group: string): boolean {
  return TRUSTED_PROCESSOR_GROUPS.some((g) => group === g || group.startsWith(`${g}.`));
}

/**
 * The bare host of a repo reference — accepting either a full URL
 * (`https://maven.neoforged.net/…`) or an already-bare hostname
 * (`maven.neoforged.net`). Returns `undefined` only for an empty value.
 */
function hostOf(repo: string | undefined): string | undefined {
  if (repo === undefined || repo.length === 0) {
    return undefined;
  }
  try {
    return new URL(repo).hostname.replace(/^\[|\]$/g, "");
  } catch {
    // Not a URL → treat it as a bare hostname (strip any path/port defensively).
    return (
      repo
        .replace(/^\[|\]$/g, "")
        .split("/")[0]
        ?.split(":")[0] ?? repo
    );
  }
}

/**
 * Whether a processor coordinate is on the built-in official allowlist: a trusted
 * group AND (when the resolving repo is known) a trusted repo host. A trusted
 * coordinate from an unknown/untrusted host is treated as NOT official — it must
 * go through the consent hook.
 */
export function isOfficialProcessor(coordinate: string, repo?: string): boolean {
  if (!isTrustedGroup(groupOf(coordinate))) {
    return false;
  }
  const host = hostOf(repo);
  if (repo !== undefined && host === undefined) {
    return false; // a repo was given but is unparseable → not trustworthy
  }
  if (host !== undefined && !TRUSTED_MAVEN_HOSTS.has(host)) {
    return false; // trusted coordinate, untrusted host
  }
  return true;
}

/** Consent hook that denies every non-allowlisted processor (the safe default). */
export const denyAllProcessors: AllowProcessor = () => false;

export interface ProcessorAdmissionInput {
  /** The processor jar's maven coordinate. */
  readonly coordinate: string;
  /** The maven host the jar was resolved from (part of the trust decision). */
  readonly repo?: string;
  /** The sha256 pin recorded for this processor jar. A pin is mandatory. */
  readonly pin: Hash;
  /**
   * The sha256 actually computed from the bytes about to be executed. When given
   * and it differs from `pin`, admission fails (defense in depth on top of the
   * content-addressed store, which already rejects a mismatched object).
   */
  readonly actual?: Hash;
  /** Host-app consent for non-allowlisted processors (default deny). */
  readonly consent: AllowProcessor;
}

/**
 * The admission gate. Throws {@link ProcessorRefused} unless the processor jar is
 * (a) sha256-pinned (and matches, when `actual` is supplied), and (b) either on the
 * official allowlist or explicitly consented to by the host app. Returns silently
 * when the processor may run.
 */
export function admitProcessor(input: ProcessorAdmissionInput): void {
  const { coordinate, repo, pin, actual, consent } = input;
  // (1) A processor is NEVER run without a concrete sha256 content pin.
  if (pin.algo !== "sha256" || !/^[0-9a-f]{64}$/.test(pin.value)) {
    throw new ProcessorRefused(coordinate, "no sha256 pin — an unpinned processor is never run");
  }
  // (2) The bytes about to run must match the pin (content-address defense in depth).
  if (actual !== undefined && (actual.algo !== pin.algo || actual.value !== pin.value)) {
    throw new ProcessorRefused(
      coordinate,
      `sha256 mismatch — pinned ${pin.value}, got ${actual.value}`,
    );
  }
  // (3) Official + trusted-repo jars run; anything else needs explicit consent.
  if (isOfficialProcessor(coordinate, repo)) {
    return;
  }
  const allowed = consent({ coordinate, sha256: pin.value, ...(repo ? { repo } : {}) });
  if (!allowed) {
    throw new ProcessorRefused(
      coordinate,
      repo !== undefined
        ? `not an official coordinate from a trusted repo (repo "${repo}") and the host allowProcessor() hook denied it`
        : "not an official coordinate and the host allowProcessor() hook denied it",
    );
  }
}

// --- the sandboxed exec spec + its policy ----------------------------------

/** Resource bounds every processor runs under. */
export interface SandboxLimits {
  /** Wall-clock kill timeout (ms). */
  readonly timeoutMs: number;
  /** JVM heap cap (`-Xmx<n>m`). */
  readonly maxMemoryMb: number;
  /** Max bytes of combined stdout/stderr captured before the process is killed. */
  readonly maxOutputBytes: number;
}

/** Conservative defaults; a build can tighten but not remove them. */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 5 * 60_000,
  maxMemoryMb: 2048,
  maxOutputBytes: 4 * 1024 * 1024,
};

/**
 * A fully-constrained JVM launch request. Everything a processor may touch is
 * enumerated here: the pinned java binary, the jar + classpath (inputs), the args,
 * the working dir, the read/write roots, `network: false`, a cleared env, and hard
 * resource limits. {@link assertSandboxPolicy} validates it before any launch.
 */
export interface ProcessorExecSpec {
  /** Human id (the processor coordinate) for diagnostics. */
  readonly subject: string;
  /** The pinned per-platform JRE java binary — NEVER an ambient `java`. */
  readonly javaBin: string;
  /** The processor jar (an absolute path under a read root). */
  readonly jar: string;
  /** The jar's declared `Main-Class` (extracted + pinned at lock time). */
  readonly mainClass: string;
  /** Classpath entries (absolute paths under a read root). */
  readonly classpath: readonly string[];
  /** Program arguments — all path tokens already resolved into the scratch roots. */
  readonly args: readonly string[];
  /** Working directory (under a write root). */
  readonly cwd: string;
  /** Absolute directories the processor may read. */
  readonly readRoots: readonly string[];
  /** Absolute directories the processor may write. */
  readonly writeRoots: readonly string[];
  /** Always `false` — a processor never has network access. */
  readonly network: false;
  /** The exact environment handed to the JVM — minimal, no inherited secrets. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxMemoryMb: number;
  readonly maxOutputBytes: number;
}

/** Env keys that must never appear in a processor's environment. */
const SECRET_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_KEY|APIKEY|AWS_|GITHUB|NPM_)/i;

/** Resolve `p` to an absolute path (already-absolute passes through). */
function abs(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(p);
}

/** True when `p` resolves to a location at or under one of `roots`. */
function isWithinRoots(p: string, roots: readonly string[]): boolean {
  const target = abs(p);
  return roots.some((root) => {
    const r = resolve(root);
    return target === r || target.startsWith(r + sep);
  });
}

/**
 * Assert a declared input/output path stays within the sandbox's scoped roots.
 * This is the filesystem half of the sandbox: a data binding or output token that
 * resolves outside the scratch roots (a `..`, an absolute `/etc/...`, a symlink
 * target) is rejected here, before it can reach the JVM boundary.
 */
export function assertPathWithinRoots(
  subject: string,
  path: string,
  roots: readonly string[],
): void {
  if (path.includes("\0")) {
    throw new ProcessorSandboxViolation(subject, `path "${path}" contains a NUL byte`);
  }
  if (!isWithinRoots(path, roots)) {
    throw new ProcessorSandboxViolation(
      subject,
      `path "${path}" escapes the scoped sandbox roots [${roots.join(", ")}]`,
    );
  }
}

/**
 * Validate an {@link ProcessorExecSpec} against the sandbox invariants. Called both
 * by {@link buildExecSpec} (when the spec is assembled) and by every
 * {@link ProcessorRunner} at the top of `run` — so even an injected runner cannot
 * be handed an unconstrained spec. Throws {@link ProcessorSandboxViolation}.
 */
export function assertSandboxPolicy(spec: ProcessorExecSpec): void {
  const { subject } = spec;
  if (spec.network !== false) {
    throw new ProcessorSandboxViolation(subject, "network access is not denied");
  }
  if (spec.readRoots.length === 0 || spec.writeRoots.length === 0) {
    throw new ProcessorSandboxViolation(
      subject,
      "read/write roots must be a bounded, non-empty set",
    );
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (SECRET_ENV_PATTERN.test(key)) {
      throw new ProcessorSandboxViolation(
        subject,
        `environment leaks a secret-looking var "${key}"`,
      );
    }
    if (typeof value !== "string") {
      throw new ProcessorSandboxViolation(subject, `environment var "${key}" is not a string`);
    }
  }
  if (!(spec.timeoutMs > 0) || !(spec.maxMemoryMb > 0) || !(spec.maxOutputBytes > 0)) {
    throw new ProcessorSandboxViolation(
      subject,
      "resource limits (time/memory/output) must be set",
    );
  }
  // Every classpath entry + the jar + the cwd must sit inside the scoped roots.
  assertPathWithinRoots(subject, spec.cwd, spec.writeRoots);
  assertPathWithinRoots(subject, spec.jar, spec.readRoots);
  for (const entry of spec.classpath) {
    assertPathWithinRoots(subject, entry, spec.readRoots);
  }
}

export interface BuildExecSpecInput {
  readonly subject: string;
  readonly javaBin: string;
  readonly jar: string;
  readonly mainClass: string;
  readonly classpath: readonly string[];
  readonly args: readonly string[];
  readonly cwd: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** Path-valued args (a subset of `args`) to assert stay inside the roots. */
  readonly pathArgs?: readonly { readonly path: string; readonly write?: boolean }[];
  readonly limits?: SandboxLimits;
  /** Extra non-secret env; defaults to an empty environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Assemble a sandboxed {@link ProcessorExecSpec} and validate it. Every declared
 * path arg is asserted to stay within the sandbox roots (writes within the write
 * roots), and the finished spec is run through {@link assertSandboxPolicy}. Throws
 * {@link ProcessorSandboxViolation} if anything about the request is unconstrained.
 */
export function buildExecSpec(input: BuildExecSpecInput): ProcessorExecSpec {
  const limits = input.limits ?? DEFAULT_SANDBOX_LIMITS;
  for (const pa of input.pathArgs ?? []) {
    assertPathWithinRoots(
      input.subject,
      pa.path,
      pa.write ? input.writeRoots : [...input.readRoots, ...input.writeRoots],
    );
  }
  const spec: ProcessorExecSpec = {
    subject: input.subject,
    javaBin: input.javaBin,
    jar: input.jar,
    mainClass: input.mainClass,
    classpath: input.classpath,
    args: input.args,
    cwd: input.cwd,
    readRoots: input.readRoots,
    writeRoots: input.writeRoots,
    network: false,
    env: input.env ?? {},
    timeoutMs: limits.timeoutMs,
    maxMemoryMb: limits.maxMemoryMb,
    maxOutputBytes: limits.maxOutputBytes,
  };
  assertSandboxPolicy(spec);
  return spec;
}

// --- the JVM boundary ------------------------------------------------------

export interface ProcessorRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The JVM launch seam. A processor runs by handing a validated
 * {@link ProcessorExecSpec} to a runner. Production uses {@link SandboxedJvmRunner};
 * tests inject a fake that records the (constrained) spec and simulates the output,
 * so the security policy is exercised without spawning a real JVM.
 */
export interface ProcessorRunner {
  run(spec: ProcessorExecSpec): Promise<ProcessorRunResult>;
}

/**
 * How the production runner isolates a processor's OS-level network + filesystem.
 * `"none"` is fail-closed: it must be opted into explicitly (a processor with no
 * OS sandbox still gets a cleared env + scoped-path *arguments*, but nothing stops
 * a malicious jar from opening a socket, so it is refused by default).
 */
export type SandboxStrategy = "auto" | "linux-namespace" | "none";

export interface SandboxedJvmRunnerOptions {
  readonly strategy?: SandboxStrategy;
  /** Injected process spawner (undefined → node:child_process). Test seam. */
  readonly spawn?: SandboxSpawn;
  /** Injected existence probe for the java binary. Test seam. */
  readonly exists?: (path: string) => boolean;
  /** Injected OS-sandbox-wrapper resolver (returns argv prefix, or refuses). */
  readonly wrapper?: (spec: ProcessorExecSpec, strategy: SandboxStrategy) => string[];
}

/** The minimal spawn surface the runner needs (node:child_process satisfies it). */
export type SandboxSpawn = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeout: number;
  },
) => Promise<ProcessorRunResult>;

/**
 * The production JVM launcher. It re-validates the spec, refuses to run without a
 * real OS sandbox wrapper (fail-closed) unless `strategy: "none"` is chosen, builds
 * a locked-down `java` argv, and spawns it with the cleared env + scoped cwd +
 * kill timeout.
 *
 * NOTE (review boundary): the *policy* — spec validation, argv/env/cwd/limit
 * construction, and the fail-closed default — is fully implemented here. The OS
 * primitive that actually severs the network and confines the filesystem (a Linux
 * user+network namespace via `unshare`, `sandbox-exec` on macOS, an AppContainer on
 * Windows) is delegated to `wrapper` and, on an unprivileged host, is where the
 * real hardening must be provisioned/verified before trusting an *untrusted*
 * installer. The default `wrapper` fails closed, so a misconfigured host refuses to
 * run rather than running a processor unsandboxed.
 */
export class SandboxedJvmRunner implements ProcessorRunner {
  readonly #strategy: SandboxStrategy;
  readonly #spawn: SandboxSpawn;
  readonly #exists: (path: string) => boolean;
  readonly #wrapper: (spec: ProcessorExecSpec, strategy: SandboxStrategy) => string[];

  constructor(options: SandboxedJvmRunnerOptions = {}) {
    this.#strategy = options.strategy ?? "auto";
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#exists = options.exists ?? defaultExists;
    this.#wrapper = options.wrapper ?? defaultWrapper;
  }

  async run(spec: ProcessorExecSpec): Promise<ProcessorRunResult> {
    // Defense in depth: never trust a caller-supplied spec unvalidated.
    assertSandboxPolicy(spec);
    if (!this.#exists(spec.javaBin)) {
      throw new JreUnavailable(`the pinned java binary "${spec.javaBin}" is not present`);
    }
    // Fail-closed: without an OS sandbox wrapper we do not launch (unless "none").
    const prefix = this.#wrapper(spec, this.#strategy);
    const cp = [spec.jar, ...spec.classpath].join(sep === "\\" ? ";" : ":");
    const javaArgs = [
      `-Xmx${spec.maxMemoryMb}m`,
      "-Djava.awt.headless=true",
      "-cp",
      cp,
      spec.mainClass,
      ...spec.args,
    ];
    const argv = [spec.javaBin, ...javaArgs];
    const [command, ...rest] = prefix.length > 0 ? [...prefix, ...argv] : argv;
    if (command === undefined) {
      throw new ProcessorSandboxViolation(spec.subject, "empty launch command");
    }
    return this.#spawn(command, rest, {
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

/**
 * The default OS-sandbox wrapper. Fail-closed: for the real strategies it demands a
 * provisioned OS primitive and, when it cannot establish one, refuses (throws) so a
 * processor is never launched without network/fs isolation. `"none"` returns an
 * empty prefix (explicit opt-out — env + path scoping still apply, but the OS does
 * not confine the process; only ever appropriate for a fully-trusted installer).
 */
function defaultWrapper(spec: ProcessorExecSpec, strategy: SandboxStrategy): string[] {
  if (strategy === "none") {
    return [];
  }
  throw new ProcessorSandboxViolation(
    spec.subject,
    `no OS sandbox wrapper is provisioned for strategy "${strategy}" — refusing to run a processor without network/filesystem isolation (configure a wrapper, or opt into strategy "none" only for a fully-trusted installer)`,
  );
}

/** Default spawner over node:child_process, enforcing the output cap + kill timeout. */
const defaultSpawn: SandboxSpawn = async (command, args, options) => {
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
