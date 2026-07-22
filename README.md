# lobbify-anvil

> **git + docker + uv for `.minecraft`** — a reproducible, content-addressed build
> system for Minecraft instances.

**Status: WIP — Stage 0 (scaffold + type spine).** The public API is typed and the
CI is green, but the subsystems are not implemented yet; every `Anvil` method throws
`NotImplemented` until its stage lands. See the roadmap below.

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

## Quickstart (placeholder — not yet implemented)

```bash
# Install the CLI. NOTE: the bin is `lobbify-anvil` (not bare `anvil`, which would
# collide with Foundry's anvil). Add your own alias if you like: alias anvil=lobbify-anvil
npm install -g lobbify-anvil
lobbify-anvil --version

# Author a pack from vanilla and build a launch-ready instance
lobbify-anvil init night-smp --minecraft 26.2 --loader fabric
cd night-smp
lobbify-anvil add modrinth:fabric-api modrinth:sodium modrinth:jei
lobbify-anvil lock     # resolve + pin the game and items
lobbify-anvil build    # install client, assets, java, loader, items — atomically
```

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
| **MVP** (Stages 0–4) | manifest + lock + content store + **full game install** (the folder is the instance) + `build`/`verify`; **vanilla + Modrinth + local files**; CLI core; `.anvilignore`; the library API + path mapping; import `.mrpack`. |
| **v1** (Stages 5–8) | **CurseForge** (bring-your-own key, replay); **full version control** (commit/branch/switch/merge/rebase/revert/log); `clone`/`pull`/`push`; `diff`; interactive TUI; `export`; Prism import. |
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
