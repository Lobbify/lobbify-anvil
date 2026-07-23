import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
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
