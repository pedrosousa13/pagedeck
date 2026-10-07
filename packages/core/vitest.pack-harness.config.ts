import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory.
    root: resolve(import.meta.dirname, "../.."),
    include: ["packages/core/src/pack.harness.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
