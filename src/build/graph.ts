/**
 * `.anvil/graph.json` — the dependency-edge sidecar that powers `anvil why`.
 *
 * The canonical `anvil.lock` deliberately carries **no** dependency edges (they
 * would make the byte-stable lock non-deterministic and are not a build input),
 * so `anvil lock` streams the resolver's edges here instead. `anvil why <item>`
 * reads this file — purely offline — and traces which root(s) pulled a
 * transitive dependency. The graph is instance metadata under `.anvil/`, never
 * part of the materialized tree.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../internal/fs.js";
import type { DependencyEdge } from "../resolver/index.js";

const GRAPH_DIR = ".anvil";
const GRAPH_FILE = join(GRAPH_DIR, "graph.json");

/** The persisted dependency graph: the flat edge list the resolver emitted. */
export interface DependencyGraph {
  readonly version: 1;
  readonly edges: readonly DependencyEdge[];
}

/** The result of an `anvil why <item>` trace. */
export interface WhyResult {
  /** The queried item name. */
  readonly item: string;
  /** Whether the item is present in the dependency graph at all. */
  readonly present: boolean;
  /** The unique root item names (or `(manifest)` entries) that pull it in. */
  readonly roots: readonly string[];
  /** Full chains, each `root → … → item`. */
  readonly chains: readonly (readonly string[])[];
}

/** Atomically write the dependency graph for an instance. */
export async function writeGraph(
  instanceDir: string,
  edges: readonly DependencyEdge[],
): Promise<void> {
  await ensureDir(join(instanceDir, GRAPH_DIR));
  const graph: DependencyGraph = { version: 1, edges };
  const finalPath = join(instanceDir, GRAPH_FILE);
  const tmpPath = join(instanceDir, `${GRAPH_FILE}.${process.pid}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(graph, null, 2)}\n`);
  await rename(tmpPath, finalPath);
}

/** Read the dependency graph, or `undefined` if the instance was never locked. */
export async function readGraph(instanceDir: string): Promise<DependencyGraph | undefined> {
  try {
    const text = await readFile(join(instanceDir, GRAPH_FILE), "utf8");
    const doc = JSON.parse(text) as DependencyGraph;
    if (doc.version !== 1 || !Array.isArray(doc.edges)) {
      return undefined;
    }
    return doc;
  } catch {
    return undefined;
  }
}

/** A hard cap on reported chains, so a pathological graph cannot blow up. */
const MAX_CHAINS = 64;

/**
 * Trace which root(s) require `item`, keyed by package name (the identity a user
 * types). Returns every `root → … → item` chain, with cycle protection and a
 * bounded chain count.
 */
export function whyChains(graph: DependencyGraph, item: string): WhyResult {
  const demandersOf = new Map<string, Set<string>>();
  const names = new Set<string>();
  for (const edge of graph.edges) {
    names.add(edge.childName);
    let set = demandersOf.get(edge.childName);
    if (!set) {
      set = new Set<string>();
      demandersOf.set(edge.childName, set);
    }
    set.add(edge.by);
  }

  if (!names.has(item)) {
    return { item, present: false, roots: [], chains: [] };
  }

  const chains: string[][] = [];
  const trace = (name: string, visited: ReadonlySet<string>): string[][] => {
    const demanders = demandersOf.get(name);
    if (!demanders || demanders.size === 0) {
      return [[name]]; // an orphaned node — treat it as its own root
    }
    const out: string[][] = [];
    for (const by of [...demanders].sort()) {
      if (by === "(manifest)") {
        out.push([name]); // a direct manifest root
        continue;
      }
      if (visited.has(by)) {
        continue; // cycle guard
      }
      for (const parent of trace(by, new Set([...visited, by]))) {
        out.push([...parent, name]);
        if (out.length >= MAX_CHAINS) {
          return out;
        }
      }
    }
    return out;
  };

  for (const chain of trace(item, new Set([item]))) {
    chains.push(chain);
    if (chains.length >= MAX_CHAINS) {
      break;
    }
  }

  const roots = [...new Set(chains.map((c) => c[0] ?? item))].sort();
  return { item, present: true, roots, chains };
}
