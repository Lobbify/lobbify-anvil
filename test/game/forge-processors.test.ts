import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_LIMITS,
  JreUnavailable,
  ProcessorRefused,
  ProcessorSandboxViolation,
  SandboxedJvmRunner,
  admitProcessor,
  assertPathWithinRoots,
  assertSandboxPolicy,
  buildExecSpec,
  denyAllProcessors,
  isOfficialProcessor,
} from "../../index.js";
import type { AllowProcessor, Hash, ProcessorExecSpec } from "../../index.js";

const PIN: Hash = { algo: "sha256", value: "a".repeat(64) };
const allowAll: AllowProcessor = () => true;

// The processor-admission gate is the RCE boundary; these are its guarantees.
describe("admitProcessor — the allowlist + sha256 pin (RCE gate)", () => {
  it("admits an official, trusted-host, sha256-pinned processor without consent", () => {
    expect(() =>
      admitProcessor({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        repo: "maven.neoforged.net",
        pin: PIN,
        actual: PIN,
        consent: denyAllProcessors,
      }),
    ).not.toThrow();
  });

  it("REFUSES a non-official coordinate under the default-deny consent", () => {
    expect(() =>
      admitProcessor({
        coordinate: "com.evil:pwn:1.0",
        repo: "https://evil.example",
        pin: PIN,
        actual: PIN,
        consent: denyAllProcessors,
      }),
    ).toThrow(ProcessorRefused);
  });

  it("REFUSES an official coordinate served from an UNTRUSTED host", () => {
    expect(() =>
      admitProcessor({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        repo: "https://evil.example/maven",
        pin: PIN,
        actual: PIN,
        consent: denyAllProcessors,
      }),
    ).toThrow(ProcessorRefused);
  });

  it("REFUSES on a sha256 mismatch even for an official coordinate", () => {
    expect(() =>
      admitProcessor({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        repo: "maven.neoforged.net",
        pin: PIN,
        actual: { algo: "sha256", value: "b".repeat(64) },
        consent: denyAllProcessors,
      }),
    ).toThrow(/sha256 mismatch/);
  });

  it("REFUSES an unpinned (non-sha256) processor — never runs unpinned", () => {
    expect(() =>
      admitProcessor({
        coordinate: "net.neoforged.installertools:binarypatcher:2.1.7",
        repo: "maven.neoforged.net",
        pin: { algo: "sha1", value: "c".repeat(40) },
        consent: allowAll,
      }),
    ).toThrow(/no sha256 pin/);
  });

  it("consent can admit a non-official processor — but a sha256 pin is still mandatory", () => {
    // consent allows the coordinate...
    expect(() =>
      admitProcessor({
        coordinate: "com.thirdparty:tool:1.0",
        repo: "https://repo.example",
        pin: PIN,
        actual: PIN,
        consent: allowAll,
      }),
    ).not.toThrow();
    // ...but consent never waives the pin requirement.
    expect(() =>
      admitProcessor({
        coordinate: "com.thirdparty:tool:1.0",
        pin: { algo: "sha1", value: "d".repeat(40) },
        consent: allowAll,
      }),
    ).toThrow(ProcessorRefused);
  });

  it("isOfficialProcessor: trusted group + trusted host only", () => {
    expect(
      isOfficialProcessor("net.minecraftforge:jarsplitter:1.0", "maven.minecraftforge.net"),
    ).toBe(true);
    expect(isOfficialProcessor("net.neoforged:AutoRenamingTool:2.0", "maven.neoforged.net")).toBe(
      true,
    );
    expect(isOfficialProcessor("com.evil:x:1", "maven.neoforged.net")).toBe(false);
    expect(isOfficialProcessor("net.neoforged:x:1", "https://evil.example")).toBe(false);
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
    readRoots: ["/scratch"],
    writeRoots: ["/scratch/out", "/scratch/work"],
    network: false,
    env: {},
    timeoutMs: DEFAULT_SANDBOX_LIMITS.timeoutMs,
    maxMemoryMb: DEFAULT_SANDBOX_LIMITS.maxMemoryMb,
    maxOutputBytes: DEFAULT_SANDBOX_LIMITS.maxOutputBytes,
    ...overrides,
  };
}

// The sandbox policy is enforced on the INPUTS to the JVM boundary, not documented.
describe("assertSandboxPolicy — the sandbox is a hard boundary", () => {
  it("accepts a fully-constrained spec", () => {
    expect(() => assertSandboxPolicy(goodSpec())).not.toThrow();
  });

  it("REFUSES a spec whose env leaks a secret-looking var", () => {
    expect(() => assertSandboxPolicy(goodSpec({ env: { AWS_SECRET_ACCESS_KEY: "x" } }))).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertSandboxPolicy(goodSpec({ env: { GITHUB_TOKEN: "x" } }))).toThrow(
      ProcessorSandboxViolation,
    );
  });

  it("REFUSES unbounded roots or missing resource limits", () => {
    expect(() => assertSandboxPolicy(goodSpec({ readRoots: [] }))).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertSandboxPolicy(goodSpec({ writeRoots: [] }))).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertSandboxPolicy(goodSpec({ timeoutMs: 0 }))).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertSandboxPolicy(goodSpec({ maxMemoryMb: 0 }))).toThrow(
      ProcessorSandboxViolation,
    );
  });

  it("REFUSES a classpath entry or jar outside the read roots", () => {
    expect(() => assertSandboxPolicy(goodSpec({ jar: "/etc/shadow" }))).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() =>
      assertSandboxPolicy(goodSpec({ classpath: ["/scratch/ok.jar", "/tmp/evil.jar"] })),
    ).toThrow(ProcessorSandboxViolation);
  });

  it("assertPathWithinRoots rejects a `..` escape and an absolute out-of-root path", () => {
    expect(() => assertPathWithinRoots("p", "/scratch/../etc/passwd", ["/scratch"])).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertPathWithinRoots("p", "/etc/passwd", ["/scratch"])).toThrow(
      ProcessorSandboxViolation,
    );
    expect(() => assertPathWithinRoots("p", "/scratch/out/x.jar", ["/scratch"])).not.toThrow();
  });
});

