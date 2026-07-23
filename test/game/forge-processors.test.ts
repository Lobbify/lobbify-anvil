import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROCESSOR_LIMITS,
  JreUnavailable,
  JvmProcessorRunner,
  ProcessorRefused,
  ShaMismatch,
  allowAllProcessors,
  buildExecSpec,
  checkProcessorAllowed,
} from "../../index.js";
import type { AllowProcessor, Hash, ProcessorExecSpec } from "../../index.js";

const PIN: Hash = { algo: "sha256", value: "a".repeat(64) };
const denyAll: AllowProcessor = () => false;

// The honest trust-the-source model: a processor runs by default; the only gates are
// the host `allowProcessor` policy (default allow) and the sha256 reproducibility pin.
describe("checkProcessorAllowed — trust-the-source: run by default, host policy can deny", () => {
  it("allows a sha256-pinned processor by default (allowAllProcessors)", () => {
    expect(() =>
      checkProcessorAllowed({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        repo: "maven.neoforged.net",
        pin: PIN,
        actual: PIN,
        consent: allowAllProcessors,
      }),
    ).not.toThrow();
  });

  it("allows a THIRD-PARTY processor by default — no built-in allowlist", () => {
    // A non-Forge/NeoForge coordinate from an arbitrary host runs under the default
    // trust-the-source policy. There is no host-trust boundary to cross.
    expect(() =>
      checkProcessorAllowed({
        coordinate: "com.thirdparty:tool:1.0",
        repo: "https://repo.example",
        pin: PIN,
        actual: PIN,
        consent: allowAllProcessors,
      }),
    ).not.toThrow();
  });

  it("the host allowProcessor() policy can DENY a processor (typed ProcessorRefused)", () => {
    expect(() =>
      checkProcessorAllowed({
        coordinate: "com.thirdparty:tool:1.0",
        repo: "https://repo.example",
        pin: PIN,
        actual: PIN,
        consent: denyAll,
      }),
    ).toThrow(ProcessorRefused);
  });

  it("a host policy can allow some processors and deny others (the seam works)", () => {
    const onlyBinpatcher: AllowProcessor = (p) => p.coordinate.startsWith("net.neoforged");
    expect(() =>
      checkProcessorAllowed({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        pin: PIN,
        actual: PIN,
        consent: onlyBinpatcher,
      }),
    ).not.toThrow();
    expect(() =>
      checkProcessorAllowed({
        coordinate: "com.evil:pwn:1.0",
        pin: PIN,
        actual: PIN,
        consent: onlyBinpatcher,
      }),
    ).toThrow(ProcessorRefused);
  });

  it("REFUSES an unpinned (non-sha256) processor — reproducibility pin required", () => {
    expect(() =>
      checkProcessorAllowed({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        pin: { algo: "sha1", value: "c".repeat(40) },
        consent: allowAllProcessors,
      }),
    ).toThrow(/reproducibility pin/);
  });

  it("REFUSES on a sha256 pin mismatch — determinism, not trust (ShaMismatch)", () => {
    // The pinned bytes and the bytes about to run differ → the build is not the
    // reproducible one the lock describes. This is a determinism check, not a gate.
    expect(() =>
      checkProcessorAllowed({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        pin: PIN,
        actual: { algo: "sha256", value: "b".repeat(64) },
        consent: allowAllProcessors,
      }),
    ).toThrow(ShaMismatch);
  });
});

function goodSpec(overrides: Partial<ProcessorExecSpec> = {}): ProcessorExecSpec {
  return {
    subject: "net.neoforged.installertools:binarypatcher:2.1.7",
    javaBin: "/scratch/jre/bin/java",
    jar: "/scratch/libs/proc.jar",
    mainClass: "com.example.Tool",
    classpath: ["/scratch/libs/dep.jar"],
    args: ["--input", "/scratch/minecraft.jar"],
    cwd: "/scratch/work",
    env: {},
    timeoutMs: DEFAULT_PROCESSOR_LIMITS.timeoutMs,
    maxMemoryMb: DEFAULT_PROCESSOR_LIMITS.maxMemoryMb,
    ...overrides,
  };
}

describe("buildExecSpec — assembles a scratch-scoped JVM launch request", () => {
  it("scopes the working dir and defaults to an empty env (reproducibility)", () => {
    const spec = buildExecSpec({
      subject: "s",
      javaBin: "/scratch/jre/bin/java",
      jar: "/scratch/libs/p.jar",
      mainClass: "M",
      classpath: ["/scratch/libs/dep.jar"],
      args: ["--output", "/scratch/out/x.jar"],
      cwd: "/scratch/work",
    });
    expect(spec.cwd).toBe("/scratch/work");
    expect(spec.env).toEqual({});
    expect(spec.classpath).toEqual(["/scratch/libs/dep.jar"]);
    expect(spec.timeoutMs).toBe(DEFAULT_PROCESSOR_LIMITS.timeoutMs);
    expect(spec.maxMemoryMb).toBe(DEFAULT_PROCESSOR_LIMITS.maxMemoryMb);
  });
});

describe("JvmProcessorRunner — launches the pinned java (no confinement)", () => {
  it("throws JreUnavailable when the pinned java binary is absent (never an ambient java)", async () => {
    const runner = new JvmProcessorRunner({ exists: () => false });
    await expect(runner.run(goodSpec())).rejects.toThrow(JreUnavailable);
  });

  it("launches the pinned java with the jar+classpath, main class, heap cap, and scoped cwd/env", async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: Record<string, string>;
    }[] = [];
    const runner = new JvmProcessorRunner({
      exists: () => true,
      spawn: async (command, args, opts) => {
        calls.push({ command, args, cwd: opts.cwd, env: { ...opts.env } });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const res = await runner.run(goodSpec());
    expect(res.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.command).toBe("/scratch/jre/bin/java"); // the pinned java, never ambient
    expect(call?.args).toContain("com.example.Tool"); // the main class
    // The classpath carries the jar AND its trusted classpath deps.
    const cpIndex = (call?.args ?? []).indexOf("-cp");
    expect(cpIndex).toBeGreaterThanOrEqual(0);
    const cp = call?.args[cpIndex + 1] ?? "";
    expect(cp).toContain("/scratch/libs/proc.jar");
    expect(cp).toContain("/scratch/libs/dep.jar");
    expect(call?.args.some((a) => a.startsWith("-Xmx"))).toBe(true); // heap cap
    expect(call?.cwd).toBe("/scratch/work"); // scratch-scoped cwd
    expect(call?.env).toEqual({}); // minimal env for reproducibility
  });
});
