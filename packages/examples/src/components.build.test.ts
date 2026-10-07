// A browser build does not refuse `node:crypto`: vite stubs it, so the failure is silent.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-components-build-test/", import.meta.url),
);

// Written under `node_modules` at test time, so bare specifiers resolve as a consumer's do.
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
      // Minified, so the assertions read the module graph and not comments that name the same
      // modules.
      minify: "esbuild",
      lib: { entry, formats: ["es"], fileName: () => "out.js" },
      rollupOptions: { external: ["react", "react-dom", "react-dom/client"] },
    },
  });
  return readFileSync(new URL("out.js", `file://${out}`), "utf8");
}

let components = "";
let control = "";

beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}Control.js`, CONTROL_SOURCE);
  components = await bundle(
    fileURLToPath(new URL("./site-components.tsx", import.meta.url)),
    `${OUT_DIR}components/`,
  );
  control = await bundle(`${OUT_DIR}Control.js`, `${OUT_DIR}control/`);
}, 120_000);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
});

test("the registered components bundle for a browser", () => {
  // It built, and the components are in it: an empty bundle would pass the assertions below.
  expect(components).toContain("tagline");
  expect(components).toContain("add");
  for (const server of SERVER_ONLY) {
    expect(components).not.toContain(server);
  }
});

test("a component reaching @pagedeck/core's index does not", () => {
  // The control: `@pagedeck/core`'s index reaches `node:` builtins, so this bundle must be dirty.
  expect(SERVER_ONLY.some((server) => control.includes(server))).toBe(true);
});
