import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { hashBuffer, hashEquals, hashFile, hashStream, hashingTap, shardOf } from "../../index.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";

describe("hashing", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) {
      await rmTmp(d);
    }
    dirs.length = 0;
  });

  it("agrees across buffer, stream, file, and tap for the same bytes", async () => {
    const bytes = Buffer.from("the quick brown fox");
    const expected = createHash("sha256").update(bytes).digest("hex");

    const buf = hashBuffer(bytes, "sha256");
    expect(buf).toEqual({ algo: "sha256", value: expected });

    const streamed = await hashStream(Readable.from(bytes), "sha256");
    expect(streamed.value).toBe(expected);

    const dir = await mkTmp("hash");
    dirs.push(dir);
    const p = join(dir, "f.bin");
    await writeFile(p, bytes);
    expect((await hashFile(p, "sha256")).value).toBe(expected);

    const { tap, digest } = hashingTap("sha256");
    await new Promise<void>((res) => {
      tap.on("data", () => undefined);
      tap.on("end", () => res());
      tap.end(bytes);
    });
    expect(digest().value).toBe(expected);
  });

  it("shards on the first two hex chars and compares structurally", () => {
    expect(shardOf("abcdef1234")).toBe("ab");
    expect(hashEquals({ algo: "sha1", value: "x" }, { algo: "sha1", value: "x" })).toBe(true);
    expect(hashEquals({ algo: "sha1", value: "x" }, { algo: "sha256", value: "x" })).toBe(false);
  });
});
