import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import root from "../../vitest.config.js";

export default defineConfig({
  resolve: root.resolve,
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory, and
    // "no test files found" passes silently.
    root: resolve(import.meta.dirname, "../.."),
    include: ["packages/site/src/origin.harness.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
