import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

/** Read at build time rather than importing JSON, which bundlers treat inconsistently. */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/**
 * The CLI bundles to a single file so `bin` needs no runtime resolution.
 * esbuild preserves the hashbang in `src/cli.ts`, so no `banner` here — adding
 * one too would emit a duplicated shebang.
 *
 * The published artifact is minified with comments stripped: the package is
 * distributed under a proprietary license, so the shipped bundle should not
 * read as the source it was built from. Minification raises that bar; it is not
 * a secret, and the license is what actually prohibits copying.
 */
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  minify: true,
  sourcemap: false,
  esbuildOptions(options) {
    // Drop any `@license`/`@preserve` banners too, so a shipped bundle carries
    // no comments at all. (Minify already strips ordinary ones.)
    options.legalComments = "none";
  },
  define: {
    __KICODE_VERSION__: JSON.stringify(pkg.version),
  },
});
