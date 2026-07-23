import { describe, expect, it } from "vitest";
import { SsrfBlocked, assertHttpScheme, guardHop, isBlockedIp } from "../../index.js";

describe("isBlockedIp", () => {
  it("blocks loopback / RFC1918 / link-local / metadata / CGNAT", () => {
    for (const ip of [
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.5.5",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks internal IPv6 (loopback, ULA, link-local, v4-mapped internal)", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::127.0.0.1", // IPv4-compatible
      "64:ff9b::169.254.169.254", // NAT64 → metadata
      "::ffff:0:169.254.169.254", // translated form → metadata
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe("assertHttpScheme", () => {
  it("accepts http(s) and rejects everything else", () => {
    expect(assertHttpScheme("https://example.com/x").protocol).toBe("https:");
    expect(() => assertHttpScheme("file:///etc/passwd")).toThrow(SsrfBlocked);
    expect(() => assertHttpScheme("ftp://host/x")).toThrow(SsrfBlocked);
    expect(() => assertHttpScheme("gopher://host")).toThrow(SsrfBlocked);
  });
});

describe("guardHop", () => {
  it("passes a public hop and blocks an internal host literal", () => {
    expect(() =>
      guardHop({ url: "https://example.com/x", host: "example.com", addresses: ["93.184.216.34"] }),
    ).not.toThrow();
    expect(() =>
      guardHop({ url: "http://127.0.0.1:8080/x", host: "127.0.0.1", addresses: [] }),
    ).toThrow(SsrfBlocked);
  });

  it("blocks when a hostname resolves to an internal address (rebinding defense)", () => {
    expect(() =>
      guardHop({
        url: "https://sneaky.example/x",
        host: "sneaky.example",
        addresses: ["169.254.169.254"],
      }),
    ).toThrow(SsrfBlocked);
  });

  it("fails closed when a non-IP host resolved to no addresses", () => {
    expect(() =>
      guardHop({ url: "https://nowhere.example/x", host: "nowhere.example", addresses: [] }),
    ).toThrow(SsrfBlocked);
  });
});
