import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { fileHash, readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const SITE = join(SITES, ".pagedeck-landmark-test");

const REFUSED_SITE = join(SITES, ".pagedeck-landmark-refused-test");
const ALLOWED_SITE = join(SITES, ".pagedeck-landmark-allowed-test");
const CARRIED_SITE = join(SITES, ".pagedeck-landmark-carried-test");

const MODULES: Record<string, string> = {
  "providers.js": `import { createElement } from "react";
function Wrapper({ children }) {
  return createElement("div", { "data-stack": "" }, children);
}
export default [{ component: Wrapper, props: {} }];
`,
  "Alpha.js": `"use client";
import { createElement } from "react";
export default function Alpha() {
  return createElement("p", null, "marker-alpha-4f21");
}
`,
  "Beta.js": `"use client";
import { createElement } from "react";
export default function Beta() {
  return createElement("p", null, "marker-beta-8d03");
}
`,
};

function site(root: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(MODULES)) {
    writeFileSync(join(root, "components", file), source);
  }
  const file = join(root, "content", "en", "home.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};
import providers from "./components/providers.js";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    rootProviders: { stack: providers, module: "./components/providers.js" },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Alpha: { path: "./components/Alpha.js", hydrate: "load" },
      Beta: { path: "./components/Beta.js", hydrate: "visible" },
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [{ component: "Alpha" }, { component: "Beta" }],
    }),
  },
});
`,
  );
  return root;
}

// The tag is a prop, so no module on disk holds the bytes `<main>`: a guard reading
// source would find nothing to fail on.
const ELEMENT_COMPONENT = `import { createElement } from "react";
export default function Element({ as }) {
  return createElement(as, null, "marker-element-2c47");
}
`;

function elementSite(root: string, as: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Element.js"), ELEMENT_COMPONENT);
  const file = join(root, "content", "en", "home.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
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
      Element: "./components/Element.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [{ component: "Element", props: { as: ${JSON.stringify(as)} } }],
    }),
  },
});
`,
  );
  return root;
}

async function runCode(
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

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

afterAll(() => {
  for (const root of [SITE, REFUSED_SITE, ALLOWED_SITE, CARRIED_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

let document: Promise<string> | undefined;

function built(): Promise<string> {
  document ??= (async () => {
    const dir = site(SITE);
    for (const verb of ["sync", "build"]) await run(dir, verb);
    const dist = join(dir, "dist");
    const file = join(dist, "manifest.json");
    const manifest = readManifest(readFileSync(file, "utf8"), file);
    const page = manifest.pages[0] as { html: string };
    return readFileSync(join(dist, page.html), "utf8");
  })();
  return document;
}

function count(html: string, name: string): number {
  return html.split(`<${name}`).length - 1;
}

test("a page with two islands under a provider stack emits one <main>", async () => {
  const html = await built();

  expect(count(html, "main")).toBe(1);
  expect(count(html, "div data-stack")).toBe(3);
}, 120_000);

test("the <main> wraps the page tree, immediately inside <body>", async () => {
  const html = await built();

  expect(html).toContain("<body>\n<main>\n");

  const main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  expect(main).toContain("marker-alpha-4f21");
  expect(main).toContain("marker-beta-8d03");

  expect(html.indexOf("</main>")).toBeLessThan(
    html.indexOf('<script type="module"'),
  );
}, 120_000);

test("a component rendering <main> fails the build, naming the page", async () => {
  const dir = elementSite(REFUSED_SITE, "main");
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    'Entry /en/: 2 <main> landmarks in one document — the build writes one around the page\'s whole rendered tree, so a component that renders its own nests inside it and axe reports landmark-main-is-top-level; render <section>, <div> or a fragment in the component instead (CONTEXT.md, "The <main> landmark is the framework\'s, written once per document")',
  );
}, 120_000);

test("the same component under a different tag builds, and emits one <main>", async () => {
  const dir = elementSite(ALLOWED_SITE, "section");
  for (const verb of ["sync", "build"]) await run(dir, verb);

  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const page = manifest.pages[0] as { html: string };
  const html = readFileSync(join(dist, page.html), "utf8");

  expect(count(html, "main")).toBe(1);
  expect(html).toContain("<section>marker-element-2c47</section>");
}, 120_000);

test("an incremental build refuses a carried document holding two landmarks", async () => {
  const dir = elementSite(CARRIED_SITE, "section");
  for (const verb of ["sync", "build"]) await run(dir, verb);

  // The row is rewritten too: a document disagreeing with its row is the edited-tree
  // fault, refused earlier with a different fix.
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    pages: { html: string }[];
    files: { domain?: string; path: string; hash: string; size: number }[];
  };
  const { html } = manifest.pages[0] as { html: string };
  const document = join(dist, html);
  const carried = readFileSync(document, "utf8")
    .replace("<section>", "<main>")
    .replace("</section>", "</main>");
  writeFileSync(document, carried);
  const row = manifest.files.find(
    (candidate) => candidate.domain === undefined && candidate.path === html,
  ) as { hash: string; size: number };
  row.hash = fileHash(carried);
  row.size = Buffer.byteLength(carried);
  writeFileSync(file, JSON.stringify(manifest));

  const { code, err } = await runCode(dir, "build", "--incremental");

  expect(code).toBe(EXIT_CODES.configError);
  expect(err).toContain("cannot be carried from the previous build");
  expect(err).toContain(
    '"/index.html" — en /\'s document, and it holds 2 <main> landmarks — the bytes are the ones the previous build recorded, so that build wrote them before this one refused a second landmark; render <section>, <div> or a fragment where the component renders <main> (CONTEXT.md, "The <main> landmark is the framework\'s, written once per document")',
  );
}, 240_000);
