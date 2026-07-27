/**
 * The precedence engine, tested directly on synthetic packages — no network, no
 * pack format, no resolver. The rules in `base/overlay.ts` are what everything
 * downstream reasons about, so they get tested as rules rather than only through
 * an end-to-end lock.
 */

import { describe, expect, it } from "vitest";
import type { LockPackage } from "../../index.js";
import { baseSetDigest, overlayBase, parseRef } from "../../index.js";

function hash(v: string): LockPackage["hash"] {
  return { algo: "sha256", value: v.repeat(64).slice(0, 64) };
}

function modrinthPkg(slug: string, version: string, target?: string): LockPackage {
  return {
    name: slug,
    kind: "mod",
    source: "modrinth",
    version,
    hash: hash(slug.slice(0, 1)),
    provenance: "copy",
    placement: { method: "link", target: target ?? `mods/${slug}-${version}.jar` },
    url: `https://cdn.modrinth.com/data/${slug}/versions/${version}/${slug}.jar`,
  };
}

/**
 * A tracked local file. `where` mirrors reality: a base's override is materialized
 * under `.anvil/base/`, the instance's own file sits in the instance tree. The two
 * therefore share a placement target and share no identity at all — which is
 * precisely the case the target axis exists for.
 */
function localPkg(target: string, body: string, where = "/instance"): LockPackage {
  return {
    name: target.split("/").pop() ?? target,
    kind: "config",
    source: "local",
    hash: hash(body.slice(0, 1)),
    provenance: "copy",
    placement: { method: "link", target },
    url: `file://${where}/${target}`,
  };
}

/** The same file as the base pack would materialize it. */
function baseLocalPkg(target: string, body: string): LockPackage {
  return localPkg(target, body, "/instance/.anvil/base");
}

const removes = (...raw: string[]) => raw.map((r) => ({ raw: r, ref: parseRef(r) }));

