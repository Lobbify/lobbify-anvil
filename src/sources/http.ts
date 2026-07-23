/**
 * The per-source rate-limited HTTP client used at **lock time** (never during a
 * build — the lock is the sole build input). One instance per source, so its
 * token bucket and User-Agent are scoped per source.
 *
 * What it guarantees:
 *   - a **conservative token bucket** (default a few requests/second) so we never
 *     hammer a public API; `Retry-After` and `X-Ratelimit-Remaining`/`-Reset` are
 *     honored, with exponential backoff + jitter on 429/503;
 *   - a **descriptive User-Agent** on every request (`lobbify-anvil/<ver>
 *     (contact)`), as public APIs ask for;
 *   - **manual redirect handling**, so the SSRF `guard` runs on the initial
 *     request and every redirect hop, and — on the real (non-injected) path — the
 *     connection is **pinned to the vetted IP** to close DNS rebinding.
 *
 * The `fetch`, DNS `lookup`, `sleep`, and clock are all injectable, so the whole
 * client — rate limiting, backoff, redirect+guard loop — is unit-tested offline.
 */

import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { HttpError } from "../types/errors.js";
import type { Http, HttpGetOptions, HttpHop, HttpResult } from "../types/index.js";
import { assertHttpScheme } from "./ssrf.js";

