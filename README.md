# lobbify-anvil

> **git + docker + uv for `.minecraft`** — a reproducible, content-addressed build
> system for Minecraft instances.

**Status: MVP complete (Stages 0–4).** The content store, atomic build engine, the
Modrinth/URL/local sources + resolver, the full Mojang + Fabric/Quilt game installer,
the thin `lobbify-anvil` CLI, and `.mrpack` import all ship. The version-control and
remote verbs (`commit`/`branch`/`merge`/`clone`/`pull`/`push`/`export`) are the next
tiers and still throw `NotImplemented`. See the roadmap below.

If you know **git**, **Docker**, and **uv**, you already know anvil: you write a
**manifest** (like a `pyproject.toml`), `anvil lock` freezes it (like `uv.lock`),
`anvil build` installs a complete, launch-ready instance (like `docker build`), and
the whole thing is versioned with full git semantics — commit, branch, merge, rebase.
It resolves everything to pinned hashes, so a manifest builds **byte-for-byte
identically** on any machine. anvil deliberately does **not** launch the game
(that's `docker run`, out of scope) — it produces a fully installed instance; a
launcher runs it.

It is **standalone** (no dependency on Lobbify) and **library-first**: the CLI is a
thin skin over an npm package, and a host app calls the package directly.

## Install

anvil installs **directly from GitHub** — no npm-registry publish required. The package
builds itself on install (a `prepare` step runs `tsup`), so you get both the library
(`@lobbify/anvil`) and the working `lobbify-anvil` CLI from a single install.

```bash
# As a library dependency (import { Anvil } from "@lobbify/anvil")
npm install github:Lobbify/lobbify-anvil
# bun add github:Lobbify/lobbify-anvil
# pnpm add github:Lobbify/lobbify-anvil
# yarn add github:Lobbify/lobbify-anvil

# As a global CLI
npm install -g github:Lobbify/lobbify-anvil
lobbify-anvil --help

# One-off, no install
npx github:Lobbify/lobbify-anvil --help

# Pin to a released version tag (recommended for reproducibility)
npm install github:Lobbify/lobbify-anvil#v0.1.0
```

> The install runs a build (`tsup`), so it takes a few seconds and needs a network
> connection the first time. Node **20** or **22** is required (see `engines`).

## The mental model

| Borrowed from | Idea | In anvil |
|---|---|---|
| **uv** | a manifest + a lockfile of pinned items | `anvil.toml` + `anvil.lock` |
| **Docker** | build a complete image from a recipe | `anvil build` → a launch-ready instance |
| **git** | a `.git/`-style brain; commit/branch/merge | `.anvil/`; `commit` / `branch` / `merge` |

**The folder *is* the instance.** Your project directory is a standard, launch-ready
`.minecraft` at the top level; the manifest and ignore file sit at the root, and
everything anvil manages internally lives in a hidden `.anvil/` (its brain, like `.git/`).
Heavy shared content (assets, libraries, runtime) is deduplicated through a shared
content store — which can simply *be* an existing `.minecraft/assets` you already have.

## Quickstart

```bash
# Install the CLI from GitHub. NOTE: the bin is `lobbify-anvil` (not bare `anvil`,
# which would collide with Foundry's anvil). Alias it if you like: alias anvil=lobbify-anvil
npm install -g github:Lobbify/lobbify-anvil
lobbify-anvil --version

# Author a pack from vanilla and build a launch-ready instance
mkdir night-smp && cd night-smp
lobbify-anvil init --name night-smp --minecraft 26.2 --loader "fabric 0.19.3"
lobbify-anvil add modrinth:fabric-api modrinth:sodium modrinth:jei
lobbify-anvil lock     # resolve + pin the game and items
lobbify-anvil build    # install client, assets, java, loader, items — atomically
lobbify-anvil verify   # re-hash the instance against the lock

# Or adopt a Modrinth modpack you already have:
lobbify-anvil import cobblemon.mrpack && lobbify-anvil build
```

### CLI reference

| Command | What it does |
|---|---|
| `init` | Scaffold `anvil.toml` (+ a documented `.anvilignore`). Flags: `--name`, `--minecraft/--mc`, `--loader`, `--summary`, `--force`. |
| `add <ref>…` | Append item references (`source:id@ver`, a URL, or a `./path`) to the manifest. |
| `remove <ref>…` | Drop item references from the manifest. |
| `lock` | Resolve the manifest → a fully-pinned `anvil.lock`. `--upgrade` re-resolves everything; `--upgrade=<item>` just one. |
| `build` | Install a launch-ready instance from the lock, atomically. `--offline` builds only from the populated store. |
| `verify` | Re-hash the materialized instance against the lock. `--strict` also fails on drift from the current lock. |
| `status` | The manifest-vs-lock-vs-built dirty state (what to run next). |
| `diff` | The package delta the next `build` would apply. |
| `why <item>` | Which root item pulled a (transitive) dependency in. |
| `import <pack.mrpack>` | Adopt a Modrinth modpack (writes `anvil.toml` + a pre-resolved `anvil.lock`). |
| `gc` / `fsck` | Mark-sweep the content store / re-hash every stored object. |

Every command takes `--dir <path>` (defaults to the cwd) and `--json` (emit a single
machine-readable JSON object on stdout, for CI). `ANVIL_STORE_DIR` overrides the shared
store location; `CURSEFORGE_API_KEY` supplies the BYO CurseForge key.

### Exit codes (for scripting / CI)

`0` is success; `1` a generic/usage error; `70` an unexpected internal bug. Typed
failures map to stable, documented codes (append-only — a shipped code is an API):

| Code | Meaning | | Code | Meaning |
|---|---|---|---|---|
| `3` | manifest invalid | | `12` | unsafe path (zip-slip) |
| `4` | lock invalid | | `13` | decompression bomb |
| `5` | source not allowed | | `14` | HTTP error |
| `6` | source key missing | | `15` | cross-volume |
| `7` | SSRF blocked | | `16` | preflight failed |
| `8` | version conflict | | `17` | swap recovery failed |
| `9` | unsatisfiable target | | `18` | non-fast-forward |
| `10` | hash mismatch | | `19` | kind inference failed |
| `11` | missing object (offline) | | `20` | not implemented |

Embed it as a library (this is how Lobbify uses it):

```ts
import { Anvil } from "@lobbify/anvil";

const anvil = new Anvil({
  dir: "/lobbify/instances/room-abc",
  paths: { assets: "/lobbify/shared/assets", libraries: "/lobbify/shared/libraries" },
  curseforgeKey: process.env.CURSEFORGE_API_KEY,
  allowSource: (ref) => isLobbifyAuthorized(ref),
});

anvil.on("progress", (event) => updateJoinUI(event));
await anvil.clone(roomManifestUrl);   // fetch manifest+lock, build in place
await anvil.pull();                    // later: fast-forward to the host
```

## Feature tiers (what ships when)

| Tier | Scope |
|---|---|
| **MVP** (Stages 0–4) | manifest + lock + content store + **full game install** (the folder is the instance) + `build`/`verify`; **vanilla + Modrinth + local files**; the CLI (`init`/`add`/`remove`/`lock`/`build`/`verify`/`status`/`diff`/`why`/`import`/`gc`/`fsck`, `--json`, stable exit codes); `.anvilignore`; the library API + path mapping; import `.mrpack`. |
| **v1** (Stages 5–8) | **CurseForge** (bring-your-own key, replay); **full version control** (commit/branch/switch/merge/rebase/revert/log); `clone`/`pull`/`push`; interactive TUI; `export`; Prism import. |
| **v1+** (Stage 9) | NeoForge/Forge; chunked deltas for big files; richer remotes/registries; advanced merge strategies; datapack/shader niceties; OSS-release hardening. |

## CurseForge — bring your own key

CurseForge works but needs **your own** API key, which is **never stored in the repo**:

```bash
export CURSEFORGE_API_KEY=…      # your key; stays out of anvil.toml / anvil.lock
```

Per CurseForge's terms, CF items are **replay** provenance: each client re-fetches the
bytes from CurseForge itself under its own key. anvil **never re-hosts, transfers,
pushes, or exports** CurseForge bytes — `.mrpack` export omits them with a warning.
Everything else (Mojang files, Modrinth jars, local files) is `copy` provenance:
cacheable and shareable through the content store.

## Trust model & security

**anvil runs build code provided by the sources you build.** Building a Forge or
NeoForge instance runs that installer's **processors** — JVM programs (the binpatcher,
the SRG renamer, installertools) that patch the client jar at build time. `anvil build`
executes them **by default**, using the build's pinned JRE.

