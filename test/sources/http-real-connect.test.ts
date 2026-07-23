/**
 * Real-socket coverage for the SSRF guard's pinned-IP connect path.
 *
 * Every other HTTP test injects a fake `fetch`, so the *real* undici path —
 * `defaultFetch` + the `pinnedDispatcher` that hands a custom `lookup` to
 * `net.connect` — is never exercised against a live socket. That gap hid a bug:
 * the pinned `lookup` only implemented the single-address callback form
 * (`cb(null, address, family)`), but Node's default `autoSelectFamily` connect
 * path calls it with `{ all: true }` and expects the array form
 * (`cb(null, [{ address, family }])`). The mismatch failed every real connect
 * with `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
 *
 * These tests spin up a real HTTP server on 127.0.0.1 and drive the real client:
 *   (a) with the default guard, a loopback target is BLOCKED (SSRF protection);
 *   (b) with loopback explicitly allowed, a real socket connect to the resolved
 *       + pinned IP SUCCEEDS and returns the body — proving the pin-IP plumbing
 *       works end to end on the bundled Node/undici.
 */

import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type HttpHop,
  RateLimitedHttp,
  SsrfBlocked,
  assertHttpScheme,
  guardHop,
} from "../../index.js";

describe("RateLimitedHttp real-connect (pinned-IP plumbing)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("REAL-PINNED-OK");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("blocks a loopback target by default (SSRF guard, real DNS→127.0.0.1)", async () => {
    const client = new RateLimitedHttp({
      userAgent: "lobbify-anvil/test",
      // A public-looking host that resolves to loopback — the DNS-rebinding shape
      // the guard exists to catch. No fetchImpl → the real undici path is used.
      lookup: async () => ["127.0.0.1"],
    });
    await expect(
      client.get(`http://pinned.test:${port}/`, { guard: guardHop }),
    ).rejects.toBeInstanceOf(SsrfBlocked);
  });

  it("with loopback allowed, connects to the resolved+pinned IP and returns the body", async () => {
    let seen: HttpHop | undefined;
    const client = new RateLimitedHttp({
      userAgent: "lobbify-anvil/test",
      lookup: async () => ["127.0.0.1"],
    });
    // An "allow loopback" guard: still enforce the scheme, but permit the
    // loopback address the default guard would reject. This is the ONLY relaxation
    // — the resolved IP is still what gets pinned and connected to.
    const allowLoopback = async (hop: HttpHop): Promise<void> => {
      seen = hop;
      assertHttpScheme(hop.url);
    };
    const res = await client.get(`http://pinned.test:${port}/`, { guard: allowLoopback });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("REAL-PINNED-OK");
    // The resolve→guard→pin path threaded the vetted IP: the guard saw exactly the
    // address undici then connected to over a real socket.
    expect(seen?.addresses).toEqual(["127.0.0.1"]);
  });
});
