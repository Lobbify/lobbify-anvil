/**
 * The build-time half of Stage 9: replay a pinned {@link ForgePlan} under the
 * processor sandbox to produce a launch-ready Forge/NeoForge instance.
 *
 * Every input the plan names is materialized out of the content store into a
 * per-build **scratch** tree (the vanilla client jar, the installer's embedded
 * `/data/*` files, and each library/processor jar). Then, for each processor in
 * order: the jar is **admitted** (official coordinate + sha256 pin, else host
 * consent — default deny), its args' path tokens are resolved into the scratch
 * roots (a token that escapes is refused), a fully-constrained
 * {@link ProcessorExecSpec} is built and handed to the injected
 * {@link ProcessorRunner}. Nothing runs with network access, an unscoped
 * filesystem, or inherited env — the sandbox policy is enforced on the inputs, not
 * merely documented. The produced outputs are copied into the stage under the same
 * instance-relative paths the plan declared (so the atomic swap installs them).
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Platform } from "../build/preflight.js";
import type { AnvilEvent } from "../events.js";
import { readZipEntry } from "../import/zip-read.js";
import { ensureDir, pathExists, safeJoin } from "../internal/fs.js";
import { hashFile } from "../store/hash.js";
import type { ContentStore } from "../store/store.js";
import { ProcessorFailed, ProcessorSandboxViolation } from "../types/errors.js";
import type { AllowProcessor } from "../types/index.js";
import { type ForgeBinding, type ForgePlan, coordOfToken, isCoordToken } from "./forge-install.js";
import {
  type ProcessorRunner,
  type SandboxLimits,
  admitProcessor,
  buildExecSpec,
} from "./forge-processors.js";

export interface RunForgeProcessorsInput {
  readonly plan: ForgePlan;
  readonly store: ContentStore;
  /** Per-build scratch dir (same volume as the instance; cleaned up by the caller). */
  readonly scratchDir: string;
  /** The stage root produced outputs are written under (via `safeJoin`). */
  readonly stageRoot: string;
  readonly platform: Platform;
  readonly runner: ProcessorRunner;
  /** Host-app consent for non-allowlisted processors (default deny). */
  readonly consent: AllowProcessor;
  /**
   * The pinned JRE `java` binary. When omitted, best-effort located under
   * `runtime/<component>/<platform>/bin/java` in the stage/instance; the runner
   * enforces its existence (a missing java is a typed `JreUnavailable`).
   */
  readonly javaBin?: string;
  /** Where the instance lives (to locate an already-materialized JRE). */
  readonly instanceDir?: string;
  readonly limits?: SandboxLimits;
  readonly emit?: (event: AnvilEvent) => void;
}

/** Map the host platform to a Mojang java-runtime platform key candidate list. */
function jreKeyCandidates(platform: Platform): string[] {
  if (platform.os === "linux") {
    return platform.arch === "ia32" ? ["linux-i386", "linux"] : ["linux"];
  }
  if (platform.os === "osx") {
    return platform.arch === "arm64" ? ["mac-os-arm64", "mac-os"] : ["mac-os"];
  }
  if (platform.arch === "arm64") {
    return ["windows-arm64", "windows-x64"];
  }
  if (platform.arch === "ia32") {
    return ["windows-x86", "windows-x64"];
  }
  return ["windows-x64"];
}

