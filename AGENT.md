# AGENT.md — `@lobbify/anvil`

Repo guide for any agent or contributor working in this package. Read it before
touching code, and treat the **Hard invariants** and **Security must-dos** below
as standing review rules — a change that violates one does not merge.

## What this is

**lobbify-anvil** is a reproducible, content-addressed build system for Minecraft
instances — think **git + docker + uv for `.minecraft`**. You write a manifest
(`anvil.toml`), `anvil lock` freezes it to a fully hash-pinned `anvil.lock`, and
`anvil build` installs a complete, launch-ready instance from that lock, atomically.
The whole instance is versioned with full git semantics (commit/branch/merge/rebase).
It is **library-first**: an npm package exposing an `Anvil` class; the CLI (`lobbify-anvil`)
and the interactive TUI are thin skins that carry **no logic**. It is standalone and
source-agnostic (Modrinth / CurseForge / URL / local); a host app (e.g. Lobbify) supplies
an `allowSource` policy and calls the library directly.

This repo is at **Stage 4 — the MVP tier (Stages 0–4) is complete.** On top of the
Stage-0 scaffold, the Stage-1 content-addressed store (`src/store/`) + atomic build
engine (`src/build/`), the Stage-2 manifest/sources/resolver/lock, and the Stage-3
full game installer (`src/game/`: Mojang walk + Fabric/Quilt), **Stage 4 adds**:

- the thin `clipanion` **CLI** (`src/cli/`) — `init` / `add` / `remove` / `lock` /
  `build` / `verify` / `status` / `diff` / `why` / `import` / `gc` / `fsck`, with
  plain + `--json` output and a documented **exit-code table** (`src/cli/errors.ts`);
- **`.mrpack` import** (`src/import/`) — `modrinth.index.json` → `[game]` + `files[]`
  as copy entries + `overrides/` as tracked local files, emitting a pre-resolved lock
  (sha512-verified downloads, `env=server`-only files filtered, mirror selection);
- the `Anvil` **authoring / introspection** methods (`init`, `addItems`, `removeItems`,
  `status`, `diff`, `why`, `import`) and the `.anvil/graph.json` dependency sidecar `why` reads.

The CLI is a **thin skin**: it parses args and calls one `Anvil` method — no business
logic. The library is testable offline via the optional `AnvilEnv` constructor arg (the
mirror/endpoint + fixture injection seam). The remaining subsystems (version control,
CurseForge, remotes, TUI) land in Stages 5–9; those `Anvil` methods still throw
`NotImplemented`. See `lobbify-anvil-implementation-plan.md`.

## Commands

```bash
npm install          # install deps
npm run build        # tsup → dist/ (ESM + .d.ts), also builds the CLI bin
npm run typecheck    # tsc --noEmit (strict) — must be clean
npm test             # vitest run
npm run lint         # biome check (lint + format + import-order check)
npm run lint:fix     # biome check --write (auto-fix + format)
npm run check        # biome check && tsc --noEmit && vitest run (the local gate)
```

CI (`.github/workflows/ci.yml`) runs `biome check` + `tsc --noEmit` + `vitest run`
(+ `build`) on **{ubuntu, macos, windows} × {Node 20, 22}**. Red blocks merge.

## Conventions

- **TypeScript strict, pure ESM, `NodeNext`.** Relative imports carry an explicit
  `.js` extension (e.g. `import { Anvil } from "./anvil.js"`). `verbatimModuleSyntax`
  is on, so type-only imports use `import type`.
- **A hash is NEVER a bare string.** It is always a `Hash = { algo, value }`. The
  store is domain-partitioned — sha1 for the Mojang assets domain, sha256 for
  everything anvil owns — so an algorithm-tagged hash is the only safe currency.
  A bare `string` hash in a signature is a review-blocking bug.
- **No logic in the CLI or TUI.** They parse input and render the `Anvil` event bus;
  all behavior lives in the library. A `cli/` or `tui/` file that computes a result
  instead of calling an `Anvil` method is wrong.
