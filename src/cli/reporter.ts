/**
 * The non-interactive progress renderer for the CLI's plain mode. It is a pure
 * consumer of the `Anvil` event bus (no logic): it turns the phase-level events
 * into concise stderr lines. `--json` mode suppresses these entirely and prints a
 * single result object instead (see the command runner), keeping stdout a clean,
 * parseable payload for CI.
 */

import type { AnvilEvent } from "../events.js";

/** A concise human progress line for an event, or `undefined` to stay quiet. */
export function describeEvent(event: AnvilEvent): string | undefined {
  switch (event.type) {
    case "resolve:start":
      return `resolving ${event.items} item${event.items === 1 ? "" : "s"}…`;
    case "resolve:done":
      return `resolved ${event.pinned} package${event.pinned === 1 ? "" : "s"}`;
    case "transfer:plan":
      return `transfer: ${event.objects} object${event.objects === 1 ? "" : "s"} (${event.bytes} bytes)`;
    case "build:stage":
      return `  ${event.phase}…`;
    case "build:done":
      return `built ${event.dir}`;
    case "verify:start":
      return `verifying ${event.items} target${event.items === 1 ? "" : "s"}…`;
    case "verify:item":
      return event.ok ? undefined : `  ✗ ${event.name}`;
    case "verify:done":
      return event.ok ? "verify: ok" : `verify: ${event.mismatches} mismatch(es)`;
    default:
      // object:*, build:start/swap, resolve:item, replay:*, pull:*, error —
      // either too granular for a plain log or handled elsewhere.
      return undefined;
  }
}
