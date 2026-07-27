# Architecture

A design overview of `@lobbify/anvil` — not exhaustive, and not a substitute
for reading the module you're changing. Module names below are real paths in
`src/`; when in doubt, the barrel (`index.ts`) of a subsystem is the more
authoritative description than this document.

## The folder is the instance

There is no separate "project" vs. "installed instance" split. Your project
directory **is** a standard, launch-ready `.minecraft` folder:

```text
my-pack/
├── anvil.toml          # the manifest — human-authored, portable, no machine paths
├── anvil.lock          # the fully-pinned lockfile — the sole build input
├── .anvilignore         # extra top-level paths the build must never touch
├── .anvil/              # anvil's own brain (like .git/) — see below
├── mods/                # placed by the build, per the lock
├── resourcepacks/
├── assets/, libraries/, versions/, saves/, …   # standard .minecraft layout
```

`.anvil/` holds everything anvil manages internally: the object model and refs
for its own version control (`src/vc/`), the swap journal and stage
directories used during a build (`src/build/swap.ts`), the per-instance replay
cache (`src/store/replay-cache.ts`), the dependency graph sidecar `anvil why`
reads, and `config.toml` (remotes, path mappings). Heavy shared content
(Mojang assets/libraries/runtime) is deduplicated through a **shared** content
store outside the instance — which can simply *be* an existing
`.minecraft/assets` directory you already have (see path mapping, below).

## Content-addressed store (`src/store/`)

Two domains under one store root (`ContentStore`, `src/store/store.ts`):

- `assets/objects/<xx>/<sha1>` — the **sha1** Mojang-native asset domain, so
  the store can literally *be* an existing `.minecraft/assets`.
- `blobs/objects/<xx>/<sha256>` — the **sha256** domain for everything anvil
  itself owns (mods, resourcepacks, the game jar, loader libraries, the
  generated `version.json`, …).

Because there are two hash algorithms in play, a bare `string` hash is never
passed around — every hash is a `{ algo, value }` pair (`Hash`,
`src/types/core.ts`) so the algorithm tag travels with the value. Objects are
sharded by the first two hex characters of the digest and written `0444`
(read-only), so a link into an instance physically cannot be edited in place.

**Materialization** (`src/store/linking.ts`) prefers to *share bytes* with the
store rather than copy them, falling through a chain: **reflink → hardlink →
symlink → copy**. Reflink/hardlink can't cross filesystem volumes, so a
store/instance device mismatch falls back to a real copy (never a fragile
symlink); symlink is never chosen by default (and never on Windows).

**GC** (`ContentStore.gc`) is mark-sweep: it unions the reachable set from
every locked instance in the on-disk **instance registry**
(`src/store/registry.ts`), plus a short time-based grace window for
just-written-but-not-yet-registered objects, and reclaims everything else.
`fsck` re-hashes every object against its own filename to catch corruption.

