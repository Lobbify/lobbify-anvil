# Changelog

Notable changes to `@lobbify/anvil`. This project is pre-1.0: a **minor** bump may
carry a breaking change, and each one is called out below.

## Unreleased

### Added

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

### Changed

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
  produced. Two independent mechanisms veto, either one alone sufficing:

  - `.anvil/refs/replay-paths` records every replay placement target a build has
    claimed. It is union-only, so a path stays claimed after the lock stops naming
    it. The walk prunes those paths before reading them, and `materialize` skips
    them for writes and deletes alike, which is what stops an inbound commit
    writing CurseForge bytes into a joiner's instance.
  - A candidate's content digests are checked against the instance's replay cache
    by membership query — never enumeration — in **both** pin domains: sha256 for a
    directly-referenced `curseforge:` item, sha1 for a base-pack member. This is
    the half that survives a rename. It costs no extra read: the digests fold into
    the same pass that computes the blob id, and an instance with no replay cache
    computes none of them.

  `push` additionally refuses outright when a reachable snapshot tracks a claimed
  replay path. That covers history recorded before this change, which cannot be
  cleaned retroactively. It refuses rather than dropping the object, because
  publishing a snapshot whose tracked entry points at an object the remote does not
  have is broken history that fails later and somewhere else.

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
history. Covers vanilla plus Fabric, Quilt, Forge and NeoForge; version control with
branch, merge and rebase; remotes; `.mrpack` export and Prism import; an Ink TUI.
