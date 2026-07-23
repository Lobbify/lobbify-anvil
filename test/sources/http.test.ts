import { describe, expect, it } from "vitest";
import { HttpError, NetworkError, SsrfBlocked, guardHop } from "../../index.js";
import { type ScriptedResponse, makeScriptedHttp } from "../helpers/net.js";

const ok = (body = "ok"): ScriptedResponse => ({
  status: 200,
  headers: { "content-type": "text/plain" },
  body: new TextEncoder().encode(body),
});

describe("RateLimitedHttp", () => {
  it("sends the descriptive User-Agent on every request", async () => {
    const s = makeScriptedHttp({ handler: () => ok() });
    await s.http.get("https://api.example/a");
    await s.http.get("https://api.example/b");
    expect(s.requests).toHaveLength(2);
    for (const r of s.requests) {
      expect(r.headers["user-agent"]).toBe("lobbify-anvil/0.1.0 (+test)");
    }
  });

  it("honors Retry-After on a 429, then succeeds", async () => {
    const s = makeScriptedHttp({
      handler: (_url, _init, call) =>
        call === 0 ? { status: 429, headers: { "retry-after": "2" } } : ok("done"),
    });
    const res = await s.http.get("https://api.example/limited");
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe("done");
    expect(s.requests).toHaveLength(2);
    // The backoff slept for exactly the Retry-After seconds.
    expect(s.sleeps).toContain(2000);
  });

  it("clamps a hostile Retry-After to a bounded backoff", async () => {
    const s = makeScriptedHttp({
      handler: (_url, _init, call) =>
        call === 0 ? { status: 429, headers: { "retry-after": "2000000" } } : ok("done"),
    });
    const res = await s.http.get("https://api.example/limited");
    expect(res.status).toBe(200);
    // 2,000,000 s would be ~23 days; it must be clamped to the 60 s ceiling.
    expect(Math.max(...s.sleeps)).toBeLessThanOrEqual(60_000);
  });

  it("paces requests through the token bucket", async () => {
    const s = makeScriptedHttp({ handler: () => ok(), rps: 1, burst: 1 });
    await s.http.get("https://api.example/1");
    await s.http.get("https://api.example/2");
    // The second request had to wait ~1s for a token to refill.
    expect(s.sleeps.some((ms) => ms >= 1000)).toBe(true);
  });

  it("re-validates the SSRF guard on a redirect hop (blocks internal target)", async () => {
    const s = makeScriptedHttp({
      handler: (_url, _init, call) =>
        call === 0
          ? { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }
          : ok("SECRET"),
    });
    await expect(
      s.http.get("https://public.example/start", { guard: guardHop }),
    ).rejects.toBeInstanceOf(SsrfBlocked);
    // The internal redirect target was never actually requested.
    expect(s.requests).toHaveLength(1);
  });

  it("follows a redirect to a public host and returns the final URL + body", async () => {
    const s = makeScriptedHttp({
      handler: (_url, _init, call) =>
        call === 0
          ? { status: 302, headers: { location: "https://cdn.example/final.jar" } }
          : ok("FINAL"),
    });
    const res = await s.http.get("https://public.example/start", { guard: guardHop });
    expect(res.url).toBe("https://cdn.example/final.jar");
    expect(new TextDecoder().decode(res.body)).toBe("FINAL");
  });

  it("fails on a redirect loop past the hop limit", async () => {
    const s = makeScriptedHttp({
      handler: () => ({ status: 302, headers: { location: "https://public.example/again" } }),
      maxRedirects: 3,
    });
    await expect(s.http.get("https://public.example/start")).rejects.toBeInstanceOf(HttpError);
  });

  it("maps a transport failure to a typed NetworkError naming the host + reason", async () => {
    const fetchFailed = () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    };
    const s = makeScriptedHttp({ handler: fetchFailed });
    const err = await s.http.get("https://api.modrinth.com/v2/project/sodium").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe("NETWORK_ERROR");
    expect((err as NetworkError).host).toBe("api.modrinth.com");
    expect((err as Error).message).toContain("could not reach api.modrinth.com");
    expect((err as Error).message).toContain("connection refused");
    // The raw cause is preserved for debugging, but not part of the rendered text.
    expect((err as NetworkError).cause).toBeDefined();
    expect((err as Error).message).not.toContain("10.0.0.1");
  });

  it("maps a DNS resolution failure to a NetworkError (host not found)", async () => {
    const s = makeScriptedHttp({
      handler: () => ok(),
      lookup: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), {
          code: "ENOTFOUND",
        });
      },
    });
    const err = await s.http.get("https://nope.invalid/mod.jar").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain("nope.invalid");
    expect((err as Error).message.toLowerCase()).toContain("dns");
    // No fetch was ever attempted — it failed at name resolution.
    expect(s.requests).toHaveLength(0);
  });

  it("maps a connection timeout to a NetworkError", async () => {
    const s = makeScriptedHttp({
      handler: () => {
        throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    });
    const err = await s.http.get("https://slow.example/x").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain("timed out");
  });

  it("does NOT mask a genuinely-unexpected (non-transport) error as a network failure", async () => {
    const s = makeScriptedHttp({
      handler: () => {
        throw new Error("a real bug in our code");
      },
    });
    const err = await s.http.get("https://api.example/x").catch((e) => e);
    expect(err).not.toBeInstanceOf(NetworkError);
    expect((err as Error).message).toBe("a real bug in our code");
  });
});
