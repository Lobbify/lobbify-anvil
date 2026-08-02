# Changelog

Notable changes to `@lobbify/anvil`. This project is pre-1.0: a **minor** bump may
carry a breaking change, and each one is called out below.

## Unreleased

### Security

- **A pack- or lock-declared path segment containing `:` is now refused rather
  than placed or extracted.** On Windows/NTFS a colon inside a segment opens
  an Alternate Data Stream against whatever precedes it (`saves:level.dat`
  attaches a hidden stream to `saves` — or creates it — without ever naming
  `saves` as its own top-level segment), instead of creating the ordinary
  file the identical string names on POSIX. That divergence breaks
  reproducibility by itself, before any hostile intent, and it let a path
  bypass the protected-top-level guard by construction. Enforced, on every
  segment (not only a protected top, since an unprotected `config:foo`
  diverges the identical way):
  - at lock time, in `declaredPlacementTarget` — a manifest item declaring
    such a path is refused (`PathEscape`);
  - at build time, in `safeJoin` — every write of a pack- or lock-derived
    target (the placement executor, the atomic swap, Forge/NeoForge
    processor replay) is refused (`PathEscape`);
  - at import time, in `isUnsafePackPath` — a `.mrpack`/CurseForge-zip
    `overrides/` file or top-level `files[]` entry with such a path is
    skipped with a warning rather than written, before its bytes reach the
    tracked-copy store.

  A pack that legitimately shipped a colon in a path was never installable
  on Windows in the first place, so the practical compatibility cost of all
  three is close to zero.

  **Deliberately not enforced on `anvil switch`/`branch` (VC checkout).**
  Those paths are the user's own already-committed working-tree files, not
  pack input — a colon there is an ordinary POSIX filename, and refusing to
  restore one would make its own commit permanently unreachable. The
  compatibility argument above is specific to *newly declared* paths that
  have never touched disk; it does not hold for a file the user already
  created and committed, so `safeJoin` calls in VC checkout omit the guard.

## v0.2.1 — 2026-08-02

**anvil now passes its own test suite on Windows and macOS.** It never had before: the
mac jobs had been red since at least 2026-07-23 on a test that hardcoded a Linux path,
and the Windows jobs died at the lint step on line endings without ever reaching a test.
Clearing those two uncovered a real Windows defect that had been hiding behind them —
see the object store entry below.

The other headline is a merge fix that also turned out to affect `rebase` and `revert`:
a branch's edit to a file the other side never touched was being discarded. If you have
been merging variant branches, **work may already have been lost silently** — the
warning that reported it said "changed on both sides", which was not true.

### Added

- **A path-carrying manifest item can declare a separate placement target.** Rendered as
  `{ path, kind, target }`; emitted only when `target` is present, so an existing
  `anvil.toml` parses and re-serialises unchanged. It exists because an imported override
  is tracked under `.anvil/overrides/` while it is *placed* somewhere else in the
  instance, and one field could not honestly say both.

### Fixed

- **`merge` no longer discards an edit the other branch made to a file you never touched
  — and neither do `rebase` and `revert`.** All three share one three-way apply, whose
  tracked-file half resolved every both-present path ours-wins without consulting the
  merge base. So branching off, retuning a config and merging back silently threw the
  retuning away, while the warning claimed the file had "changed on both sides". Only a
  side whose bytes moved off the base has said anything about a file; if yours did not,
  theirs is now taken. Genuinely divergent content still resolves ours-wins, and the
  warning now fires only then and names what it discarded.

  The same function was already propagating theirs' *deletion* when ours equalled the
  base — deleting a file carried across while editing it did not. anvil's item-set merge
  one level up has always done the standard three-way; the tracked-file half was the odd
  one out.

