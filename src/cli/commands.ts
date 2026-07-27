/**
 * The clipanion command classes — the thin `lobbify-anvil` skin over the `Anvil`
 * library. Each command only parses arguments, constructs an `Anvil` (via the
 * context factory), subscribes the progress reporter, calls exactly one library
 * method, and renders the result. There is **no business logic here**: a command
 * that computes anything instead of delegating to `Anvil` is a bug.
 */

import { basename, resolve } from "node:path";
import { Command, Option } from "clipanion";
import type { Anvil } from "../anvil.js";
import type { RemoteKind } from "../remote/index.js";
import type { AnvilOptions } from "../types/index.js";
import type { ConflictStrategy } from "../vc/index.js";
import { describeConflict } from "../vc/index.js";

/** Validate a `--kind` string against the allowed remote kinds. */
function parseRemoteKind(raw: string | undefined): RemoteKind | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "git" || raw === "url" || raw === "room") {
    return raw;
  }
  throw new Error(`invalid --kind "${raw}" (expected git | url | room)`);
}
import type { AnvilCliContext } from "./context.js";
import { EXIT_ERROR, EXIT_OK, renderError } from "./errors.js";
import { describeEvent } from "./reporter.js";

/** The one-of `--ours/--theirs/--newest/--manual` conflict strategy from four booleans. */
function pickStrategy(flags: {
  ours: boolean;
  theirs: boolean;
  newest: boolean;
  manual: boolean;
}): ConflictStrategy | undefined {
  if (flags.ours) {
    return "ours";
  }
  if (flags.theirs) {
    return "theirs";
  }
  if (flags.newest) {
    return "newest";
  }
  if (flags.manual) {
    return "manual";
  }
  return undefined;
}

/** The compact `algo:value` short form used in plain command output. */
function shortId(hash: { algo: string; value: string }): string {
  return `${hash.value.slice(0, 12)}`;
}

/** A rendered command result: plain-mode lines + a JSON payload. */
type Render<T> = {
  readonly plain: (result: T) => readonly string[];
  readonly json: (result: T) => Record<string, unknown>;
  /** The process exit code for a result (default: {@link EXIT_OK}). */
  readonly exitCode?: (result: T) => number;
};

/** Shared base: the `--dir` / `--json` options and the run harness. */
abstract class AnvilCommand extends Command<AnvilCliContext> {
  dir = Option.String("--dir", {
    description: "Instance directory (defaults to the current directory)",
  });
  json = Option.Boolean("--json", false, {
    description: "Emit a single machine-readable JSON result on stdout",
  });

  protected instanceDir(): string {
    return resolve(this.context.cwd, this.dir ?? ".");
  }

  /** Build the base `AnvilOptions` from env + the resolved instance dir. */
  protected options(extra?: Partial<AnvilOptions>): AnvilOptions {
    const env = this.context.env;
    return {
      dir: this.instanceDir(),
      ...(env.ANVIL_STORE_DIR ? { storeDir: env.ANVIL_STORE_DIR } : {}),
      ...(env.CURSEFORGE_API_KEY ? { curseforgeKey: env.CURSEFORGE_API_KEY } : {}),
      ...extra,
    };
  }