/** Best-effort locate the staged pinned java binary; a sentinel when not found. */
async function resolveJavaBin(input: RunForgeProcessorsInput): Promise<string> {
  if (input.javaBin) {
    return input.javaBin;
  }
  const exe = input.platform.os === "windows" ? "bin/java.exe" : "bin/java";
  const roots = [input.stageRoot, ...(input.instanceDir ? [input.instanceDir] : [])];
  for (const root of roots) {
    for (const key of jreKeyCandidates(input.platform)) {
      const candidate = join(root, "runtime", input.plan.jreComponent, key, exe);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }
  // A sentinel path the real runner will reject with JreUnavailable; the fake
  // runner ignores it. Never falls back to an ambient `java`.
  return join(input.scratchDir, ".no-pinned-jre");
}

/**
 * Replay the plan under the sandbox. Returns the instance-relative paths produced
 * (== the plan's declared outputs), materialized into the stage.
 */
export async function runForgeProcessors(input: RunForgeProcessorsInput): Promise<string[]> {
  const { plan, store, scratchDir, stageRoot, runner, consent, emit } = input;
  const libsDir = join(scratchDir, "libs");
  const dataDir = join(scratchDir, "data");
  const outDir = join(scratchDir, "out");
  const workDir = join(scratchDir, "work");
  const minecraftJar = join(scratchDir, "minecraft.jar");
  await Promise.all([
    ensureDir(libsDir),
    ensureDir(dataDir),
    ensureDir(outDir),
    ensureDir(workDir),
  ]);

  emit?.({ type: "build:stage", phase: "acquire" });

  // 1. Materialize the vanilla client jar (the patch input).
  await store.materialize(plan.clientInput, minecraftJar, { order: ["copy"] });

  // 2. Materialize every library/processor jar into the scratch libs tree.
  const libScratch = new Map<string, string>();
  for (const [coord, lib] of Object.entries(plan.libraries)) {
    const dest = safeJoin(libsDir, lib.path);
    await ensureDir(dirname(dest));
    await store.materialize(lib.hash, dest, { order: ["copy"] });
    libScratch.set(coord, dest);
  }

  // 3. Extract the installer's embedded /data files (in-memory read → scratch).
  const dataScratch = new Map<string, string>();
  if (plan.installerEntries.length > 0) {
    const installerBytes = await readFile(store.objectPath(plan.installer));
    for (const entry of plan.installerEntries) {
      // Validate the destination BEFORE any work: a `..`/absolute installer-data
      // entry is a zip-slip-class escape and is rejected here (PathEscape).
      const dest = safeJoin(dataDir, entry);
      const bytes = await readZipEntry(installerBytes, entry);
      if (!bytes) {
        throw new ProcessorFailed(entry, `installer has no embedded entry "${entry}"`);
      }
      await ensureDir(dirname(dest));
      await writeFile(dest, bytes);
      dataScratch.set(entry, dest);
    }
  }

  // 4. Pre-create the output scratch paths (one per declared output).
  const outScratch = new Map<string, string>();
  for (const rel of plan.outputs) {
    const dest = safeJoin(outDir, rel);
    await ensureDir(dirname(dest));
    outScratch.set(rel, dest);
  }

  // 5. Resolve the data bindings to concrete scratch values.
  const bindingValue = (binding: ForgeBinding): { value: string; write: boolean } | undefined => {
    switch (binding.kind) {
      case "literal":
        return { value: binding.value, write: false };
      case "installerFile": {
        const p = dataScratch.get(binding.entry);
        return p ? { value: p, write: false } : undefined;
      }
      case "library": {
        const p = libScratch.get(binding.coord);
        return p ? { value: p, write: false } : undefined;
      }
      case "output": {
        const p = outScratch.get(binding.path);
        return p ? { value: p, write: true } : undefined;
      }
    }
  };

  const javaBin = await resolveJavaBin(input);
  const readRoots = [scratchDir];
  const writeRoots = [outDir, workDir];

  // 6. Run each processor through the sandbox, in order.
  for (const proc of plan.processors) {
    const jarPath = libScratch.get(proc.coordinate);
    if (!jarPath) {
      throw new ProcessorFailed(proc.coordinate, "processor jar was not materialized");
    }
    // Admission: official coordinate + sha256 pin (defense-in-depth re-hash), else
    // host consent. Refused → typed ProcessorRefused, before anything runs.
    const actual = await hashFile(jarPath, "sha256");
    admitProcessor({
      coordinate: proc.coordinate,
      ...(proc.repo ? { repo: proc.repo } : {}),
      pin: proc.jar,
      actual,
      consent,
    });

    const pathArgs: { path: string; write?: boolean }[] = [];
    const resolveToken = (token: string): string => {
      if (token === "{MINECRAFT_JAR}") {
        pathArgs.push({ path: minecraftJar });
        return minecraftJar;
      }
      if (token === "{ROOT}") {
        pathArgs.push({ path: scratchDir });
        return scratchDir;
      }
      if (token === "{SIDE}") {
        return "client";
      }
      // `{DATA_KEY}` → the classified binding.
      if (token.startsWith("{") && token.endsWith("}")) {
        const key = token.slice(1, -1);
        const binding = plan.bindings[key];
        if (binding) {
          const resolved = bindingValue(binding);
          if (!resolved) {
            throw new ProcessorFailed(proc.coordinate, `unresolved data binding "${key}"`);
          }
          if (binding.kind !== "literal") {
            pathArgs.push({ path: resolved.value, ...(resolved.write ? { write: true } : {}) });
          }
          return resolved.value;
        }
      }
      // `[coord]` → a library input or a produced output.
      if (isCoordToken(token)) {
        const coord = coordOfToken(token);
        const lib = libScratch.get(coord);
        if (lib) {
          pathArgs.push({ path: lib });
          return lib;
        }
        // maybe a produced output referenced directly.
        for (const [rel, dest] of outScratch) {
          if (rel === `libraries/${coordPath(coord)}`) {
            pathArgs.push({ path: dest, write: true });
            return dest;
          }
        }
        throw new ProcessorSandboxViolation(
          proc.coordinate,
          `arg token "${token}" names no materialized library or declared output`,
        );
      }
      return token; // a plain literal arg
    };

    const args = proc.args.map(resolveToken);
    const classpath: string[] = [];
    for (const coord of proc.classpath) {
      const p = libScratch.get(coord);
      if (!p) {
        throw new ProcessorFailed(
          proc.coordinate,
          `classpath coord "${coord}" was not materialized`,
        );
      }
      classpath.push(p);
    }

    const spec = buildExecSpec({
      subject: proc.coordinate,
      javaBin,
      jar: jarPath,
      mainClass: proc.mainClass,
      classpath,
      args,
      cwd: workDir,
      readRoots,
      writeRoots,
      pathArgs,
      ...(input.limits ? { limits: input.limits } : {}),
    });

    emit?.({ type: "build:stage", phase: "stage" });
    const result = await runner.run(spec);
    if (result.exitCode !== 0) {
      throw new ProcessorFailed(
        proc.coordinate,
        `exited with code ${result.exitCode}${result.stderr ? `: ${result.stderr.slice(0, 500)}` : ""}`,
      );
    }
  }

  // 7. Verify + place every declared output into the stage.
  for (const rel of plan.outputs) {
    const src = outScratch.get(rel);
    if (!src || !(await pathExists(src))) {
      throw new ProcessorFailed(rel, "declared output was not produced by any processor");
    }
    const dest = safeJoin(stageRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  return [...plan.outputs];
}

/** The maven jar path of a bare coordinate (for matching `[coord]` output tokens). */
function coordPath(coord: string): string {
  const parts = coord.split(":");
  const [group, artifact, version] = parts;
  if (!group || !artifact || !version) {
    return coord;
  }
  const classifier = parts[3];
  const jar = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${group.split(".").join("/")}/${artifact}/${version}/${jar}`;
}
