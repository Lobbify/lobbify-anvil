/**
 * Build a {@link RemoteTransport} from a {@link RemoteDescriptor} + the ambient
 * dependencies. The descriptor's kind picks the transport; a `url` remote further
 * splits on scheme — an `http(s)` base is a read-only {@link HttpTreeIO}, a
 * `file://` URL or a bare local path is a read/write {@link DirTreeIO}.
 */

import { fileURLToPath } from "node:url";
import { RemoteError } from "../types/errors.js";
import type { Http } from "../types/index.js";
import type { RemoteDescriptor } from "./descriptor.js";
import type { GitRunner } from "./git.js";
import { GitTransport } from "./git.js";
import type { RoomClient } from "./room.js";
import { RoomTransport } from "./room.js";
import type { RemoteTransport } from "./transport.js";
import { ServedTreeTransport } from "./transport.js";
import { DirTreeIO, HttpTreeIO } from "./tree-io.js";

export interface TransportDeps {
  /** The http client for `http(s)` served trees and room reads (SSRF-guarded). */
  readonly http?: Http;
  /** Where git working clones live (required for a `git` remote). */
  readonly clonesDir?: string;
  /** The git runner (defaults to the `git` binary). */
  readonly git?: GitRunner;
  /** The git author for push commits. */
  readonly gitAuthor?: { name: string; email: string };
  /** A host-app room client (for a `lobby://` remote). */
  readonly roomClient?: RoomClient;
}

/** Resolve a `url`-kind location to a local directory path, or `undefined` if http. */
function localDirOf(url: string): string | undefined {
  if (/^https?:\/\//i.test(url)) {
    return undefined;
  }
  if (/^file:\/\//i.test(url)) {
    return fileURLToPath(url);
  }
  // A bare path (absolute or relative) — a local/shared-volume directory remote.
  return url;
}

/** Construct the transport for a descriptor. */
export function makeTransport(descriptor: RemoteDescriptor, deps: TransportDeps): RemoteTransport {
  switch (descriptor.kind) {
    case "git": {
      if (!deps.clonesDir) {
        throw new RemoteError(descriptor.name, "a git remote needs a clones directory");
      }
      return new GitTransport({
        descriptor,
        clonesDir: deps.clonesDir,
        ...(deps.git ? { git: deps.git } : {}),
        ...(deps.gitAuthor ? { author: deps.gitAuthor } : {}),
      });
    }
    case "room":
      return new RoomTransport({
        descriptor,
        ...(deps.roomClient ? { client: deps.roomClient } : {}),
        ...(deps.http ? { http: deps.http } : {}),
      });
    case "url": {
      const dir = localDirOf(descriptor.url);
      if (dir !== undefined) {
        return new ServedTreeTransport(descriptor, new DirTreeIO(dir));
      }
      if (!deps.http) {
        throw new RemoteError(descriptor.name, "an http remote needs an http client");
      }
      return new ServedTreeTransport(descriptor, new HttpTreeIO(descriptor.url, deps.http));
    }
  }
}