describe("base overlay precedence", () => {
  it("keeps a base member the instance says nothing about", () => {
    const base = [modrinthPkg("sodium", "0.5.8")];
    const result = overlayBase({ base, instance: [], removes: [] });
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.fromBase).toBe(true);
    expect(result.overridden).toHaveLength(0);
  });

  it("ADD: an instance item the base does not ship is simply added, unflagged", () => {
    const base = [modrinthPkg("sodium", "0.5.8")];
    const instance = [modrinthPkg("iris", "1.7.0")];
    const result = overlayBase({ base, instance, removes: [] });
    expect(result.effective.map((p) => p.name).sort()).toEqual(["iris", "sodium"]);
    expect(result.effective.find((p) => p.name === "iris")?.fromBase).toBeUndefined();
    expect(result.effective.find((p) => p.name === "sodium")?.fromBase).toBe(true);
  });

  it("OVERRIDE by identity: a version bump replaces the base member, old filename and all", () => {
    const base = [modrinthPkg("sodium", "0.5.8")];
    const instance = [modrinthPkg("sodium", "0.6.0")];
    const result = overlayBase({ base, instance, removes: [] });
    // The whole point: the base's 0.5.8 jar must NOT survive next to 0.6.0.
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.version).toBe("0.6.0");
    expect(result.effective[0]?.fromBase).toBeUndefined();
    expect(
      result.effective.some(
        (p) => p.placement.method === "link" && p.placement.target.includes("0.5.8"),
      ),
    ).toBe(false);
    expect(result.overridden).toEqual([expect.objectContaining({ on: "identity" })]);
  });

  it("OVERRIDE by target: a config at the same path wins, though identities differ", () => {
    const base = [baseLocalPkg("config/sodium.json", "base-config")];
    const instance = [localPkg("config/sodium.json", "mine")];
    const result = overlayBase({ base, instance, removes: [] });
    expect(result.effective).toHaveLength(1);
    expect(result.effective[0]?.hash.value).toBe(hash("m").value);
    expect(result.overridden[0]?.on).toBe("target");
  });

  it("REMOVE by identity drops a base member and flags nothing unmatched", () => {
    const base = [modrinthPkg("sodium", "0.5.8"), modrinthPkg("iris", "1.7.0")];
    const result = overlayBase({ base, instance: [], removes: removes("modrinth:sodium") });
    expect(result.effective.map((p) => p.name)).toEqual(["iris"]);
    expect(result.removed[0]?.on).toBe("identity");
    expect(result.unmatched).toEqual([]);
  });

  it("REMOVE by placement path drops a base config the user knows only by path", () => {
    const base = [baseLocalPkg("config/sodium.json", "base-config")];
    const result = overlayBase({ base, instance: [], removes: removes("./config/sodium.json") });
    expect(result.effective).toEqual([]);
    expect(result.removed[0]?.on).toBe("target");
  });

  it("a remove matching nothing is reported, never silently dropped", () => {
    const base = [modrinthPkg("sodium", "0.5.8")];
    const result = overlayBase({ base, instance: [], removes: removes("modrinth:nosuchmod") });
    expect(result.unmatched).toEqual(["modrinth:nosuchmod"]);
  });

  it("a modrinth remove never matches a url member that merely shares its name", () => {
    const urlMember: LockPackage = {
      name: "sodium",
      kind: "mod",
      source: "url",
      hash: hash("u"),
      provenance: "copy",
      placement: { method: "link", target: "mods/sodium.jar" },
      url: "https://elsewhere.example/sodium.jar",
    };
    const result = overlayBase({
      base: [urlMember],
      instance: [],
      removes: removes("modrinth:sodium"),
    });
    expect(result.effective).toHaveLength(1);
    expect(result.unmatched).toEqual(["modrinth:sodium"]);
  });

  it("removal wins over override: a removed instance item cannot displace a base member", () => {
    const base = [modrinthPkg("sodium", "0.5.8")];
    const instance = [modrinthPkg("sodium", "0.6.0")];
    const result = overlayBase({ base, instance, removes: removes("modrinth:sodium") });
    // Both layers named sodium; `remove` names it too, so nothing survives.
    expect(result.effective).toEqual([]);
    expect(result.removed).toHaveLength(2);
  });

  it("is order-independent: shuffling either layer yields the same effective set", () => {
    const base = [
      modrinthPkg("a", "1"),
      modrinthPkg("b", "1"),
      baseLocalPkg("config/x.json", "base"),
    ];
    const instance = [modrinthPkg("b", "2"), localPkg("config/x.json", "mine")];
    const forward = overlayBase({ base, instance, removes: [] });
    const backward = overlayBase({
      base: [...base].reverse(),
      instance: [...instance].reverse(),
      removes: [],
    });
    const key = (r: typeof forward) =>
      r.effective
        .map((p) => `${p.name}@${p.version ?? ""}#${p.hash.value}${p.fromBase ? "!base" : ""}`)
        .sort()
        .join("|");
    expect(key(forward)).toBe(key(backward));
  });
});

describe("base set digest", () => {
  it("is independent of member order", () => {
    const members = [modrinthPkg("a", "1"), modrinthPkg("b", "2")];
    expect(baseSetDigest(members).value).toBe(baseSetDigest([...members].reverse()).value);
  });

  it("moves when a member's pinned bytes change", () => {
    const before = [modrinthPkg("a", "1")];
    const after = [{ ...(modrinthPkg("a", "1") as LockPackage), hash: hash("z") }];
    expect(baseSetDigest(before).value).not.toBe(baseSetDigest(after).value);
  });

  it("moves when a member lands at a different path", () => {
    const before = [modrinthPkg("a", "1", "mods/a.jar")];
    const after = [modrinthPkg("a", "1", "mods/nested/a.jar")];
    expect(baseSetDigest(before).value).not.toBe(baseSetDigest(after).value);
  });

  it("is unchanged by the overlay: it describes the base, not the instance", () => {
    const base = [modrinthPkg("a", "1"), modrinthPkg("b", "1")];
    const digest = baseSetDigest(base);
    overlayBase({ base, instance: [modrinthPkg("b", "2")], removes: [] });
    expect(baseSetDigest(base).value).toBe(digest.value);
  });
});
