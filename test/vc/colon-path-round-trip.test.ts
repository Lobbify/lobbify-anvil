/**
 * LB-827 round 2 — the blocker round 1 introduced and this round fixes: `safeJoin`
 * made the `:`-segment (NTFS Alternate Data Stream) rejection unconditional, and
 * `safeJoin` is not only the pack/placement gate. VC checkout
 * (`src/vc/snapshot.ts`) resolves the user's own already-committed `tracked`/
 * `carried` files through it too. A colon is an ordinary, legal POSIX filename
 * character, so a real file a POSIX user created and committed
 * (`config/server:25565.toml`) has to round-trip through `commit`/`switch` exactly
 * like any other tracked file — round 1 made that commit permanently unreachable
 * instead (measured on the branch: the file committed fine, then `switch` back to
 * that commit threw `PathEscape` at `safeJoin`, half-applying the checkout while
 * `status()` still reported clean).
 *
 * This file proves the fix the way the ticket asks: write the file, commit,
 * mutate, switch back, and assert it is restored byte-identical — for real,
 * through the actual `Anvil` VC methods, not a unit call into `safeJoin` alone
 * (that unit-level proof lives in
 * `test/security/local-placement-traversal.test.ts`, in the "DEFAULT (no
 * rejectColon)" case — this file is the end-to-end guarantee that the default
 * is what VC checkout actually gets).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathExists } from "../../src/internal/fs.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { makeVcFixture, manifest, modWorld, version } from "../helpers/vc.js";

function world(): ReturnType<typeof modWorld> {
  return modWorld([
    { slug: "alpha", id: "ALPHA", versions: [version("ALPHA", "1.0.0", ["26.2"])] },
  ]);
}

/** Write a file, creating its parent directories (mirrors worktree-tracking.test.ts). */
async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/**
 * POSIX-only, and the reason is the same mechanism the whole ticket is about.
 *
 * Every case here writes a real file whose name contains a `:`. That is an
 * ordinary legal filename on Linux and macOS, and on NTFS it is not a filename
 * at all — the write is redirected into an Alternate Data Stream, so the file
 * cannot be created, committed, or read back as a regular file. CI proved it:
 * both windows jobs failed with
 * `ENOENT open C:\...\config\sub\name:stream.txt` plus two restore assertions,
 * while ubuntu and macos passed.
 *
 * ⚠️ Skipping is not a workaround for a flaky test — the scenario is
 * unrepresentable on Windows. And that is itself the answer to the question
 * this file exists to ask: the regression it guards against (a user's own
 * colon-named file committing fine and then never restoring) **cannot occur on
 * Windows**, because such a file can never be committed there in the first
 * place. The guarantee is only meaningful where the filename is legal, which is
 * exactly where it still runs.
 */
