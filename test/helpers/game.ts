/**
 * Offline, deterministic game-install fixtures. `FakeGame` implements the `Http`
 * interface and replays the real Mojang / Fabric response *shapes* (version
 * manifest, piston-meta profile, asset index + objects, java-runtime `all.json` +
 * per-platform manifest + files, Fabric loader list + profile + maven jars) from a
 * small in-memory dataset whose hashes are computed from the served bytes, so
 * every pin verifies. Nothing here touches the network.
 */

import type { Http, HttpGetOptions, HttpResult } from "../../index.js";
import { sha1hex, sha256hex } from "./net.js";
import { makeZip } from "./zip.js";

const H = "https://fixtures.test";
export const MC = "26.2";
export const FABRIC_LOADER = "0.19.3";
export const COMPONENT = "java-runtime-epsilon";

export const mojangOptions = {
  versionManifestUrl: `${H}/mc/version_manifest_v2.json`,
  javaRuntimeAllUrl: `${H}/java-runtime/all.json`,
};
export const loaderMetaBase = `${H}/fabric`;
export const resourcesBase = `${H}/resources`;

function enc(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function mavenJarUrl(coord: string, base = "https://maven.fabricmc.net/"): string {
  const parts = coord.split(":");
  const [g, a, v] = parts;
  const cls = parts[3];
  const jar = cls ? `${a}-${v}-${cls}.jar` : `${a}-${v}.jar`;
  return `${base.replace(/\/+$/, "")}/${(g as string).split(".").join("/")}/${a}/${v}/${jar}`;
}
function mavenPathOf(coord: string): string {
  const parts = coord.split(":");
  const [g, a, v] = parts;
  const cls = parts[3];
  const jar = cls ? `${a}-${v}-${cls}.jar` : `${a}-${v}.jar`;
  return `${(g as string).split(".").join("/")}/${a}/${v}/${jar}`;
}

export interface FakeGameData {
  readonly http: FakeGame;
}

/** A byte server keyed by exact URL that also invokes an SSRF guard benignly. */
export class FakeGame implements Http {
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

/** A natives jar (a zip with a per-OS binary + a META-INF entry to exclude). */
function nativesJar(soName: string): Uint8Array {
  return new Uint8Array(
    makeZip([
      { name: soName, data: `NATIVE:${soName}` },
      { name: "META-INF/MANIFEST.MF", data: "excluded" },
    ]),
  );
}

/** Build the full offline game dataset (vanilla + a Fabric loader). */
export function makeGameFixtures(): FakeGameData {
  const g = new FakeGame();

  // --- vanilla profile artifacts -----------------------------------------
  const clientJar = bytes("MINECRAFT-CLIENT-26.2\n");
  const clientUrl = `${H}/objects/client.jar`;
  g.put(clientUrl, clientJar);

  const baseJar = bytes("base-lib-1.0\n");
  const objcJar = bytes("java-objc-bridge-1.1\n"); // osx-only
  const asmVanillaJar = bytes("asm-9.7-vanilla\n"); // overridden by the loader's 9.10.1
  const baseUrl = `${H}/objects/base.jar`;
  const objcUrl = `${H}/objects/objc.jar`;
  const asmVUrl = `${H}/objects/asm97.jar`;
  g.put(baseUrl, baseJar);
  g.put(objcUrl, objcJar);
  g.put(asmVUrl, asmVanillaJar);

  const natives = {
    linux: {
      classifier: "natives-linux",
      so: "liblwjgl.so",
      url: `${H}/objects/nat-linux.jar`,
      jar: nativesJar("liblwjgl.so"),
    },
    macos: {
      classifier: "natives-macos",
      so: "liblwjgl.dylib",
      url: `${H}/objects/nat-macos.jar`,
      jar: nativesJar("liblwjgl.dylib"),
    },
    macosArm: {
      classifier: "natives-macos-arm64",
      so: "liblwjgl-arm.dylib",
      url: `${H}/objects/nat-macos-arm.jar`,
      jar: nativesJar("liblwjgl-arm.dylib"),
    },
    windows: {
      classifier: "natives-windows",
      so: "lwjgl.dll",
      url: `${H}/objects/nat-win.jar`,
      jar: nativesJar("lwjgl.dll"),
    },
  };
  for (const n of Object.values(natives)) {
    g.put(n.url, n.jar);
  }

  // asset index + one object
  const assetObj = bytes("en_us-lang\n");
  const assetSha1 = sha1hex(assetObj);
  g.put(`${resourcesBase}/${assetSha1.slice(0, 2)}/${assetSha1}`, assetObj);
  const assetIndexObj = {
    objects: { "minecraft/lang/en_us.json": { hash: assetSha1, size: assetObj.length } },
  };
  const assetIndexBytes = enc(assetIndexObj);
  const assetIndexUrl = `${H}/objects/assets-26.json`;
  g.put(assetIndexUrl, assetIndexBytes);

  const nativesLib = (key: keyof typeof natives, n: (typeof natives)[keyof typeof natives]) => ({
    name: `org.lwjgl:lwjgl:3.4.1:${n.classifier}`,
    downloads: {
      artifact: {
        path: mavenPathOf(`org.lwjgl:lwjgl:3.4.1:${n.classifier}`),
        sha1: sha1hex(n.jar),
        size: n.jar.length,
        url: n.url,
      },
    },
    rules: [
      {
        action: "allow",
        os: { name: key === "windows" ? "windows" : key === "linux" ? "linux" : "osx" },
      },
    ],
  });

  const profile = {
    id: MC,
    type: "release",
    mainClass: "net.minecraft.client.main.Main",
    javaVersion: { component: COMPONENT, majorVersion: 25 },
    assets: "26",
    assetIndex: {
      id: "26",
      sha1: sha1hex(assetIndexBytes),
      size: assetIndexBytes.length,
      url: assetIndexUrl,
    },
    downloads: { client: { sha1: sha1hex(clientJar), size: clientJar.length, url: clientUrl } },
    arguments: {
      game: ["--username", "${auth_player_name}"],
      jvm: ["-Djava.library.path=${natives_directory}"],
    },
    libraries: [
      {
        name: "com.example:base:1.0",
        downloads: {
          artifact: {
            path: mavenPathOf("com.example:base:1.0"),
            sha1: sha1hex(baseJar),
            size: baseJar.length,
            url: baseUrl,
          },
        },
      },
      {
        name: "ca.weblite:java-objc-bridge:1.1",
        downloads: {
          artifact: {
            path: mavenPathOf("ca.weblite:java-objc-bridge:1.1"),
            sha1: sha1hex(objcJar),
            size: objcJar.length,
            url: objcUrl,
          },
        },
        rules: [{ action: "allow", os: { name: "osx" } }],
      },
      {
        name: "org.ow2.asm:asm:9.7",
        downloads: {
          artifact: {
            path: mavenPathOf("org.ow2.asm:asm:9.7"),
            sha1: sha1hex(asmVanillaJar),
            size: asmVanillaJar.length,
            url: asmVUrl,
          },
        },
      },
      nativesLib("linux", natives.linux),
      nativesLib("macos", natives.macos),
      nativesLib("macosArm", natives.macosArm),
      nativesLib("windows", natives.windows),
    ],
  };
  g.put(`${H}/objects/${MC}.json`, enc(profile));

  // version manifest
  g.put(
    mojangOptions.versionManifestUrl,
    enc({
      latest: { release: MC, snapshot: MC },
      versions: [{ id: MC, type: "release", url: `${H}/objects/${MC}.json`, sha1: "deadbeef" }],
    }),
  );

  // --- java-runtime (per platform) ---------------------------------------
  const jreLeafBin = bytes("#!/bin/sh\necho java\n");
  const jreLeafLib = bytes("jre-lib-blob\n");
  const jreBinUrl = `${H}/jre/bin-java`;
  const jreLibUrl = `${H}/jre/lib-x`;
  g.put(jreBinUrl, jreLeafBin);
  g.put(jreLibUrl, jreLeafLib);
  const jreManifest = {
    files: {
      bin: { type: "directory" },
      "bin/java": {
        type: "file",
        executable: true,
        downloads: { raw: { sha1: sha1hex(jreLeafBin), size: jreLeafBin.length, url: jreBinUrl } },
      },
      "lib/x.txt": {
        type: "file",
        executable: false,
        downloads: { raw: { sha1: sha1hex(jreLeafLib), size: jreLeafLib.length, url: jreLibUrl } },
      },
      "bin/java-link": { type: "link", target: "java" },
    },
  };
  const jreManifestBytes = enc(jreManifest);
  const jreManifestUrl = `${H}/jre/manifest.json`;
  g.put(jreManifestUrl, jreManifestBytes);

  const jrePlatforms = ["linux", "mac-os", "mac-os-arm64", "windows-x64"];
  const all: Record<string, Record<string, unknown[]>> = {};
  for (const p of jrePlatforms) {
    all[p] = {
      [COMPONENT]: [
        {
          manifest: {
            sha1: sha1hex(jreManifestBytes),
            size: jreManifestBytes.length,
            url: jreManifestUrl,
          },
          version: { name: "25.0.1" },
        },
      ],
    };
  }
  all.gamecore = { [COMPONENT]: [] };
  g.put(mojangOptions.javaRuntimeAllUrl, enc(all));

  // --- Fabric loader ------------------------------------------------------
  const asmJar = bytes("asm-9.10.1-fabric\n");
  const loaderJar = bytes("fabric-loader-0.19.3\n");
  g.put(mavenJarUrl("org.ow2.asm:asm:9.10.1"), asmJar);
  g.put(mavenJarUrl("net.fabricmc:fabric-loader:0.19.3"), loaderJar);
  g.put(
    `${loaderMetaBase}/versions/loader`,
    enc([
      { version: FABRIC_LOADER, stable: true },
      { version: "0.19.2", stable: false },
    ]),
  );
  g.put(
    `${loaderMetaBase}/versions/loader/${MC}/${FABRIC_LOADER}/profile/json`,
    enc({
      id: `fabric-loader-${FABRIC_LOADER}-${MC}`,
      inheritsFrom: MC,
      type: "release",
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      arguments: { game: [], jvm: ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
      libraries: [
        {
          name: "org.ow2.asm:asm:9.10.1",
          url: "https://maven.fabricmc.net/",
          sha1: sha1hex(asmJar),
          sha256: sha256hex(asmJar),
          size: asmJar.length,
        },
        {
          name: "net.fabricmc:fabric-loader:0.19.3",
          url: "https://maven.fabricmc.net/",
          sha1: sha1hex(loaderJar),
          sha256: sha256hex(loaderJar),
          size: loaderJar.length,
        },
      ],
    }),
  );

  // A second (older) loader version, so a re-lock can pin it instead of newest.
  const loaderJar2 = bytes("fabric-loader-0.19.2\n");
  g.put(mavenJarUrl("net.fabricmc:fabric-loader:0.19.2"), loaderJar2);
  g.put(
    `${loaderMetaBase}/versions/loader/${MC}/0.19.2/profile/json`,
    enc({
      id: `fabric-loader-0.19.2-${MC}`,
      inheritsFrom: MC,
      type: "release",
      mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
      arguments: { game: [], jvm: ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
      libraries: [
        {
          name: "org.ow2.asm:asm:9.10.1",
          url: "https://maven.fabricmc.net/",
          sha1: sha1hex(asmJar),
          sha256: sha256hex(asmJar),
          size: asmJar.length,
        },
        {
          name: "net.fabricmc:fabric-loader:0.19.2",
          url: "https://maven.fabricmc.net/",
          sha1: sha1hex(loaderJar2),
          sha256: sha256hex(loaderJar2),
          size: loaderJar2.length,
        },
      ],
    }),
  );

  return { http: g };
}
