import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { build } from "vite";

const RUNTIME_ENTRY = fileURLToPath(new URL("./runtime.ts", import.meta.url));

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-size-test/", import.meta.url),
);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

const BUDGET = 2048;

test("the islands runtime fits in 2 kB Brotli with React external", async () => {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: "esbuild",
      lib: {
        entry: RUNTIME_ENTRY,
        formats: ["es"],
        fileName: () => "runtime.js",
      },
      rollupOptions: { external: ["react", "react-dom/client"] },
    },
  });

  const bundle = readFileSync(new URL("runtime.js", `file://${OUT_DIR}`));
  const size = brotliCompressSync(bundle, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;

  expect(size).toBeLessThanOrEqual(BUDGET);
});
