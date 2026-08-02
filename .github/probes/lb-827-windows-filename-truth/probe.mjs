#!/usr/bin/env node
/**
 * LB-827 ground-truth probe — THROWAWAY, not part of the anvil package.
 *
 * Does NOT reason about strings and does NOT touch `foldName` / `safeJoin` /
 * `declaredPlacementTarget`. It writes and reads REAL files on whatever real
 * filesystem this CI runner gives it, and reports exactly what happened.
 *
 * Every case prints, unconditionally:
 *   - the exact path(s) attempted
 *   - the raw error (if any) from the syscall
 *   - a directory listing of the relevant parent(s)
 *   - an explicit verdict line starting with "VERDICT:" so grep finds it
 *
 * The point of always printing the listing (not just on the "interesting"
 * branch) is that "did not collapse" and "the probe silently did not run"
 * must not be able to look the same in the log.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// If a bug in THIS script throws, make that unmistakably distinct from a
// filesystem finding — never let a script crash look like "no bypass found".
process.on("uncaughtException", (e) => {
  console.error("\nPROBE_SCRIPT_BUG (uncaught exception, NOT a filesystem finding):");
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});

const verdicts = [];

function verdict(caseId, text) {
  const line = `VERDICT[${caseId}]: ${text}`;
  console.log(line);
  verdicts.push(line);
}

function section(title) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

function errInfo(e) {
  if (!e) return null;
  return { code: e.code ?? null, message: e.message ?? String(e) };
}

function tryMkdir(p) {
  try {
    mkdirSync(p, { recursive: true });
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: errInfo(e) };
  }
}

function tryWrite(p, content) {
  try {
    writeFileSync(p, content);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: errInfo(e) };
  }
}

function tryRead(p) {
  try {
    return { ok: true, content: readFileSync(p, "utf8"), error: null };
  } catch (e) {
    return { ok: false, content: null, error: errInfo(e) };
  }
}

function safeExists(p) {
  try {
    return existsSync(p);
  } catch (e) {
    return `<existsSync error: ${errInfo(e).code ?? errInfo(e).message}>`;
  }
}

function listDir(p) {
  try {
    // withFileTypes so we can tell a dir from a file in the raw log.
    return readdirSync(p, { withFileTypes: true }).map(
      (d) => `${d.name}${d.isDirectory() ? "/" : ""}`,
    );
  } catch (e) {
    return { error: errInfo(e) };
  }
}

/** Recursive listing (small trees only — this is a probe, not a real walker). */
function walk(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    out.push(`${root}  <readdir error: ${errInfo(e).code ?? errInfo(e).message}>`);
    return out;
  }
  for (const d of entries) {
    const p = join(root, d.name);
    out.push(`${p}${d.isDirectory() ? "/" : ""}`);
    if (d.isDirectory()) walk(p, depth + 1, out);
  }
  return out;
}

function printWalk(label, root) {
  console.log(`\n--- recursive listing: ${label} (${root}) ---`);
  for (const line of walk(root)) console.log("  " + line);
  console.log("--- end listing ---");
}

console.log(`platform:        ${process.platform}`);
console.log(`node version:    ${process.version}`);
console.log(`path separator:  ${JSON.stringify(sep)}`);
console.log(`arch:            ${process.arch}`);

const probeRoot = mkdtempSync(join(tmpdir(), "anvil-lb827-"));
console.log(`probe root:      ${probeRoot}`);

// ---------------------------------------------------------------------------
// Case 1 — trailing dot on a protected top-level name ("saves.")
// ---------------------------------------------------------------------------
section("Case 1: trailing dot — saves.");
{
  const caseRoot = join(probeRoot, "case1");
  tryMkdir(caseRoot);
  const dirtyDir = join(caseRoot, "saves.");
  const mk = tryMkdir(dirtyDir);
  console.log("mkdir(saves.) =>", JSON.stringify(mk));
  const dirtyFile = join(dirtyDir, "probe.txt");
  const wr = tryWrite(dirtyFile, "trailing-dot-marker");
  console.log("write(saves./probe.txt) =>", JSON.stringify(wr));

  const cleanFile = join(caseRoot, "saves", "probe.txt");
  const cleanRead = tryRead(cleanFile);
  console.log(`read-back via CLEAN spelling (${cleanFile}) =>`, JSON.stringify(cleanRead));
  const dirtyRead = tryRead(dirtyFile);
  console.log(`read-back via DIRTY spelling (${dirtyFile}) =>`, JSON.stringify(dirtyRead));

  printWalk("case1", caseRoot);

  if (cleanRead.ok && cleanRead.content === "trailing-dot-marker") {
    verdict("1-trailing-dot", "COLLAPSED — write to \"saves.\" landed at real \"saves/\"");
  } else if (mk.ok || wr.ok) {
    verdict(
      "1-trailing-dot",
      `DISTINCT — "saves." created as its own entry, "saves/" not reached. listing=${JSON.stringify(listDir(caseRoot))}`,
    );
  } else {
    verdict("1-trailing-dot", `NEITHER — mkdir/write themselves failed: ${JSON.stringify({ mk, wr })}`);
  }
}

