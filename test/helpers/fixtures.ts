/**
 * Shared test scaffolding: temp dirs, a content-addressed fixtures pool, hash
 * helpers, and the tree-of-sha manifest used by the determinism gate (a stable,
 * mtime-independent fingerprint of an instance's materialized bytes).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import type { Hash, HashAlgo } from "../../index.js";

export async function mkTmp(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `anvil-${label}-`));
}

export async function rmTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function hexOf(bytes: Uint8Array, algo: HashAlgo): string {
  return createHash(algo).update(bytes).digest("hex");
}

export function hashOf(bytes: Uint8Array, algo: HashAlgo): Hash {
  return { algo, value: hexOf(bytes, algo) };
}

/** Write `bytes` into the content-addressed fixtures pool; return its {algo,value}. */
export async function writeFixture(
  poolDir: string,
  bytes: Uint8Array,
  algo: HashAlgo,
): Promise<Hash> {
  const hash = hashOf(bytes, algo);
  const dir = join(poolDir, hash.algo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, hash.value), Buffer.from(bytes));
  return hash;
}

async function* walk(root: string, rel = ""): AsyncGenerator<string> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRel = rel ? `${rel}${sep}${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walk(root, childRel);
    } else {
      yield childRel;
    }
  }
}

/**
 * A deterministic manifest of an instance's materialized content: one
 * `<posix-relative-path>\t<sha256>` line per file, sorted, `.anvil/` and
 * `saves/` excluded (metadata + protected worlds are never part of the tree).
 */
export async function treeManifest(root: string): Promise<string> {
  const lines: string[] = [];
  for await (const relPath of walk(root)) {
    const top = relPath.split(sep)[0];
    if (top === ".anvil" || top === "saves") {
      continue;
    }
    const bytes = await readFile(join(root, relPath));
    const posixRel = relPath.split(sep).join(posix.sep);
    lines.push(`${posixRel}\t${hexOf(bytes, "sha256")}`);
  }
  lines.sort();
  return lines.join("\n");
}

/** Relative posix paths of every file under `root` (for assertions). */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const relPath of walk(root)) {
    out.push(relPath.split(sep).join(posix.sep));
  }
  return out.sort();
}

export { relative };
