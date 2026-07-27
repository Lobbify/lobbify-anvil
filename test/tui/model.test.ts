import { describe, expect, it } from "vitest";
import type { AnvilEvent } from "../../src/events.js";
import { kindBadge, provenanceBadge, severityBadge, sourceBadge } from "../../src/tui/badges.js";
import {
  computeBlastRadius,
  computeRelockPreview,
  packContextFromLock,
} from "../../src/tui/blast-radius.js";
import { detectCapabilities } from "../../src/tui/capabilities.js";
import { buildConflictCards, conflictCardSegments } from "../../src/tui/conflict-model.js";
import { buildItemRows, itemRowSegments } from "../../src/tui/item-list.js";
import {
  renderPlainConflictCards,
  renderPlainDashboard,
  renderPlainProgress,
} from "../../src/tui/plain.js";
import { reduceAll } from "../../src/tui/progress-model.js";
import { plainText } from "../../src/tui/segments.js";
import { bumpLevel, diffSegments } from "../../src/tui/semver-diff.js";
import type { Hash, LockPackage, Lockfile } from "../../src/types/index.js";
import type { Conflict } from "../../src/vc/index.js";

/** Matches an ANSI SGR (color/style) escape sequence (ESC-anchored). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

function h(value: string): Hash {
  return { algo: "sha256", value };
}

function pkg(
  name: string,
  kind: LockPackage["kind"],
  source: LockPackage["source"],
  version: string | undefined,
  hash: string,
  provenance: LockPackage["provenance"] = "copy",
): LockPackage {
  return {
    name,
    kind,
    source,
    ...(version !== undefined ? { version } : {}),
    hash: h(hash),
    provenance,
    placement: { method: "link", target: `mods/${name}.jar` },
  };
}

function lock(packages: LockPackage[], minecraft = "26.2", loader = "fabric 0.19.1"): Lockfile {
  return {
    meta: { version: 1, manifestHash: h("m"), minecraft, loader, java: "runtime-21" },
    resolved: packages,
  };
}

describe("tui: capability detection", () => {
  it("a real TTY on both ends → interactive + color", () => {
    const caps = detectCapabilities({ env: {}, stdout: { isTTY: true }, stdin: { isTTY: true } });
    expect(caps).toEqual({ color: true, unicode: true, interactive: true });
  });

  it("NO_COLOR forces the plain, colorless path even on a TTY", () => {
    const caps = detectCapabilities({
      env: { NO_COLOR: "1" },
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    });
    expect(caps.color).toBe(false);
    expect(caps.interactive).toBe(false);
  });

  it("a non-TTY stdout (a pipe) → not interactive", () => {
    const caps = detectCapabilities({ env: {}, stdout: {}, stdin: {} });
    expect(caps.interactive).toBe(false);
    expect(caps.color).toBe(false);
  });

  it("CI forces non-interactive", () => {
    const caps = detectCapabilities({
      env: { CI: "true" },
      stdout: { isTTY: true },
      stdin: { isTTY: true },
    });
    expect(caps.interactive).toBe(false);
  });
});

describe("tui: badges carry TEXT (no color-only signaling)", () => {
  it("kind / source / provenance / severity badges have literal text labels", () => {
    expect(kindBadge("mod").text).toBe("[mod]");
    expect(kindBadge("resourcepack").text).toBe("[resourcepack]");
    expect(kindBadge("shaderpack").text).toBe("[shaderpack]");
    expect(sourceBadge("modrinth").text).toBe("[modrinth]");
    expect(sourceBadge("curseforge").text).toBe("[curseforge]");
    expect(sourceBadge("local").text).toBe("[local]");
    expect(provenanceBadge("replay")?.text).toBe("[replay]");
    expect(provenanceBadge("copy")).toBeUndefined();
    expect(severityBadge("high").text).toBe("[HIGH]");
  });
});

describe("tui: colorized semver diff", () => {
  it("classifies the bump level", () => {
    expect(bumpLevel("1.2.0", "2.0.0")).toBe("major");
    expect(bumpLevel("1.2.0", "1.3.0")).toBe("minor");
    expect(bumpLevel("1.2.0", "1.2.1")).toBe("patch");
  });

  it("renders add / remove / change with the version text intact", () => {
    expect(plainText(diffSegments(undefined, "1.0.0"))).toBe("+1.0.0");
    expect(plainText(diffSegments("1.0.0", undefined))).toBe("-1.0.0");
    expect(plainText(diffSegments("1.2.0", "1.3.0"))).toBe("1.2.0 → 1.3.0");
  });
});

describe("tui: item list rows (badges + semver)", () => {
  it("a row shows kind + source badges, the name, and its version", () => {
    const current = lock([pkg("sodium", "mod", "modrinth", "0.6.0", "aaa")]);
    const rows = buildItemRows(current);
    expect(rows).toHaveLength(1);
    const text = plainText(itemRowSegments(rows[0] as (typeof rows)[number]));
    expect(text).toContain("[mod]");
    expect(text).toContain("[modrinth]");
    expect(text).toContain("sodium");
    expect(text).toContain("0.6.0");
  });

  it("a changed item renders a from → to semver diff", () => {
    const prev = lock([pkg("sodium", "mod", "modrinth", "0.5.0", "old")]);
    const cur = lock([pkg("sodium", "mod", "modrinth", "0.6.0", "new")]);
    const rows = buildItemRows(cur, prev);
    const row = rows.find((r) => r.name === "sodium");
    expect(row?.change).toBe("changed");
    expect(plainText(itemRowSegments(row as NonNullable<typeof row>))).toContain("0.5.0 → 0.6.0");
  });

  it("a replay (CurseForge) item is flagged with a [replay] badge", () => {
    const cur = lock([pkg("jei", "mod", "curseforge", "1.0", "cf", "replay")]);
    const rows = buildItemRows(cur);
    expect(plainText(itemRowSegments(rows[0] as (typeof rows)[number]))).toContain("[replay]");
  });
});

describe("tui: progress reducer folds the event bus", () => {
  it("tallies stores, dedup-skips, and completion", () => {
    const events: AnvilEvent[] = [
      { type: "resolve:start", items: 2 },
      { type: "resolve:item", name: "a", index: 1, total: 2 },
      { type: "resolve:done", pinned: 2 },
      { type: "transfer:plan", objects: 2, bytes: 100 },
      { type: "object:store", hash: h("x"), deduped: false },
      { type: "object:store", hash: h("y"), deduped: true },
      { type: "build:done", dir: "/tmp/inst" },
    ];
    const state = reduceAll(events);
    expect(state.objects.stored).toBe(1);
    expect(state.objects.deduped).toBe(1);
    expect(state.done).toBe(true);
    expect(state.builtDir).toBe("/tmp/inst");
  });

  it("never renders a percent over 100% when object counts dwarf the package plan", () => {
    // `plan.objects` is a package count (few); `object:store` fires per content
    // object (many) — pairing them into one ratio would overflow the bar.
    const events: AnvilEvent[] = [
      { type: "transfer:plan", objects: 3, bytes: 10 },
      { type: "build:stage", phase: "acquire" },
    ];
    for (let i = 0; i < 3000; i++) {
      events.push({ type: "object:store", hash: h(`o${i}`), deduped: false });
    }
    const out = renderPlainProgress(reduceAll(events));
    // Every percentage the panel prints is within 0..100.
    for (const m of out.matchAll(/(\d+)%/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(100);
    }
    // The acquire tally is an honest, unbounded count — not a bogus ratio bar.
    expect(out).toContain("3000 stored");
    expect(out).toContain("3 packages");
  });
});

describe("tui: blast radius + re-lock preview", () => {
  const packLock = lock([
    pkg("sodium", "mod", "modrinth", "0.6.0", "a"),
    pkg("jei", "mod", "curseforge", "1.0", "b", "replay"),
    pkg("mypatch", "config", "local", undefined, "c"),
  ]);
  const ctx = packContextFromLock(packLock);

  it("a @game conflict cascades over every source item; local items are kept", () => {
    const conflict: Conflict = {
      key: "@game",
      kind: "game",
      severity: "high",
      base: "26.2",
      ours: "26.1",
      theirs: "26.3",
      message: "divergent game",
    };
    expect(computeBlastRadius(conflict, ctx).count).toBe(2);
    const preview = computeRelockPreview(conflict, ctx);
    expect(preview.reResolved).toBe(2);
    expect(preview.keptPins).toBe(1);
  });

  it("a single-item conflict disturbs only that item", () => {
    const conflict: Conflict = {
      key: "modrinth:sodium",
      kind: "item",
      severity: "normal",
      message: "both changed sodium",
    };
    expect(computeBlastRadius(conflict, ctx).count).toBe(1);
  });
});

describe("tui: conflict cards", () => {
  const ctx = packContextFromLock(
    lock([
      pkg("sodium", "mod", "modrinth", "0.6.0", "a"),
      pkg("lithium", "mod", "modrinth", "0.1", "b"),
    ]),
  );
  const conflicts: Conflict[] = [
    {
      key: "modrinth:sodium",
      kind: "item",
      severity: "normal",
      ours: "1",
      theirs: "2",
      message: "x",
    },
    {
      key: "@game",
      kind: "game",
      severity: "high",
      base: "26.2",
      ours: "26.1",
      theirs: "26.3",
      message: "g",
    },
  ];

  it("orders the high-severity @game cascade first and spells out consequences", () => {
    const cards = buildConflictCards(conflicts, ctx);
    expect(cards[0]?.conflict.key).toBe("@game");
    expect(cards[0]?.blast.count).toBe(2);
    const text = conflictCardSegments(cards[0] as (typeof cards)[number], 0, cards.length)
      .map(plainText)
      .join("\n");
    expect(text).toContain("[HIGH]");
    expect(text).toContain("blast radius");
    expect(text).toContain("re-lock preview");
  });
});

describe("tui: plain fallback emits NO ANSI escapes", () => {
  const packLock = lock([pkg("sodium", "mod", "modrinth", "0.6.0", "a")]);
  const rows = buildItemRows(packLock);

  it("the dashboard is greppable, ANSI-free, and keeps badge text", () => {
    const out = renderPlainDashboard({
      status: {
        hasManifest: true,
        hasLock: true,
        hasBuilt: false,
        manifestDirty: false,
        buildDirty: true,
        worktreeDirty: false,
        summary: "locked but never built — run `anvil build`",
      },
      lock: packLock,
      rows,
    });
    expect(out).not.toMatch(ANSI);
    expect(out).toContain("[mod]");
    expect(out).toContain("[modrinth]");
    expect(out).toContain("sodium");
  });

  it("the progress panel and conflict cards are ANSI-free too", () => {
    const progress = renderPlainProgress(
      reduceAll([
        { type: "transfer:plan", objects: 3, bytes: 10 },
        { type: "object:store", hash: h("a"), deduped: false },
        { type: "object:store", hash: h("b"), deduped: true },
      ]),
    );
    expect(progress).not.toMatch(ANSI);
    expect(progress).toContain("deduped");

    const cards = buildConflictCards(
      [
        {
          key: "@game",
          kind: "game",
          severity: "high",
          base: "26.2",
          ours: "26.1",
          theirs: "26.3",
          message: "g",
        },
      ],
      packContextFromLock(packLock),
    );
    const cardText = renderPlainConflictCards(cards);
    expect(cardText).not.toMatch(ANSI);
    expect(cardText).toContain("[HIGH]");
  });
});
