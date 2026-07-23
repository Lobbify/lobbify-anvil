import { afterEach, describe, expect, it } from "vitest";
import type { DependencyGraph } from "../../index.js";
import { readGraph, whyChains, writeGraph } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

describe("dependency graph (anvil why)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("round-trips through .anvil/graph.json", async () => {
    const dir = await mkTmp("graph");
    dirs.push(dir);
    const edges = [
      { child: "modrinth:root", childName: "root", by: "(manifest)" },
      { child: "modrinth:lib", childName: "lib", by: "root" },
    ];
    await writeGraph(dir, edges);
    const g = await readGraph(dir);
    expect(g?.edges).toEqual(edges);
  });

  it("traces a transitive dependency up to its root", () => {
    const g: DependencyGraph = {
      version: 1,
      edges: [
        { child: "modrinth:root", childName: "root", by: "(manifest)" },
        { child: "modrinth:mid", childName: "mid", by: "root" },
        { child: "modrinth:leaf", childName: "leaf", by: "mid" },
      ],
    };
    const w = whyChains(g, "leaf");
    expect(w.present).toBe(true);
    expect(w.roots).toEqual(["root"]);
    expect(w.chains).toEqual([["root", "mid", "leaf"]]);
  });

  it("reports a direct manifest root as its own chain", () => {
    const g: DependencyGraph = {
      version: 1,
      edges: [{ child: "modrinth:root", childName: "root", by: "(manifest)" }],
    };
    const w = whyChains(g, "root");
    expect(w.roots).toEqual(["root"]);
    expect(w.chains).toEqual([["root"]]);
  });

  it("survives a dependency cycle without hanging", () => {
    const g: DependencyGraph = {
      version: 1,
      edges: [
        { child: "modrinth:a", childName: "a", by: "(manifest)" },
        { child: "modrinth:a", childName: "a", by: "b" },
        { child: "modrinth:b", childName: "b", by: "a" },
      ],
    };
    const w = whyChains(g, "b");
    expect(w.present).toBe(true);
    expect(w.roots).toContain("a");
  });

  it("returns present:false for an unknown item", () => {
    expect(whyChains({ version: 1, edges: [] }, "nope").present).toBe(false);
  });
});