- **The object store could not write a single object on Windows.** `writeTemp` created the
  temp already-immutable (0444) and then reopened it **read-only** to `fsync` it. On
  Windows `fsync` is `FlushFileBuffers`, which requires a handle with write access and
  returns `ERROR_ACCESS_DENIED` → `EPERM` without one, so every `putStream` failed. It now
  syncs through the same handle the bytes were written with, which keeps all three
  properties that shaped the original code: the object is never mode-writable for an
  instant, there is no rename→chmod window, and the fsync still happens unconditionally
  before the rename. Nothing was downgraded to best-effort. `recordReplayPaths` carried the
  identical defect on the build and sync paths and is fixed the same way.

- **`merge`, `revert` and `rebase` no longer drop the `[base]` block from `anvil.lock`.**
  On a `game.from` instance all three verbs run the same 3-way apply, whose worktree
  write rebuilt the lock from a hand-written list of fields that did not include `base`.
  What landed on disk was a lock whose rows still carried `from_base = true`, beside an
  `anvil.toml` still declaring `game.from`, and nothing left to name the pack they came
  from — so a CurseForge-derived instance stopped identifying as CurseForge to anything
  reading `base.source`. The re-derived lock is now carried through whole; the worktree
  write patches `meta.manifest_hash` and nothing else.

- **`import` followed by `lock`, with no `build` in between, no longer crashes.** It
  exited 70 with an internal-error banner and an `ENOENT` on an override path. An
  imported override is tracked under `.anvil/overrides/`, but its manifest entry named
  the in-instance path, which only exists once a build has materialised it — so the
  resolver went looking for a file that was not there yet. The manifest is now
  self-consistent before any build: a path-carrying item records where to **read** from
  and, separately, where to **place**. A genuinely missing local file still fails
  loudly; the fix deliberately does not trade the crash for a silent drop.

## v0.2.0 — 2026-07-28

### Added

- **Forge and NeoForge are supported**, alongside Fabric and Quilt — anvil now covers
  all four loaders. `anvil build` runs the loader installer's own processors to produce
  a launch-ready instance. Those processors are JVM code from the pack's sources and
  **are executed by design**: anvil trusts what you build, as git trusts hooks and
  `npm install` trusts scripts. It is not a sandbox against its own inputs and does not
  claim to be — see SECURITY.md and the README's "Trust model & security". Embedders
  restrict via the `allowSource` / `allowProcessor` hooks and an injectable
  `ProcessorRunner`.

- **`game.from` accepts a CurseForge modpack**, alongside Modrinth: `game.from =
  "curseforge:715572@8323938"`. It resolves through the same `BasePackSource`
  contract, so precedence, `game.remove`, the `[base]` lock block, the `set`
  digest and `.anvil/base.lock` all behave identically.

  It is **not** the `.mrpack` path with a different fetcher, because a CurseForge
  `manifest.json` is a genuinely different (and better) primitive: it names each
  member by a stable `(projectID, fileID)` identity pair and states nothing else
  — no URL, no hash, no filename. Two consequences:

  - **Resolving a pack downloads no member bytes.** Every member fact comes from
    the CurseForge API for that pair, so a 482-member pack locks in metadata
    calls instead of ~15 GB of jars that would be discarded and re-fetched at
    build time anyway. The pack archive is the only thing fetched.
  - **Two pack versions diff as a plain set difference**, with no hashing and no
    filename matching — exposed as `diffMemberSets(before, after)` →
    `{ added, removed, updated, unchanged }`. Measured against the live API on
    2026-07-26, All the Mods 10 v7.1 → v7.2 is 482 members each and differs in
    90 of them (392 unchanged, 89 updated, 1 added, 1 removed).

  Members are pinned by `(projectID, fileID)` plus CurseForge's attested **sha1**
  — the strongest hash the API offers for a file (algo 1; algo 2 is md5). They
  carry `provenance: "replay"` and no rehostable `url`, so the existing
  replay-never-rehosted machinery applies to them unchanged.

  CurseForge is **bring-your-own-key**: anvil ships none. A base resolve without
  one fails with a typed `SourceKeyMissing`, never a silent skip or an empty pack.

  **Known limitations**, none of them silent:
  - A pack's `overrides/` are tracked as `local` rows keyed by an absolute path
    under this instance's `.anvil/base/`, so the base-set digest and a member
    diff vary by instance directory for a pack that ships them. Catalogue members
    are unaffected. Pre-existing and identical for a Modrinth base.
  - `getModFiles` requests one page of 50 and does not paginate, so a `game.from`
    resolved as `latest` against a project with more than 50 published files
    selects the newest of one page. Pin `game.from` by file id
    (`curseforge:<project>@<fileId>`) for a reproducible base — which is what the
    determinism story wants anyway. Pre-existing; it affects a direct
    `curseforge:` item reference the same way.
  - A superseded member's jar can be left behind in `mods/`. `.anvilignore`
    matching is top-level-segment-wide, so a line naming any file under `mods/`
    makes the swap skip *removing* it, and a bump that renames many members at
    once leaves many. The leftover file is inert: it is refused by version
    control and by `push` (see Security, below), so it costs disk and nothing
    else. Pre-existing; it applies to any replay item whose version moves.

