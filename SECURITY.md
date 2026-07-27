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
boundary also has to hold for the file on disk. Version control refuses those bytes
at admission rather than at each egress point: a union-only ledger of every replay
placement target a build has claimed (`.anvil/refs/replay-paths`) and a content check
against the replay cache both veto a candidate, either one alone sufficing. That is
what keeps a jar left behind by a version bump — one no lock names any more — out of
a commit, out of `push`, and out of a joiner's instance on `pull`.

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
