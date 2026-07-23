/**
 * `launchTui` — the entry the CLI calls when `lobbify-anvil` is run with **no
 * command**. It detects terminal capabilities once and forks:
 *
 *   - **plain** (`!isTTY` or `NO_COLOR`): print an ANSI-free dashboard and exit 0
 *     — pipes and CI still get useful, greppable output;
 *   - **interactive** (a real TTY, color allowed): mount the colorful Ink app with
 *     a `@clack/prompts` action menu (lock / build / merge / add / init).
 *
 * It carries no logic of its own: it loads state via `Anvil` + the library's
 * lock/graph readers and renders it; every action calls one `Anvil` method.
 */

import type { Writable } from "node:stream";
import { createElement as h } from "react";
import type { Anvil, StatusResult } from "../anvil.js";
import { readBuiltLock } from "../build/index.js";
import { readLockIfPresent } from "../lock/index.js";
import type { AnvilOptions, Lockfile } from "../types/index.js";
import { type Capabilities, type StreamLike, detectCapabilities } from "./capabilities.js";
import { Dashboard } from "./components.js";
import { runConflictMerge } from "./conflict-controller.js";
import { type ItemRow, buildItemRows } from "./item-list.js";
import { type DashboardData, renderPlainDashboard } from "./plain.js";
import { type InkStreams, inkResolveCard, renderLive, renderStaticInk } from "./runtime.js";
import {
  addWizard,
  chooseAction,
  confirmAction,
  initWizard,
  promptBranch,
  showNote,
  tuiIntro,
  tuiOutro,
} from "./wizard.js";

/** Options for {@link launchTui}. Streams + env are injected for testability. */
export interface LaunchOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where plain (non-interactive) output is written. */
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** The input stream (its `isTTY` decides interactivity). Defaults to stdin. */
  readonly stdin?: StreamLike;
  readonly makeAnvil: (options: AnvilOptions) => Anvil;
  /** Force capabilities (tests). Otherwise detected from the streams + env. */
  readonly capabilities?: Capabilities;
  /** The real-TTY streams Ink drives (defaults to `process.*`). */
  readonly inkStreams?: InkStreams;
}

/** Build `AnvilOptions` from cwd + env (mirrors the CLI command base). */
function optionsFromEnv(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): AnvilOptions {
  return {
    dir: cwd,
    ...(env.ANVIL_STORE_DIR ? { storeDir: env.ANVIL_STORE_DIR } : {}),
    ...(env.CURSEFORGE_API_KEY ? { curseforgeKey: env.CURSEFORGE_API_KEY } : {}),
  };
}

interface LoadedData extends DashboardData {
  readonly status: StatusResult;
  readonly lock?: Lockfile;
  readonly rows: readonly ItemRow[];
}

/** Load the dashboard data (status + item rows) for an instance. */
async function loadData(anvil: Anvil): Promise<LoadedData> {
  const status = await anvil.status();
  const lock = await readLockIfPresent(anvil.dir);
  const built = await readBuiltLock(anvil.dir);
  const rows: readonly ItemRow[] = lock ? buildItemRows(lock, built) : [];
  return { status, ...(lock ? { lock } : {}), rows };
}

/** Run the interactive Ink + clack loop until the user quits. */
async function runInteractive(anvil: Anvil, streams: InkStreams, unicode: boolean): Promise<void> {
  tuiIntro();
  let running = true;
  while (running) {
    const data = await loadData(anvil);
    await renderStaticInk(
      h(Dashboard, { status: data.status, lock: data.lock, rows: data.rows }),
      streams,
    );
    const action = await chooseAction();
    try {
      switch (action) {
        case "refresh":
          break;
        case "lock":
          await renderLive(anvil.progress, () => anvil.lock(), streams, unicode);
          break;
        case "build":
          if (await confirmAction("Build the instance now?")) {
            await renderLive(anvil.progress, () => anvil.build(), streams, unicode);
          }
          break;
        case "add":
          await addWizard(anvil);
          break;
        case "init":
          await initWizard(anvil);
          break;
        case "merge": {
          const branch = await promptBranch("Branch to merge in");
          if (branch) {
            const result = await runConflictMerge(anvil, branch, (card, i, total) =>
              inkResolveCard(card, i, total, streams, unicode),
            );
            const o = result.outcome;
            if (o.committed) {
              showNote(`merged — commit ${o.committed.id.value.slice(0, 12)}`, "merge");
            } else if (o.upToDate) {
              showNote("already up to date", "merge");
            } else {
              showNote(`${o.conflicts.length} unresolved conflict(s) — nothing committed`, "merge");
            }
          }
          break;
        }
        case "quit":
          running = false;
          break;
      }
    } catch (err) {
      showNote(err instanceof Error ? err.message : String(err), "error");
    }
  }
  tuiOutro("goodbye");
}

/**
 * Launch the TUI. Returns a process exit code; never throws for a normal run.
 */
export async function launchTui(opts: LaunchOptions): Promise<number> {
  const stdoutStream = opts.stdout as unknown as StreamLike;
  const caps =
    opts.capabilities ??
    detectCapabilities({
      env: opts.env,
      stdout: stdoutStream,
      stdin: opts.stdin ?? (process.stdin as StreamLike),
    });

  const anvil = opts.makeAnvil(optionsFromEnv(opts.cwd, opts.env));

  if (!caps.interactive) {
    try {
      const data = await loadData(anvil);
      opts.stdout.write(`${renderPlainDashboard(data)}\n`);
      return 0;
    } catch (err) {
      // A malformed lock/manifest must not reject the promise — report + exit code.
      opts.stderr.write(`tui error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 70;
    }
  }

  const inkStreams: InkStreams = opts.inkStreams ?? {
    stdout: opts.stdout as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    stderr: opts.stderr as unknown as NodeJS.WriteStream,
  };
  try {
    await runInteractive(anvil, inkStreams, caps.unicode);
    return 0;
  } catch (err) {
    opts.stderr.write(`tui error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 70;
  }
}
