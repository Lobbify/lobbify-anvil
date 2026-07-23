/**
 * Ink **render drivers** — the small imperative helpers that mount the pure
 * components for the three live moments: a one-shot static frame (the dashboard),
 * a live panel bound to the event bus (lock / build), and a per-card interactive
 * prompt (conflict resolution). Kept apart from the components so the components
 * stay trivially snapshot-testable and this file owns all the `render()` glue.
 */

import { render } from "ink";
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { Resolution } from "../vc/index.js";
import { ConflictCardPrompt, type EventBusLike, Once, ProgressView } from "./components.js";
import type { ConflictCard } from "./conflict-model.js";

/** The real-TTY streams Ink drives (a subset of `RenderOptions`). */
export interface InkStreams {
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
  readonly stderr?: NodeJS.WriteStream;
}

/** Render `element` once, print the frame, then unmount (a static banner). */
export async function renderStaticInk(element: ReactElement, streams: InkStreams): Promise<void> {
  const app = render(
    h(
      Once,
      {
        onMount: () => {
          app.unmount();
        },
      },
      element,
    ),
    { ...streams, exitOnCtrlC: false },
  );
  await app.waitUntilExit();
}

/**
 * Mount a live {@link ProgressView} bound to `bus`, run `op`, and keep the bars on
 * screen until it settles. Returns `op`'s result (or rethrows its error) with the
 * view always unmounted.
 */
export async function renderLive<T>(
  bus: EventBusLike,
  op: () => Promise<T>,
  streams: InkStreams,
  unicode = true,
): Promise<T> {
  const app = render(h(ProgressView, { bus, unicode }), { ...streams, exitOnCtrlC: false });
  // Let the view's `useEffect` subscription attach before the operation starts,
  // so the first resolve/transfer events are not emitted into a void.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await op();
  } finally {
    // Let React flush the terminal state from the last event before unmounting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.unmount();
    await app.waitUntilExit();
  }
}

/**
 * Present one interactive conflict card and resolve with the user's choice
 * (o/t/n) or `undefined` (skip). Used as the `resolveCard` hook of the controller.
 */
export function inkResolveCard(
  card: ConflictCard,
  index: number,
  total: number,
  streams: InkStreams,
  unicode = true,
): Promise<Resolution | undefined> {
  return new Promise((resolve) => {
    const app = render(
      h(ConflictCardPrompt, {
        card,
        index,
        total,
        unicode,
        onChoose: (resolution) => {
          app.unmount();
          resolve(resolution);
        },
      }),
      { ...streams, exitOnCtrlC: false },
    );
  });
}
