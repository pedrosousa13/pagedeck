import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory,
    // and finding no test files passes silently.
    root: resolve(import.meta.dirname, "../.."),
    include: ["packages/islands/src/**/*.harness.ts"],
    testTimeout: 120_000,
    // Skips only Playwright's package-database check, which WebKit's hand-supplied
    // libraries fail here; a missing library still fails at launch.
    env: { PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1" },
  },
});
