import { describe, expect, it } from "vitest";
import {
  type ProfileLibrary,
  buildVersionProfile,
  mergeLibraries,
  serializeVersionJson,
} from "../../index.js";

const vanilla = {
  id: "26.2",
  type: "release",
  mainClass: "net.minecraft.client.main.Main",
  assetIndex: { id: "26" },
  arguments: { game: ["--username", "${x}"], jvm: ["-Djava.library.path=${natives_directory}"] },
  libraries: [
    { name: "org.ow2.asm:asm:9.7" },
    { name: "a.b:base:1.0" },
    { name: "org.lwjgl:lwjgl:3.4.1:natives-linux" },
    { name: "org.lwjgl:lwjgl:3.4.1:natives-macos" },
  ] as ProfileLibrary[],
};
const loader = {
  id: "fabric-loader-0.19.3-26.2",
  inheritsFrom: "26.2",
  type: "release",
  mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
  arguments: { game: [], jvm: ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
  libraries: [
    { name: "org.ow2.asm:asm:9.10.1" },
    { name: "net.fabricmc:fabric-loader:0.19.3" },
  ] as ProfileLibrary[],
};

describe("version.json — union/dedup libraries (the dup-ASM lesson)", () => {
  it("dedups a shared group:artifact to the loader's version, keeps all natives", () => {
    const merged = mergeLibraries(vanilla.libraries, loader.libraries);
    const asm = merged.filter((l) => l.name.startsWith("org.ow2.asm:asm:"));
    expect(asm).toHaveLength(1);
    expect(asm[0]?.name).toBe("org.ow2.asm:asm:9.10.1"); // loader wins
    // Both per-OS natives survive the union (distinct artifacts, not duplicates).
    expect(merged.some((l) => l.name.endsWith(":natives-linux"))).toBe(true);
    expect(merged.some((l) => l.name.endsWith(":natives-macos"))).toBe(true);
    expect(merged.some((l) => l.name === "net.fabricmc:fabric-loader:0.19.3")).toBe(true);
  });

  it("is sorted by maven coordinate", () => {
    const merged = mergeLibraries(vanilla.libraries, loader.libraries);
    const names = merged.map((l) => l.name);
    expect(names).toEqual([...names].sort());
  });

  it("is order-independent: shuffled inputs → identical merge", () => {
    const a = mergeLibraries(vanilla.libraries, loader.libraries);
    const b = mergeLibraries([...vanilla.libraries].reverse(), [...loader.libraries].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("version.json — canonical merged profile", () => {
  it("flattens inheritsFrom, takes the loader mainClass, merges arguments", () => {
    const profile = buildVersionProfile({ vanilla, loader, id: loader.id });
    expect(profile.inheritsFrom).toBeUndefined();
    expect(profile.id).toBe(loader.id);
    expect(profile.mainClass).toBe(loader.mainClass);
    const args = profile.arguments as { jvm: unknown[] };
    // vanilla jvm args come first, loader's appended.
    expect(args.jvm).toEqual([
      "-Djava.library.path=${natives_directory}",
      "-DFabricMcEmu= net.minecraft.client.main.Main ",
    ]);
  });

  it("is byte-identical across runs and independent of input library order", () => {
    const one = serializeVersionJson({ vanilla, loader, id: loader.id });
    const two = serializeVersionJson({
      vanilla: { ...vanilla, libraries: [...vanilla.libraries].reverse() },
      loader: { ...loader, libraries: [...loader.libraries].reverse() },
      id: loader.id,
    });
    expect(one).toBe(two);
    expect(one.endsWith("\n")).toBe(true);
  });

  it("vanilla install keeps the profile self-contained (no loader)", () => {
    const profile = buildVersionProfile({ vanilla, id: vanilla.id });
    expect(profile.mainClass).toBe(vanilla.mainClass);
    expect(profile.id).toBe("26.2");
  });
});
