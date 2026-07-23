/**
 * The SSRF guard for the `url` source — **on by default**.
 *
 * A `url` item (or a redirect it triggers) can point anywhere. Left unchecked it
 * is a server-side request forgery primitive: fetch `http://169.254.169.254/…`
 * (cloud metadata), `http://127.0.0.1:…` (a local admin API), or an internal
 * RFC1918 host. So we:
 *
 *   - reject any non-`http(s)` scheme;
 *   - block loopback / RFC1918 / link-local / cloud-metadata / ULA / multicast
 *     targets, checking the **DNS-resolved addresses** (not just the hostname),
 *     which closes the DNS-rebinding hole;
 *   - re-validate on **every** redirect hop (the guard is invoked per hop by the
 *     HTTP client), so a public host that 302s to an internal one is still caught.
 *
 * The final host is surfaced to `allowSource`/the caller via the resolved
 * {@link HttpHop}. This module has no network side effects: address resolution is
 * injected, so it is fully unit-testable offline.
 */

import { isIP, isIPv4 } from "node:net";
import { SsrfBlocked } from "../types/errors.js";
import type { HttpHop } from "../types/index.js";

/** Parse a dotted IPv4 string into its four octets, or `undefined`. */
function ipv4Octets(ip: string): [number, number, number, number] | undefined {
  if (!isIPv4(ip)) {
    return undefined;
  }
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return undefined;
  }
  return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] as number];
}

/** True if a dotted-quad IPv4 address is not a safe public target. */
function isBlockedIpv4(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) {
    return true; // unparseable → refuse
  }
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+ metadata .169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

/** Expand an IPv6 address to its eight 16-bit hextet numbers, or `undefined`. */
function ipv6Hextets(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) {
    return undefined;
  }
  // Strip a zone id (fe80::1%eth0) before parsing.
  let bare = ip.split("%")[0] as string;
  // Expand an embedded dotted IPv4 (::ffff:1.2.3.4) into two hextets.
  const lastColon = bare.lastIndexOf(":");
  const v4tail = bare.slice(lastColon + 1);
  if (v4tail.includes(".") && isIPv4(v4tail)) {
    const o = ipv4Octets(v4tail);
    if (!o) {
      return undefined;
    }
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    bare = `${bare.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  // Split on "::" (at most once) to expand the zero-run.
  const halves = bare.split("::");
  const parseSide = (side: string): number[] =>
    side
      .split(":")
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 16));
  if (halves.length === 1) {
    const hextets = parseSide(bare);
    return hextets.length === 8 ? hextets : undefined;
  }
  if (halves.length !== 2) {
    return undefined;
  }
  const head = parseSide(halves[0] as string);
  const tail = parseSide(halves[1] as string);
  const missing = 8 - head.length - tail.length;
  if (missing < 0) {
    return undefined;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Extract an embedded IPv4 from an IPv6 address in any of the v4-embedding ranges
 * — IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible / `::`/`::1` (`::/96`), the
 * translated `::ffff:0:0/96` alt form, and NAT64 (`64:ff9b::/96`). Returns the
 * dotted-quad of the low 32 bits, so the embedded address is checked as IPv4.
 */
function embeddedIpv4(h: number[]): string | undefined {
  const dotted = (hi: number, lo: number): string =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const lo = dotted(h[6] as number, h[7] as number);
  const prefixZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0;
  // ::/96 (compatible, incl. :: and ::1) and ::ffff:0:0/96 (mapped): h[4]=0.
  if (prefixZero && h[4] === 0 && (h[5] === 0 || h[5] === 0xffff)) {
    return lo;
  }
  // Alternative translated form where ffff lands in h[4].
  if (prefixZero && h[4] === 0xffff && h[5] === 0) {
    return lo;
  }
  // 64:ff9b::/96 NAT64.
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return lo;
  }
  return undefined;
}

/** True if an IPv6 address is not a safe public target. */
function isBlockedIpv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) {
    return true;
  }
  // Any embedded IPv4 (::, ::1, mapped, compatible, translated, NAT64) is
  // vetted as IPv4 — this is where loopback/RFC1918/metadata-via-v6 is caught.
  const v4 = embeddedIpv4(h);
  if (v4 !== undefined) {
    return isBlockedIpv4(v4);
  }
  const first = h[0] as number;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True if a literal IP address (v4 or v6) is not a safe public target. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isBlockedIpv4(ip);
  }
  if (family === 6) {
    return isBlockedIpv6(ip);
  }
  return true; // not an IP literal
}

/** Assert a URL's scheme is `http`/`https`; returns the parsed URL. */
export function assertHttpScheme(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlocked(rawUrl, "not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlocked(rawUrl, `scheme "${url.protocol}" is not http(s)`);
  }
  return url;
}

/**
 * Validate one already-resolved hop (scheme + host literal + every resolved
 * address). Throws {@link SsrfBlocked} on anything internal. This is what the
 * HTTP client invokes per hop; `hop.addresses` are the IPs it will connect to.
 */
export function guardHop(hop: HttpHop): void {
  const url = assertHttpScheme(hop.url);
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const hostIsIp = isIP(host) !== 0;
  if (hostIsIp && isBlockedIp(host)) {
    throw new SsrfBlocked(hop.url, `host ${host} is an internal/reserved address`);
  }
  // Fail closed: a non-IP host that resolved to nothing must not pass unvetted.
  if (!hostIsIp && hop.addresses.length === 0) {
    throw new SsrfBlocked(hop.url, `host ${host} did not resolve to any address`);
  }
  for (const addr of hop.addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlocked(hop.url, `resolves to internal/reserved address ${addr}`);
    }
  }
}