// ---------------------------------------------------------------------------
// Case 2 — trailing space on a protected top-level name ("saves ")
// ---------------------------------------------------------------------------
section("Case 2: trailing space — saves ");
{
  const caseRoot = join(probeRoot, "case2");
  tryMkdir(caseRoot);
  const dirtyDir = join(caseRoot, "saves ");
  const mk = tryMkdir(dirtyDir);
  console.log("mkdir('saves ') =>", JSON.stringify(mk));
  const dirtyFile = join(dirtyDir, "probe.txt");
  const wr = tryWrite(dirtyFile, "trailing-space-marker");
  console.log("write('saves '/probe.txt) =>", JSON.stringify(wr));

  const cleanFile = join(caseRoot, "saves", "probe.txt");
  const cleanRead = tryRead(cleanFile);
  console.log(`read-back via CLEAN spelling (${cleanFile}) =>`, JSON.stringify(cleanRead));
  const dirtyRead = tryRead(dirtyFile);
  console.log(`read-back via DIRTY spelling (${dirtyFile}) =>`, JSON.stringify(dirtyRead));

  printWalk("case2", caseRoot);

  if (cleanRead.ok && cleanRead.content === "trailing-space-marker") {
    verdict("2-trailing-space", "COLLAPSED — write to \"saves \" landed at real \"saves/\"");
  } else if (mk.ok || wr.ok) {
    verdict(
      "2-trailing-space",
      `DISTINCT — "saves " created as its own entry, "saves/" not reached. listing=${JSON.stringify(listDir(caseRoot))}`,
    );
  } else {
    verdict("2-trailing-space", `NEITHER — mkdir/write themselves failed: ${JSON.stringify({ mk, wr })}`);
  }
}

// ---------------------------------------------------------------------------
// Case 3 — the ones that matter most: .anvil. and .anvilignore.
// ---------------------------------------------------------------------------
section("Case 3a: trailing dot — .anvil. (the object store / VC history)");
{
  const caseRoot = join(probeRoot, "case3a");
  tryMkdir(caseRoot);
  // Seed a real ".anvil" with a marker file, as if it already held commit history.
  const realAnvil = join(caseRoot, ".anvil");
  tryMkdir(realAnvil);
  tryWrite(join(realAnvil, "HEAD"), "REAL-HEAD-abc123");

  const dirtyDir = join(caseRoot, ".anvil.");
  const mk = tryMkdir(dirtyDir);
  console.log("mkdir(.anvil.) =>", JSON.stringify(mk));
  const wr = tryWrite(join(dirtyDir, "HEAD"), "CLOBBERED-HEAD-malicious");
  console.log("write(.anvil./HEAD) =>", JSON.stringify(wr));

  const cleanRead = tryRead(join(realAnvil, "HEAD"));
  console.log(`read-back real .anvil/HEAD =>`, JSON.stringify(cleanRead));

  printWalk("case3a", caseRoot);

  if (cleanRead.ok && cleanRead.content === "CLOBBERED-HEAD-malicious") {
    verdict("3a-dotanvil-dot", "COLLAPSED — write to \".anvil.\" clobbered the REAL .anvil/HEAD");
  } else if (cleanRead.ok && cleanRead.content === "REAL-HEAD-abc123") {
    verdict("3a-dotanvil-dot", `DISTINCT — real .anvil/HEAD untouched. listing=${JSON.stringify(listDir(caseRoot))}`);
  } else {
    verdict("3a-dotanvil-dot", `INCONCLUSIVE — ${JSON.stringify({ mk, wr, cleanRead })}`);
  }
}

