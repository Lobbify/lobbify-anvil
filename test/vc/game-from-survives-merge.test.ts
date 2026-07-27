/**
 * A merge reconstructs the merged manifest's `[game]` table field by field. Every
 * authored field it does not know about is dropped silently — and `game.from`
 * dropping silently turns a base-derived instance into a bare one, losing every
 * package the base contributed on the next lock.
 *
 * This was a real hole in the merge path when `game.from` began to mean something;
 * these tests are the guard against it reopening for the next `[game]` field.
 */

import { describe, expect, it } from "vitest";
import type { ItemSet, Manifest } from "../../index.js";
import { buildItemSet, gameValue, threeWayMerge } from "../../src/vc/index.js";

const EMPTY = new Map();

function manifestWith(game: Partial<Manifest["game"]>): Manifest {
  return {
    project: { name: "p", version: "1" },
    game: { minecraft: "26.2", loader: "fabric 0.19.1", ...game },
    items: [],
  };
}

function setOf(game: Partial<Manifest["game"]>): ItemSet {
  return buildItemSet(manifestWith(game), "/instance", EMPTY);
}

async function merge(
  base: Partial<Manifest["game"]>,
  ours: Partial<Manifest["game"]>,
  theirs: Partial<Manifest["game"]>,
) {
  return threeWayMerge({
    base: setOf(base),
    ours: setOf(ours),
    theirs: setOf(theirs),
    project: { name: "p", version: "1" },
    oursPins: EMPTY,
    theirsPins: EMPTY,
    basePins: EMPTY,
  });
}

describe("game.from through a merge", () => {
  it("survives a merge that touched neither side's base", async () => {
    const from = "modrinth:atm10@4.6";
    const result = await merge({ from }, { from }, { from });
    expect(result.conflicts).toEqual([]);
    expect(result.manifest?.game.from).toBe(from);
  });

  it("takes the side that changed the base, and reports the cascade", async () => {
    const result = await merge(
      { from: "modrinth:atm10@4.5" },
      { from: "modrinth:atm10@4.5" },
      { from: "modrinth:atm10@4.6" },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.manifest?.game.from).toBe("modrinth:atm10@4.6");
    // Swapping the base can orphan every mod, which is exactly what the @game
    // cascade exists to force back through resolution.
    expect(result.gameChanged).toBe(true);
  });

  it("conflicts when both sides changed the base differently", async () => {
    const result = await merge(
      { from: "modrinth:atm10@4.5" },
      { from: "modrinth:atm10@4.6" },
      { from: "modrinth:cobblemon@1.2" },
    );
    expect(result.conflicts.map((c) => c.key)).toContain("@game");
    expect(result.manifest).toBeUndefined();
  });

  it("carries game.remove through too", async () => {
    const result = await merge(
      { from: "modrinth:atm10@4.6" },
      { from: "modrinth:atm10@4.6" },
      { from: "modrinth:atm10@4.6", remove: ["modrinth:unwanted"] },
    );
    expect(result.manifest?.game.remove).toEqual(["modrinth:unwanted"]);
  });

  it("an instance using neither field produces the @game value it always did", () => {
    // The compatibility claim: absent `from`/`remove` contribute empty segments,
    // so two base-less sides still compare equal and nothing cascades.
    const a = gameValue(setOf({}).game);
    const b = gameValue(setOf({}).game);
    expect(a).toBe(b);
    expect(gameValue(setOf({ from: "modrinth:x@1" }).game)).not.toBe(a);
    expect(gameValue(setOf({ remove: ["modrinth:y"] }).game)).not.toBe(a);
  });
});