  /** Construct the Anvil, wire progress, run one method, render, map exit code. */
  protected async run<T>(
    exec: (anvil: Anvil) => Promise<T>,
    render: Render<T>,
    options?: Partial<AnvilOptions>,
  ): Promise<number> {
    const anvil = this.context.makeAnvil(this.options(options));
    const off = anvil.on("progress", (event) => {
      if (!this.json) {
        const line = describeEvent(event);
        if (line !== undefined) {
          this.context.stderr.write(`${line}\n`);
        }
      }
    });
    try {
      const result = await exec(anvil);
      off();
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify({ ok: true, ...render.json(result) })}\n`);
      } else {
        for (const line of render.plain(result)) {
          this.context.stdout.write(`${line}\n`);
        }
      }
      return render.exitCode ? render.exitCode(result) : EXIT_OK;
    } catch (err) {
      off();
      return renderError(err, this.context, this.json);
    }
  }
}

const MANIFEST_FILENAME = "anvil.toml";

export class InitCommand extends AnvilCommand {
  static override paths = [["init"]];
  static override usage = Command.Usage({
    description: "Scaffold anvil.toml (and a .anvilignore) for a fresh instance",
  });

  // An optional positional target dir/name (`anvil init my-pack`), git init <dir> /
  // uv init <name> style — an alias for --dir. Both may be given only if they name
  // the same directory.
  directory = Option.String({ required: false, name: "dir" });
  name = Option.String("--name", { description: "Project name (default: directory name)" });
  minecraft = Option.String("--minecraft,--mc", { description: "Minecraft version (required)" });
  loader = Option.String("--loader", {
    description: "Loader: 'fabric <v>' | 'quilt <v>' | 'vanilla' (default)",
  });
  projectVersion = Option.String("--project-version", {
    description: "Pack version (default 0.1.0)",
  });
  summary = Option.String("--summary", { description: "One-line project summary" });
  force = Option.Boolean("--force", false, { description: "Overwrite an existing anvil.toml" });

  /**
   * Emit a usage error honoring the --json contract (exactly one JSON object on
   * stdout) or a plain `error: …` on stderr — never a mixed/empty payload a CI
   * parser would choke on.
   */
  #usage(message: string): number {
    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "USAGE", message, exitCode: EXIT_ERROR } })}\n`,
      );
    } else {
      this.context.stderr.write(`error: ${message}\n`);
    }
    return EXIT_ERROR;
  }

  override async execute(): Promise<number> {
    // Reconcile the positional dir/name with --dir: both set the target instance
    // directory, and are accepted together only when they agree — a genuine
    // mismatch is a clear error, never a silent pick of one.
    if (this.directory !== undefined) {
      if (
        this.dir !== undefined &&
        resolve(this.context.cwd, this.dir) !== resolve(this.context.cwd, this.directory)
      ) {
        return this.#usage(
          `conflicting target directory: positional "${this.directory}" and --dir "${this.dir}" differ — pass only one`,
        );
      }
      this.dir = this.directory;
    }
    if (!this.minecraft) {
      return this.#usage(
        "a Minecraft version is required — pass --minecraft <version> (e.g. --minecraft 26.2)",
      );
    }
    const name = this.name ?? basename(this.instanceDir());
    const minecraft = this.minecraft;
    return this.run(
      (anvil) =>
        anvil.init({
          name,
          minecraft,
          ...(this.loader ? { loader: this.loader } : {}),
          ...(this.projectVersion ? { version: this.projectVersion } : {}),
          ...(this.summary ? { summary: this.summary } : {}),
          force: this.force,
        }),
      {
        plain: (m) => [
          `initialized ${MANIFEST_FILENAME} for "${m.project.name}" — Minecraft ${m.game.minecraft}, ${m.game.loader}`,
        ],
        json: (m) => ({ project: m.project, game: m.game }),
      },
    );
  }
}

export class AddCommand extends AnvilCommand {
  static override paths = [["add"]];
  static override usage = Command.Usage({
    description: "Add item references (source:id@ver | a URL | ./path) to the manifest",
  });
  items = Option.Rest({ required: 1 });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.addItems(this.items), {
      plain: (m) => [`manifest now lists ${m.items.length} item(s)`],
      json: (m) => ({ items: m.items.length }),
    });
  }
}

export class RemoveCommand extends AnvilCommand {
  static override paths = [["remove"]];
  static override usage = Command.Usage({
    description: "Remove item references from the manifest (by identity)",
  });
  items = Option.Rest({ required: 1 });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.removeItems(this.items), {
      plain: (m) => [`manifest now lists ${m.items.length} item(s)`],
      json: (m) => ({ items: m.items.length }),
    });
  }
}

export class LockCommand extends AnvilCommand {
  static override paths = [["lock"]];
  static override usage = Command.Usage({
    description: "Resolve the manifest and freeze a fully-pinned anvil.lock",
  });
  upgrade = Option.String("--upgrade", {
    tolerateBoolean: true,
    description: "Re-resolve to newer versions: bare = everything, or --upgrade=<item> for one",
  });

  #upgradeArg(): boolean | readonly string[] | undefined {
    if (this.upgrade === true) {
      return true; // bare `--upgrade` → upgrade everything
    }
    if (typeof this.upgrade === "string") {
      return [this.upgrade]; // `--upgrade=<item>` → upgrade one
    }
    return undefined;
  }

  override async execute(): Promise<number> {
    const upgrade = this.#upgradeArg();
    return this.run((anvil) => anvil.lock(upgrade !== undefined ? { upgrade } : {}), {
      plain: (lock) => [`locked ${lock.resolved.length} package(s) → ${MANIFEST_FILENAME_LOCK}`],
      json: (lock) => ({
        packages: lock.resolved.length,
        minecraft: lock.meta.minecraft,
        loader: lock.meta.loader,
      }),
    });
  }
}