section("Case 3b: trailing dot — .anvilignore. (the rules file)");
{
  const caseRoot = join(probeRoot, "case3b");
  tryMkdir(caseRoot);
  const realIgnore = join(caseRoot, ".anvilignore");
  tryWrite(realIgnore, "REAL-RULES\nmods/*\n");

  const dirtyFile = join(caseRoot, ".anvilignore.");
  const wr = tryWrite(dirtyFile, "MALICIOUS-RULES\n*\n");
  console.log("write(.anvilignore.) =>", JSON.stringify(wr));

  const cleanRead = tryRead(realIgnore);
  console.log(`read-back real .anvilignore =>`, JSON.stringify(cleanRead));

  printWalk("case3b", caseRoot);

  if (cleanRead.ok && cleanRead.content.startsWith("MALICIOUS-RULES")) {
    verdict("3b-dotanvilignore-dot", "COLLAPSED — write to \".anvilignore.\" clobbered the REAL .anvilignore");
  } else if (cleanRead.ok && cleanRead.content.startsWith("REAL-RULES")) {
    verdict(
      "3b-dotanvilignore-dot",
      `DISTINCT — real .anvilignore untouched. listing=${JSON.stringify(listDir(caseRoot))}`,
    );
  } else {
    verdict("3b-dotanvilignore-dot", `INCONCLUSIVE — ${JSON.stringify({ wr, cleanRead })}`);
  }
}