- **`game.from` works: an instance can start from a published modpack.** The field
  existed in the manifest schema and the resolver refused it; it now resolves the
  pack into a base layer and lays the manifest's own `items` over it.

  **Precedence, in full** — the effective set is `remove`, then `override`, then
  union:
  - a `game.remove` entry drops matching packages from **both** layers, matching on
    **identity** (`modrinth:sodium`, same source only) or on **placement path**
    (`"./config/x.toml"`);
  - an instance item drops a base member sharing its **identity** *or* its
    **placement target**. Bumping a base mod drops the whole base member, old
    filename included, so two versions of one mod never land in `mods/` together;
    overriding a pack config works on the path, where the two sides share no
    catalogue identity at all;
  - **the instance always wins.** No rule lets a base member displace something the
    manifest asked for.

  A transitive dependency the base already provides reuses the base's pin instead
  of resolving fresh, so adding one mod cannot silently bump a mod the pack chose.
  A root you listed yourself is never pinned that way.

  The pack is resolved **once, at lock time**: the lock ends up holding ordinary
  pinned rows, `build` never fetches a pack, and a pack changed upstream cannot
  change an instance that already locked.

- **The lock records the base.** A new `[base]` block (`ref`, `source`, `id`,
  `version`, `archive` pin, `set` digest, `members` count) and `from_base = true`
  on each base-derived `[[package]]`. Both are omitted entirely for an instance
  with no base, so such a lock — and therefore its commit ids — is byte-identical
  to before.

  `set` digests the base's member set *before* the overlay, so two instances whose
  locks carry the same `set` are known to share several hundred identical rows
  without comparing any of them; only the unflagged overlay needs reconciling.

- **New user-facing files, both under `.anvil/`** (called out because they are new
  paths on disk): `.anvil/base/` holds a pack's loose `overrides/` as tracked local
  files so their bytes are addressable offline, and `.anvil/base.lock` caches the
  base's *full* member set. The instance lock holds only the survivors, and
  re-running the overlay against survivors would make a `game.remove` entry match
  nothing the second time round. Same pattern as `.anvil/graph.json`.

- **A `warning` progress event.** Emitted for a skip the run decided on its own — a
  base member targeting `saves/`, a server-only pack file, an item dropped by
  `game.remove`. The CLI prints it; consumers of the event bus should ignore
  unknown types as before.

### Changed

- **BREAKING (internal): the per-instance replay cache now has two hash domains.**
  It previously refused any pin that was not sha256; it now stores an object under
  whichever algorithm its lock row pins, in a per-algo directory — sha256 keeps
  the existing `objects/` path (so caches on disk are unaffected), sha1 gets
  `objects-sha1/`. `ReplayCache.objectPath()` no longer throws for a sha1 hash.

  This exists because a CurseForge **base pack** member is pinned from catalogue
  metadata rather than from bytes, and sha1 is the strongest hash CurseForge
  attests for a file. Refusing it would have forced the alternative: downloading
  every member at lock time purely to compute a sha256, discarding the bytes, and
  downloading them again at build time — which is what makes a 482-member pack
  unusable as a base.

  The property that matters is unchanged: **bytes are verified against the lock's
  pin, in that pin's own algorithm, before they land**, and a mismatch is a hard
  `ShaMismatch` with nothing admitted. sha1 is weaker tamper-evidence than sha256
  and is used only where CurseForge offers nothing stronger. A directly-referenced
  `curseforge:` item is unaffected and still pins sha256, because that path
  downloads the bytes anyway.

