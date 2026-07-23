/**
 * The **@clack/prompts** guided flows — the lightweight linear wizards where a
 * full Ink render is overkill: the init wizard, the add-items flow (with a
 * resolved-dependency preview), the main action menu, and confirmations.
 *
 * These stay thin skins: each prompts, then calls exactly one `Anvil` method and
 * reports. `picocolors` adds color to the prompt chrome (it self-disables under
 * `NO_COLOR` / non-TTY). All behavior lives in the library.
 */

import { basename } from "node:path";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import type { Anvil } from "../anvil.js";
import { readGraph } from "../build/index.js";

/** The actions the interactive main menu offers. */
export type TuiAction = "refresh" | "lock" | "build" | "merge" | "add" | "init" | "quit";

/** True when a clack prompt was cancelled (Ctrl-C / Esc). */
function cancelled(value: unknown): value is symbol {
  return isCancel(value);
}

/** The colorful intro banner for the interactive session. */
export function tuiIntro(): void {
  intro(`${pc.bgCyan(pc.black(" lobbify-anvil "))} ${pc.dim("interactive")}`);
}

/** The closing line. */
export function tuiOutro(message = "done"): void {
  outro(pc.dim(message));
}

/** The main action menu. Returns the chosen action (or `quit` on cancel). */
export async function chooseAction(): Promise<TuiAction> {
  const choice = await select({
    message: "What would you like to do?",
    options: [
      { value: "refresh", label: "Refresh", hint: "reload status + items" },
      { value: "lock", label: "Lock", hint: "resolve the manifest → anvil.lock" },
      { value: "build", label: "Build", hint: "install the instance" },
      { value: "merge", label: "Merge a branch", hint: "3-way merge with conflict cards" },
      { value: "add", label: "Add items", hint: "append refs to the manifest" },
      { value: "init", label: "Init", hint: "scaffold anvil.toml" },
      { value: "quit", label: "Quit" },
    ],
  });
  if (cancelled(choice)) {
    return "quit";
  }
  return choice as TuiAction;
}

/** The init wizard — scaffold `anvil.toml`. Returns true when created. */
export async function initWizard(anvil: Anvil): Promise<boolean> {
  const name = await text({
    message: "Project name",
    placeholder: basename(anvil.dir),
    defaultValue: basename(anvil.dir),
  });
  if (cancelled(name)) {
    cancel("init cancelled");
    return false;
  }
  const minecraft = await text({
    message: "Minecraft version",
    placeholder: "26.2",
    validate: (v) => (v.trim() === "" ? "a Minecraft version is required" : undefined),
  });
  if (cancelled(minecraft)) {
    cancel("init cancelled");
    return false;
  }
  const loaderKind = await select({
    message: "Mod loader",
    options: [
      { value: "vanilla", label: "Vanilla (no loader)" },
      { value: "fabric", label: "Fabric" },
      { value: "quilt", label: "Quilt" },
    ],
  });
  if (cancelled(loaderKind)) {
    cancel("init cancelled");
    return false;
  }
  let loader = loaderKind as string;
  if (loader !== "vanilla") {
    const version = await text({
      message: `${loader} loader version (blank = latest at lock time)`,
      placeholder: "0.19.1",
    });
    if (cancelled(version)) {
      cancel("init cancelled");
      return false;
    }
    loader = version.trim() ? `${loader} ${version.trim()}` : loader;
  }
  try {
    const manifest = await anvil.init({ name: String(name), minecraft: String(minecraft), loader });
    note(
      `${pc.green("created")} anvil.toml — ${pc.bold(manifest.project.name)}, Minecraft ${pc.yellow(
        manifest.game.minecraft,
      )}, ${manifest.game.loader}`,
      "init",
    );
    return true;
  } catch (err) {
    note(pc.red(err instanceof Error ? err.message : String(err)), "init failed");
    return false;
  }
}

/** The add-items flow — append refs, optionally lock, and preview dependencies. */
export async function addWizard(anvil: Anvil): Promise<boolean> {
  const raw = await text({
    message: "Items to add (space- or comma-separated: source:id@ver, a URL, or ./path)",
    placeholder: "modrinth:sodium modrinth:lithium",
    validate: (v) => (v.trim() === "" ? "enter at least one item" : undefined),
  });
  if (cancelled(raw)) {
    cancel("add cancelled");
    return false;
  }
  const refs = String(raw)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const manifest = await anvil.addItems(refs);
    note(
      `${pc.green("added")} — manifest now lists ${pc.bold(String(manifest.items.length))} item(s)`,
      "add",
    );
  } catch (err) {
    note(pc.red(err instanceof Error ? err.message : String(err)), "add failed");
    return false;
  }

  const doLock = await confirm({ message: "Resolve and lock now (with a dependency preview)?" });
  if (cancelled(doLock) || !doLock) {
    return true;
  }
  const spin = spinner();
  spin.start("resolving…");
  try {
    const lock = await anvil.lock();
    spin.stop(`locked ${lock.resolved.length} package(s)`);
    const graph = await readGraph(anvil.dir);
    const deps = graph
      ? new Set(graph.edges.filter((e) => e.by !== "(manifest)").map((e) => e.childName))
      : new Set<string>();
    note(
      deps.size === 0
        ? "no transitive dependencies were pulled in"
        : `pulled ${pc.bold(String(deps.size))} dependency(ies): ${pc.dim([...deps].sort().join(", "))}`,
      "dependency preview",
    );
    return true;
  } catch (err) {
    spin.stop("lock failed");
    note(pc.red(err instanceof Error ? err.message : String(err)), "lock failed");
    return false;
  }
}

/** Prompt for a branch name (for merge). Returns the name, or undefined on cancel. */
export async function promptBranch(message: string): Promise<string | undefined> {
  const branch = await text({ message, placeholder: "feature" });
  if (cancelled(branch) || String(branch).trim() === "") {
    return undefined;
  }
  return String(branch).trim();
}

/** A yes/no confirmation. */
export async function confirmAction(message: string): Promise<boolean> {
  const answer = await confirm({ message });
  return !cancelled(answer) && answer === true;
}

/** Show a note (used to surface an operation's result in the menu loop). */
export function showNote(message: string, title?: string): void {
  note(message, title);
}
