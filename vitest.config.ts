import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // LB-829 — vitest's 5000ms default is too tight for THIS SUITE ON WINDOWS CI,
    // and the reason is the runner, not the tests.
    //
    // Measured, same unchanged suite, three `windows-latest` samples: total test
    // phase 50.61s / 102.19s / 122.76s. That is 2.4x from runner variance alone,
    // and on one run Node 22 beat its own Node 20 sibling (50.61s vs 68.76s), so
    // it is not a Node-version cost either. Plenty of this suite's tests build real
    // packs and move real objects, so a fair number sit near 5s at the slow end of
    // that spread — and which ones tip is the draw. Four different files have
    // failed across three runs: vc/merge, import/mrpack, remote/clone-pull, and
    // build/crash. Raising them one at a time was chasing a moving target.
    //
    // The cost of this raise is real and is the reason it is 15s rather than 60:
    // a genuinely hung test now takes 15s to fail, on every local run, on the
    // platform where most development happens. Fifteen seconds clears the observed
    // Windows spread with margin while keeping a hang cheap to notice.
    //
    // The per-file `vi.setConfig({ testTimeout: 20_000 })` overrides on the three
    // heaviest files are deliberately KEPT. They say "this file is genuinely
    // heavy"; this default says "the platform is unpredictable". Collapsing them
    // into one number would lose that distinction.
    testTimeout: 15_000,
    // clipanion 3.x ships `.mjs` with extensionless directory imports that Node's
    // native ESM loader rejects; inlining routes it through vite/esbuild (which
    // resolves them), matching how the shipped bundle consumes it via tsup.
    server: { deps: { inline: ["clipanion"] } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "index.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