- **The CurseForge API client validates its responses instead of casting them.**
  `JSON.parse(...) as T` type-checks at compile time and guarantees nothing at run
  time, so a mirror, a proxy, an error page served with a 200, or a delisted id
  could produce an untyped `TypeError` deep in the resolver. `getMod`,
  `getModFile`, `getModFiles` and `getDownloadUrl` now normalize what they return:
  a malformed record raises a typed `UnsatisfiableTarget`, a malformed entry in a
  listing is dropped rather than failing the listing, and a non-string
  `download-url` reads as "no download" (the existing typed `ReplayUnavailable`).
  A `slug` is accepted only in the shape a CurseForge slug takes, since it becomes
  a lock row's `name`.

- **`anvil import` of a CurseForge zip: three parser changes** from sharing
  `import/cf-manifest.ts` with the base path.
  - A `files[]` over the 10 000 cap now raises `ManifestError` rather than
    `DecompressionBomb`, and is rejected *before* the list is built rather than
    after.
  - A `files[]` that is present but not an array is now an error. It previously
    read as zero files, which imported a pack that installs nothing without
    reporting anything.
  - A repeated `(projectID, fileID)` is now imported once. A pair is an identity,
    so repeating it named the same artifact twice — and cost one API call per
    repeat against the user's own key.
  - A traversing or malformed `overrides` prefix falls back to `"overrides"`
    instead of being used verbatim.

- **BREAKING: a `game.remove` entry that matches nothing now fails the lock.** It
  was previously a silent no-op. The failure mode that justifies the break: a typo
  in a `remove` entry left you shipping the mod you believed you had dropped, and
  nothing said so. Applies whether or not the manifest declares a base.

- **BREAKING (embedders): `resolveManifest` requires a `resolveBase` callback when
  the manifest declares `game.from`.** Fetching a pack is I/O the resolver does not
  own. `Anvil.lock` supplies it; a direct caller that does not gets a typed
  `ManifestError` rather than a silently base-less instance. Manifests without
  `game.from` are unaffected.

- **`GameValue` (version control) carries `from` and `remove`.** A merge
  reconstructs the merged manifest's `[game]` field by field, so a field it did not
  know about was dropped silently — which for `game.from` would have turned a
  base-derived instance into a bare one on the next lock. A base change now also
  triggers the `@game` cascade, which is right: swapping the base can orphan every
  mod in the instance.

- **A commit now captures the whole working tree, not just the manifest and lock.**
  Undeclared files — a hand-edited `config/sodium/options.json`, an `options.txt`, a
  jar dropped into `mods/` — are recorded in the snapshot and restored by `switch`,
  `merge`, `rebase` and `revert`. Previously `anvil commit` reported success and did
  not record them.

  Excluded from tracking: the game install (`assets/`, `libraries/`, `versions/`,
  `natives/`, `runtime/`), runtime churn (`logs/`, `crash-reports/`, `screenshots/`,
  `backups/`, `debug/`, `.fabric/`, `.mixin.out/`, `.cache/`,
  `server-resource-packs/`, `usercache.json`, `usernamecache.json`,
  `realms_persistence.json`), OS and editor cruft at any depth (`.DS_Store`,
  `Thumbs.db`, `desktop.ini`, `.directory`, `*.swp`, `*.swo`, `*~`), `saves/` and
  `.anvil/`, and every path the current or built lock says the build owns. Symlinks
  are not followed and not tracked, and no file mode is recorded (an exec bit would
  make a commit id platform-dependent). A tracked path is stored NFC, so a tree
  holding `café.txt` gets the same commit id on macOS as on Linux.

  Two files whose paths differ only by case or Unicode form are **refused** with an
  error naming both. They are one file on Windows and macOS, so a checkout would
  write whichever came last and lose the other's bytes with no error at all.