const MANIFEST_FILENAME_LOCK = "anvil.lock";

export class BuildCommand extends AnvilCommand {
  static override paths = [["build"]];
  static override usage = Command.Usage({
    description: "Install a launch-ready instance from the lock, atomically",
  });
  offline = Option.Boolean("--offline", false, {
    description: "Build only from the populated store; error on the first missing object",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.build(this.offline ? { offline: true } : {}), {
      plain: (r) => [`built ${r.dir} (${r.objects} object(s) materialized)`],
      json: (r) => ({ dir: r.dir, objects: r.objects }),
    });
  }
}

export class VerifyCommand extends AnvilCommand {
  static override paths = [["verify"]];
  static override usage = Command.Usage({
    description: "Re-hash the materialized instance against its lock",
  });
  strict = Option.Boolean("--strict", false, {
    description: "Also fail if the instance has drifted from the current lock",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.verify(this.strict ? { strict: true } : {}), {
      plain: (r) =>
        r.ok
          ? ["verify: ok — every target matches its pin"]
          : [
              `verify: ${r.mismatches.length} mismatch(es):`,
              ...r.mismatches.map((m) => `  ✗ ${m}`),
            ],
      json: (r) => ({ ok: r.ok, mismatches: r.mismatches }),
      exitCode: (r) => (r.ok ? EXIT_OK : EXIT_ERROR),
    });
  }
}

export class ImportCommand extends AnvilCommand {
  static override paths = [["import"]];
  static override usage = Command.Usage({
    description:
      "Adopt a pack into this instance: a .mrpack, a CurseForge zip, or a Prism/MultiMC directory",
  });
  archive = Option.String({ required: true, name: "archive" });

  override async execute(): Promise<number> {
    const archive = resolve(this.context.cwd, this.archive);
    return this.run((anvil) => anvil.import(archive), {
      plain: (r) => [
        `imported ${this.archive} → ${MANIFEST_FILENAME} + ${MANIFEST_FILENAME_LOCK} ` +
          `(${r.files} file(s), ${r.overrides} override(s))`,
        ...r.warnings.map((w) => `  ! ${w}`),
      ],
      json: (r) => ({ archive: this.archive, ...r }),
    });
  }
}

export class StatusCommand extends AnvilCommand {
  static override paths = [["status"]];
  static override usage = Command.Usage({
    description: "Show the manifest-vs-lock-vs-built dirty state",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.status(), {
      plain: (s) => [
        s.summary,
        `  manifest: ${manifestState(s)}  ·  lock: ${
          s.hasLock ? (s.manifestDirty ? "stale" : "present") : "missing"
        }  ·  built: ${s.hasBuilt ? (s.buildDirty ? "out-of-date" : "current") : "never"}` +
          `  ·  worktree: ${s.worktreeDirty ? "uncommitted" : "up to date"}`,
      ],
      json: (s) => ({ status: s }),
      // A present-but-unparseable manifest is a real problem, not a clean state.
      exitCode: (s) => (s.manifestError ? EXIT_ERROR : EXIT_OK),
    });
  }
}

/** The manifest cell for the status detail line. */
function manifestState(s: {
  hasManifest: boolean;
  manifestError?: string;
}): string {
  if (!s.hasManifest) {
    return "missing";
  }
  return s.manifestError ? "unparseable" : "present";
}

export class DiffCommand extends AnvilCommand {
  static override paths = [["diff"]];
  static override usage = Command.Usage({
    description: "Show the package delta the next build would apply (lock vs built)",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.diff(), {
      plain: (d) => {
        if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) {
          return ["no changes — the built instance matches the lock"];
        }
        const lines: string[] = [];
        for (const p of d.added) {
          lines.push(`+ ${p.name}${p.version ? ` ${p.version}` : ""}`);
        }
        for (const p of d.removed) {
          lines.push(`- ${p.name}${p.version ? ` ${p.version}` : ""}`);
        }
        for (const c of d.changed) {
          lines.push(`~ ${c.name}  ${c.from ?? "?"} → ${c.to ?? "?"}`);
        }
        return lines;
      },
      json: (d) => ({
        added: d.added.map((p) => p.name),
        removed: d.removed.map((p) => p.name),
        changed: d.changed,
      }),
    });
  }
}

