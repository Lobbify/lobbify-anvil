/**
 * The local-file source: copy a file from disk into the store, pinned by the
 * sha256 of its bytes. Portable across the store (the hash is), but the `url`
 * hint it records is a machine-local `file://` path — inherently non-portable,
 * which is the nature of a local item.
 *
 * Placement follows the item's own path when it has one. A file authored at
 * `config/sodium/mixins.json` is read from there and placed back there; only a
 * file with no in-instance path of its own (one outside the instance root) falls
 * back to `<kind-dir>/<basename>`. Collapsing every local item to kind+basename
 * relocated files across a re-lock — a root `options.txt` reappeared under
 * `config/`, and nested config trees could not round-trip at all.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { hashBuffer } from "../store/hash.js";
import { HttpError } from "../types/errors.js";
import type {
  FetchPlan,
  LockPackage,
  Placement,
  ResolveResult,
  ResolvedRef,
  Source,
} from "../types/index.js";
import type { SourceContext } from "../types/index.js";
import { inferKind } from "./kind.js";
import { safeBasename, singleFilePlacement } from "./place.js";

export class LocalSource implements Source {
  readonly kind = "local" as const;

  async resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult> {
    // The resolver passes an absolute path in ref.id for local items.
    const path = ref.id;
    const bytes = new Uint8Array(await readFile(path));
    const hash = hashBuffer(bytes, "sha256");
    const rawName = basename(path);
    const itemKind = await inferKind({
      subject: path,
      explicit: ref.kind,
      filename: rawName,
      bytes,
    });
    const filename = safeBasename(rawName, ".jar");
    if (ctx.store) {
      await ctx.store.putBuffer(bytes, "sha256", hash);
    }
    // The declared path wins when the item has one; kind+basename is the fallback
    // for a file that lives outside the instance and names no placement itself.
    const placement: Placement =
      ref.target !== undefined
        ? { method: "link", target: ref.target }
        : singleFilePlacement(itemKind, filename);
    const pkg: LockPackage = {
      name: filename,
      kind: itemKind,
      source: "local",
      hash,
      provenance: "copy",
      placement,
      size: bytes.byteLength,
      url: pathToFileURL(path).toString(),
    };
    return { pkg };
  }

  plan(pkg: LockPackage, _ctx: SourceContext): FetchPlan {
    if (!pkg.url) {
      throw new HttpError(pkg.name, "local package has no source path to re-read");
    }
    return {
      url: pkg.url,
      expected: pkg.hash,
      provenance: "copy",
      ...(pkg.size !== undefined ? { size: pkg.size } : {}),
    };
  }
}