- **`.anvilexclude`** — a new optional root file listing paths version control must
  not record. `.anvilignore` protects a path from the **build**; `.anvilexclude`
  hides a path from **commits**. A line takes one of three forms: a `*` and no `/`
  is a basename glob matched at any depth (`*.log`); a `*` and a `/` matches the
  whole instance-relative path segment by segment (`config/*.json`); no `*` is a
  literal path prefix (`notes/`). `*` is the only wildcard and never crosses a `/`.
  Matching ignores case; there is no negation. `anvil init` scaffolds a commented
  template. The file is itself tracked, so it travels with `clone`/`pull`/`push`.

  An excluded path is skipped for writes **and** deletes, so adding `screenshots/`
  to the file and then switching branches does not delete screenshots an older
  commit tracked.

- **Bounds on what a remote can make a pull do.** A VC object that inflates past
  512 MiB is refused as a decompression bomb, and a snapshot listing more than
  100,000 tracked files is refused on decode — each entry is a file a checkout
  would write, so an unbounded list turns a small payload into a large unpack.

- **`status` reports `worktreeDirty`** — whether tracked files differ from HEAD.
  The `status` command shows it as a `worktree:` cell. Computing it never writes to
  the object store.

- `revert` now returns `warnings`, alongside `merge` and `rebase`.


- **After upgrading, an instance holding undeclared files reports a dirty working
  tree where it previously reported clean, and needs one commit to re-baseline.**
  Until that commit, `switch` refuses with the usual dirty-working-tree error
  rather than overwriting the files. This is the feature working — the same
  experience as `git status` noticing files it has not seen — but it is a visible
  behaviour change on first run.

  It is **not** a format break. A snapshot with nothing undeclared encodes to
  exactly the bytes it did before, so every existing commit id stays valid, and a
  snapshot written by an older anvil still decodes.

- A merge, rebase or revert merges the two tracked sets **by path**, so a branch
  that added a file no longer loses it. File contents are never merged: when both
  sides changed the same file, ours wins and a warning names the path.

### Breaking

- **An item listed by an in-instance path is now placed at that path.**
  `"./config/sodium/mixins.json"` is read from there and built back there with its
  nesting intact, and `"./options.txt"` stays at the instance root.

  Previously every local item was placed at `<kind-dir>/<basename>`, so
  `items = ["./patch.jar"]` was read from the instance root and installed to
  `mods/patch.jar`. It now stays at `patch.jar`. **Write `"./mods/patch.jar"` to get
  the old result.**

  Only an item that names no path of its own — every `modrinth:` / `curseforge:` /
  URL item, and a local file living outside the instance — is placed by its kind.

  Existing manifests are unaffected in hash terms: the placement is derived from the
  path as authored, before absolutization, so stored refs stay byte-identical and no
  `meta.manifestHash` moves.

### Fixed

- **Imported pack overrides are no longer deleted.** `anvil import` of a `.mrpack` or
  CurseForge zip registered override files in the lockfile but not the manifest. Since
  the manifest regenerates the lock, the next `lock` dropped them and the next `build`
  removed them from the instance. Overrides now get a manifest entry at import time.

- **Local items no longer silently relocate.** A file at the instance root reappeared
  under a kind directory after a re-lock (a root `options.txt` turned up in `config/`),
  and nested trees could not round-trip at all. Same root cause as the breaking change
  above. This also affected Prism imports of unmatched jars in subdirectories.

- A Prism-imported jar that is re-identified against Modrinth or CurseForge is
  recorded as a bare `source:id` ref, which carries no path, so it is still placed by
  kind. Such a move is now reported in `warnings` rather than happening quietly.

### Security

