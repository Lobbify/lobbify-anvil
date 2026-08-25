# Security policy

## Trust model — read this first

**anvil runs build code that comes from the sources you build.**

Building a Forge or NeoForge instance runs that installer's **processors** — JVM
programs (the binpatcher, the SRG/AutoRenaming tool, installertools, jarsplitter) that
patch the Minecraft client jar at build time. `anvil build` executes them **by
default**, using the build's pinned per-platform JRE. A processor is arbitrary code,
and it runs with the privileges of the process that invoked `anvil build`.

This is intentional, and it is the same **trust-the-source** model that underlies the
tools anvil is modeled on:

- **git** runs your repo's hooks (`pre-commit`, `post-checkout`, …).
- **`npm install`** runs `preinstall` / `postinstall` lifecycle scripts.
- **`docker build`** runs every command in the `Dockerfile`.
- **Gradle / Maven** run the build script itself.
- **anvil** runs a Forge/NeoForge installer's processors.

In every case, choosing to build a source is choosing to run its build code.

> ### Only build instances from sources you trust.
>
> The standalone tool is **not** a sandbox against its own inputs. It does **not**
> claim, and must not be understood to provide, protection against a malicious
> modpack, installer, manifest, or lockfile that you chose to build. If you do not
> trust where a pack came from, do not build it.

There is deliberately **no** built-in "allowlist of safe processors" or "trusted maven
host" gate. Such a list would be a false boundary — anyone can publish to a public
maven repository, and a coordinate is not a proof of provenance — so anvil does not
ship a security guarantee it cannot actually enforce.

## What anvil *does* protect

These are integrity, reproducibility, and denial-of-service protections. They are **not**
a defense against the build code of a source you told anvil to build:

- **Reproducibility pinning.** Every fetched artifact — the installer, every library,
  every processor jar and its classpath deps — is **sha256-pinned**. A rebuild fetches
  byte-identical bytes or fails; the content-addressed store rejects any object whose
  bytes do not match its hash. This makes builds deterministic; it does **not** make an
  arbitrary pinned processor safe to run.
- **SSRF guard.** All `url`-source and game/loader network I/O goes through a client
  that blocks non-`http(s)` schemes and hosts resolving to loopback / RFC1918 /
  link-local / cloud-metadata addresses, re-validated on every redirect hop.
- **Zip-slip / decompression-bomb guards.** Every archive extraction (natives, `.mrpack`
  / CurseForge-zip / Prism overrides, installer `/data` entries) rejects `..`,
  absolute paths, drive letters, and symlink/hardlink entries, and enforces entry-count
  and uncompressed-size bounds.
- **Placement-path guard.** A manifest-declared placement path is refused outright —
  a typed `PathEscape`, not a silent relocation — if it targets a protected top-level
  entry (`saves/`, `.anvil/`, `.anvilignore`), or if a segment contains a `:`. A colon
  inside a path segment is an ordinary POSIX filename character but opens an NTFS
  Alternate Data Stream on Windows — a different filesystem outcome for the identical
  declared path, which breaks reproducibility on its own and can graft hidden data onto
  a protected node (`saves:level.dat`) without ever naming `saves` as a top-level
  segment.

  **One shape is re-homed instead of refused**, and it is stated here rather than left
  for a reader to discover. A path whose *first* segment is a single ASCII letter
  followed by a colon (`a:b.jar`, `C:evil.txt`) is drive-letter-shaped, and an older
  rule classifies it as naming somewhere outside the instance before the colon check
  runs at all (`normalizeDeclaredSegments`, `src/sources/place.ts:99-102`, ahead of
  `findColonSegment` at `place.ts:148`). Such a path is not refused; it falls back to
  kind placement like any other external path. **The fallback does not produce an ADS**:
  the filename is rebuilt by `safeBasename` (`place.ts:63-77`), which replaces `:` with
  `_`, so `a:b.jar` is placed at `mods/a_b.jar`. A colon anywhere else in the path
  (`config/a:b.jar`), or behind more than one leading letter (`ab:c.jar`), is refused as
  described above — `saves:level.dat` included. Only a *derived* target falls back at
  all: an **explicit** manifest `target` naming nothing inside the instance is a hard
  `PathEscape` (`src/resolver/resolve.ts:145-150`), and a base pack's member is skipped
  with a warning rather than re-homed (`src/base/mrpack-base.ts:299-314`).

  The guard is enforced at lock time (`declaredPlacementTarget`) and at every
  build-time write of a pack- or lock-derived target (`safeJoin` with
  `rejectColon: true`, in the placement executor, the atomic swap, and
  Forge/NeoForge processor replay). It is **not** enforced on VC checkout
  (`anvil switch`/`branch`): those paths are the user's own already-committed
  working-tree files, not pack input, and a colon there is an ordinary POSIX
  filename that must round-trip like any other tracked file — an NTFS user could
  never have committed one, so there is nothing to defend against on the platform
  the guard exists for.
