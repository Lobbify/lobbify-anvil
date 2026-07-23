/**
 * The **Ink components** — the colorful, interactive rendering of the shared
 * {@link Line}/{@link Segment} model. Written with `createElement` (no JSX) so the
 * package needs no JSX/tsconfig changes and stays a plain-`.ts` build.
 *
 * Every component honors {@link ColorContext}: when color is disabled it emits
 * unstyled `<Text>` (no ANSI), so an Ink render degrades cleanly too — though the
 * production non-TTY path uses the Ink-free plain renderer (see plain.ts).
 *
 * These are pure presentation: they render library data and, for the conflict
 * prompt, forward a keypress to a callback. No merge/build logic lives here.
 */

import { Box, Text, useInput } from "ink";
import {
  Fragment,
  createContext,
  createElement as h,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import type { StatusResult } from "../anvil.js";
import type { AnvilEvent } from "../events.js";
import type { Lockfile } from "../types/index.js";
import type { Resolution } from "../vc/index.js";
import { CHOICE_HINTS, type ConflictCard, conflictCardSegments } from "./conflict-model.js";
import { type ItemRow, gameSummary, itemRowSegments } from "./item-list.js";
import {
  type ProgressState,
  initialProgress,
  progressSegments,
  reduceProgress,
} from "./progress-model.js";
import type { Line, Segment } from "./segments.js";
import { inkColor } from "./theme.js";

/** Whether Ink components apply color. `true` in the interactive path. */
export const ColorContext = createContext<boolean>(true);

/** Wrap a subtree with an explicit color setting (used by tests + launch). */
export function ColorProvider(props: { value: boolean; children?: ReactNode }): ReactElement {
  return h(ColorContext.Provider, { value: props.value }, props.children);
}

/** The event-bus shape a live view subscribes to (structurally `ProgressBus`). */
export interface EventBusLike {
  on(listener: (event: AnvilEvent) => void): () => void;
}

/** Map a segment to Ink `<Text>` props, dropping all styling when color is off. */
function inkProps(
  s: Segment,
  colorEnabled: boolean,
): {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
} {
  if (!colorEnabled) {
    return {};
  }
  return {
    ...(s.color ? { color: inkColor(s.color) } : {}),
    ...(s.bg ? { backgroundColor: inkColor(s.bg) } : {}),
    ...(s.bold ? { bold: true } : {}),
    ...(s.dim ? { dimColor: true } : {}),
  };
}

/** Render one line as inline colored `<Text>` runs. */
export function SegmentText(props: { segments: Line }): ReactElement {
  const colorEnabled = useContext(ColorContext);
  return h(
    Text,
    null,
    props.segments.map((s, i) => h(Text, { key: i, ...inkProps(s, colorEnabled) }, s.text)),
  );
}

/** Render a block of lines as a vertical `<Box>`. */
export function Lines(props: { lines: readonly Line[] }): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    props.lines.map((line, i) => h(SegmentText, { key: i, segments: line })),
  );
}

/** The item list: an optional heading + one row per item (badges + semver). */
export function ItemListView(props: { rows: readonly ItemRow[]; title?: string }): ReactElement {
  const heading: Line | undefined = props.title
    ? [{ text: props.title, color: "heading", bold: true }]
    : undefined;
  const body: ReactElement =
    props.rows.length === 0
      ? h(SegmentText, { segments: [{ text: "no items", color: "muted" }] })
      : h(Lines, { lines: props.rows.map(itemRowSegments) });
  return h(
    Box,
    { flexDirection: "column" },
    heading ? h(SegmentText, { segments: heading }) : null,
    body,
  );
}

/** The live progress panel — folds the event bus into bars. */
export function ProgressView(props: { bus: EventBusLike; unicode?: boolean }): ReactElement {
  const [state, setState] = useState<ProgressState>(initialProgress);
  useEffect(() => {
    const off = props.bus.on((event) => {
      setState((prev) => reduceProgress(prev, event));
    });
    return off;
  }, [props.bus]);
  return h(Lines, { lines: progressSegments(state, props.unicode ?? true) });
}

/** One conflict card, framed by severity color. */
export function ConflictCardView(props: {
  card: ConflictCard;
  index: number;
  total: number;
  unicode?: boolean;
}): ReactElement {
  const colorEnabled = useContext(ColorContext);
  const unicode = props.unicode ?? true;
  const severe = props.card.conflict.severity === "high";
  const border = colorEnabled ? { borderColor: inkColor(severe ? "high" : "normal") } : {};
  return h(
    Box,
    { flexDirection: "column", borderStyle: unicode ? "round" : "classic", paddingX: 1, ...border },
    h(Lines, { lines: conflictCardSegments(props.card, props.index, props.total) }),
  );
}

/**
 * An interactive one-card prompt: renders the card and forwards the chosen key
 * (o/t/n/s) to `onChoose` as a {@link Resolution} (or `undefined` to skip).
 */
export function ConflictCardPrompt(props: {
  card: ConflictCard;
  index: number;
  total: number;
  unicode?: boolean;
  onChoose: (resolution: Resolution | undefined) => void;
}): ReactElement {
  useInput((input) => {
    const key = input.toLowerCase();
    if (key === "o") {
      props.onChoose({ choose: "ours" });
    } else if (key === "t") {
      props.onChoose({ choose: "theirs" });
    } else if (key === "n") {
      props.onChoose({ choose: "newest" });
    } else if (key === "s") {
      props.onChoose(undefined);
    }
  });
  return h(
    Box,
    { flexDirection: "column" },
    h(ConflictCardView, {
      card: props.card,
      index: props.index,
      total: props.total,
      unicode: props.unicode,
    }),
    h(SegmentText, {
      segments: [
        { text: "press ", color: "muted" },
        ...CHOICE_HINTS.flatMap((c) => [
          { text: c.key, color: "accent" as const, bold: true },
          { text: `=${c.label} `, color: "muted" as const },
        ]),
      ],
    }),
  );
}

/** The instance dashboard: status + game base + the item list. */
export function Dashboard(props: {
  status: StatusResult;
  lock?: Lockfile;
  rows: readonly ItemRow[];
}): ReactElement {
  return h(
    Box,
    { flexDirection: "column" },
    h(SegmentText, { segments: [{ text: "lobbify-anvil", color: "heading", bold: true }] }),
    h(SegmentText, { segments: [{ text: props.status.summary, color: "muted" }] }),
    props.lock ? h(SegmentText, { segments: gameSummary(props.lock) }) : null,
    h(
      Box,
      { marginTop: 1 },
      h(ItemListView, { rows: props.rows, title: `items (${props.rows.length})` }),
    ),
  );
}

/** Render its children once, then request exit (a static, colorful frame). */
export function Once(props: { children?: ReactNode; onMount: () => void }): ReactElement {
  useEffect(() => {
    props.onMount();
  }, [props.onMount]);
  return h(Fragment, null, props.children);
}