/** A minimal fetch response shape (undici's satisfies it; fakes implement it). */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: {
    get(name: string): string | null;
    entries?(): IterableIterator<[string, string]>;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly redirect: "manual";
  readonly dispatcher?: unknown;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface RateLimitedHttpOptions {
  /** Descriptive UA sent on every request. */
  readonly userAgent: string;
  /** Sustained request rate (requests/second). Conservative by default. */
  readonly rps?: number;
  /** Bucket burst capacity. Defaults to `rps`. */
  readonly burst?: number;
  /** Max retries on 429/503 before giving up. */
  readonly maxRetries?: number;
  /** Max redirect hops before failing. */
  readonly maxRedirects?: number;
  /** Injected fetch (defaults to undici; the real path pins the vetted IP). */
  readonly fetchImpl?: FetchLike;
  /** Injected DNS resolver returning every address for a host. */
  readonly lookup?: (host: string) => Promise<string[]>;
  /** Injected sleep (test seam). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected clock (test seam). */
  readonly now?: () => number;
}

const DEFAULT_RPS = 4;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
/** Hard ceiling on any single honored backoff/pause — a hostile server can
 * otherwise send `Retry-After: 2000000` (or a far-future ratelimit reset) and
 * wedge the lock for days, or spin the token bucket. */
const MAX_DELAY_MS = 60_000;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function realLookup(host: string): Promise<string[]> {
  if (isIP(host)) {
    return [host];
  }
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/** Build a dispatcher that pins the connection to a vetted IP (rebinding guard). */
function pinnedDispatcher(address: string): Agent {
  const family = isIP(address) === 6 ? 6 : 4;
  // Pin every hostname lookup to the already-vetted address, so undici connects
  // to exactly the IP the SSRF guard approved (closing DNS rebinding).
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    callback(null, address, family);
  };
  return new Agent({ connect: { lookup } });
}

export class RateLimitedHttp implements Http {
  readonly #ua: string;
  readonly #rps: number;
  readonly #burst: number;
  readonly #maxRetries: number;
  readonly #maxRedirects: number;
  readonly #fetch: FetchLike;
  readonly #injectedFetch: boolean;
  readonly #lookup: (host: string) => Promise<string[]>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  #tokens: number;
  #lastRefill: number;
  #pauseUntil = 0;

  constructor(opts: RateLimitedHttpOptions) {
    this.#ua = opts.userAgent;
    this.#rps = opts.rps ?? DEFAULT_RPS;
    this.#burst = opts.burst ?? this.#rps;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#injectedFetch = opts.fetchImpl !== undefined;
    this.#fetch = opts.fetchImpl ?? defaultFetch;
    this.#lookup = opts.lookup ?? realLookup;
    this.#sleep = opts.sleep ?? realSleep;
    this.#now = opts.now ?? Date.now;
    this.#tokens = this.#burst;
    this.#lastRefill = this.#now();
  }

  async get(url: string, options: HttpGetOptions = {}): Promise<HttpResult> {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      if (hop > this.#maxRedirects) {
        throw new HttpError(url, `too many redirects (> ${this.#maxRedirects})`);
      }
      const { addresses, pin } = await this.#resolveAndGuard(current, options);
      const res = await this.#requestWithRetry(current, options.headers ?? {}, pin);
      if (isRedirect(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          throw new HttpError(current, `redirect ${res.status} without a Location header`);
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (res.status >= 400) {
        throw new HttpError(current, `unexpected status ${res.status}`, res.status);
      }
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      // Reject an honestly-declared oversize body BEFORE buffering it into memory.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new HttpError(
          current,
          `response declares ${declared} > ${maxBytes} bytes`,
          res.status,
        );
      }
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > maxBytes) {
        throw new HttpError(current, `response exceeds ${maxBytes} bytes`, res.status);
      }
      void addresses;
      return { status: res.status, headers: collectHeaders(res), url: current, body };
    }
  }

  /** Resolve the host, run the SSRF guard, and pick a vetted IP to pin. */
  async #resolveAndGuard(
    url: string,
    options: HttpGetOptions,
  ): Promise<{ addresses: string[]; pin?: string }> {
    if (!options.guard) {
      return { addresses: [] };
    }
    // Reject a bad scheme BEFORE any DNS resolution.
    assertHttpScheme(url);
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : await this.#lookup(host);
    const hop: HttpHop = { url, host, addresses };
    await options.guard(hop);
    return { addresses, pin: addresses[0] };
  }

  async #requestWithRetry(
    url: string,
    headers: Readonly<Record<string, string>>,
    pin: string | undefined,
  ): Promise<FetchResponseLike> {
    const init: FetchInitLike = {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": this.#ua, "accept-encoding": "identity", ...headers },
      // Pin the vetted IP on the real path; harmless/ignored under an injected fetch.
      ...(pin && !this.#injectedFetch ? { dispatcher: pinnedDispatcher(pin) } : {}),
    };
    for (let attempt = 0; ; attempt += 1) {
      await this.#takeToken();
      const res = await this.#fetch(url, init);
      if ((res.status === 429 || res.status === 503) && attempt < this.#maxRetries) {
        await this.#sleep(this.#retryDelayMs(res, attempt));
        continue;
      }
      this.#paceFromHeaders(res);
      return res;
    }
  }

  /** Backoff for a 429/503: honor `Retry-After`, else exponential + jitter. */
  #retryDelayMs(res: FetchResponseLike, attempt: number): number {
    const clamp = (ms: number): number => Math.min(MAX_DELAY_MS, Math.max(0, ms));
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return clamp(seconds * 1000);
      }
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) {
        return clamp(at - this.#now());
      }
    }
    const base = Math.min(30_000, 250 * 2 ** attempt);
    return base + Math.floor(this.#pseudoJitter() % 1000);
  }

  /** When a response says the window is exhausted, pause the bucket until reset. */
  #paceFromHeaders(res: FetchResponseLike): void {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === null || Number(remaining) > 0) {
      return;
    }
    const reset = res.headers.get("x-ratelimit-reset");
    if (reset === null) {
      return;
    }
    const secs = Number(reset);
    if (!Number.isFinite(secs)) {
      return;
    }
    // Reset can be "seconds from now" (Modrinth) — treat small values that way.
    const resetMs = secs > 1_000_000_000 ? secs * 1000 : this.#now() + secs * 1000;
    // Clamp to a bounded pause so a far-future reset can't wedge / spin the bucket.
    const capped = Math.min(resetMs, this.#now() + MAX_DELAY_MS);
    this.#pauseUntil = Math.max(this.#pauseUntil, capped);
    this.#tokens = 0;
  }

  async #takeToken(): Promise<void> {
    for (;;) {
      const now = this.#now();
      if (now < this.#pauseUntil) {
        await this.#sleep(this.#pauseUntil - now);
        continue;
      }
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficit = 1 - this.#tokens;
      await this.#sleep(Math.ceil((deficit / this.#rps) * 1000));
    }
  }

  #refill(): void {
    const now = this.#now();
    const elapsedS = (now - this.#lastRefill) / 1000;
    if (elapsedS > 0) {
      this.#tokens = Math.min(this.#burst, this.#tokens + elapsedS * this.#rps);
      this.#lastRefill = now;
    }
  }

  #pseudoJitter(): number {
    return Math.floor(this.#now() * 2654435761) >>> 0;
  }
}

/** Collect response headers into a plain, lowercased record. */
function collectHeaders(res: FetchResponseLike): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = res.headers.entries?.();
  if (entries) {
    for (const [k, v] of entries) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** The real fetch path (undici), honoring an optional pinned-IP dispatcher. */
const defaultFetch: FetchLike = async (url, init) => {
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    redirect: init.redirect,
    ...(init.dispatcher ? { dispatcher: init.dispatcher as Agent } : {}),
  });
  return res as unknown as FetchResponseLike;
};
