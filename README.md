# lobbify-anvil

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-339933?logo=node.js&logoColor=white)](./package.json)

> **git + docker + uv for `.minecraft`** — a reproducible, content-addressed build
> system for Minecraft instances.

**Status: feature-complete through v1, plus Forge/NeoForge.** The content store, atomic
build engine, the Modrinth/URL/local/**CurseForge** sources + resolver, the full Mojang
game installer with **all four loaders (Fabric, Quilt, Forge, NeoForge)**, anvil's own
**version control** (`commit`/`branch`/`merge`/`rebase`), **remotes**
(`clone`/`pull`/`push`), `.mrpack` + Prism import, `.mrpack` export, the thin
`lobbify-anvil` CLI, and a colorful interactive TUI all ship. Remaining v1+ items
(chunked deltas, recursive virtual-base merge, more registries) are on the roadmap below.

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

Because the folder is the instance, **an item you list by path is placed at that path**.
`"./config/sodium/mixins.json"` is read from there and built back there, nesting intact,
and `"./options.txt"` stays at the instance root. Only an item that names no path of its
own — every `modrinth:` / `curseforge:` / URL item, and a local file that lives outside
the instance — is placed by its kind, into `mods/`, `resourcepacks/`, `shaderpacks/`,
`datapacks/`, or `config/`. Paths under `saves/`, `.anvil/`, or `.anvilignore` are refused.

## Starting from an existing pack

An instance can start from a published modpack and describe itself as a diff
against it, instead of listing several hundred items:

```toml
[game]
minecraft = "26.2"
loader    = "fabric 0.19.3"
from      = "modrinth:all-the-mods-10@4.6"   # the base layer
remove    = ["modrinth:unwanted-mod"]        # things the pack ships that you don't want

items = [
  "modrinth:sodium@0.6.0",     # overrides the pack's sodium, whatever version it shipped
  "./config/tuning.toml",      # overrides the pack's config at that path
]
```

**Your items always win.** An item of yours replaces a base member that shares its
identity (`modrinth:sodium` replaces the pack's sodium, and the pack's old jar is
not installed alongside) or its destination (`./config/tuning.toml` replaces the
pack's file at `config/tuning.toml`). A `remove` entry matches on either axis too,
and an entry matching nothing fails the lock rather than passing silently.

The pack is resolved **once, at `anvil lock`**. The lock ends up holding ordinary
pinned rows, so `anvil build` never fetches a pack and a pack changed upstream
cannot change an instance you already locked. The lock also records which rows
came from the base and a digest of the base's member set, so two instances built
on the same pack can be compared without inspecting either one's members.

Full precedence rules: [ARCHITECTURE.md → Base packs](ARCHITECTURE.md#base-packs-gamefrom-srcbase).

## What a commit captures

A commit records the **source state** of the folder, not the build product:

- `anvil.toml`, `anvil.lock`, and `.anvilignore`;
- the bytes of every **local** item the lock declares, so an old commit is
  self-contained and still switchable after the shared store has been garbage
  collected;
- every **undeclared** file in the folder — a hand-edited `config/…`, your
  `options.txt`, a jar you dropped into `mods/` yourself.

It does not record the game install (`assets/`, `libraries/`, `versions/`,
`natives/`, `runtime/`), which `anvil build` re-derives from the lock; anything else
the lock says the build owns; `saves/`; runtime churn (`logs/`, `crash-reports/`,
`screenshots/`, `backups/`, `debug/`, `.fabric/`, `.mixin.out/`, `.cache/`,
`server-resource-packs/`, `usercache.json`, `usernamecache.json`,
`realms_persistence.json`); or the cruft your OS and editor leave anywhere in the
tree (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.directory`, `*.swp`, `*.swo`,
`*~`). Opening the folder in Finder or Explorer therefore does not dirty it.

To keep something else out of your history, list it in **`.anvilexclude`**. The two
dotfiles are easy to confuse, so:

> **`.anvilignore` says the build must not touch this. `.anvilexclude` says version
> control must not record this.**

In `.anvilexclude`, blank lines and `#` comments are ignored and a line takes one of
three forms:

| Line | Form | Matches |
|---|---|---|
| `*.log` | a `*`, no `/` | that **basename**, at any depth |
| `config/*.json` | a `*` and a `/` | the whole **path**, segment by segment |
| `notes/` | no `*` | that literal path, and everything under it |

`*` is the only wildcard (no `?`, no `**`) and it never crosses a `/`, so
`config/*.json` matches `config/a.json` but not `config/sub/a.json`. A path or
prefix line also claims everything under what it matches. Matching ignores case, and
there is no negation. An excluded path is skipped in both directions — never
written, never deleted — so excluding `screenshots/` and then switching branches
does not delete your screenshots.

Three limits worth knowing. **Symlinks are not tracked**: there is no way to record
a link target in the object store, and following one can escape the instance. **No
file mode is recorded**: Windows cannot represent an exec bit, and recording one
would make the same tree produce different commit ids on different machines. **Two
files whose paths differ only by case or Unicode form are refused**: they are one
file on Windows and macOS, so a checkout would keep one and silently lose the
other's bytes. `commit` names both paths and asks you to rename one.

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
| `init` | Scaffold `anvil.toml` (+ documented `.anvilignore` and `.anvilexclude` files). Flags: `--name`, `--minecraft/--mc`, `--loader`, `--summary`, `--force`. |
| `add <ref>…` | Append item references (`source:id@ver`, a URL, or a `./path`) to the manifest. |
| `remove <ref>…` | Drop item references from the manifest. |
| `lock` | Resolve the manifest → a fully-pinned `anvil.lock`. `--upgrade` re-resolves everything; `--upgrade=<item>` just one. |
| `build` | Install a launch-ready instance from the lock, atomically. `--offline` builds only from the populated store. |
| `verify` | Re-hash the materialized instance against the lock. `--strict` also fails on drift from the current lock. |
| `status` | The manifest-vs-lock-vs-built dirty state, plus whether the working tree has uncommitted changes (what to run next). |
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
guarded**. History pulled from a remote is bounded the same way: an object is
verified against the hash it arrived under, refused if it inflates past 512 MiB, and
refused if a snapshot lists more than 100,000 tracked files. Those are integrity/DoS
protections — they are *not* a defense against the build code of a source you told
it to build.

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

## Contributing & docs

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, the four gates, how to add
  a new `Source`, and the test/fixture conventions.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — a design overview: the content store,
  manifest → resolver → lock, the build pipeline, anvil's own version control,
  remotes, and the trust model.
- [`SECURITY.md`](./SECURITY.md) — the trust model in full, and how to report a
  vulnerability.

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution. Mojang, Modrinth,
and CurseForge are named only as data sources — not endorsements.