- **Import-time colon guard.** A `.mrpack`/CurseForge-zip `overrides/` file, a
  `.mrpack` top-level `files[]` entry, or a file the Prism/MultiMC importer picks
  up, whose path contains a `:` segment is skipped with a warning rather than
  written — the same treatment a protected-top path already gets — before the byte
  that would create the ADS is ever written to the tracked-copy store.

  The Prism case (`src/import/prism.ts:327`) is defending something different from
  the other two, which is why it is named separately: its input is the user's **own**
  instance rather than untrusted pack content. An unmatched file's pack-relative path
  becomes a manifest `target`, and `declaredPlacementTarget` refuses a `:` segment at
  lock time — so importing the file anyway would report success and leave an instance
  that can never lock or build again. Skipping the one file is the smaller loss, and
  the warning names the colon so the fix is actionable: the file is still in Prism,
  and renaming it and re-importing carries it over.
- **No telemetry / no phone-home.**

## The CurseForge replay boundary, and exactly where it ends

CurseForge **project files** (mod jars) are `provenance: "replay"`: they are fetched
per-client under the user's own key into a per-instance `.anvil/replay-cache/`, and
the shared store, GC, transfer, push, and export paths cannot enumerate that
directory. A CurseForge **base pack** (`game.from = "curseforge:…"`) holds this in its
strongest form — resolving one downloads no member bytes at all, so there is nothing
to leak — and its members are pinned from `(projectID, fileID)` plus CurseForge's
attested sha1 without a download.

A replay item is nonetheless *placed* into the instance as an ordinary jar, so the
boundary also has to hold for the file on disk. Version control refuses those bytes at
admission rather than at each egress point, since every publish path reads the same
tracked set. On the sending side the candidate's content digests are asked of this
instance's replay cache; on the receiving side — where a joiner has no cache and no
local record — the authority is the `provenance: "replay"` pins carried by the locks in
the incoming history itself, unioned across the whole transferred closure. That is what
keeps a jar left behind by a version bump, one no lock names any more, out of a commit,
out of `push`, and out of a joiner's instance on `pull`.

One state is not covered and is worth stating: if the replay cache has been deleted
**and** the jar has since been renamed, its bytes cannot be identified and the path was
never recorded. `anvil build` warns when it finds recorded replay paths with no cache,
which is the only signal available before the fact.

**Where the boundary ends, stated plainly:** a pack's `overrides/` tree — the loose
configs the *pack author* ships, not project files — is extracted into `.anvil/base/`
and registered as ordinary `local` / `copy` items. Those bytes **do** enter the shared
content store, and can therefore be pushed to a remote or written into a `.mrpack`
export like any other local file.

This is the same line `anvil import` already draws for a CurseForge zip, and it is a
consequence of there being exactly two provenances: a `copy` row is materialized from
the shared store, a `replay` row from the replay cache, and a loose config file has no
`(projectID, fileID)` to re-fetch itself with. It is recorded here rather than papered
over. If you redistribute instances built on a CurseForge base, that config tree is
what you are redistributing; a third provenance for "pack-authored bytes that may be
placed but not shared" would close it and is not implemented.

## Embedding anvil to build from untrusted or remote sources

If your application builds instances from sources your users supply (a "join this room /
import this pack" flow, a hosted build service, anything remote), then **you** are
responsible for confinement. anvil gives you the seams to enforce your own policy:

- **`allowSource(ref)`** — a host-policy hook evaluated **before any network I/O**.
  Return `false` to refuse a source your app does not trust; a malicious manifest
  cannot trigger a fetch you did not allow.
- **`allowProcessor(proc)`** — a host-policy hook called before each Forge/NeoForge
  installer processor runs. Return `false` to block it; anvil stops with a typed
  `PROCESSOR_REFUSED` before the processor executes. **Defaults to allow** (trust the
  source); set it to enforce your own policy.
- **a custom `ProcessorRunner`** — inject your own runner to wrap the JVM in a real OS
  sandbox (Linux user/network namespaces, macOS `sandbox-exec`, a container, a VM)
  instead of the default `JvmProcessorRunner`, which launches the pinned `java` with no
  confinement. This is where real sandboxing belongs under the trust-the-source model.

```ts
import { Anvil } from "@lobbify/anvil";

const anvil = new Anvil({
  dir: instanceDir,
  allowSource: (ref) => isTrusted(ref),          // refuse untrusted sources up front
  allowProcessor: (proc) => isTrustedTool(proc), // and/or gate each installer processor
  // processorRunner: () => new MySandboxedRunner(), // and/or confine the JVM yourself
});
```

Building from untrusted sources **without** supplying these is using the tool outside
its trust model.

## Reporting a vulnerability

Please report suspected vulnerabilities privately — do **not** open a public issue for a
security report.

- Prefer **GitHub private vulnerability reporting** ("Report a vulnerability" under this
  repository's **Security** tab).
- Or email **support@lobbify.games**.

Include a description, affected version/commit, and a minimal reproduction if you can.
We will acknowledge receipt, work with you on a fix, and credit you (if you wish) once a
fix ships.

Note that "a Forge/NeoForge processor executed code when I built an untrusted pack" is
**working as designed** under the trust model above — not a vulnerability. Reports that
anvil's *own* guarantees are broken (a pin that doesn't verify, an SSRF/zip-slip guard
that can be bypassed, a build that isn't reproducible) are very much in scope.
