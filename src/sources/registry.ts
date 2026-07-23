/**
 * The source registry and the default `allowSource` policy.
 *
 * Each source gets its **own** rate-limited HTTP client, so token buckets and the
 * User-Agent are scoped per source (Modrinth's bucket never throttles URL
 * fetches, and vice versa). The local source needs no HTTP.
 *
 * ## Default `allowSource` policy (keyless CLI)
 *
 * The standalone CLI is permissive by construction — it allows all four sources
 * (`modrinth`, `url`, `local`, `curseforge`). Safety does not come from this
 * gate being restrictive; it comes from the layers below it:
 *   - the **SSRF guard** (always on for `url`) blocks internal/metadata targets;
 *   - **CurseForge** still needs a BYO key, so it fails closed without one.
 *
 * The gate exists so an **embedder** (e.g. Lobbify) can hand a stricter policy —
 * `allowOnly("modrinth", "local")` — to veto sources it does not trust. It is
 * evaluated **before any network I/O**, so a malicious manifest cannot even
 * trigger a fetch to a vetoed source.
 */

import type { AllowSource, Http, Source, SourceKind } from "../types/index.js";
import { CurseForgeSource } from "./curseforge.js";
import { RateLimitedHttp } from "./http.js";
import type { RateLimitedHttpOptions } from "./http.js";
import { LocalSource } from "./local.js";
import { ModrinthSource } from "./modrinth.js";
import { UrlSource } from "./url.js";

/** A descriptive User-Agent with a contact URL, sent on every request. */
export const USER_AGENT = "lobbify-anvil/0.1.0 (+https://github.com/lobbify/lobbify-anvil)";

/** One registry entry: the source and its per-source rate-limited HTTP client. */
export interface SourceEntry {
  readonly source: Source;
  /** The per-source HTTP client (absent for the local source). */
  readonly http?: Http;
}

export type SourceRegistry = ReadonlyMap<SourceKind, SourceEntry>;

/** The permissive default policy for the standalone CLI (allow all sources). */
export const defaultAllowSource: AllowSource = () => true;

/** A stricter policy factory for embedders: allow only the named sources. */
export function allowOnly(...kinds: readonly SourceKind[]): AllowSource {
  const set = new Set(kinds);
  return (ref) => set.has(ref.source);
}

export interface BuildRegistryOptions {
  /** Modrinth API base override (proxy/mirror). */
  readonly modrinthBaseUrl?: string;
  /** CurseForge Core API base override (proxy/mirror/offline fixtures). */
  readonly curseforgeBaseUrl?: string;
  /** Sustained requests/second per source. Conservative default in the client. */
  readonly rps?: number;
  /**
   * A factory for the per-source HTTP client. Defaults to {@link RateLimitedHttp};
   * tests inject a fake client here to stay offline.
   */
  readonly httpFactory?: (options: RateLimitedHttpOptions) => Http;
}

/** Build the standard Modrinth / URL / local / CurseForge registry. */
export function buildRegistry(options: BuildRegistryOptions = {}): SourceRegistry {
  const make = (): Http => {
    const httpOptions: RateLimitedHttpOptions = {
      userAgent: USER_AGENT,
      ...(options.rps !== undefined ? { rps: options.rps } : {}),
    };
    return options.httpFactory
      ? options.httpFactory(httpOptions)
      : new RateLimitedHttp(httpOptions);
  };
  const map = new Map<SourceKind, SourceEntry>();
  map.set("modrinth", {
    source: new ModrinthSource(options.modrinthBaseUrl ? { baseUrl: options.modrinthBaseUrl } : {}),
    http: make(),
  });
  map.set("url", { source: new UrlSource(), http: make() });
  map.set("local", { source: new LocalSource() });
  map.set("curseforge", {
    source: new CurseForgeSource(
      options.curseforgeBaseUrl ? { baseUrl: options.curseforgeBaseUrl } : {},
    ),
    http: make(),
  });
  return map;
}
