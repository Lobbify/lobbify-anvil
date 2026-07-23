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
import type { AnvilOptions } from "../types/index.js";
import type { AnvilCliContext } from "./context.js";
import { EXIT_ERROR, EXIT_OK, renderError } from "./errors.js";
import { describeEvent } from "./reporter.js";

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

  override async execute(): Promise<number> {
    if (!this.minecraft) {
      const message = "`init` requires --minecraft <version>";
      // Keep the --json contract: exactly one JSON object on stdout, else plain
      // stderr — never a mixed/empty payload a CI parser would choke on.
      if (this.json) {
        this.context.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "USAGE", message, exitCode: EXIT_ERROR } })}\n`,
        );
      } else {
        this.context.stderr.write(`error: ${message}\n`);
      }
      return EXIT_ERROR;
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
    description: "Adopt a .mrpack (Modrinth modpack) into this instance",
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
        `  manifest: ${s.hasManifest ? "present" : "missing"}  ·  lock: ${
          s.hasLock ? (s.manifestDirty ? "stale" : "present") : "missing"
        }  ·  built: ${s.hasBuilt ? (s.buildDirty ? "out-of-date" : "current") : "never"}`,
      ],
      json: (s) => ({ status: s }),
    });
  }
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
  GcCommand,
  FsckCommand,
] as const;
