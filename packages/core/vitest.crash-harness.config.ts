import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory.
    root: resolve(import.meta.dirname, "../.."),
    // Named, not globbed: `singleton.harness.ts` needs a browser.
    include: ["packages/core/src/react-compiler.harness.ts"],
    testTimeout: 120_000,
  },
});
