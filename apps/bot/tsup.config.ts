import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/register-commands.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: ["@hostbot/shared"],
});
