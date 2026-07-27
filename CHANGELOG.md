# Changelog

Notable changes to `@lobbify/anvil`. This project is pre-1.0: a **minor** bump may
carry a breaking change, and each one is called out below.

## Unreleased

### Added

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
