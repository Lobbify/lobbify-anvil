# Contributing to lobbify-anvil

Thanks for looking at `@lobbify/anvil`. This is a small, opinionated library, so
the bar for a change is **it doesn't break an invariant**, not "does it work on
my machine." Read [`AGENT.md`](./AGENT.md) for the full conventions doc — this
file is the practical getting-started version.

## Dev setup

- **Node 20 or 22** (see `engines` in `package.json` — anything else isn't supported).
- Install and build once:

  ```bash
  npm install
  npm run build      # tsup → dist/ (ESM + .d.ts), also builds the CLI bin
  ```

- The four gates, run individually or all at once:

  ```bash
  npm run typecheck   # tsc --noEmit (strict) — must be clean
  npm run lint         # biome check (lint + format + import-order)
  npm run lint:fix     # biome check --write — auto-fix formatting/import order
  npm test             # vitest run
  npm run check         # biome check && tsc --noEmit && vitest run — the local gate, run this before every PR
  ```

CI (`.github/workflows/ci.yml`) runs the same lint/typecheck/test/build matrix on
**{ubuntu, macos, windows} × {Node 20, 22}**. A red matrix cell blocks merge —
if a change is platform-sensitive (path separators, symlinks, case-folding),
think about all three OSes, not just the one you're on.

## Project layout

`src/` is organized by subsystem, each with an `index.ts` barrel. Skim the
barrel before the internals — it's the intended public surface of that
subsystem and usually has the best doc comments.

| Path | Owns |
|---|---|
| `src/types/` | The type spine (`core.ts`: `Hash`, `LockPackage`, `Placement`, `Source`, …) + `errors.ts` (the typed `AnvilError` hierarchy). Read this first — every other subsystem implements against it. |
| `src/events.ts` | The typed progress-event taxonomy (discriminated unions) the CLI/TUI consume. |
| `src/anvil.ts` | The `Anvil` class — the public library entry point. Wires every subsystem together; all business logic is reachable from here. |
| `src/store/` | The content-addressed object store, hashing, atomic writes, the reflink→hardlink→symlink→copy linking chain, the placement executor, the hardened zip extractor, and the per-instance replay cache. |
| `src/build/` | The offline build pipeline: preflight → acquire → stage → verify → journaled atomic swap; `.anvilignore`; the incremental delta planner; path resolution. |
| `src/manifest/` | The `anvil.toml` parser/serializer and the `source:id@version` ref grammar. |
| `src/sources/` | The `Source` implementations (Modrinth, CurseForge, URL, local), the per-source rate-limited HTTP client, the SSRF guard, kind inference, and the source registry. **Start here if you're adding a new source** — see below. |
| `src/resolver/` | The manifest → fully-pinned `Lockfile` resolver (BFS worklist, `allowSource` gate, conflict handling). |
| `src/lock/` | The canonical, deterministic `anvil.lock` TOML schema, serializer, and atomic I/O. |
| `src/game/` | The Mojang installer walk, Fabric/Quilt/Forge/NeoForge loaders, the merged `version.json` generator, and the Forge/NeoForge installer-processor runner. |
| `src/vc/` | anvil's own version-control engine (not a git wrapper): the `.anvil/` object model, refs/reflog, generation-number graph + LCA, item-set 3-way merge, rebase, and the working-tree walk that records undeclared files (`.anvilexclude`). |
| `src/remote/` | Remote descriptors, transports (dir / http / git / room), content-addressed object transfer, and `clone`/`pull`/`push` orchestration. |
| `src/export/` | `.mrpack` export (a dependency-free deterministic zip writer). |
| `src/import/` | Pack import: `.mrpack`, CurseForge-zip, Prism/MultiMC (via fingerprint re-identification), and the hardened zip reader. |
| `src/cli/` | The thin `lobbify-anvil` bin (clipanion commands, error rendering, the progress reporter). No business logic — see the rule below. |
| `src/tui/` | The colorful interactive Ink TUI, plus an ANSI-free plain renderer for non-TTY/CI. Also no business logic. |
| `src/internal/` | Small cross-cutting helpers (fs safety, cross-process locking, test fault injection) not part of the public API. |

**No logic in `src/cli/` or `src/tui/`.** Both are pure consumers of the `Anvil`
class and its progress bus. If you find yourself computing something in a CLI
command or a TUI component instead of calling an `Anvil` method, that logic
belongs in the library.

## How to add a new Source

anvil is **source-agnostic** by design — Modrinth, CurseForge, a bare URL, and
local files are all just implementations of one interface
(`src/types/core.ts`, `Source`):

```ts
export interface Source {
  readonly kind: SourceKind;
  /** Resolve a ref to a fully-pinned package (+ required deps). May do network I/O. */
  resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult>;
  /** Produce the byte-fetch plan for an already-pinned package. No network I/O. */
  plan(pkg: LockPackage, ctx: SourceContext): FetchPlan;
}
```

A new source needs a new `SourceKind` string literal in `src/types/core.ts`,
and then to implement:

- **`resolve(ref, ctx)`** — runs at **lock time** (`anvil lock`), never at
  build time. Given a parsed ref (`source:id@version`) and the ambient
  `SourceContext` (the source's own rate-limited `Http` client, the frozen
  `ctx.now` lock clock, the BYO key if any, `ctx.store` to admit hashed bytes,
  `ctx.game` to filter by Minecraft version/loader), it must:
  - call `ctx.allowSource(ref)` *before any network I/O* — this is the
    embedder's veto gate; a refused source must not be fetched;
  - resolve the version spec (`pin` / `range` / `latest`) deterministically
    under `ctx.now`, so re-resolving the same manifest at the same clock
    always picks the same artifact;
  - fetch and hash the bytes into a real `{ algo, value }` `Hash` — sha256 for
    anything anvil owns (everything except the Mojang asset domain);
  - admit the bytes into `ctx.store` (via `putBuffer`/`putFile`) when present,
    so a subsequent build does zero network I/O;
  - return a fully-pinned `LockPackage` (`pkg`) plus any **required** transitive
    dependencies as `ResolvedRef[]` (`dependencies`) — optional/embedded deps
    are filtered out before they reach the resolver;
  - infer the item's `ItemKind` via `inferKind()` (`src/sources/kind.ts`)
    rather than guessing — an ambiguous kind should fail closed, not default.
- **`plan(pkg, ctx)`** — runs at **build time**, must do **no network I/O**,
  and turns an already-pinned `LockPackage` back into a `FetchPlan` (the URL,
  any headers, the expected `Hash`, the provenance). The lock is the sole
  build input; `plan` only reads the `pkg` it's given.

**Provenance matters.** Almost everything is `provenance: "copy"` — cacheable
in the shared content store. The one exception is CurseForge, which is
`provenance: "replay"` per its ToS (fetched fresh per-client, never cached in
the shared store or re-hosted — see [`SECURITY.md`](./SECURITY.md) and the
third invariant below). Don't add a new `"replay"` source without reading
`src/store/replay-cache.ts` and `test/security/replay-tos-audit.test.ts` first
— it's a standing hard review gate, not a detail to improvise.

**Register it.** Add the source to `buildRegistry()` in
`src/sources/registry.ts` (each source gets its own `RateLimitedHttp` instance
so token buckets and User-Agent stay scoped per source), and export it from
`src/sources/index.ts`.

**Read a reference implementation before writing your own.**
`src/sources/url.ts` is the simplest complete example (fetch → SSRF-guarded →
hash → infer kind → store → pin). `src/sources/modrinth.ts` is the fuller
pattern: a small typed API client (`ModrinthApi`), a frozen-clock version
selection, and the batched transitive-dependency fan-out. Both are worth
reading end to end before writing a new `Source`.

## Tests & fixtures

Tests are `vitest`, one spec file per module, mirroring `src/` under `test/`.
`test/helpers/` has the shared scaffolding: `fixtures.ts` (temp dirs, a
content-addressed fixtures pool, the deterministic `treeManifest()` fingerprint
the determinism tests compare), `net.ts`, `zip.ts`, `game.ts`, `mrpack.ts`,
`curseforge.ts`, `remote.ts`, `vc.ts`, `scenario.ts`, `cli.ts`.

**The network seam is a fake `Http` implementation, not a recorded cassette.**
Every `Source` takes its HTTP client through the `Http` interface
(`get`/`post`), so tests build an in-memory fake (e.g. `FakeModrinth` in
`test/helpers/net.ts`) that replays realistic response shapes — project/version
JSON, file bytes — entirely offline; nothing in the suite touches the real
network. `test/sources/http.test.ts` additionally wraps the *real*
`RateLimitedHttp` around a scripted low-level `fetch` + injected DNS + a
virtual clock, so the token bucket, backoff, redirects, and the SSRF guard all
run for real, still offline.

**If you ever do add a recorded fixture** (a captured real HTTP response,
especially anything from CurseForge's Core API), **scrub it for secrets before
committing**: strip any `x-api-key` header, bearer token, or other credential
from the request *and* response side, and check that a "download URL" in the
payload doesn't itself embed a key. A leaked key in a fixture file is a
security incident, not a test-hygiene nit.

## The three invariants — review discipline

Every PR is implicitly reviewed against these three. If your change could
plausibly touch one, say so in the PR description and show how it's preserved
— "it doesn't look related" is not a substitute for checking.

1. **Determinism.** The same `anvil.lock` produces a byte-identical instance on
   any machine/OS/Node version. Every fetched artifact is hash-pinned; every
   *generated* file (the merged `version.json`, the lock TOML itself) is
   canonicalized — sorted keys, deduped/ordered library unions, forced `/` in
   serialized paths. If you generate a new kind of file, it needs a
   determinism test (cross-OS-shaped, at minimum cross-run).
2. **Atomic swap.** `anvil build` never leaves a half-installed instance. All
   changes stage into `.anvil/stage-<id>` and go live through the journaled
   swap (`src/build/swap.ts`) — a crash at any point leaves either the fully
   old or the fully new instance, never a mix. **`saves/` is never touched**
   (enforced by `IgnoreSet`, not just convention). If you touch the swap,
   acquire, or placement path, run it against the crash-recovery tests
   (`test/build/`) and think about what a kill -9 mid-write does.
3. **Replay-never-rehosted.** CurseForge bytes are `provenance: "replay"`:
   fetched per-client under the user's own key, materialized only into the
   per-instance `.anvil/replay-cache/` (`src/store/replay-cache.ts`), and
   structurally unreachable from the shared store, GC, transfer, or export
   code — not just excluded by convention. If your change touches store
   serving, GC, remote transfer, or `.mrpack` export, it must not gain a path
   that can read `replay-cache/`; `test/security/replay-tos-audit.test.ts` is
   the standing gate.

## PR process

- Branch from an up-to-date `main` (`git checkout main && git pull`, then
  branch — never off another in-flight feature branch, or its commits leak
  into your diff).
- Conventional-commit-style subject lines (`feat: …`, `fix: …`, `docs: …`,
  `refactor: …`, `chore: …`, `test: …`) — this repo's `git log` is the style
  guide if in doubt.
- All four gates green locally (`npm run check` covers three of them; add
  `npm run build`) before you open the PR. CI re-runs the full OS × Node
  matrix regardless, but a red local gate means a red CI.
- If your change affects trust/safety behavior (a new source, a new
  extraction site, anything processor- or network-related), read
  [`SECURITY.md`](./SECURITY.md) — it documents the trust model
  (trust-the-source for build code, `allowSource`/`allowProcessor` as the
  embedder's policy seams) that your change needs to be consistent with.
- Small, focused PRs are easier to review against the invariants above than
  one PR that touches five subsystems.
