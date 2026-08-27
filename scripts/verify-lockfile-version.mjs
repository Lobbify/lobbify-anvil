#!/usr/bin/env node
// LB-958: package-lock.json carries the project's own version in two places
// (top-level `version` and `packages[""].version`) and both silently drift
// whenever package.json's version is bumped without re-running
// `npm install --package-lock-only`. This has no effect on what gets
// installed, but a committed lockfile stating the wrong version is a
// credibility cost in a public repo. Fail CI loudly instead of drifting again.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

const expected = pkg.version;
const lockRoot = lock.version;
const lockSelf = lock.packages?.[""]?.version;

const mismatches = [];
if (lockRoot !== expected) {
  mismatches.push(`package-lock.json "version" is "${lockRoot}", expected "${expected}"`);
}
if (lockSelf !== expected) {
  mismatches.push(
    `package-lock.json packages[""].version is "${lockSelf}", expected "${expected}"`,
  );
}

if (mismatches.length > 0) {
  console.error("Lockfile version drift (LB-958):");
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error(
    "Fix: run `npm install --package-lock-only`, confirm only the version fields moved, and commit.",
  );
  process.exit(1);
}

console.log(`package-lock.json version fields match package.json (${expected}).`);
