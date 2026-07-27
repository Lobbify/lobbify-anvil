# Changelog

Notable changes to `@lobbify/anvil`. This project is pre-1.0: a **minor** bump may
carry a breaking change, and each one is called out below.

## Unreleased

### Added

- **`game.from` works: an instance can start from a published modpack.** The field
  existed in the manifest schema and the resolver refused it; it now resolves the
  pack (Modrinth `.mrpack`; CurseForge is next) into a base layer and lays the
  manifest's own `items` over it.

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
