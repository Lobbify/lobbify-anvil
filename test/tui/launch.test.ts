import { afterEach, describe, expect, it } from "vitest";
import { type OfflineCli, makeOfflineCli } from "../helpers/cli.js";
import { mkTmp, rmTmp } from "../helpers/fixtures.js";
import { FABRIC_LOADER, MC } from "../helpers/game.js";

/** Matches an ANSI SGR (color/style) escape sequence (ESC-anchored). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);

/**
 * End-to-end: `lobbify-anvil` with NO command opens the TUI. Under the captured
 * (non-TTY) streams the offline harness uses, it must degrade to the plain,
 * ANSI-free dashboard and exit 0 — the CI/pipe path.
 */
describe("tui launch: no-command opens the TUI (plain fallback under non-TTY)", () => {
  const dirs: string[] = [];
  let cli: OfflineCli;
  let cwd: string;

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rmTmp(d);
    }
  });

  async function setup(): Promise<void> {
    cwd = await mkTmp("tui-launch");
    const store = await mkTmp("tui-launch-store");
    dirs.push(cwd, store);
    cli = makeOfflineCli({ cwd, storeDir: store });
  }

  it("prints a greppable dashboard with no ANSI escapes", async () => {
    await setup();
    // Before init: the dashboard reports the un-initialized state.
    const empty = await cli.run([]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("lobbify-anvil");
    expect(empty.stdout).toContain("no anvil.toml");
    expect(empty.stdout).not.toMatch(ANSI);

    // After init + lock: the dashboard lists the game base + items, still plain.
    await cli.run(["init", "--name", "p", "--mc", MC, "--loader", `fabric ${FABRIC_LOADER}`]);
    await cli.run(["add", "modrinth:sodium"]);
    cli.modrinth.add({
      id: "SODIUM",
      slug: "sodium",
      title: "sodium",
      projectType: "mod",
      versions: [
        {
          id: "sodium-v1",
          projectId: "SODIUM",
          versionNumber: "0.6.0",
          datePublished: "2026-06-01T00:00:00Z",
          loaders: ["fabric"],
          gameVersions: [MC],
          filename: "sodium-0.6.0.jar",
          bytes: new TextEncoder().encode("sodium-jar"),
        },
      ],
    });
    await cli.run(["lock"]);

    const dash = await cli.run([]);
    expect(dash.code).toBe(0);
    expect(dash.stdout).toContain(`Minecraft ${MC}`);
    expect(dash.stdout).toContain("[mod]");
    expect(dash.stdout).toContain("sodium");
    expect(dash.stdout).not.toMatch(ANSI);
  });
});