This is the same, deliberate **trust-the-source** model you already rely on elsewhere:

| Tool | Runs your source's code |
|---|---|
| **git** | hooks (`pre-commit`, `post-checkout`, …) |
| **npm/yarn/pnpm** | `preinstall` / `postinstall` lifecycle scripts |
| **docker** | every `RUN` in the `Dockerfile` |
| **Gradle / Maven** | the build script itself |
| **anvil** | a Forge/NeoForge installer's processors |

> **Only build instances from sources you trust.** The standalone tool is **not** a
> sandbox against its own inputs, and does **not** claim to protect you from a
> malicious modpack, installer, or manifest you chose to build. A processor is
> arbitrary code; if you don't trust where a pack came from, don't build it.

**What anvil *does* guarantee** is reproducibility and no silent surprises, not
safety-from-your-inputs: every fetched artifact (including processor jars and their
classpath deps) is **sha256-pinned** so a rebuild is byte-identical; all network I/O
goes through an **SSRF-guarded** client; and every archive extraction is **zip-slip
guarded**. Those are integrity/DoS protections — they are *not* a defense against the
build code of a source you told it to build.

**Embedding anvil to build from untrusted/remote sources?** Then *you* own the
sandboxing, and anvil gives you the seams:

- **`allowSource(ref)`** — vetoed **before any network I/O**; refuse sources you don't trust.
- **`allowProcessor(proc)`** — called before each installer processor runs; return
  `false` to block it (a typed `PROCESSOR_REFUSED`). Defaults to allow.
- **a custom `ProcessorRunner`** — inject a runner that wraps the JVM in a real OS
  sandbox (namespaces / `sandbox-exec` / a container) instead of the default launcher.

See [`SECURITY.md`](./SECURITY.md) for the full model and reporting.

## Development

```bash
npm install
npm run check     # biome check && tsc --noEmit && vitest run
npm run build     # tsup → dist/
```

See [`AGENT.md`](./AGENT.md) for conventions and the three hard invariants
(determinism · atomic swap · replay-never-rehosted) that gate every change.

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution. Mojang, Modrinth,
and CurseForge are named only as data sources — not endorsements.