- **A superseded CurseForge jar can no longer enter version control, or a remote.**
  The replay boundary was enforced on lock rows: the shared store, GC, transfer and
  export code all skip `provenance: "replay"` packages, and the bytes live in a
  per-instance cache none of them can enumerate. Tracked working-tree files, added
  in this same release, do not go through the lock at all.

  A replay item is placed as an ordinary file in `mods/`. Once no lock names its
  path — a version bump renamed it, the built-lock ref was lost, or `.anvilignore`
  made the atomic swap skip the removal — the working-tree walk read it as an
  undeclared file and admitted its bytes as a VC blob. A tracked file records a
  path and a blob id and nothing else, so from that point nothing downstream could
  tell where the bytes came from: `push` shipped them to a served tree, a git
  remote or a room, and a joiner's `pull` wrote them into `mods/` with no
  CurseForge key involved anywhere.

  Provenance is now a property of the **bytes** rather than of what the current
  lock happens to name, and it is enforced at the one place a tracked set is
  produced. That placement is deliberate: all four publish paths read the same
  `snapshot.tracked`, so refusing at admission closes them together and keeps the
  bytes out of `.anvil/objects/` entirely, which filtering at each egress would not.

  Which check can answer depends on what the machine knows:

  - **Sending** — a candidate's content digests are checked against this instance's
    replay cache by membership query, never enumeration, in **both** pin domains:
    sha256 for a directly-referenced `curseforge:` item, sha1 for a base-pack
    member. It survives a rename, because it asks about bytes rather than paths.
    It costs no extra read: the digests fold into the same pass that computes the
    blob id, and an instance with no replay cache computes none of them.
  - **Receiving** — a joiner has no replay cache and no local record, and `clone`
    materializes before it ever runs a build, so every local signal is empty at
    exactly the moment it is needed. The authority there is the incoming history's
    own locks: their `provenance: "replay"` rows pin the bytes by content hash.
    `pull`/`clone` collect that pin union across the whole transferred closure —
    the commit that strands a jar is the one whose lock stopped naming it, so the
    pin lives in an ancestor — and a matching object is verified and decoded in
    memory, then dropped. It is never written to the object store, so a joiner
    cannot re-publish what it declined to hold.

  `.anvil/refs/replay-paths` records replay placement targets union-only, so a path
  stays claimed after the lock stops naming it. It is a fallback for the one state
  where the byte question cannot be asked — the replay cache deleted — plus the
  claim `clone`/`pull` record before writing anything. It is deliberately not a
  second path-based rule running alongside the content check: as one, a path that
  had held a CurseForge jar became permanently un-committable, silently swallowing
  whatever file a user later put there.

  The pair is **not** exhaustive. With the replay cache deleted *and* the jar since
  renamed, the bytes cannot be identified and the new path was never claimed;
  `anvil build` warns when it finds claimed paths with no cache, which is the only
  signal available before the fact.

  `push` additionally refuses outright when reachable history tracks such bytes.
  That covers commits recorded before this change, which cannot be cleaned
  retroactively, and a foreign entry a merge carried in. It refuses rather than
  dropping the object, because publishing a snapshot whose tracked entry points at
  an object the remote does not have is broken history that fails later and
  somewhere else.

  Visible effect: a stranded replay jar is no longer restored or removed by
  `switch`, and no longer reported by `status` as a dirty working tree. It stays on
  disk until a build removes it.

- Path handling for placement targets is guarded independently of extraction: `.` and
  `..` are folded at derivation, anything resolving outside the instance names no
  placement (and falls back to a kind directory rather than escaping), and a protected
  top (`saves/`, `.anvil/`, `.anvilignore`) is refused outright rather than quietly
  re-homed into a kind directory. A NUL byte is rejected.

## v0.1.0 — 2026-07-23

First public release. Reproducible, content-addressed Minecraft instances: the folder
is the instance, `anvil.toml` declares it, `.anvil/` holds the object store and
history. Covers vanilla plus Fabric and Quilt; version control with
branch, merge and rebase; remotes; `.mrpack` export and Prism import; an Ink TUI.
