import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  minify: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
});