describe.skipIf(process.platform === "win32")(
  "VC round-trip over a colon-bearing file (LB-827 round 2)",
  () => {
    const dirs: string[] = [];
    afterEach(async () => {
      for (const d of dirs) {
        await rmTmp(d);
      }
      dirs.length = 0;
    });

    it("commits a ':'-bearing file, mutates it, and switch restores the ORIGINAL bytes exactly", async () => {
      const fx = await makeVcFixture(world());
      dirs.push(fx.dir, fx.storeDir);
      const anvil = fx.anvil();
      await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

      // A real, legal POSIX filename a Linux/macOS user could actually have —
      // exactly the shape from the ticket's own repro.
      const colonFile = join(fx.dir, "config", "server:25565.toml");
      await put(colonFile, "PORT=25565");
      const c1 = await anvil.commit("c1: add config/server:25565.toml");

      // Mutate it (still tracked, new content) and commit again — this is the
      // ticket's literal sequence: write -> commit -> mutate -> switch back.
      await writeFile(colonFile, "PORT=25566");
      await anvil.commit("c2: bump the port");
      expect(await readFile(colonFile, "utf8")).toBe("PORT=25566");

      // The regressed behavior: this threw PathEscape at safeJoin (fs.ts:150 in
      // round 1) instead of restoring. It must not throw, and it must restore the
      // ORIGINAL bytes exactly — not the mutated ones, not an empty/partial file.
      await expect(anvil.switch(c1.id.value)).resolves.not.toThrow();
      expect(await readFile(colonFile, "utf8")).toBe("PORT=25565");

      // And forward again — a real restore, not a one-way accident.
      await anvil.switch("main");
      expect(await readFile(colonFile, "utf8")).toBe("PORT=25566");

      // No phantom dirtiness after a clean round trip.
      expect((await anvil.status()).worktreeDirty).toBe(false);
    });

    it("restores a ':'-bearing file across ADD -> DELETE -> switch back, byte-identical", async () => {
      const fx = await makeVcFixture(world());
      dirs.push(fx.dir, fx.storeDir);
      const anvil = fx.anvil();
      await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

      const colonFile = join(fx.dir, "config", "sub", "name:stream.txt");
      const c0 = await anvil.commit("c0: baseline, no colon file yet");

      await put(colonFile, "ORIGINAL-BYTES");
      const c1 = await anvil.commit("c1: add the colon file");
      expect(await pathExists(colonFile)).toBe(true);

      // Switching to the commit before it existed removes it cleanly (no throw).
      await expect(anvil.switch(c0.id.value)).resolves.not.toThrow();
      expect(await pathExists(colonFile)).toBe(false);

      // And switching forward re-creates it with the exact original bytes.
      await anvil.switch(c1.id.value);
      expect(await readFile(colonFile, "utf8")).toBe("ORIGINAL-BYTES");
    });

    it("a top-level colon filename that merely resembles a protected name still round-trips", async () => {
      // Not `saves/` (a directory, protected) — a top-level FILE literally named
      // "saves:backup.txt". isProtectedTop folds this to "saves:backup.txt" !==
      // "saves", so it was never protected in the first place; this only proves
      // the colon guard itself (now scoped to pack-controlled callers) does not
      // also start rejecting it on the VC-checkout path by accident.
      const fx = await makeVcFixture(world());
      dirs.push(fx.dir, fx.storeDir);
      const anvil = fx.anvil();
      await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

      const oddTopLevel = join(fx.dir, "saves:backup.txt");
      await writeFile(oddTopLevel, "NOT-A-WORLD-JUST-A-WEIRD-NAME");
      const c1 = await anvil.commit("c1: add the odd top-level file");

      await writeFile(oddTopLevel, "CHANGED");
      await anvil.commit("c2: change it");

      await anvil.switch(c1.id.value);
      expect(await readFile(oddTopLevel, "utf8")).toBe("NOT-A-WORLD-JUST-A-WEIRD-NAME");
    });

    it("a real saves/ world is still never touched while a sibling colon file round-trips", async () => {
      // Belt-and-suspenders: proves the widened default doesn't also widen the
      // separate, still-enforced protected-top guard (allowProtected is untouched
      // by this ticket).
      const fx = await makeVcFixture(world());
      dirs.push(fx.dir, fx.storeDir);
      const anvil = fx.anvil();
      await fx.writeLockFor(manifest({ minecraft: "26.2", items: ["modrinth:alpha"] }));

      const level = join(fx.dir, "saves", "myworld", "level.dat");
      await put(level, "PRECIOUS-WORLD-BYTES");
      const colonFile = join(fx.dir, "config", "server:25565.toml");
      await put(colonFile, "PORT=25565");
      const c1 = await anvil.commit("c1: world + colon config");

      await writeFile(colonFile, "PORT=25566");
      await anvil.commit("c2: bump the port");

      await anvil.switch(c1.id.value);
      expect(await readFile(colonFile, "utf8")).toBe("PORT=25565");
      // saves/ was never a VC target to begin with — it must be exactly untouched.
      expect(await readFile(level, "utf8")).toBe("PRECIOUS-WORLD-BYTES");
    });
  },
);
