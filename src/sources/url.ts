/**
 * The URL source: copy a file from an arbitrary http(s) URL, pinned by the
 * sha256 of the bytes fetched at lock time. The **SSRF guard is on by default** —
 * the fetch is validated on the initial request and re-validated on every
 * redirect hop, so an internal target is refused even if a public URL redirects
 * to it. The final (post-redirect) URL is what the lock records and what a build
 * re-fetches.
 */

import { hashBuffer } from "../store/hash.js";
import { HttpError } from "../types/errors.js";
import type {
  FetchPlan,
  LockPackage,
  ResolveResult,
  ResolvedRef,
  Source,
  SourceContext,
} from "../types/index.js";
import { inferKind } from "./kind.js";
import { safeBasename, singleFilePlacement } from "./place.js";
import { guardHop } from "./ssrf.js";

/** A bomb bound on a single url-source download at lock time. */
const MAX_URL_BYTES = 512 * 1024 * 1024;

function filenameFromUrl(finalUrl: string, kind: string): string {
  let base = "";
  try {
    base = new URL(finalUrl).pathname.split("/").pop() ?? "";
  } catch {
    base = "";
  }
  const ext = kind === "mod" ? ".jar" : ".zip";
  if (base.length === 0 || !base.includes(".")) {
    return `${base || "download"}${ext}`;
  }
  return base;
}

export class UrlSource implements Source {
  readonly kind = "url" as const;

  async resolve(ref: ResolvedRef, ctx: SourceContext): Promise<ResolveResult> {
    if (!ctx.http) {
      throw new HttpError(ref.id, "no HTTP client is configured for the url source");
    }
    // SSRF guard runs per hop, inside http.get, before any bytes are read.
    const res = await ctx.http.get(ref.id, { guard: guardHop, maxBytes: MAX_URL_BYTES });
    const bytes = res.body;
    const hash = hashBuffer(bytes, "sha256");
    // Provisional filename (for extension) → infer kind → final filename.
    const provisional = filenameFromUrl(res.url, "mod");
    const itemKind = await inferKind({
      subject: ref.id,
      explicit: ref.kind,
      filename: provisional,
      bytes,
    });
    const filename = safeBasename(filenameFromUrl(res.url, itemKind), ".jar");
    if (ctx.store) {
      await ctx.store.putBuffer(bytes, "sha256", hash);
    }
    const pkg: LockPackage = {
      name: filename,
      kind: itemKind,
      source: "url",
      hash,
      provenance: "copy",
      placement: singleFilePlacement(itemKind, filename),
      size: bytes.byteLength,
      url: res.url,
    };
    return { pkg };
  }

  plan(pkg: LockPackage, _ctx: SourceContext): FetchPlan {
    if (!pkg.url) {
      throw new HttpError(pkg.name, "url package has no download URL");
    }
    return {
      url: pkg.url,
      expected: pkg.hash,
      provenance: "copy",
      ...(pkg.size !== undefined ? { size: pkg.size } : {}),
    };
  }
}
