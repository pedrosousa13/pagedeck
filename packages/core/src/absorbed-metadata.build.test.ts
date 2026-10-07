import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Alpha.js": `"use client";
import { createElement } from "react";
export default function Alpha({ title }) {
  return createElement(
    "div",
    null,
    createElement("title", null, title),
    createElement("meta", { name: "description", content: "desc-from-alpha" }),
    createElement("meta", { itemProp: "position", content: "1" }),
    "marker-alpha-1d47",
  );
}
`,
  "Beta.js": `"use client";
import { createElement } from "react";
export default function Beta({ title }) {
  return createElement(
    "div",
    null,
    createElement("title", null, title),
    "marker-beta-6b02",
  );
}
`,
};

const ABSORB_SITE = join(SITES, ".pagedeck-absorbed-head-test");
const CONFLICT_SITE = join(SITES, ".pagedeck-absorbed-head-conflict-test");

function site(root: string, titles: readonly [string, string]): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  const file = join(root, "content", "en", "home.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}`, `${JSON.stringify({ rev: 1, data: {} })}\n`);

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: () => "landing",
    byTemplate: { landing: [...usage("Alpha"), ...usage("Beta")] },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Alpha: { path: "./components/Alpha.js", hydrate: "visible" },
      Beta: { path: "./components/Beta.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [
        { component: "Alpha", props: { title: ${JSON.stringify(titles[0])} } },
        { component: "Beta", props: { title: ${JSON.stringify(titles[1])} } },
      ],
    }),
  },
});
`,
  );
  return root;
}

async function run(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; err: string }> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  return { code, err: err.join("\n") };
}

afterAll(() => {
  for (const root of [ABSORB_SITE, CONFLICT_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

let document: Promise<string> | undefined;

function absorbed(): Promise<string> {
  document ??= (async () => {
    const dir = site(ABSORB_SITE, ["one true title", "one true title"]);
    for (const verb of ["sync", "build"]) {
      const { code, err } = await run(dir, verb);
      if (code !== EXIT_CODES.success) throw new Error(err);
    }
    const dist = join(dir, "dist");
    const file = join(dist, "manifest.json");
    const manifest = readManifest(readFileSync(file, "utf8"), file);
    const page = manifest.pages[0] as { html: string };
    return readFileSync(join(dist, page.html), "utf8");
  })();
  return document;
}

function halves(html: string): { head: string; body: string } {
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  return { head, body: html.slice(html.indexOf("<body>")) };
}

function count(html: string, name: string): number {
  return html.split(`<${name}`).length - 1;
}

test("two islands claiming one title emit one <title>, in the head", async () => {
  const { head, body } = halves(await absorbed());

  expect(count(head, "title")).toBe(1);
  expect(head).toContain("<title>one true title</title>");
  expect(count(body, "title")).toBe(0);
}, 120_000);

test("an island's <meta> is absorbed into the head, once", async () => {
  const { head, body } = halves(await absorbed());

  expect(count(head, "meta")).toBe(2);
  expect(head).toContain(
    '<meta name="description" content="desc-from-alpha"/>',
  );
  expect(count(body, "meta")).toBe(1);
  expect(body).toContain('<div><meta itemProp="position" content="1"/>marker-alpha-1d47</div>');
}, 120_000);

test("the islands still hydrate around the metadata that left them", async () => {
  const { body } = halves(await absorbed());

  expect(body).toContain("marker-alpha-1d47");
  expect(body).toContain("marker-beta-6b02");
  expect(count(body, "fw-island")).toBe(2);
}, 120_000);

test("two islands claiming one title differently fail the build", async () => {
  const dir = site(CONFLICT_SITE, ["title-from-alpha", "title-from-beta"]);
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const { code, err } = await run(dir, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    "Entry /en/: 2 claims on <title> disagree — a document holds one <title>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:\n" +
      '  "Alpha" — "title-from-alpha"\n' +
      '  "Beta" — "title-from-beta"',
  );
}, 120_000);
