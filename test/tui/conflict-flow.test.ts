import { afterEach, describe, expect, it } from "vitest";
import { readLock } from "../../index.js";
import { runConflictMerge } from "../../src/tui/conflict-controller.js";
import type { ConflictCard } from "../../src/tui/conflict-model.js";
import type { Resolution } from "../../src/vc/index.js";
import { rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

/**
 * GATE: the conflict cards drive a REAL merge to resolution through the library,
 * and the blast-radius count shown on the card is accurate.
 *
 * Scenario: base @26.2 with two mods; ours bumps to @26.1, theirs to @26.3 — a
 * divergent, high-severity `@game` conflict. Both mods support all three, so
 * choosing a side re-locks cleanly. The card's blast radius must equal the two
 * source items the game cascade re-resolves.
 */
describe("tui GATE: conflict cards drive a real merge to resolution", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rmTmp(d);
    }
  });

  it("resolves a divergent @game conflict; blast-radius count is accurate", async () => {
    const fx = await makeVcFixture(
      modWorld([
        {
          slug: "universal",
          id: "UNI",
          versions: [version("UNI", "1.0.0", ["26.1", "26.2", "26.3"])],
        },
        {
          slug: "extra",
          id: "EXTRA",
          versions: [version("EXTRA", "1.0.0", ["26.1", "26.2", "26.3"])],
        },
      ]),
    );
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();

    // base @26.2 with two mods.
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:universal", "modrinth:extra"] }),
    );
    await anvil.commit("base");
    await anvil.branch("theirs");

    // ours bumps the game to 26.1 (items unchanged) — a real 3-way, not a FF.
    await fx.writeLockFor(
      manifest({ minecraft: "26.1", items: ["modrinth:universal", "modrinth:extra"] }),
    );
    await anvil.commit("ours: bump to 26.1");

    // theirs bumps the game to 26.3.
    await anvil.switch("theirs");
    await fx.writeLockFor(
      manifest({ minecraft: "26.3", items: ["modrinth:universal", "modrinth:extra"] }),
    );
    await anvil.commit("theirs: bump to 26.3");

    await anvil.switch("main");

    // Drive the merge through the card controller, choosing "ours" (26.1).
    const seen: ConflictCard[] = [];
    const result = await runConflictMerge(anvil, "theirs", (card): Resolution => {
      seen.push(card);
      return { choose: "ours" };
    });

    // Exactly one card was presented — the high-severity @game cascade.
    expect(result.cards).toHaveLength(1);
    const card = result.cards[0];
    expect(card?.conflict.kind).toBe("game");
    expect(card?.conflict.severity).toBe("high");

    // Blast radius is accurate: both source mods re-resolve under the new game.
    expect(card?.blast.count).toBe(2);
    expect(seen[0]?.blast.count).toBe(2);

    // The real merge committed and the merged lock carries the chosen game (26.1).
    expect(result.outcome.committed).toBeDefined();
    const merged = await readLock(fx.dir);
    expect(merged.meta.minecraft).toBe("26.1");
    expect(merged.resolved.filter((p) => p.source === "modrinth")).toHaveLength(2);
  });

  it("a clean 3-way merge needs no cards", async () => {
    const fx = await makeVcFixture(
      modWorld([
        { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
        { slug: "beta", id: "BETA", versions: [version("BETA", "2.0.0", ["26.2"])] },
      ]),
    );
    dirs.push(fx.dir, fx.storeDir);
    const anvil = fx.anvil();
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    await anvil.commit("base");
    await anvil.branch("theirs");
    await fx.writeLockFor(
      manifest({ minecraft: "26.2", items: ["modrinth:alpha", "modrinth:beta"] }),
    );
    await anvil.commit("ours: add beta");
    await anvil.switch("theirs");
    await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));
    // theirs == base (no change) → ours is ahead → merging theirs is up-to-date.
    await anvil.switch("main");
    const result = await runConflictMerge(anvil, "theirs", () => {
      throw new Error("resolveCard must not be called for a conflict-free merge");
    });
    expect(result.cards).toHaveLength(0);
    expect(result.outcome.upToDate).toBe(true);
  });
});
