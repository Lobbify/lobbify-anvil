# Changelog

Notable changes to `@lobbify/anvil`. This project is pre-1.0: a **minor** bump may
carry a breaking change, and each one is called out below.

## Unreleased

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