// ---------------------------------------------------------------------------
// Case 4 — 8.3 short names
// ---------------------------------------------------------------------------
section("Case 4: 8.3 short names — is generation on, does SAVES~1 resolve?");
{
  const caseRoot = join(probeRoot, "case4");
  tryMkdir(caseRoot);

  if (process.platform === "win32") {
    // Report the volume setting itself, not just the behaviour — it's configurable
    // per-volume (and sometimes per-directory) via fsutil.
    for (const args of [
      ["8dot3name", "query", caseRoot],
      ["8dot3name", "query"],
    ]) {
      try {
        const out = execFileSync("fsutil", args, { encoding: "utf8" });
        console.log(`$ fsutil ${args.join(" ")}\n${out}`);
      } catch (e) {
        console.log(`$ fsutil ${args.join(" ")}  => FAILED: ${errInfo(e).message}`);
      }
    }
    // Raw short-name dump for the directory we're about to probe, via cmd's `dir /x`
    // — printed verbatim so a human/agent reading the log can see the real alias
    // even if this script's parsing of it is wrong.
    try {
      const out = execFileSync("cmd", ["/c", "dir", "/x", caseRoot], { encoding: "utf8" });
      console.log(`$ cmd /c dir /x "${caseRoot}"\n${out}`);
    } catch (e) {
      console.log(`$ cmd /c dir /x  => FAILED: ${errInfo(e).message}`);
    }
  } else {
    console.log("not windows — 8.3 short names are an NTFS/Win32 concept, skipping fsutil probes.");
  }

  // The direct question: "saves" (5 chars) is already 8.3-compliant. Does the
  // volume still mint a short-name alias SAVES~1 for it, and does that alias
  // resolve to the real directory?
  const realSaves = join(caseRoot, "saves");
  tryMkdir(realSaves);
  tryWrite(join(realSaves, "marker.txt"), "REAL-SAVES-MARKER");
  const aliasPath = join(caseRoot, "SAVES~1", "marker.txt");
  const aliasRead = tryRead(aliasPath);
  console.log(`read-back via SAVES~1 (${aliasPath}) =>`, JSON.stringify(aliasRead));

  // Positive control: a name that is NOT 8.3-compliant, to prove short-name
  // generation is (or isn't) happening on this volume at all, independent of
  // whether "saves" itself gets an alias.
  const longName = "saves-not-eight-dot-three-compliant";
  const longDir = join(caseRoot, longName);
  tryMkdir(longDir);
  tryWrite(join(longDir, "marker.txt"), "REAL-LONGNAME-MARKER");
  const longAliasPath = join(caseRoot, "SAVES-N~1", "marker.txt");
  const longAliasRead = tryRead(longAliasPath);
  console.log(
    `positive control — read-back via SAVES-N~1 for "${longName}" (${longAliasPath}) =>`,
    JSON.stringify(longAliasRead),
  );

  printWalk("case4", caseRoot);

  if (aliasRead.ok && aliasRead.content === "REAL-SAVES-MARKER") {
    verdict("4-8dot3", "SAVES~1 RESOLVES to the real saves/ directory — 8.3 aliasing is a live bypass vector.");
  } else {
    verdict(
      "4-8dot3",
      `SAVES~1 does NOT resolve (${JSON.stringify(aliasRead.error)}). Long-name control alias ${
        longAliasRead.ok ? "DID" : "did NOT"
      } resolve (${JSON.stringify(longAliasRead.error ?? longAliasRead.content)}) — see raw fsutil/dir output above for the volume setting.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Case 5 — dot-run path components
// ---------------------------------------------------------------------------
section("Case 5: dot-run components — config/.../a.txt and config/..../a.txt");
{
  const caseRoot = join(probeRoot, "case5");
  tryMkdir(caseRoot);
  const configDir = join(caseRoot, "config");
  tryMkdir(configDir);

  for (const dots of ["...", "...."]) {
    const sub = join(configDir, dots);
    const mk = tryMkdir(sub);
    console.log(`mkdir(config/${dots}) =>`, JSON.stringify(mk));
    const target = join(sub, "a.txt");
    const wr = tryWrite(target, `marker-for-${dots.length}-dots`);
    console.log(`write(config/${dots}/a.txt) =>`, JSON.stringify(wr));
    const rb = tryRead(target);
    console.log(`read-back same path =>`, JSON.stringify(rb));
  }

  printWalk("case5", caseRoot);

  const flat = walk(caseRoot);
  const gotConfigOnly = flat.some((l) => l.endsWith(join(configDir, "a.txt")));
  const gotRootLevel = flat.some((l) => l.endsWith(join(caseRoot, "a.txt")));
  verdict(
    "5-dot-runs",
    `full recursive tree above is the ground truth. flags: a.txt-directly-under-config=${gotConfigOnly}, a.txt-at-case-root=${gotRootLevel}`,
  );
}

// ---------------------------------------------------------------------------
// Case 6 — ADS / drive-relative segments
// ---------------------------------------------------------------------------
section("Case 6a: ADS-shaped single segment — saves:level.dat (saves/ pre-exists)");
{
  const caseRoot = join(probeRoot, "case6a");
  tryMkdir(caseRoot);
  const realSaves = join(caseRoot, "saves");
  tryMkdir(realSaves);
  const realLevelDat = join(realSaves, "level.dat");
  tryWrite(realLevelDat, "REAL-WORLD-DATA");

  const adsPath = join(caseRoot, "saves:level.dat");
  const wr = tryWrite(adsPath, "ADS-ATTACK-PAYLOAD");
  console.log(`write(saves:level.dat) =>`, JSON.stringify(wr));

  const readReal = tryRead(realLevelDat);
  console.log(`read-back real saves/level.dat =>`, JSON.stringify(readReal));
  const readAds = tryRead(adsPath);
  console.log(`read-back via the colon path itself =>`, JSON.stringify(readAds));

  printWalk("case6a", caseRoot);

  verdict(
    "6a-ads-saves-colon",
    `write ${wr.ok ? "SUCCEEDED" : `FAILED (${JSON.stringify(wr.error)})`}; real saves/level.dat content is now ${JSON.stringify(readReal)}; reading the colon path itself gives ${JSON.stringify(readAds)}.`,
  );
}

section("Case 6b: ADS-shaped single segment — saves:level.dat (saves/ absent beforehand)");
{
  const caseRoot = join(probeRoot, "case6b");
  tryMkdir(caseRoot);

  const adsPath = join(caseRoot, "saves:level.dat");
  const wr = tryWrite(adsPath, "ADS-ATTACK-PAYLOAD-NO-PREEXISTING");
  console.log(`write(saves:level.dat), no pre-existing saves/ =>`, JSON.stringify(wr));

  const savesExists = safeExists(join(caseRoot, "saves"));
  console.log(`existsSync(saves) after the write =>`, savesExists);

  printWalk("case6b", caseRoot);

  verdict(
    "6b-ads-saves-colon-no-preexisting",
    `write ${wr.ok ? "SUCCEEDED" : `FAILED (${JSON.stringify(wr.error)})`}; saves/ now exists=${savesExists}; listing=${JSON.stringify(listDir(caseRoot))}`,
  );
}

section("Case 6c: drive-relative-shaped nested segment — config/D:evil.txt");
{
  const caseRoot = join(probeRoot, "case6c");
  tryMkdir(caseRoot);
  const configDir = join(caseRoot, "config");
  tryMkdir(configDir);

  const target = join(configDir, "D:evil.txt");
  const wr = tryWrite(target, "DRIVE-RELATIVE-PAYLOAD");
  console.log(`write(config/D:evil.txt) =>`, JSON.stringify(wr));
  const rb = tryRead(target);
  console.log(`read-back same literal path =>`, JSON.stringify(rb));

  printWalk("case6c", caseRoot);

  verdict(
    "6c-drive-relative-nested",
    `write ${wr.ok ? "SUCCEEDED" : `FAILED (${JSON.stringify(wr.error)})`}; config/ now contains=${JSON.stringify(listDir(configDir))}`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
section("SUMMARY — all verdicts");
for (const v of verdicts) console.log(v);

console.log("\nPROBE_COMPLETE");
process.exit(0);
