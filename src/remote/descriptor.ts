/**
 * A **remote descriptor** — the address of a served instance a joiner can clone,
 * pull from, or (for a writable target) push to. A remote is, per the plan,
 * "anything serving a manifest + lock": the three kinds are
 *
 *   - `git`  — a git repository whose tree is the instance (the `.anvil/` VC
 *     history is versioned in it). Read via a shallow clone; a push target.
 *   - `url`  — a served tree at a base location: an `http(s)://` static host
 *     (read-only) or a `file://` / local directory (read + writable → pushable).
 *   - `room` — a Lobbify room (`lobby://…`): the host publishes on build; the
 *     joiner reads the current pinned manifest + lock. The room integration seam
 *     enforces its own source policy and never carries a CurseForge key.
 *
 * Descriptors live in the instance's `.anvil/config.toml` under `[remote.<name>]`.
 */

/** The three remote kinds — a git repo, any served URL/dir, or a Lobbify room. */
export type RemoteKind = "git" | "url" | "room";

/** A configured remote: a name, its kind, its base URL/location, and a default ref. */
export interface RemoteDescriptor {
  /** The short remote name (`origin`) used on the CLI and in the config. */
  readonly name: string;
  readonly kind: RemoteKind;
  /** The base URL / location (a git URL, an `http(s)`/`file` URL, a dir, or `lobby://…`). */
  readonly url: string;
  /** The default branch/ref to track (defaults to `main`). */
  readonly ref?: string;
}

/**
 * Infer a remote's {@link RemoteKind} from its URL. Explicit `lobby://` is a room;
 * a git-looking URL (a `git+` prefix, an `ssh`/`git` scheme, an `scp`-style
 * `user@host:path`, or a `.git` suffix) is git; everything else — `http(s)://`, a
 * `file://` URL, or a bare local path — is a served `url` tree.
 */
export function inferRemoteKind(url: string): RemoteKind {
  const u = url.trim();
  if (/^lobby:\/\//i.test(u)) {
    return "room";
  }
  if (
    /^git\+/i.test(u) ||
    /^git:\/\//i.test(u) ||
    /^ssh:\/\//i.test(u) ||
    /^[^/\s]+@[^/\s]+:/.test(u) || // scp-style: git@github.com:owner/repo.git
    /\.git\/?$/i.test(u)
  ) {
    return "git";
  }
  return "url";
}

/** Build a descriptor, inferring the kind from the URL unless one is given. */
export function makeDescriptor(
  name: string,
  url: string,
  opts?: { kind?: RemoteKind; ref?: string },
): RemoteDescriptor {
  return {
    name,
    kind: opts?.kind ?? inferRemoteKind(url),
    url,
    ...(opts?.ref ? { ref: opts.ref } : {}),
  };
}

/** The tracked branch of a descriptor (an explicit `ref`, else `main`). */
export function remoteBranch(descriptor: RemoteDescriptor, override?: string): string {
  return override ?? descriptor.ref ?? "main";
}
