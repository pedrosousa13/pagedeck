import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory,
    // and finding no test files passes silently.
    root: resolve(import.meta.dirname, "../.."),
    include: ["packages/docs-site/src/a11y.harness.ts"],
    hookTimeout: 240_000,
  },
});
