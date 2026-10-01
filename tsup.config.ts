import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

/** Read at build time rather than importing JSON, which bundlers treat inconsistently. */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * The CLI bundles to a single file so `bin` needs no runtime resolution.
 * esbuild preserves the hashbang in `src/cli.ts`, so no `banner` here — adding
 * one too would emit a duplicated shebang.
 */
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  define: {
    __KICODE_VERSION__: JSON.stringify(pkg.version),
  },
});