**CurseForge bytes never enter this store.** They are a structurally separate
type, `ReplayCache`, living under the instance's own `.anvil/replay-cache/` —
see [Replay-never-rehosted](#replay-never-rehosted-curseforge), below.

## Manifest → resolver → lock

- **Manifest** (`src/manifest/`, `anvil.toml`) — the human-authored input: a
  project header, a `GameSpec` (Minecraft version + loader string, optionally
  `from:` an existing pack to start from), and one flat, declarative `items`
  list. There is deliberately no separate "mods" vs. "resourcepacks" list —
  every item (mod, resourcepack, shader, datapack, local file, whatever) is
  the same `ManifestItem`, either a `source:id@version` ref or a local path;
  its `ItemKind` is inferred, not hand-categorized. **Where an item lands** has
  two rules, in precedence order: an item listed by an in-instance path is
  placed at that path verbatim (`"./config/sodium/mixins.json"` nests,
  `"./options.txt"` stays at the root), and everything else — every remote
  source, plus a local file outside the instance — is placed by its kind, into
  `mods/`, `resourcepacks/`, `shaderpacks/`, `datapacks/`, or `config/`. The
  path→placement derivation is `declaredPlacementTarget` in
  `src/sources/place.ts`; it folds every `.`/`..`, declines to place anything
  that resolves outside the root (kind-directory fallback), and refuses a
  protected top (`saves/`, `.anvil/`, `.anvilignore`) outright rather than
  quietly re-homing it into a kind directory.
- **Resolver** (`src/resolver/resolve.ts`) — a single-pass BFS worklist over
  the manifest's roots and their transitive dependencies. For every ref
  reached, `allowSource(ref)` is evaluated **before any network I/O** (the
  embedder's veto gate), then the matching `Source.resolve()` runs under a
  **frozen `now` clock**, so a `latest`/omitted version spec is deterministic
  across repeated `anvil lock` runs at the same instant. Identity is a
  canonical key per source (Modrinth slug/id, the final URL, the absolute
  local path, the CurseForge project id), so the same project referenced two
  different ways still dedups to one lock entry. Conflicts are **fail-closed**:
  one resolved version per project; a second demand that the pinned version
  can't satisfy stops the resolve with a typed error naming both demanders. A
  re-lock can also be **constrained** — reusing a prior lock's pins verbatim
  for everything not explicitly `--upgrade`d — which is how Stage 5's VC
  merge/rebase re-lock stays minimal and deterministic.
- **Lock** (`src/lock/`, `anvil.lock`) — the resolver's output: a canonical,
  deterministically-serialized TOML file (`src/lock/serialize.ts`,
  `src/lock/toml.ts`) that is the **sole input to a build**. A build never
  reads the manifest or touches source APIs for anything it already has
  pinned; it only fetches bytes the store doesn't have yet for pins the lock
  already names. Every `LockPackage` row carries everything needed to fetch,
  verify, and place the item byte-identically: its `Hash`, `Placement`,
  `provenance` (`copy` vs. `replay`), and optional platform `targets`.

## Base packs (`game.from`, `src/base/`)

An instance may start from an existing modpack instead of listing every item
itself:

```toml
[game]
minecraft = "26.2"
loader    = "fabric 0.19.3"
from      = "modrinth:all-the-mods-10@4.6"
remove    = ["modrinth:unwanted-mod", "./config/pack-defaults.toml"]

items = ["modrinth:sodium@0.6.0"]
```

That instance is two layers: the pack's members underneath, the manifest's own
`items` on top. `src/base/` owns both halves — `mrpack-base.ts` (Modrinth) and
`cf-base.ts` (CurseForge) turn a pack reference into a pinned member set,
`overlay.ts` lays the instance over it, and `diff.ts` compares two member sets.

### The two formats pin differently, and that is the point

A Modrinth `.mrpack` index names each member by **URL + hash**. A CurseForge
`manifest.json` names each member by a **`(projectID, fileID)` identity pair** and
states nothing else. So the two sources do genuinely different work:

|                        | `.mrpack`                              | CurseForge pack                        |
| ---------------------- | -------------------------------------- | -------------------------------------- |
| member named by        | URL + sha512/sha1                      | `(projectID, fileID)`                   |
| identity recovery      | reverse the CDN URL, 2 batched calls   | already in the manifest                 |
| bytes at lock time     | every member downloaded                | **none** — metadata only                |
| pack can lie about     | hashes, URLs, paths                    | nothing about a member                  |
| diff two versions      | compare content addresses              | set difference on the pair              |

`cf-base.ts` therefore downloads exactly one thing: the pack archive, to read its
`manifest.json` and `overrides/`. Member facts (filename, size, class, the attested
sha1 it pins) come from the CurseForge API for each pair. That is what makes a
482-member pack usable as a base, and what makes `diffMemberSets` cheap enough to
run on two pack versions.

Members are emitted `provenance: "replay"` with no `url`, so the replay-never-rehosted
machinery routes them away from the shared store without `cf-base.ts` enforcing
anything itself. Their pin is sha1 — the strongest hash CurseForge attests for a file
— which is why `ReplayCache` carries a sha1 domain alongside sha256.

### Precedence

The effective set is computed in three phases:

1. **Remove.** Each `game.remove` entry drops matching packages from *both*
   layers. An entry matches on either axis: **identity** (`modrinth:sodium`
   matches the member whose canonical key or slug is `sodium`, same source only)
   or **placement path** (`"./config/x.toml"` matches whatever `link`s to
   `config/x.toml`). An entry that matches nothing **fails the lock** — the
   failure it prevents is shipping the mod you believed you removed.
2. **Override.** A base member is dropped when any instance package matches it
   on either axis:
   - **identity** — same canonical key. Bumping a base mod drops the *whole*
     base member, its old filename included, so `mods/sodium-0.5.8.jar` does not
     survive next to `mods/sodium-0.6.0.jar`.
   - **placement target** — same `link` target. Overriding a pack config works
     here, where the two sides share no catalogue identity at all: a base config
     is a `local` blob under `.anvil/base/`, yours is a `local` path in the
     instance, and all they have in common is where they land.

   Either axis, never both, so the phase is order-independent: a base member is
   dropped iff some instance package claims its identity or its destination.
3. **Union**, then the ordinary placement-collision check. After phase 2 that
   check can only fire for two *instance* items — base-vs-instance clashes were
   already resolved, by rule, in the instance's favour.

**The instance always wins.** No rule lets a base member displace something the
manifest asked for, which is also why a hostile pack cannot shadow your files.

Transitive dependencies are the one place the base gets a say: a dependency the
base already provides reuses the base's pin rather than resolving fresh, so
adding one mod does not silently bump a mod the pack chose. A **root** you listed
yourself is never pinned this way — you listed it, you control it.

### What the lock records

```toml
[base]
ref     = "modrinth:all-the-mods-10@4.6"
source  = "modrinth"
id      = "all-the-mods-10"
version = "4.6"
archive = "sha256:…"   # the .mrpack's own pin
set     = "sha256:…"   # digest over the resolved member set, pre-overlay
members = 482
```

plus `from_base = true` on every base-derived `[[package]]`. Both are omitted
entirely for an instance with no base, so such a lock is byte-identical to what
it was before base packs existed.

`set` is the property the sync use case rests on. Two instances whose locks carry
the same `set` started from byte-identical base members, so the entire flagged
partition — several hundred rows — is known equal without comparing a single
entry, and only the unflagged overlay has to be reconciled. Where the digests
differ, the rows themselves are still a usable diff primitive: a Modrinth member
carries slug + version, a CurseForge member carries `(project, file)`.

### Base resolution happens once, at lock time

The build reads `[[package]]` rows and nothing else; it never fetches a pack.
A pack edited or withdrawn upstream cannot change an instance that already
locked, which is what keeps `game.from` inside the determinism invariant.

Two files support that. `.anvil/base/` holds the pack's loose `overrides/` as
tracked `local` files, so their bytes are addressable offline (and carried into
commits like any local item). `.anvil/base.lock` caches the base's **full**
member set — the instance lock holds only the survivors, and re-running the
overlay against survivors would make a `game.remove` entry match nothing the
second time and would strand a base member that an override had displaced. Same
pattern as `.anvil/graph.json`: a fact `lock` produced that the deterministic
lock must not carry, kept where the next `lock` can read it.

### Adding a source

`BasePackSource` (`src/base/types.ts`) is the seam. An implementation owes the
resolver fully-pinned members with decided placements, catalogue identity where
it exists, and its own bounds on untrusted pack data. CurseForge was added beside
Modrinth without the resolver changing: `buildBaseRegistry()` gained one entry,
and `anvil.ts` already looked the source up by the ref's kind.

## Build pipeline (`src/build/`)

```mermaid
flowchart LR
    A[recoverSwap\nreconcile any\ninterrupted swap] --> B[preflight\nfilter by platform/\nrules, disk space]
    B --> C[acquire\nfetch missing\nbytes into the store]
    C --> D[stage\nmaterialize into\n.anvil/stage-id]
    D --> E[verify\nre-hash staged\ntargets vs. the lock]
    E --> F[journaled\natomic swap]
    F --> G[write\n.anvil/refs/built]
```

1. **Recover** — every build first calls `recoverSwap()` to reconcile any
   swap interrupted by a prior crash, so it always starts from a consistent
   instance.
2. **Preflight** (`preflight.ts`) — filters the lock's packages down to the
   ones that actually apply to this build: per-OS/arch `targets` (natives,
   the JRE), Mojang "rules" evaluation, and a disk-space check.
3. **Acquire** (`acquire.ts`, an injectable `Acquirer`) — fetches only the
   bytes the store is missing; a `--offline` build uses a
   store-only acquirer and fails fast on the first gap instead.
4. **Stage** — the placement executor (`src/store/placement.ts`) turns each
   pinned `LockPackage` into materialized bytes under `.anvil/stage-<id>`, per
   its `Placement` discriminant: `link` (single file), `extract`
   (safe-extracted archive, e.g. natives), `asset-tree` (a full Mojang asset
   index + objects), `runtime-tree` (a per-platform JRE tree, preserving the
   executable bit and mac-bundle symlinks), `store-only` (present in the
   store, nothing placed), or `forge-build` (run the pinned Forge/NeoForge
   installer processors and land their declared `outputs`). Every target path
   is `safeJoin`ed under the instance root — a placement can never escape it.
5. **Verify** — every single-file/asset-index target is re-hashed against its
   pin before the swap commits.
6. **Atomic swap** (`swap.ts`) — see below.
7. **Record** — the built lock is written to `.anvil/refs/built` so the next
   build can compute an incremental delta (`incremental.ts`) instead of
   re-staging everything.

The **game install** itself — `resolveGame()` at lock time, `GameAcquirer` at
build time (`src/game/`) — walks the Mojang version manifest for the client
jar, asset index, and libraries; installs the pinned per-platform Java runtime
as a `runtime-tree`; and, when the manifest names a loader, layers in Fabric or
Quilt (via their meta APIs) or Forge/NeoForge (via that ecosystem's installer,
whose **processors** — the binpatcher, SRG renamer, installertools — run as
pinned build code at build time; see the trust model below). All of it is
merged into one canonical `version.json` (sorted keys, deduped/ordered library
union) so the generated file is as reproducible as anything fetched.

### Atomic swap

The build never leaves a half-installed instance. Changed targets are staged
on the **same volume** as the instance (so the final move is a rename, not a
copy), then installed through a write-ahead journal
(`.anvil/swap.journal`): for each target, move any existing file aside into a
backup, then move the new one in; a single `commit` line is the
linearization point. The journal file and every directory it renames through
are `fsync`ed *before* the commit line is written, so a crash can never roll
forward onto a rename that never actually hit disk. Recovery
(`recoverSwap()`) reconciles an interrupted swap to **fully old** (no commit
line) or **fully new** (commit present) — never a mix. The swap set is built
only from non-protected targets, so `saves/` — and anything else
`.anvilignore` protects — is structurally never part of a swap, at any crash
point.

## anvil's own version control (`src/vc/`)

Not a git wrapper — a small, purpose-built object model and history engine
over the **item-set**, not the raw files:

- **Objects** (`objects.ts`) — sha256-addressed blob / snapshot / commit
  objects, zlib-compressed on disk but **hashed uncompressed**, so a commit id
  is identical across Node 20/22 and every OS. A snapshot holds the manifest,
  lock and ignore blobs, the **carried** local-item bytes (build inputs, kept
  self-contained across a store GC), and the **tracked** working-tree files
  (undeclared bytes, VC-only). The tracked set is omitted from the encoding when
  empty, so a snapshot with nothing undeclared keeps the id it had before
  tracking existed. No file mode is recorded — an exec bit is unrepresentable on
  Windows and would make a commit id platform-dependent — and a tracked path is
  stored NFC for the same reason, since macOS hands back NFD where Linux does
  not. Decoding bounds what a remote can ask for: an object that inflates past
  512 MiB is refused as a decompression bomb, and a snapshot listing more than
  100,000 tracked files is refused outright (each entry is a file materialize
  would write, so an unbounded list is an amplifier).
- **The working-tree walk** (`worktree.ts`) — which undeclared files a snapshot
  records. Exclusion is applied to *directories* during the walk, so the game
  install is pruned rather than filtered (a real instance holds tens of thousands
  of asset objects). Excluded: the snapshot's own slots, `saves/` and `.anvil/`,
  the game-install tops, runtime churn, OS and editor cruft by basename at any
  depth (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `.directory`, `*.swp`, `*.swo`,
  `*~` — the top-level rules cannot express those, and without them opening the
  folder in Finder dirties the tree), everything the current **or** built lock
  says the build owns, and the instance's `.anvilexclude`. An `.anvilexclude` line
  with a `/` in it matches the whole instance-relative path segment-wise
  (`config/*.json`); one without matches a basename at any depth (`*.log`); one
  with no `*` is a literal prefix. A tracked set whose paths collide under case
  folding is refused rather than committed: Windows and macOS would resolve the
  two to one file and a checkout would drop one side's bytes. The one split that
  catches people: `.anvilignore` entries are *tracked*, not excluded. That file
  means "the build must not touch this", which is exactly the hand-edited state
  worth recording. `.anvilexclude` is the separate "version control must not
  record this" file. A snapshot is full state, so a deleted file is represented by
  its **absence**; there are no tombstones, and materialize turns absence back
  into a real deletion (pruning the parents it empties).
- **Refs** (`refs.ts`) — `HEAD` / `ORIG_HEAD` / `MERGE_HEAD` /
  `refs/heads|tags|remotes`, a reflog, and packed-refs.
- **Ordering** (`graph.ts`) — a **generation number** is the authoritative
  ordering signal; wall-clock time is display-only and never trusted for
  ancestry or "who's newer."
- **Item-set merge** (`itemset.ts`, `merge.ts`) — a 3-way merge keyed by
  stable identity (`<source>:<id>`, `local:<path>`, `config:<path>`, the
  special `@game` key), followed by a constrained, pin-preserving re-lock
  (untouched items keep their exact prior pins; two branches' *derived* locks
  are never merged directly — only their item-sets are). The tracked set gets
  its own 3-way, one level down: a merge of the **set by path**, so a branch
  that added a file does not lose it. File contents are never merged — two sides
  that changed the same file resolve ours-wins with a warning naming the path.
- **Rebase** (`rebase.ts`, `repo.ts`) — per-commit item-delta replay with a
  per-step re-lock, `--continue`/`--skip`/`--abort`, and a crash-survivable
  `REBASE_STATE`.

The important framing: **the "layers" of a pack — what was added when — live
in commit history, not in the manifest file.** `anvil.toml` at any given
commit is just the current, flattened item list; the history is what lets you
`log`, `diff`, `revert`, `branch`, and `merge` how that list evolved.

## Remotes (`src/remote/`)

A remote is a descriptor (`descriptor.ts`) stored in `.anvil/config.toml`
under `[remote.<name>]`, backed by one of several transports
(`transport.ts`, `factory.ts`): a writable served **directory** tree, a
read-only **http(s)** base, a **git** repo, or a `lobby://` **room** seam.
`clone`/`pull`/`push` (`sync.ts`) move objects **content-addressed** — local
store → remote endpoint, or remote → local re-fetch-from-source, each
sha-verified on arrival, never trusted on the wire alone. The untrusted
remote's lock is run through `allowSource` and the SSRF checks *before* any
byte moves. **Joiners fast-forward only**: on divergence, local commits are
stashed to a `local/<timestamp>` branch (never discarded) and the pack is
fast-forwarded to the remote's head; `saves/` is untouched by any of it.

## Export (`src/export/`)

`.mrpack` export walks a built instance's lock and writes it back out as a
portable Modrinth pack: `copy`-provenance items become `files[]` entries
(pointing at their original download URL + hash), local items become
`overrides/`, and — per the replay invariant — **CurseForge replay items are
omitted from the export, with a clear warning**, never silently dropped or
silently re-hosted. The zip itself is written by a small dependency-free,
deterministic writer (`zip-write.ts`); reading (import) goes through `yauzl`.

## Trust model

Building a Forge/NeoForge instance runs that installer's processors — real
JVM code — at build time, and anvil runs it **by default** under a deliberate
**trust-the-source** model (the same posture as git hooks, `npm install`
lifecycle scripts, or `docker build` running every `RUN` line). anvil is not a
sandbox against a malicious source you chose to build; what it *does*
guarantee is reproducibility (everything is sha-pinned) and integrity
(SSRF-guarded network I/O, zip-slip/decompression-bomb-guarded extraction) —
not safety from the build code of a source you trusted. Embedders building
from untrusted/remote input get two policy seams, `allowSource` and
`allowProcessor`, plus an injectable `ProcessorRunner` to wrap the JVM in a
real OS sandbox. See [`SECURITY.md`](./SECURITY.md) for the full model.

### Replay-never-rehosted (CurseForge)

CurseForge's terms require its files be fetched by each end user under their
own key, not redistributed. anvil enforces this at the **storage layer**, not
as a flag that's easy to miss in review: `provenance: "replay"` objects
materialize only into the instance-local `.anvil/replay-cache/`
(`src/store/replay-cache.ts`) — a location the shared `ContentStore`, its GC,
the remote transfer code, and `.mrpack` export have no method that can even
enumerate. The lock row for a replay item carries the CurseForge
`{project, file}` identity and a hash to verify against, but no rehostable
download URL; the real URL is re-resolved under the user's own key at fetch
time.
