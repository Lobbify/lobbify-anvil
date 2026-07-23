/**
 * Offline, deterministic Forge/NeoForge fixtures for Stage 9.
 *
 * A {@link FakeForge} serves the maven metadata, promotions feed, installer jar, and
 * library jars from an in-memory dataset keyed by exact URL — using the REAL trusted
 * hostnames (`maven.neoforged.net` / `maven.minecraftforge.net`) so the processor
 * allowlist's host check passes without special-casing. Every hash is computed from
 * the served bytes, so every pin verifies. A {@link FakeProcessorRunner} stands in
 * for the JVM boundary: it re-validates the sandbox policy on every spec, records the
 * (constrained) spec, and deterministically produces the declared outputs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  type ForgeEndpoints,
  type Http,
  type HttpGetOptions,
  type HttpResult,
  type ProcessorExecSpec,
  type ProcessorRunResult,
  type ProcessorRunner,
  assertSandboxPolicy,
  mavenPath,
} from "../../index.js";
import { sha1hex, sha256hex } from "./net.js";
import { makeZip } from "./zip.js";

const NEO_REPO = "https://maven.neoforged.net/releases/";
const FORGE_REPO = "https://maven.minecraftforge.net/";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A byte server keyed by exact URL that invokes any SSRF guard benignly. */
export class FakeForge implements Http {
  readonly calls: string[] = [];
  readonly #map = new Map<string, Uint8Array>();

  put(url: string, data: Uint8Array): void {
    this.#map.set(url, data);
  }

  async get(url: string, options?: HttpGetOptions): Promise<HttpResult> {
    this.calls.push(url);
    await options?.guard?.({ url, host: new URL(url).hostname, addresses: ["93.184.216.34"] });
    const b = this.#map.get(url);
    if (!b) {
      return { status: 404, headers: {}, url, body: bytes(`404 ${url}`) };
    }
    return { status: 200, headers: {}, url, body: b };
  }
}

/** A jar (zip) carrying a `Main-Class` manifest — a runnable processor jar. */
export function runnableJar(mainClass: string): Uint8Array {
  return new Uint8Array(
    makeZip([
      {
        name: "META-INF/MANIFEST.MF",
        data: `Manifest-Version: 1.0\r\nMain-Class: ${mainClass}\r\n\r\n`,
      },
      { name: "com/example/Tool.class", data: "CAFEBABE" },
    ]),
  );
}

function libArtifact(coord: string, repo: string, jarBytes: Uint8Array) {
  const path = mavenPath(coord);
  return {
    name: coord,
    downloads: {
      artifact: {
        path,
        url: joinUrl(repo, path),
        sha1: sha1hex(jarBytes),
        size: jarBytes.byteLength,
      },
    },
  };
}

export interface ForgeFixture {
  readonly http: FakeForge;
  readonly endpoints: ForgeEndpoints;
  readonly flavor: "forge" | "neoforge";
  readonly minecraft: string;
  readonly recommended: string;
  readonly latest: string;
  readonly versions: readonly string[];
  /** The processor coordinate (official, trusted host) the happy path admits. */
  readonly processorCoord: string;
  /** The instance-relative path the processors produce. */
  readonly producedPath: string;
}

export interface MakeForgeOptions {
  readonly flavor?: "forge" | "neoforge";
  /** Override the (single) processor's coordinate — e.g. an untrusted one. */
  readonly processorCoord?: string;
  /** Inject a malicious installer `data` binding value (e.g. a path escape). */
  readonly evilDataValue?: string;
}

