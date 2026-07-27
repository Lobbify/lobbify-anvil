/**
 * Snapshot-encoding compatibility for the tracked set (LB-705, decision D2).
 *
 * The `tracked` key is OMITTED from the canonical encoding when the set is empty,
 * so a snapshot with nothing undeclared encodes to exactly the bytes anvil wrote
 * before tracking existed and keeps its commit id. Writing `tracked: []` instead
 * would silently invalidate every commit id ever recorded, and would make an old
 * repo with nothing undeclared report a dirty working tree out of nowhere.
 *
 * The expected encodings below are **hard-coded literals**, not re-derived from
 * `canonicalJson`. Recomputing the same expression would agree with any change to
 * the encoder, which is the one thing this file exists to catch.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Hash, type SnapshotObject, encodeObject, idOf } from "../../index.js";

const h = (c: string): Hash => ({ algo: "sha256", value: c.repeat(64) });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha256hex = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const base = {
  type: "snapshot",
  manifest: h("1"),
  lock: h("2"),
  ignore: h("3"),
  carried: [],
} as const;

// The three hash strings the encodings below spell out, named only so the
// literals stay readable. Everything else in them is written out by hand.
const MANIFEST = `sha256:${"1".repeat(64)}`;
const LOCK = `sha256:${"2".repeat(64)}`;
const IGNORE = `sha256:${"3".repeat(64)}`;
const BLOB = `sha256:${"4".repeat(64)}`;

/** The exact bytes a pre-LB-705 anvil produced for this snapshot. */
const LEGACY_ENCODING = `anvil-object:snapshot\n{"carried":[],"ignore":"${IGNORE}","lock":"${LOCK}","manifest":"${MANIFEST}","type":"snapshot"}`;

/** The id that encoding hashes to — pinned, so a re-encode cannot move it. */
const LEGACY_ID = "6dbb55bf6b2a75a804e1ddc599ac8d805b44994b9ae265c736915aa499ef3185";

const TRACKED_ENCODING = `anvil-object:snapshot\n{"carried":[],"ignore":"${IGNORE}","lock":"${LOCK}","manifest":"${MANIFEST}","tracked":[{"blob":"${BLOB}","path":"config/x.toml"}],"type":"snapshot"}`;

const TRACKED_ID = "1e9b51f2869f9cb06b27395f245efb2e7680fc770645a901e97c0e5bf23e17ce";

describe("vc snapshot encoding: the tracked set is omitted when empty", () => {
  it("GATE tracked-omitted: an empty tracked set encodes to the pre-LB-705 bytes and id", () => {
    const snapshot: SnapshotObject = { ...base, tracked: [] };
    expect(decode(encodeObject(snapshot))).toBe(LEGACY_ENCODING);
    // Belt and braces: no `tracked` key at all, not merely an equal-looking string.
    expect(decode(encodeObject(snapshot))).not.toContain("tracked");
    expect(idOf(snapshot).value).toBe(LEGACY_ID);
    // The pinned id really is the sha256 of the pinned encoding.
    expect(sha256hex(LEGACY_ENCODING)).toBe(LEGACY_ID);
  });

  it("includes the tracked set once it is non-empty, changing the id", () => {
    const snapshot: SnapshotObject = {
      ...base,
      tracked: [{ path: "config/x.toml", blob: h("4") }],
    };
    expect(decode(encodeObject(snapshot))).toBe(TRACKED_ENCODING);
    expect(idOf(snapshot).value).toBe(TRACKED_ID);
    expect(sha256hex(TRACKED_ENCODING)).toBe(TRACKED_ID);
    // A tracked file genuinely moves the id — a deletion is therefore a real commit.
    expect(TRACKED_ID).not.toBe(LEGACY_ID);
  });

  it("sorts the tracked set by path, so input order cannot change the id", () => {
    const forward: SnapshotObject = {
      ...base,
      tracked: [
        { path: "a.toml", blob: h("4") },
        { path: "b.toml", blob: h("5") },
      ],
    };
    const reversed: SnapshotObject = {
      ...base,
      tracked: [
        { path: "b.toml", blob: h("5") },
        { path: "a.toml", blob: h("4") },
      ],
    };
    expect(decode(encodeObject(reversed))).toBe(decode(encodeObject(forward)));
    expect(decode(encodeObject(forward))).toContain(
      `"tracked":[{"blob":"${BLOB}","path":"a.toml"},{"blob":"sha256:${"5".repeat(64)}","path":"b.toml"}]`,
    );
  });

  it("records no file mode, so the same tree hashes identically on every OS", () => {
    // The encoded entry has exactly two keys. An exec bit here would make a commit
    // id platform-dependent (Windows cannot represent one).
    const snapshot: SnapshotObject = {
      ...base,
      tracked: [{ path: "config/x.toml", blob: h("4") }],
    };
    const body = decode(encodeObject(snapshot));
    const entry = body.slice(body.indexOf('"tracked":['), body.indexOf('],"type"') + 1);
    expect(entry).toBe(`"tracked":[{"blob":"${BLOB}","path":"config/x.toml"}]`);
  });
});