export class WhyCommand extends AnvilCommand {
  static override paths = [["why"]];
  static override usage = Command.Usage({
    description: "Explain which root item pulled a (transitive) dependency in",
  });
  item = Option.String({ required: true, name: "item" });

  override async execute(): Promise<number> {
    const item = this.item;
    return this.run((anvil) => anvil.why(item), {
      plain: (w) => {
        if (!w.present) {
          return [`"${item}" is not in the dependency graph (unknown item, or run \`anvil lock\`)`];
        }
        const lines = [
          `"${item}" is required by: ${w.roots.join(", ") || "(nothing — it is a root)"}`,
        ];
        for (const chain of w.chains) {
          lines.push(`  ${chain.join(" → ")}`);
        }
        return lines;
      },
      json: (w) => ({ why: w }),
    });
  }
}

export class GcCommand extends AnvilCommand {
  static override paths = [["gc"]];
  static override usage = Command.Usage({
    description: "Mark-sweep unreachable objects from the content store",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.gc(), {
      plain: (r) => [`gc: removed ${r.removed} object(s), freed ${r.freedBytes} byte(s)`],
      json: (r) => ({ removed: r.removed, freedBytes: r.freedBytes }),
    });
  }
}

export class FsckCommand extends AnvilCommand {
  static override paths = [["fsck"]];
  static override usage = Command.Usage({
    description: "Re-hash every stored object and report content-address drift",
  });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.fsck(), {
      plain: (r) =>
        r.ok
          ? ["fsck: ok — every object matches its content address"]
          : [`fsck: ${r.problems.length} problem(s):`, ...r.problems.map((p) => `  ✗ ${p}`)],
      json: (r) => ({ ok: r.ok, problems: r.problems }),
      exitCode: (r) => (r.ok ? EXIT_OK : EXIT_ERROR),
    });
  }
}

// --- version control (Stage 5) ---------------------------------------------

export class CommitCommand extends AnvilCommand {
  static override paths = [["commit"]];
  static override usage = Command.Usage({
    description: "Snapshot the manifest + lock into history (the manifest is the index)",
  });
  message = Option.String("-m,--message", { description: "Commit message (required)" });

  override async execute(): Promise<number> {
    if (!this.message) {
      const msg = "`commit` requires -m <message>";
      this.context.stderr.write(`error: ${msg}\n`);
      return EXIT_ERROR;
    }
    const message = this.message;
    return this.run((anvil) => anvil.commit(message), {
      plain: (c) => [`committed ${shortId(c.id)} (generation ${c.generation})`],
      json: (c) => ({ id: `${c.id.algo}:${c.id.value}`, generation: c.generation }),
    });
  }
}

export class BranchCommand extends AnvilCommand {
  static override paths = [["branch"]];
  static override usage = Command.Usage({
    description: "Create a branch at HEAD (does not switch to it)",
  });
  name = Option.String({ required: true, name: "name" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.branch(this.name), {
      plain: (c) => [`created branch "${this.name}" at ${shortId(c.id)}`],
      json: (c) => ({ branch: this.name, at: `${c.id.algo}:${c.id.value}` }),
    });
  }
}

export class SwitchCommand extends AnvilCommand {
  static override paths = [["switch"]];
  static override usage = Command.Usage({
    description: "Move the working tree + HEAD to a branch / tag / commit (by hash-diff)",
  });
  ref = Option.String({ required: true, name: "ref" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.switch(this.ref), {
      plain: (c) => [`switched to ${this.ref} (${shortId(c.id)})`],
      json: (c) => ({ ref: this.ref, id: `${c.id.algo}:${c.id.value}` }),
    });
  }
}

