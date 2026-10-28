import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { build } from "vite";

const ISLAND_ERRORS_ENTRY = fileURLToPath(
  new URL("./island-errors.ts", import.meta.url),
);

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-island-errors-size-test/", import.meta.url),
);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

const BUDGET = 640;

test("the island error reporting module fits its own ceiling with React external", async () => {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: "esbuild",
      lib: {
        entry: ISLAND_ERRORS_ENTRY,
        formats: ["es"],
        fileName: () => "island-errors.js",
      },
      rollupOptions: { external: ["react", "react-dom/client"] },
    },
  });

  const bundle = readFileSync(new URL("island-errors.js", `file://${OUT_DIR}`));
  const size = brotliCompressSync(bundle, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;

  expect(size).toBeLessThanOrEqual(BUDGET);
});
