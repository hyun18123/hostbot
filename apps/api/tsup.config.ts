import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // @hostbot/shared ships TypeScript source, so it must be bundled into the
  // production build instead of being resolved at runtime.
  noExternal: ["@hostbot/shared"],
});