export class LogCommand extends AnvilCommand {
  static override paths = [["log"]];
  static override usage = Command.Usage({
    description: "Show history reachable from HEAD (newest-first by generation)",
  });
  start = Option.String({ required: false, name: "start" });
  graph = Option.Boolean("--graph", false, { description: "Prefix each commit with a graph rail" });
  stat = Option.Boolean("--stat", false, { description: "Show the item-set delta per commit" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.log(this.start), {
      plain: (entries) => {
        if (entries.length === 0) {
          return ["no commits yet"];
        }
        const lines: string[] = [];
        for (const e of entries) {
          const rail = this.graph ? "* " : "";
          const refs = e.refs.length > 0 ? ` (${e.refs.join(", ")})` : "";
          lines.push(`${rail}${shortId(e.id)} [gen ${e.gen}] ${e.op}: ${e.message}${refs}`);
          if (this.stat) {
            if (e.stat.game) {
              lines.push(
                `    @game ${e.stat.game.from.minecraft}/${e.stat.game.from.loader} → ${e.stat.game.to.minecraft}/${e.stat.game.to.loader}`,
              );
            }
            for (const a of e.stat.added) {
              lines.push(`    + ${a.key}`);
            }
            for (const c of e.stat.changed) {
              lines.push(`    ~ ${c.to.key}`);
            }
            for (const r of e.stat.removed) {
              lines.push(`    - ${r.key}`);
            }
          }
        }
        return lines;
      },
      json: (entries) => ({
        commits: entries.map((e) => ({
          id: `${e.id.algo}:${e.id.value}`,
          gen: e.gen,
          op: e.op,
          message: e.message,
          parents: e.parents.map((p) => `${p.algo}:${p.value}`),
          refs: e.refs,
        })),
      }),
    });
  }
}

/** Shared `--ours/--theirs/--newest/--manual` flags for merge + rebase. */
abstract class ResolvingCommand extends AnvilCommand {
  ours = Option.Boolean("--ours", false, {
    description: "Resolve every conflict in favor of ours",
  });
  theirs = Option.Boolean("--theirs", false, {
    description: "Resolve every conflict in favor of theirs",
  });
  newest = Option.Boolean("--newest", false, {
    description: "Resolve conflicts to the newer version",
  });
  manual = Option.Boolean("--manual", false, {
    description: "Leave conflicts for manual resolution",
  });

  protected strategyOption(): { strategy: ConflictStrategy } | Record<string, never> {
    const strategy = pickStrategy(this);
    return strategy ? { strategy } : {};
  }
}

export class MergeCommand extends ResolvingCommand {
  static override paths = [["merge"]];
  static override usage = Command.Usage({
    description: "3-way merge a branch's item set into HEAD, then a constrained re-lock",
  });
  branch = Option.String({ required: true, name: "branch" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.merge(this.branch, this.strategyOption()), {
      plain: (r) => {
        if (r.upToDate) {
          return ["already up to date"];
        }
        if (r.committed) {
          const kind = r.fastForward ? "fast-forwarded to" : "merged as";
          return [
            ...r.warnings.map((w) => `warning: ${w}`),
            `${kind} ${shortId(r.committed.id)} (generation ${r.committed.generation})`,
          ];
        }
        return [
          `merge stopped — ${r.conflicts.length} conflict(s), nothing committed:`,
          ...r.conflicts.map((c) => `  ${describeConflict(c)}`),
        ];
      },
      json: (r) => ({
        committed: r.committed ? `${r.committed.id.algo}:${r.committed.id.value}` : null,
        fastForward: r.fastForward,
        upToDate: r.upToDate,
        conflicts: r.conflicts,
        warnings: r.warnings,
      }),
      exitCode: (r) => (r.conflicts.length > 0 ? EXIT_ERROR : EXIT_OK),
    });
  }
}

export class RevertCommand extends AnvilCommand {
  static override paths = [["revert"]];
  static override usage = Command.Usage({
    description: "Create a new commit that undoes a past commit's item-delta, then re-locks",
  });
  ref = Option.String({ required: true, name: "ref" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.revert(this.ref), {
      plain: (r) =>
        r.committed
          ? [
              ...r.warnings.map((w) => `warning: ${w}`),
              `reverted — committed ${shortId(r.committed.id)} (generation ${r.committed.generation})`,
            ]
          : [
              `revert stopped — ${r.conflicts.length} conflict(s), nothing committed:`,
              ...r.conflicts.map((c) => `  ${describeConflict(c)}`),
            ],
      json: (r) => ({
        committed: r.committed ? `${r.committed.id.algo}:${r.committed.id.value}` : null,
        conflicts: r.conflicts,
        warnings: r.warnings,
      }),
      exitCode: (r) => (r.conflicts.length > 0 ? EXIT_ERROR : EXIT_OK),
    });
  }
}

