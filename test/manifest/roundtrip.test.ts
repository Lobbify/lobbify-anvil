/**
 * LB-862 — anvil must be able to read back every manifest it writes.
 *
 * `parseRef` accepts a local reference in three shapes: a `source:` prefix, or a
 * bare path starting `./`, `../` or `/`. `formatRef` renders a local ref as its
 * **bare id**, dropping the prefix. So a local item whose id begins with none of
 * those three is written in a form the parser cannot read — the manifest stops
 * opening, and every command starts by reading it.
 *
 * ## Why this file's inputs are NOT derived from `ref.ts`
 *
 * The obvious version of this test enumerates the parser's own branches and feeds
 * them back in. It would pass by construction and stay green through exactly the
 * bug it is meant to catch: a source kind added to the parser and not to the
 * writer generates no new case, because the case list came from the parser.
 *
 * So every input below is quoted from something that promises the form to a
 * **user** — README, or the parser's own error strings, which are themselves a
 * published contract. Each carries its citation. That makes the test able to
 * disagree with the code in **both** directions: it fails if the writer emits
 * something unreadable, and it fails if the parser stops accepting a form we
 * documented.
 *
 * Adding a source kind is therefore expected to require a line here. That is the
 * point, not friction to be optimised away.
 */

import { describe, expect, it } from "vitest";
import { ManifestError, parseManifest, parseRef, serializeManifest } from "../../index.js";

/**
 * Every item form anvil documents, with where it is documented. Sourced from the
 * docs and the error messages — deliberately not from `SOURCE_KINDS`.
 */
const DOCUMENTED_ITEM_FORMS: ReadonlyArray<{
  readonly form: string;
  readonly where: string;
  /** Carries a `local:` the bare form does not need, so a rewrite drops it. */
  readonly redundantPrefix?: boolean;
}> = [
  // README "Starting from an existing pack" — the items example.
  { form: '"modrinth:sodium@0.6.0"', where: "README items example" },
  { form: '"modrinth:fabric-api"', where: "README — version omitted means latest" },
  // README:71-72 — "an item you list by path is placed at that path".
  { form: '"./config/tuning.toml"', where: "README:91 — overrides a pack config" },
  { form: '"./config/sodium/mixins.json"', where: "README:71 — nesting intact" },
  { form: '"./options.txt"', where: "README:72 — stays at the instance root" },
  // README:184 (`add <ref>…`) and the parse error: "an http(s) URL".
  { form: '"https://example.com/mods/extra.jar"', where: "README:184 — a URL" },
  // ref.ts's error promises "source:id@version" generally; these are the sources
  // README names by example elsewhere.
  { form: '"curseforge:jei@1.2.3"', where: "README:73 — curseforge: items" },
  { form: '"mojang:client@26.2"', where: "ARCHITECTURE — the mojang source" },
  // The `local:` prefix. This is the only way to spell a local path that does not
  // begin with `./`, `../` or `/` — including EVERY Windows absolute path.
  // Redundant prefix: `./mods/mine.jar` is already readable bare, so the writer
  // drops the `local:`. The one form in the grammar that a rewrite does NOT
  // return byte-identical — see the dedicated case below.
  {
    form: '"local:./mods/mine.jar"',
    where: "ref.ts grammar — explicit source prefix",
    redundantPrefix: true,
  },
  { form: '"local:mods/mine.jar"', where: "ref.ts grammar — bare relative, prefix-only" },
  // parse.ts's error: 'or a { path, kind } table'.
  { form: '{ path = "./config/mymod.toml", kind = "config" }', where: "parse.ts error string" },
  { form: '{ path = "./config/mymod.toml" }', where: "parse.ts:129 — kind is optional" },
  { form: '{ path = "mods/mine.jar" }', where: "parse.ts:129 — no prefix required" },
];

const HEAD = `[project]
name = "demo"
version = "1.0.0"

[game]
minecraft = "26.2"
loader = "fabric"
`;

function manifestWith(item: string): string {
  return `${HEAD}items = [${item}]\n`;
}

