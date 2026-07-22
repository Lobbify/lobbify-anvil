import { defineConfig } from "tsup";

// Two entry points ship from one package: the library (index) and the thin CLI
// bin (`lobbify-anvil`). The CLI and TUI carry no logic — they are skins over the
// Anvil class. Later stages add clipanion/ink; Stage 0 ships a minimal bin stub.
export default defineConfig({
  entry: {
    index: "index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  shims: false,
});