export class RebaseCommand extends ResolvingCommand {
  static override paths = [["rebase"]];
  static override usage = Command.Usage({
    description:
      "Replay the current branch onto another ref (per-commit re-lock, crash-survivable)",
  });
  onto = Option.String({ required: false, name: "onto" });
  continue = Option.Boolean("--continue", false, { description: "Resume a paused rebase" });
  skip = Option.Boolean("--skip", false, { description: "Drop the current commit and continue" });
  abort = Option.Boolean("--abort", false, { description: "Abort, restoring ORIG_HEAD" });

  override async execute(): Promise<number> {
    return this.run(
      (anvil) =>
        anvil.rebase({
          ...(this.onto ? { onto: this.onto } : {}),
          continue: this.continue,
          skip: this.skip,
          abort: this.abort,
          ...this.strategyOption(),
        }),
      {
        plain: (r) => {
          switch (r.status) {
            case "done":
              return [
                ...r.warnings.map((w) => `warning: ${w}`),
                r.head
                  ? `rebase complete — HEAD at ${shortId(r.head.id)} (generation ${r.head.generation})`
                  : "rebase complete",
              ];
            case "up-to-date":
              return ["already up to date — nothing to rebase"];
            case "aborted":
              return ["rebase aborted — restored ORIG_HEAD"];
            default:
              return [
                `rebase paused — ${r.conflicts.length} conflict(s), ${r.remaining} commit(s) remaining:`,
                ...r.conflicts.map((c) => `  ${describeConflict(c)}`),
                "resolve, then `rebase --continue` (or `--skip` / `--abort`)",
              ];
          }
        },
        json: (r) => ({
          status: r.status,
          head: r.head ? `${r.head.id.algo}:${r.head.id.value}` : null,
          remaining: r.remaining,
          conflicts: r.conflicts,
          warnings: r.warnings,
        }),
        exitCode: (r) => (r.status === "conflicts" ? EXIT_ERROR : EXIT_OK),
      },
    );
  }
}

// --- remotes (Stage 7) ------------------------------------------------------

export class RemoteAddCommand extends AnvilCommand {
  static override paths = [["remote", "add"]];
  static override usage = Command.Usage({
    description: "Record a remote (git | url | room) in .anvil/config.toml",
  });
  remoteName = Option.String({ required: true, name: "name" });
  url = Option.String({ required: true, name: "url" });
  ref = Option.String("--ref", { description: "Default branch/ref to track (default main)" });
  kind = Option.String("--kind", { description: "Force the remote kind: git | url | room" });

  override async execute(): Promise<number> {
    let kind: RemoteKind | undefined;
    try {
      kind = parseRemoteKind(this.kind);
    } catch (err) {
      this.context.stderr.write(`error: ${(err as Error).message}\n`);
      return EXIT_ERROR;
    }
    return this.run(
      (anvil) =>
        anvil.addRemote(this.remoteName, this.url, {
          ...(this.ref ? { ref: this.ref } : {}),
          ...(kind ? { kind } : {}),
        }),
      {
        plain: (d) => [`added remote "${d.name}" → ${d.url} (${d.kind})`],
        json: (d) => ({ remote: d }),
      },
    );
  }
}

export class RemoteRemoveCommand extends AnvilCommand {
  static override paths = [["remote", "remove"]];
  static override usage = Command.Usage({ description: "Remove a configured remote" });
  remoteName = Option.String({ required: true, name: "name" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.removeRemote(this.remoteName), {
      plain: (removed) => [removed ? `removed remote "${this.remoteName}"` : "no such remote"],
      json: (removed) => ({ removed }),
    });
  }
}

export class RemoteListCommand extends AnvilCommand {
  static override paths = [["remote", "list"]];
  static override usage = Command.Usage({ description: "List the configured remotes" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.remotes(), {
      plain: (remotes) =>
        remotes.length === 0
          ? ["no remotes configured"]
          : remotes.map((r) => `${r.name}\t${r.kind}\t${r.url}${r.ref ? ` (${r.ref})` : ""}`),
      json: (remotes) => ({ remotes }),
    });
  }
}

