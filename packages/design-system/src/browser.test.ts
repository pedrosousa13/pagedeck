import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";
import { PACKAGE_NAME, catalog } from "./catalog.js";

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-design-system-build-test/", import.meta.url),
);

const resolve = createRequire(import.meta.url).resolve;

// Absolute paths: an entry written under `node_modules` sits outside the package
// scope a self-reference resolves from.
const ENTRY_SOURCE = `${Object.entries(catalog)
  .map(
    ([name, entry]) =>
      `export { default as ${name} } from ${JSON.stringify(resolve(entry.module))};`,
  )
  .join("\n")}\n`;

const CONTROL_SOURCE = `
import { renderPage } from "@pagedeck/core";
export default function Control() {
  return typeof renderPage;
}
`;

const SERVER_ONLY = [
  "node:crypto",
  "node:fs",
  "node:path",
  "node:sqlite",
  "node:worker_threads",
  "react-dom/static",
];

async function bundle(entry: string, out: string): Promise<string> {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: out,
      emptyOutDir: true,
      // Minified, so the assertions read the module graph and not comments that name
      // the same modules.
      minify: "esbuild",
      lib: { entry, formats: ["es"], fileName: () => "out.js" },
      rollupOptions: {
        external: [
          "react",
          "react-dom",
          "react-dom/client",
          "react/jsx-runtime",
        ],
      },
    },
  });
  // Every chunk: catalog rows are dynamic imports, so components land in chunks of
  // their own.
  return readdirSync(out)
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(new URL(file, `file://${out}`), "utf8"))
    .join("\n");
}

let catalogBundle = "";
let packageBundle = "";
let control = "";

beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}entry.js`, ENTRY_SOURCE);
  writeFileSync(`${OUT_DIR}Control.js`, CONTROL_SOURCE);
  catalogBundle = await bundle(`${OUT_DIR}entry.js`, `${OUT_DIR}catalog/`);
  packageBundle = await bundle(resolve(PACKAGE_NAME), `${OUT_DIR}package/`);
  control = await bundle(`${OUT_DIR}Control.js`, `${OUT_DIR}control/`);
}, 120_000);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

test("every registered component bundles for a browser", () => {
  expect(catalogBundle).toContain("pricing__toggle");
  expect(catalogBundle).toContain("landing__signup");
  expect(catalogBundle).toContain("sm:grid-cols-3");
  for (const server of SERVER_ONLY) {
    expect(catalogBundle).not.toContain(server);
  }
  expect(catalogBundle).not.toContain("test-support");
});

test("the package's own entry point bundles for a browser too", () => {
  expect(packageBundle).toContain(`"${PACKAGE_NAME}"`);
  expect(packageBundle).toContain("pricing__toggle");
  for (const server of SERVER_ONLY) {
    expect(packageBundle).not.toContain(server);
  }
  expect(packageBundle).not.toContain("test-support");
});

test("a component reaching @pagedeck/core's index does not", () => {
  expect(SERVER_ONLY.some((server) => control.includes(server))).toBe(true);
});
