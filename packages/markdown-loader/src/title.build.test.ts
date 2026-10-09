import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");
// Inside the package, so the site resolves `@pagedeck/*` and React from its node_modules.
const SITE = mkdtempSync(join(PACKAGE, ".pagedeck-title-build-test-"));

const FILES: Readonly<Record<string, string>> = {
  "pagedeck.config.ts": `import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { defineConfig, fromCollection } from "@pagedeck/core";

const pages = defineCollection({
  name: "pages",
  loader: defineMarkdownLoader({ root: "./content", locale: "en", languages: [] }),
  schema: false,
});

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "layout" })],
    components: { layout: "./components/layout.js" },
  },
});
`,
  "components/layout.js": `import { createElement, Fragment } from "react";

export default function Layout({ title, html }) {
  return createElement(
    Fragment,
    null,
    createElement("title", null, title),
    createElement("div", { dangerouslySetInnerHTML: { __html: html } }),
  );
}
`,
  "content/index.md": "# Tom &amp; Jerry\n\nA page.\n",
};

beforeAll(async () => {
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(SITE, path, ".."), { recursive: true });
    writeFileSync(join(SITE, path), text);
  }
  for (const verb of ["sync", "build"]) {
    await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
  }
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a character reference in a page's heading reaches <title> escaped once (#101)", () => {
  const html = readFileSync(join(SITE, "site", "index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain("<title>Tom &amp; Jerry</title>");
  expect(html).not.toContain("&amp;amp;");
});
