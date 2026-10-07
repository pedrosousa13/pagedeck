import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vitest/config";

const plugins: Plugin[] = [];
if (process.env.PAGEDECK_REACT_COMPILER === "1") {
  const { compileIslands } = await import("../core/src/react-compiler.js");
  // The cast is version skew only: `vitest/config` types vite 7's `Plugin` and
  // the workspace is on vite 8.
  plugins.push(compileIslands().plugin as Plugin);
}

export default defineConfig({
  plugins,
  test: {
    // Absolute: Vitest resolves a relative `root` against the working directory,
    // and finding no test files passes silently.
    root: resolve(import.meta.dirname, "../.."),
    include: ["packages/islands/src/**/*.harness.tsx"],
  },
});
