/**
 * `.anvil/config.toml` — the instance's machine-local configuration. It carries
 * two anvil-owned sections:
 *
 *   - `[paths]`      — the category path remapping read by {@link resolvePaths}
 *                      (store / instance / assets / libraries / runtime).
 *   - `[remote.<name>]` — the {@link RemoteDescriptor}s a `clone`/`pull`/`push`
 *                      target (kind / url / ref).
 *
 * The reader is tolerant (parse with `smol-toml`); the writer is owned + canonical
 * (fixed key order, one string-escape table) so re-writing the config to add a
 * remote never clobbers a hand-authored `[paths]` table. anvil owns this file:
 * only these two sections are round-tripped.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../internal/fs.js";
import { kv, tomlString } from "../lock/toml.js";
import { RemoteError } from "../types/errors.js";
import type { RemoteDescriptor, RemoteKind } from "./descriptor.js";

/** The `[paths]` remap table (mirrors {@link resolvePaths}'s `PathsTable`). */
export interface PathsTable {
  readonly store?: string;
  readonly instance?: string;
  readonly assets?: string;
  readonly libraries?: string;
  readonly runtime?: string;
}

/** The parsed `.anvil/config.toml`: the path remap + the configured remotes. */
export interface AnvilConfig {
  readonly paths?: PathsTable;
  readonly remotes: readonly RemoteDescriptor[];
}

const CONFIG_REL = join(".anvil", "config.toml");
const REMOTE_KINDS: ReadonlySet<string> = new Set<RemoteKind>(["git", "url", "room"]);
const PATH_KEYS = ["store", "instance", "assets", "libraries", "runtime"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function readConfigText(instanceDir: string): Promise<string | undefined> {
  try {
    return await readFile(join(instanceDir, CONFIG_REL), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Parse `.anvil/config.toml`; a missing file is an empty config. */
export async function readConfig(instanceDir: string): Promise<AnvilConfig> {
  const text = await readConfigText(instanceDir);
  if (text === undefined) {
    return { remotes: [] };
  }
  const { parse: parseToml } = await import("smol-toml");
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    throw new RemoteError("config", `.anvil/config.toml is malformed: ${(err as Error).message}`);
  }

  const paths = parsePaths(doc.paths);
  const remotes: RemoteDescriptor[] = [];
  const remoteTable = isRecord(doc.remote) ? doc.remote : {};
  for (const name of Object.keys(remoteTable).sort()) {
    const raw = remoteTable[name];
    if (!isRecord(raw)) {
      continue;
    }
    const kind = raw.kind;
    const url = raw.url;
    if (typeof url !== "string" || typeof kind !== "string" || !REMOTE_KINDS.has(kind)) {
      throw new RemoteError(
        name,
        "a [remote.<name>] table needs a string `url` and a valid `kind`",
      );
    }
    remotes.push({
      name,
      kind: kind as RemoteKind,
      url,
      ...(typeof raw.ref === "string" ? { ref: raw.ref } : {}),
    });
  }
  return { ...(paths ? { paths } : {}), remotes };
}

function parsePaths(raw: unknown): PathsTable | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const key of PATH_KEYS) {
    const v = raw[key];
    if (typeof v === "string") {
      out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? (out as PathsTable) : undefined;
}

/** Serialize the config to its canonical TOML form (paths first, then remotes). */
export function serializeConfig(config: AnvilConfig): string {
  const blocks: string[] = [
    "# .anvil/config.toml — machine-local config (owned by lobbify-anvil).",
  ];
  if (config.paths) {
    const lines = ["[paths]"];
    for (const key of PATH_KEYS) {
      const v = config.paths[key];
      if (v !== undefined) {
        lines.push(kv(key, tomlString(v)));
      }
    }
    if (lines.length > 1) {
      blocks.push("", lines.join("\n"));
    }
  }
  for (const remote of [...config.remotes].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const lines = [`[remote.${remote.name}]`];
    lines.push(kv("kind", tomlString(remote.kind)));
    lines.push(kv("url", tomlString(remote.url)));
    if (remote.ref !== undefined) {
      lines.push(kv("ref", tomlString(remote.ref)));
    }
    blocks.push("", lines.join("\n"));
  }
  return `${blocks.join("\n")}\n`;
}

/** Atomically write `.anvil/config.toml`. */
export async function writeConfig(instanceDir: string, config: AnvilConfig): Promise<void> {
  await ensureDir(join(instanceDir, ".anvil"));
  const finalPath = join(instanceDir, CONFIG_REL);
  const tmpPath = join(instanceDir, ".anvil", `config.toml.${process.pid}.tmp`);
  await writeFile(tmpPath, serializeConfig(config));
  await rename(tmpPath, finalPath);
}

/** Add or replace a remote by name, preserving `[paths]` and the other remotes. */
export async function addRemote(instanceDir: string, descriptor: RemoteDescriptor): Promise<void> {
  const config = await readConfig(instanceDir);
  const remotes = config.remotes.filter((r) => r.name !== descriptor.name);
  remotes.push(descriptor);
  await writeConfig(instanceDir, { ...config, remotes });
}

/** Remove a remote by name (a no-op if absent). Returns whether one was removed. */
export async function removeRemote(instanceDir: string, name: string): Promise<boolean> {
  const config = await readConfig(instanceDir);
  const remotes = config.remotes.filter((r) => r.name !== name);
  if (remotes.length === config.remotes.length) {
    return false;
  }
  await writeConfig(instanceDir, { ...config, remotes });
  return true;
}

/** List the configured remotes (sorted by name). */
export async function listRemotes(instanceDir: string): Promise<readonly RemoteDescriptor[]> {
  return (await readConfig(instanceDir)).remotes;
}

/**
 * Resolve a remote by name, or (when no name is given) the sole configured remote
 * or the one named `origin`. Throws {@link RemoteError}/`RemoteNotFound` mapping.
 */
export async function resolveRemote(
  instanceDir: string,
  name?: string,
): Promise<RemoteDescriptor | undefined> {
  const remotes = await listRemotes(instanceDir);
  if (name) {
    return remotes.find((r) => r.name === name);
  }
  if (remotes.length === 1) {
    return remotes[0];
  }
  return remotes.find((r) => r.name === "origin");
}