describe("buildExecSpec — constrains a processor's declared paths", () => {
  it("network is always false and the spec validates", () => {
    const spec = buildExecSpec({
      subject: "s",
      javaBin: "/scratch/jre/bin/java",
      jar: "/scratch/libs/p.jar",
      mainClass: "M",
      classpath: [],
      args: ["--output", "/scratch/out/x.jar"],
      cwd: "/scratch/work",
      readRoots: ["/scratch"],
      writeRoots: ["/scratch/out", "/scratch/work"],
      pathArgs: [{ path: "/scratch/out/x.jar", write: true }],
    });
    expect(spec.network).toBe(false);
    expect(spec.env).toEqual({});
  });

  it("REFUSES a declared path arg that escapes the sandbox roots", () => {
    expect(() =>
      buildExecSpec({
        subject: "s",
        javaBin: "/scratch/jre/bin/java",
        jar: "/scratch/libs/p.jar",
        mainClass: "M",
        classpath: [],
        args: ["--output", "/etc/cron.d/pwn"],
        cwd: "/scratch/work",
        readRoots: ["/scratch"],
        writeRoots: ["/scratch/out", "/scratch/work"],
        pathArgs: [{ path: "/etc/cron.d/pwn", write: true }],
      }),
    ).toThrow(ProcessorSandboxViolation);
  });

  it("REFUSES a read path arg written outside the write roots is caught as write-escape", () => {
    expect(() =>
      buildExecSpec({
        subject: "s",
        javaBin: "/scratch/jre/bin/java",
        jar: "/scratch/libs/p.jar",
        mainClass: "M",
        classpath: [],
        args: ["--output", "/scratch/libs/notwritable.jar"],
        cwd: "/scratch/work",
        readRoots: ["/scratch"],
        writeRoots: ["/scratch/out"],
        pathArgs: [{ path: "/scratch/libs/notwritable.jar", write: true }],
      }),
    ).toThrow(ProcessorSandboxViolation);
  });
});

describe("SandboxedJvmRunner — fail-closed production launcher", () => {
  it("re-validates the spec and refuses an unconstrained one (defense in depth)", async () => {
    const runner = new SandboxedJvmRunner({ strategy: "none", exists: () => true });
    await expect(runner.run(goodSpec({ env: { SOME_TOKEN: "leak" } }))).rejects.toThrow(
      ProcessorSandboxViolation,
    );
  });

  it("throws JreUnavailable when the pinned java binary is absent (never an ambient java)", async () => {
    const runner = new SandboxedJvmRunner({ strategy: "none", exists: () => false });
    await expect(runner.run(goodSpec())).rejects.toThrow(JreUnavailable);
  });

  it("REFUSES to launch without an OS sandbox wrapper (fail-closed default)", async () => {
    // strategy "auto"/"linux-namespace" with the default wrapper cannot provision an
    // OS sandbox here → it refuses rather than running a processor unsandboxed.
    const runner = new SandboxedJvmRunner({ strategy: "linux-namespace", exists: () => true });
    await expect(runner.run(goodSpec())).rejects.toThrow(ProcessorSandboxViolation);
  });

  it('with strategy "none" + an injected spawner, launches the pinned java with a scoped argv/env', async () => {
    const calls: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: Record<string, string>;
    }[] = [];
    const runner = new SandboxedJvmRunner({
      strategy: "none",
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
    expect(call?.args.some((a) => a.startsWith("-Xmx"))).toBe(true); // heap cap
    expect(call?.cwd).toBe("/scratch/work"); // scoped cwd
    expect(call?.env).toEqual({}); // no inherited env
  });
});