/** Build the offline NeoForge (default) or Forge dataset. */
export function makeForgeFixtures(options: MakeForgeOptions = {}): ForgeFixture {
  const flavor = options.flavor ?? "neoforge";
  const g = new FakeForge();
  const mc = "26.2";
  const repo = flavor === "neoforge" ? NEO_REPO : FORGE_REPO;

  const versions =
    flavor === "neoforge"
      ? ["26.1.4", "26.2.0", "26.2.5", "26.2.9-beta"]
      : ["26.1-51.0.1", "26.2-52.0.10", "26.2-52.0.16"];
  const recommended = flavor === "neoforge" ? "26.2.5" : "26.2-52.0.16";
  const latest = flavor === "neoforge" ? "26.2.9-beta" : "26.2-52.0.16";
  const version = recommended;

  const groupPath = flavor === "neoforge" ? "net/neoforged/neoforge" : "net/minecraftforge/forge";
  const metadataUrl = joinUrl(repo, `${groupPath}/maven-metadata.xml`);
  g.put(
    metadataUrl,
    bytes(
      `<?xml version="1.0"?><metadata><versioning><latest>${latest}</latest><release>${recommended}</release><versions>${versions
        .map((v) => `<version>${v}</version>`)
        .join("")}</versions></versioning></metadata>`,
    ),
  );

  const endpoints: ForgeEndpoints = { metadataUrl, repoBaseUrl: repo };
  if (flavor === "forge") {
    const promotionsUrl =
      "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
    g.put(
      promotionsUrl,
      enc({
        promos: { [`${mc}-recommended`]: "52.0.16", [`${mc}-latest`]: "52.0.16" },
      }),
    );
    (endpoints as { promotionsUrl?: string }).promotionsUrl = promotionsUrl;
  }

  // --- the processor toolchain (installer libraries) ---------------------
  const processorCoord =
    options.processorCoord ??
    (flavor === "neoforge"
      ? "net.neoforged.installertools:binarypatcher:2.1.7"
      : "net.minecraftforge:binarypatcher:1.1.1");
  const procJar = runnableJar("com.example.binarypatcher.ConsoleTool");
  const commonsCoord = "commons-io:commons-io:2.11.0";
  const commonsJar = bytes("commons-io-2.11.0\n");
  const procLib = libArtifact(processorCoord, repo, procJar);
  const commonsLib = libArtifact(commonsCoord, repo, commonsJar);
  g.put(procLib.downloads.artifact.url, procJar);
  g.put(commonsLib.downloads.artifact.url, commonsJar);

  // --- the game library (universal, fetched) + the produced client lib ---
  const universalCoord = `${flavor === "neoforge" ? "net.neoforged:neoforge" : "net.minecraftforge:forge"}:${version}:universal`;
  const universalJar = bytes(`${flavor}-universal-${version}\n`);
  const universalLib = libArtifact(universalCoord, repo, universalJar);
  g.put(universalLib.downloads.artifact.url, universalJar);

  const clientCoord = `${flavor === "neoforge" ? "net.neoforged:neoforge" : "net.minecraftforge:forge"}:${version}:client`;
  const producedPath = `libraries/${mavenPath(clientCoord)}`;

  // --- install_profile.json + version.json + the installer jar -----------
  const installProfile = {
    spec: 1,
    profile: flavor === "neoforge" ? "NeoForge" : "forge",
    version: `${flavor}-${version}`,
    minecraft: mc,
    data: {
      BINPATCH: { client: "/data/client.lzma", server: "/data/server.lzma" },
      SIDE: { client: "client", server: "server" },
      PATCHED: { client: `[${clientCoord}]`, server: `[${clientCoord}]` },
      ...(options.evilDataValue ? { EVIL: { client: options.evilDataValue } } : {}),
    },
    processors: [
      {
        sides: ["client"],
        jar: processorCoord,
        classpath: [processorCoord, commonsCoord],
        args: [
          "--clean",
          "{MINECRAFT_JAR}",
          "--output",
          "{PATCHED}",
          "--apply",
          "{BINPATCH}",
          "--side",
          "{SIDE}",
          ...(options.evilDataValue ? ["--evil", "{EVIL}"] : []),
        ],
        outputs: { "{PATCHED}": "" },
      },
    ],
    libraries: [procLib, commonsLib],
  };

  const versionProfile = {
    id: `${flavor}-${version}`,
    inheritsFrom: mc,
    type: "release",
    mainClass: "cpw.mods.modlauncher.Launcher",
    arguments: {
      game: ["--launchTarget", `${flavor}client`],
      jvm: ["-p", "${library_directory}"],
    },
    libraries: [
      universalLib,
      // The produced client lib: no download url → a processor output.
      { name: clientCoord },
    ],
  };

  const installerBytes = new Uint8Array(
    makeZip([
      { name: "install_profile.json", data: JSON.stringify(installProfile) },
      { name: "version.json", data: JSON.stringify(versionProfile) },
      { name: "data/client.lzma", data: "BINPATCH-CLIENT-BYTES" },
      { name: "data/server.lzma", data: "BINPATCH-SERVER-BYTES" },
    ]),
  );
  const installerName =
    flavor === "neoforge"
      ? `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
      : `net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
  g.put(joinUrl(repo, installerName), installerBytes);

  return {
    http: g,
    endpoints,
    flavor,
    minecraft: mc,
    recommended,
    latest,
    versions,
    processorCoord,
    producedPath,
  };
}

/**
 * A hermetic stand-in for the JVM boundary. It re-validates the sandbox policy on
 * every spec (so a test can trust the recorded specs are genuinely constrained),
 * records the spec, and deterministically writes bytes to each output-path arg (an
 * arg under the write root) — simulating a processor producing its patched jar.
 */
export class FakeProcessorRunner implements ProcessorRunner {
  readonly specs: ProcessorExecSpec[] = [];
  readonly #exitCode: number;

  constructor(opts: { exitCode?: number } = {}) {
    this.#exitCode = opts.exitCode ?? 0;
  }

  async run(spec: ProcessorExecSpec): Promise<ProcessorRunResult> {
    assertSandboxPolicy(spec); // the boundary never trusts an unconstrained spec
    this.specs.push(spec);
    if (this.#exitCode === 0) {
      const outDir = spec.writeRoots[0];
      for (const arg of spec.args) {
        if (outDir && arg.startsWith(outDir)) {
          await mkdir(dirname(arg), { recursive: true });
          // Deterministic bytes derived from the STABLE basename (never the scratch
          // uuid), so two independent builds produce byte-identical outputs.
          await writeFile(arg, Buffer.from(`forge-processor-output:${basename(arg)}\n`));
        }
      }
    }
    return {
      exitCode: this.#exitCode,
      stdout: "",
      stderr: this.#exitCode === 0 ? "" : "processor failed",
    };
  }
}
