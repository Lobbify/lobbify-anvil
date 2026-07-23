import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressBus } from "../../index.js";
import { packContextFromLock } from "../../src/tui/blast-radius.js";
import {
  ColorProvider,
  ConflictCardPrompt,
  ConflictCardView,
  ItemListView,
  ProgressView,
} from "../../src/tui/components.js";
import { buildConflictCards } from "../../src/tui/conflict-model.js";
import { buildItemRows } from "../../src/tui/item-list.js";
import type { Hash, LockPackage, Lockfile } from "../../src/types/index.js";
import type { Conflict } from "../../src/vc/index.js";

/** Matches an ANSI SGR (color/style) escape sequence (ESC-anchored). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

function hh(value: string): Hash {
  return { algo: "sha256", value };
}
function pkg(name: string, source: LockPackage["source"], version: string): LockPackage {
  return {
    name,
    kind: "mod",
    source,
    version,
    hash: hh(name),
    provenance: "copy",
    placement: { method: "link", target: `mods/${name}.jar` },
  };
}
function lock(packages: LockPackage[]): Lockfile {
  return {
    meta: {
      version: 1,
      manifestHash: hh("m"),
      minecraft: "26.2",
      loader: "fabric 0.19.1",
      java: "r",
    },
    resolved: packages,
  };
}

const instances: { unmount: () => void }[] = [];
function track<T extends { unmount: () => void }>(inst: T): T {
  instances.push(inst);
  return inst;
}
afterEach(() => {
  for (const i of instances.splice(0)) {
    i.unmount();
  }
});

describe("tui Ink: item list renders badges + semver", () => {
  it("shows kind/source badges, names, and versions", () => {
    const rows = buildItemRows(
      lock([pkg("sodium", "modrinth", "0.6.0"), pkg("jei", "curseforge", "15.2")]),
    );
    const { lastFrame } = track(render(h(ItemListView, { rows, title: "items (2)" })));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("items (2)");
    expect(frame).toContain("[mod]");
    expect(frame).toContain("[modrinth]");
    expect(frame).toContain("[curseforge]");
    expect(frame).toContain("sodium");
    expect(frame).toContain("0.6.0");
  });

  it("with color disabled the frame carries NO ANSI escapes", () => {
    const rows = buildItemRows(lock([pkg("sodium", "modrinth", "0.6.0")]));
    const { lastFrame } = track(
      render(h(ColorProvider, { value: false }, h(ItemListView, { rows, title: "items" }))),
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(ANSI);
    expect(frame).toContain("[mod]");
    expect(frame).toContain("sodium");
  });
});

describe("tui Ink: ProgressView consumes the Anvil event bus", () => {
  it("updates live as events are emitted on the bus", async () => {
    const bus = new ProgressBus();
    const { lastFrame } = track(render(h(ProgressView, { bus })));
    await tick(); // let the useEffect subscription attach

    bus.emit({ type: "resolve:start", items: 2 });
    bus.emit({ type: "resolve:item", name: "a", index: 1, total: 2 });
    await tick();
    expect(lastFrame()).toContain("resolve");
    expect(lastFrame()).toContain("(1/2)");

    bus.emit({ type: "transfer:plan", objects: 2, bytes: 10 });
    bus.emit({ type: "object:store", hash: hh("x"), deduped: false });
    bus.emit({ type: "object:store", hash: hh("y"), deduped: true });
    bus.emit({ type: "build:done", dir: "/tmp/i" });
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deduped");
    expect(frame).toContain("built");
  });
});

describe("tui Ink: conflict card renders blast radius", () => {
  const ctx = packContextFromLock(
    lock([pkg("sodium", "modrinth", "0.6.0"), pkg("lithium", "modrinth", "0.1")]),
  );
  const conflict: Conflict = {
    key: "@game",
    kind: "game",
    severity: "high",
    base: "26.2",
    ours: "26.1",
    theirs: "26.3",
    message: "divergent game base",
  };

  it("shows severity, the sides, and an accurate blast-radius count", () => {
    const cards = buildConflictCards([conflict], ctx);
    const { lastFrame } = track(
      render(h(ConflictCardView, { card: cards[0] as (typeof cards)[number], index: 0, total: 1 })),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[HIGH]");
    expect(frame).toContain("@game");
    expect(frame).toContain("blast radius");
    expect(frame).toContain("2 items");
  });

  it("a keypress drives the card to a resolution", async () => {
    const cards = buildConflictCards([conflict], ctx);
    let chosen: unknown;
    const { stdin } = track(
      render(
        h(ConflictCardPrompt, {
          card: cards[0] as (typeof cards)[number],
          index: 0,
          total: 1,
          onChoose: (r) => {
            chosen = r;
          },
        }),
      ),
    );
    await tick();
    stdin.write("t");
    await tick();
    expect(chosen).toEqual({ choose: "theirs" });
  });
});