export class CloneCommand extends AnvilCommand {
  static override paths = [["clone"]];
  static override usage = Command.Usage({
    description: "Create an instance from a remote and build it in place",
  });
  url = Option.String({ required: true, name: "url" });
  name = Option.String("--name", { description: "Remote name to record (default origin)" });
  ref = Option.String("--ref", { description: "Branch/ref to track (default main)" });
  kind = Option.String("--kind", { description: "Force the remote kind: git | url | room" });

  override async execute(): Promise<number> {
    let kind: RemoteKind | undefined;
    try {
      kind = parseRemoteKind(this.kind);
    } catch (err) {
      this.context.stderr.write(`error: ${(err as Error).message}\n`);
      return EXIT_ERROR;
    }
    return this.run(
      (anvil) =>
        anvil.clone(this.url, {
          ...(this.name ? { name: this.name } : {}),
          ...(this.ref ? { ref: this.ref } : {}),
          ...(kind ? { kind } : {}),
        }),
      {
        plain: (r) => [
          `cloned ${this.url} → ${r.dir} (branch ${r.branch}, ${r.objects} object(s) transferred)`,
        ],
        json: (r) => ({ dir: r.dir, commit: r.commit, branch: r.branch, objects: r.objects }),
      },
    );
  }
}

export class PullCommand extends AnvilCommand {
  static override paths = [["pull"]];
  static override usage = Command.Usage({
    description: "Fast-forward to a remote's latest (divergent local commits are stashed)",
  });
  remote = Option.String({ required: false, name: "remote" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.pull(this.remote), {
      plain: (r) => {
        if (r.upToDate) {
          return ["already up to date"];
        }
        const lines = [
          `pulled — fast-forwarded ${r.fastForwarded} commit(s), ${r.objects} object(s) transferred`,
        ];
        if (r.stashedTo) {
          lines.push(
            `  note: local history diverged; your commits are preserved on "${r.stashedTo}"`,
          );
        }
        return lines;
      },
      json: (r) => ({
        fastForwarded: r.fastForwarded,
        objects: r.objects,
        upToDate: r.upToDate,
        ...(r.stashedTo ? { stashedTo: r.stashedTo } : {}),
      }),
    });
  }
}

export class PushCommand extends AnvilCommand {
  static override paths = [["push"]];
  static override usage = Command.Usage({
    description: "Publish the current branch to a writable remote (git / dir; url is read-only)",
  });
  remote = Option.String({ required: false, name: "remote" });

  override async execute(): Promise<number> {
    return this.run((anvil) => anvil.push(this.remote), {
      plain: (r) => {
        const hex = r.commit.slice(r.commit.indexOf(":") + 1).slice(0, 12);
        return [`pushed ${hex} → ${r.branch} (${r.objects} object(s))`];
      },
      json: (r) => ({ commit: r.commit, branch: r.branch, objects: r.objects }),
    });
  }
}

export class ExportCommand extends AnvilCommand {
  static override paths = [["export"]];
  static override usage = Command.Usage({
    description:
      "Write an .mrpack from the built instance (CurseForge items omitted with a warning)",
  });
  target = Option.String({ required: true, name: "target" });

  override async execute(): Promise<number> {
    const target = resolve(this.context.cwd, this.target);
    return this.run((anvil) => anvil.export(target), {
      plain: (r) => [
        `exported ${this.target} (${r.files} file(s), ${r.overrides} override(s))`,
        ...(r.omitted.length > 0
          ? [`  omitted ${r.omitted.length} CurseForge item(s): ${r.omitted.join(", ")}`]
          : []),
        ...r.warnings.map((w) => `  ! ${w}`),
      ],
      json: (r) => ({
        path: r.path,
        files: r.files,
        overrides: r.overrides,
        omitted: r.omitted,
        warnings: r.warnings,
      }),
    });
  }
}

/** Every non-builtin command, in help-listing order. */
export const COMMANDS = [
  InitCommand,
  AddCommand,
  RemoveCommand,
  LockCommand,
  BuildCommand,
  VerifyCommand,
  ImportCommand,
  StatusCommand,
  DiffCommand,
  WhyCommand,
  CommitCommand,
  BranchCommand,
  SwitchCommand,
  LogCommand,
  MergeCommand,
  RevertCommand,
  RebaseCommand,
  CloneCommand,
  PullCommand,
  PushCommand,
  ExportCommand,
  RemoteAddCommand,
  RemoteRemoveCommand,
  RemoteListCommand,
  GcCommand,
  FsckCommand,
] as const;