describe("LB-862: every manifest anvil writes, anvil can read back", () => {
  describe("the property: parse(serialize(parse(text))) succeeds and preserves the item", () => {
    for (const { form, where } of DOCUMENTED_ITEM_FORMS) {
      it(`round-trips ${form}  (${where})`, () => {
        const once = parseManifest(manifestWith(form));
        const written = serializeManifest(once);

        // The whole defect: anvil emitting something anvil cannot read.
        let twice: ReturnType<typeof parseManifest>;
        try {
          twice = parseManifest(written);
        } catch (err) {
          const itemsLine = written.split("\n").find((l) => l.includes("items")) ?? written;
          throw new Error(
            `serializeManifest wrote a manifest parseManifest rejects.
  input form: ${form}
  written:    ${itemsLine}
  error:      ${(err as Error).message}`,
          );
        }

        // Not just "it parses" — it has to mean the same thing. A writer that
        // dropped an item entirely would satisfy a parses-clean assertion.
        expect(twice.items).toEqual(once.items);

        // And it must be a FIXED POINT: writing the re-read manifest again gives
        // the same bytes. Without this, a writer could oscillate between two
        // valid forms and rewrite the user's file on every command, forever.
        expect(serializeManifest(twice)).toBe(written);
      });
    }
  });

  describe("the authored form survives a rewrite unchanged", () => {
    // This is a SEPARATE property from round-tripping, and it exists because the
    // round-trip property cannot fail for the branch that produces it.
    //
    // `formatRef` decides between bare and prefixed by asking `parseRef` whether
    // the bare form reads back. That coupling is deliberate — it makes the
    // writer's correctness defined by the reader rather than a restatement of it
    // — but it means a round-trip test can no longer distinguish "prefers bare"
    // from "always prefixes": both round-trip. Only churn tells them apart.
    //
    // Which matters because always-prefixing is the plausible wrong turn. It is
    // correct, simpler, and would rewrite every documented `"./config/x.toml"`
    // in every user's version-controlled manifest into a form they never typed,
    // arriving from a command they ran for an unrelated reason.
    for (const { form, where, redundantPrefix } of DOCUMENTED_ITEM_FORMS) {
      if (redundantPrefix) {
        continue; // asserted on its own terms below
      }
      it(`leaves ${form} alone  (${where})`, () => {
        const written = serializeManifest(parseManifest(manifestWith(form)));
        const items = written.slice(written.indexOf("items"));

        // A `local:` prefix appears in the output only if the author wrote one.
        expect(items.includes("local:")).toBe(form.includes("local:"));

        // String items come back byte-identical; table items keep being tables
        // with the same path, rather than being flattened to a string.
        if (form.startsWith("{")) {
          const path = /path = ("[^"]*")/.exec(form)?.[1];
          expect(items).toContain(`{ path = ${path}`);
        } else {
          expect(items).toContain(form);
        }
      });
    }

    it("the one exception: a redundant `local:` on an already-readable path is dropped", () => {
      // Disclosed rather than hidden, and asserted rather than described. A
      // `ResolvedRef` records no trace of how it was spelled, so the writer
      // cannot tell `local:./mods/mine.jar` from `./mods/mine.jar` — both parse
      // to the same ref, and one output has to be chosen for both.
      //
      // Dropping the redundant prefix is a one-time, semantically identical
      // change to a single line. Keeping it would mean always prefixing, which
      // rewrites every documented bare form in every manifest instead.
      const written = serializeManifest(parseManifest(manifestWith('"local:./mods/mine.jar"')));
      const items = written.slice(written.indexOf("items"));
      expect(items).toContain('"./mods/mine.jar"');
      expect(items).not.toContain("local:");

      // Semantically identical, asserted rather than claimed — and idempotent,
      // so the churn happens once and never again.
      expect(parseManifest(written).items).toEqual(
        parseManifest(manifestWith('"local:./mods/mine.jar"')).items,
      );
      expect(serializeManifest(parseManifest(written))).toBe(written);
    });
  });

  describe("the three doors, as separate named cases", () => {
    // Each is a distinct code path. Door 3 goes through `renderItem`'s path
    // branch rather than `formatRef`, so a fix touching only `formatRef` closes
    // the first two and leaves this one open while looking complete.
    //
    // Every case asserts the FIRST parse succeeded and yielded the id it meant to
    // before asserting anything about the second. Otherwise a typo in the TOML
    // escaping fails the test at step one and reads exactly like the round-trip
    // defect — red for a reason nobody chose is the same failure as green for
    // one.

    function door(item: string, expectId: string): string {
      const first = parseManifest(manifestWith(item));
      const parsed = first.items[0];
      // The fixture landed: one item, local-sourced, holding the id under test.
      expect(first.items).toHaveLength(1);
      expect(parsed?.path ?? parsed?.ref?.id).toBe(expectId);
      expect(parsed?.path !== undefined || parsed?.ref?.source === "local").toBe(true);
      return serializeManifest(first);
    }

    it("door 1: a `local:` ref with a bare relative id", () => {
      const written = door('"local:mods/mine.jar"', "mods/mine.jar");
      expect(() => parseManifest(written)).not.toThrow(ManifestError);
    });

    it("door 2: a `local:` ref with a Windows absolute id", () => {
      // Authored on Windows via `anvil add local:C:\mods\mine.jar`. No bare form
      // of this exists — `C:\…` matches none of `./`, `../`, `/` — so the prefix
      // is not a stylistic choice here, it is the only spelling. (The doubled
      // backslashes are TOML basic-string escaping; the id asserted below is what
      // actually reached the parser.)
      const written = door('"local:C:\\\\mods\\\\mine.jar"', "C:\\mods\\mine.jar");
      expect(() => parseManifest(written)).not.toThrow(ManifestError);
    });

    it("door 3: a `{ path = … }` table with a bare relative path", () => {
      // Reachable with no Windows and no prefix anywhere: the documented table
      // form, on Linux.
      const written = door('{ path = "mods/mine.jar" }', "mods/mine.jar");
      expect(() => parseManifest(written)).not.toThrow(ManifestError);
    });
  });

  it("the reachable trigger: a rewrite that touches nothing still bricks the file", () => {
    // `anvil add` reads the manifest, appends, and rewrites the whole thing — so
    // adding an unrelated modrinth item is enough to destroy a local item that
    // was sitting there working. This asserts the weaker version: a verbatim
    // read-and-rewrite, no edit at all.
    const original = manifestWith('{ path = "mods/mine.jar" }');
    const rewritten = serializeManifest(parseManifest(original));
    expect(() => parseManifest(rewritten)).not.toThrow();
  });
});