- **The lock is the sole build input.** `build` consults only `anvil.lock` and hits
  the network solely to fetch pinned bytes it lacks. Do not read the manifest during a build.
- **Errors are typed.** Throw a named `AnvilError` subclass with a stable `code`
  (never a bare `Error`) for any known condition. Async methods reject; they never throw synchronously.
- **Formatting/lint is biome** — run `npm run lint:fix` before committing; no ESLint/Prettier.
- **Node built-ins use the `node:` protocol** (`import { readFile } from "node:fs/promises"`).

## The three hard invariants (standing review rules)

Every stage is gated on these. A PR that could violate one must prove it cannot.

1. **Determinism.** The same lock produces a **byte-identical** instance on two
   machines and two OSes. Everything is pinned to a hash — the game client, the JRE
   (per-platform manifest + per-file shas, not just a component id), and **every**
   loader library. All *generated* files (notably a merged `version.json`: sorted
   keys, deduped/ordered library union — recall the Fabric-1.21 dup-ASM lesson) are
   canonicalized and covered by the determinism harness, not just materialized bytes.
   Force `/` in serialized paths; own the TOML serialization; byte-compare cross-OS **and** cross-Node.

2. **Atomic swap.** A `build` never leaves a half-installed instance. Stage into
   `.anvil/stage-<id>` on the **same volume**, verify, then swap via a journal
   (move-aside → roll-forward/back). A crash at any boundary leaves either the old or
   the new instance — never a Frankenstein. **`saves/` is never touched** (honored via
   `.anvilignore`); the flagship safety test builds over an instance with existing worlds
   and asserts they are untouched.

3. **Replay-never-rehosted.** CurseForge bytes are `provenance: "replay"`: fetched
   per-client under the user's **own** key and **never** re-hosted, transferred, pushed,
   or exported (CF ToS). This is enforced at the **storage layer** — CF bytes materialize
   into a per-instance `replay-cache/` that the store-serve, GC, transfer, and export code
   physically cannot enumerate. Keys are never serialized into lock/config/events/logs;
   only an env-var *reference* is stored. `.mrpack` export omits replay items with a clear warning.

## Security must-dos (later stages — do not regress)

The "join a room / import a pack" path is fully untrusted (manifest + lock + archives).

- **safeExtract / zip-slip guard on EVERY archive extraction.** One hardened util
  rejects `..`, absolute paths, drive letters, and symlink/hardlink entries, and asserts
  the resolved destination stays under the instance root. Mandated at every extraction
  site (natives, `.mrpack`/CF-zip/Prism overrides, config overrides), plus decompression-bomb
  bounds (max entries / uncompressed size). Built in Stage 1; tested in each importing stage.
- **SSRF guard on the `url` source (on by default).** Block non-`http(s)`, and
  loopback/RFC1918/link-local/cloud-metadata IPs; re-validate on every redirect hop;
  show `allowSource` the final host. Stage 2.
- **Forge/NeoForge processor sandbox.** Installer processors are JVM code run at build
  time — only run processor jars pinned to official Maven coordinates by sha256; sandbox
  the JVM (no network, scoped FS); require explicit consent for anything else. Stage 9.
- **Read `yauzl` not `unzipper`** for zips (`unzipper` eagerly pulls `@aws-sdk` — a prior
  app boot bug). **No telemetry / no phone-home**; any update check is opt-out.

## Layout

```text
index.ts            # public API barrel
src/types/          # the type spine: core.ts (Hash, LockPackage, Placement, Source, …) + errors.ts
src/events.ts       # the typed progress-event taxonomy (discriminated unions)
src/anvil.ts        # the Anvil class + ProgressBus + the AnvilEnv injection seam
src/game/           # the Mojang installer + Fabric/Quilt loaders (Stage 3)
src/import/         # .mrpack import (Stage 4): mrpack.ts + the hardened zip reader
src/cli/            # the thin `lobbify-anvil` bin (Stage 4): commands, reporter, errors, run
test/               # vitest — determinism/crash/game/CLI-e2e/import/error fixtures (offline)
```
