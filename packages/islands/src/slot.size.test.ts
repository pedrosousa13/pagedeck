import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { build } from "vite";

const SLOT_ENTRY = fileURLToPath(new URL("./slot.ts", import.meta.url));

const RUNTIME_ENTRY = fileURLToPath(new URL("./runtime.ts", import.meta.url));

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-slot-size-test/", import.meta.url),
);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

const BUDGET = 1280;

async function bundle(entry: string): Promise<void> {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: "esbuild",
      lib: { entry, formats: ["es"], fileName: () => "out.js" },
      rollupOptions: { external: ["react", "react-dom/client"] },
    },
  });
}

function brotliBytes(): number {
  return brotliCompressSync(readFileSync(new URL("out.js", `file://${OUT_DIR}`)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;
}

test("the slot module fits its own ceiling with React external", async () => {
  await bundle(SLOT_ENTRY);

  expect(brotliBytes()).toBeLessThanOrEqual(BUDGET);
});

test("a page with no container island loads none of the slot module", async () => {
  await bundle(RUNTIME_ENTRY);

  // A static import of the slot module would fold this string into the entry.
  expect(readFileSync(new URL("out.js", `file://${OUT_DIR}`), "utf8")).not.toContain(
    "dangerouslySetInnerHTML",
  );
});
