import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

const OUT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-preview-bundle-test/", import.meta.url),
);

// Written under `node_modules` at test time, so bare specifiers resolve as a consumer's do.
const COMPONENT_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-component-bundle-test/", import.meta.url),
);

const COMPONENT_SOURCE = `
import { createElement } from "react";
import { unescapedHtml, useBuildData, useLocale } from "@pagedeck/core/tree";

export default function RichText({ body, key }) {
  const { direction } = useLocale();
  const built = useBuildData(key);
  return createElement("div", {
    dir: direction,
    "data-built": String(built),
    ...unescapedHtml(body),
  });
}
`;

beforeAll(async () => {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      // Minified, so the assertions read the module graph and not comments that name the same
      // modules.
      minify: "esbuild",
      lib: { entry: ENTRY, formats: ["es"], fileName: () => "out.js" },
      rollupOptions: { external: ["react", "react-dom", "react-dom/client"] },
    },
  });

  mkdirSync(COMPONENT_DIR, { recursive: true });
  writeFileSync(`${COMPONENT_DIR}RichText.js`, COMPONENT_SOURCE);
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: `${COMPONENT_DIR}dist/`,
      emptyOutDir: true,
      minify: "esbuild",
      lib: {
        entry: `${COMPONENT_DIR}RichText.js`,
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: { external: ["react"] },
    },
  });
}, 60_000);

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true });
  rmSync(COMPONENT_DIR, { recursive: true, force: true });
});

function bundled(): string {
  return readFileSync(new URL("out.js", `file://${OUT_DIR}`), "utf8");
}

function bundledComponent(): string {
  return readFileSync(new URL("out.js", `file://${COMPONENT_DIR}dist/`), "utf8");
}

const SERVER_ONLY = [
  "node:crypto",
  "node:fs",
  "node:path",
  "node:sqlite",
  "node:worker_threads",
  "react-dom/static",
  "vite",
];

test("the preview app bundles with only React external", () => {
  // It built at all: a `node:` builtin reached through the render core would have failed it.
  expect(bundled()).toContain("mountPreview");
});

test("it reaches no node builtin", () => {
  for (const builtin of [
    "node:crypto",
    "node:fs",
    "node:path",
    "node:sqlite",
    "node:worker_threads",
  ]) {
    expect(bundled()).not.toContain(builtin);
  }
});

test("it reaches neither the static renderer nor the bundler", () => {
  expect(bundled()).not.toContain("react-dom/static");
  expect(bundled()).not.toContain("vite");
});

test("a component importing @pagedeck/core/tree bundles for a browser", () => {
  expect(bundledComponent()).toContain("useContext");
  for (const server of SERVER_ONLY) {
    expect(bundledComponent()).not.toContain(server);
  }
});

test("it carries the mark a production build is searched for", () => {
  // The needle `preview-build.test.ts` searches production chunks for is really in preview's bytes.
  expect(bundled()).toContain("fw-preview-build-target");
});
