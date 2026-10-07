import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { budgetReportPath } from "./budgets.js";
import type { BudgetReport } from "./budgets.js";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const BY_LAYOUT = join(SITES, ".pagedeck-layout-by-layout-test");
const BY_CALLBACK = join(SITES, ".pagedeck-layout-by-callback-test");
const UNREGISTERED = join(SITES, ".pagedeck-layout-unregistered-test");
const MIXED = join(SITES, ".pagedeck-layout-mixed-test");

const COUNTER_MARKER = "marker-counter-5e21";

const COMPONENTS: Record<string, string> = {
  "Layout.js": `import { createElement } from "react";
export default function Layout({ title, html, children }) {
  return createElement("article", null,
    createElement("h1", null, title),
    createElement("div", { dangerouslySetInnerHTML: { __html: html } }),
    children,
  );
}
`,
  "Counter.js": `"use client";\nexport default function Counter() { return "${COUNTER_MARKER}"; }\n`,
};

const ENTRIES: Record<string, unknown> = {
  index: { title: "Home", html: "<p>home</p>", frontmatter: {} },
  about: { title: "About", html: "<p>about</p>", frontmatter: {} },
  counter: {
    title: "Counter",
    html: "<p>counter</p>",
    frontmatter: { components: ["Counter"] },
  },
};

const imports = (root: string): string => `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { fromCollection, fromTemplate } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

const components = { Layout: "./components/Layout.js", Counter: "./components/Counter.js" };
`;

const LAYOUT_CONFIG = `
export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "Layout" })],
    components,
    budget: { "/**": "1mb" },
  },
});
`;

const MIXED_CONFIG = `
export default defineConfig({
  collections: [pages],
  build: {
    pages: [
      fromCollection(pages, { layout: "Layout" }),
      fromTemplate("/list", () => [{ locale: "en", params: {}, dependencies: [] }]),
    ],
    components,
    content: (page) => {
      (globalThis.__pagedeckLayoutCalls ??= []).push(page.path);
      return { tree: [{ component: "Layout", props: { title: "List", html: "<p>from the callback</p>" } }] };
    },
  },
});
`;

const CALLBACK_CONFIG = `
export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages)],
    components,
    budget: { "/**": "1mb" },
    content: (page, store) => {
      const { title, html, frontmatter } = store.getEntry("pages", page.entry.locale, page.entry.path).data;
      const children = (frontmatter.components ?? []).map((component) => ({ component }));
      return { tree: [{ component: "Layout", props: { title, html }, children }] };
    },
  },
});
`;

function writeSite(
  root: string,
  config: string,
  entries: Record<string, unknown>,
): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, data] of Object.entries(entries)) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
  }
  writeFileSync(join(root, "pagedeck.config.ts"), `${imports(root)}${config}`);
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

async function build(root: string): Promise<void> {
  for (const verb of ["sync", "build"]) {
    const { code, err } = await run(root, verb);
    if (code !== EXIT_CODES.success) throw new Error(err);
  }
}

afterAll(() => {
  for (const root of [BY_LAYOUT, BY_CALLBACK, UNREGISTERED, MIXED]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a collection rendered into a layout builds the site a content callback building the same tree builds", async () => {
  writeSite(BY_LAYOUT, LAYOUT_CONFIG, ENTRIES);
  writeSite(BY_CALLBACK, CALLBACK_CONFIG, ENTRIES);
  await build(BY_LAYOUT);
  await build(BY_CALLBACK);

  expect(
    diffOutputTrees(join(BY_CALLBACK, "site"), join(BY_LAYOUT, "site")),
  ).toEqual([]);
  expect(readFileSync(join(BY_LAYOUT, "site", "about", "index.html"), "utf8"))
    .toContain("<h1>About</h1><div><p>about</p></div>");
}, 180_000);

test("an island a frontmatter list places ships to its own page and to no other", async () => {
  writeSite(BY_LAYOUT, LAYOUT_CONFIG, ENTRIES);
  await build(BY_LAYOUT);

  const report = JSON.parse(
    readFileSync(budgetReportPath(BY_LAYOUT), "utf8"),
  ) as BudgetReport;
  const spend = Object.fromEntries(
    report.pages.map((page) => [page.path, page]),
  );
  expect(Object.keys(spend).sort()).toEqual(["/", "/about/", "/counter/"]);
  expect([spend["/"]?.actual, spend["/about/"]?.actual]).toEqual([0, 0]);
  const counter = (spend["/counter/"]?.chunks ?? []).filter(({ path }) =>
    readFileSync(join(BY_LAYOUT, "site", path), "utf8").includes(COUNTER_MARKER),
  );
  expect(counter).toHaveLength(1);
  expect(
    readFileSync(join(BY_LAYOUT, "site", "counter", "index.html"), "utf8"),
  ).toMatch(/<fw-island\b[^>]*data-fw-component="Counter"/);
}, 180_000);

test("a build whose entries name unregistered components or lack html fails as content, with every fault named", async () => {
  writeSite(UNREGISTERED, LAYOUT_CONFIG, {
    ...ENTRIES,
    broken: { title: "Broken", frontmatter: {} },
    sneaky: {
      title: "Sneaky",
      html: "",
      frontmatter: { components: ["./components/Counter.js", "@scope/pkg"] },
    },
  });

  expect((await run(UNREGISTERED, "sync")).code).toBe(EXIT_CODES.success);
  const { code, err } = await run(UNREGISTERED, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    `Collection "pages": 1 entry does not have the shape a layout renders — give each a string title and html, and a list at frontmatter.components if it has one, as the markdown loader writes them, or render the collection through a content callback instead:
  /en/broken — html is not a string`,
  );
  expect(err).toContain(
    `Collection "pages": 1 entry names components at frontmatter.components that build.components does not register — name only registered components, which are "Counter", "Layout":
  /en/sneaky — "./components/Counter.js", "@scope/pkg"`,
  );
}, 180_000);

test("a content callback beside a layout renders only the pages whose source names no layout", async () => {
  const calls: string[] = [];
  (globalThis as { __pagedeckLayoutCalls?: string[] }).__pagedeckLayoutCalls =
    calls;
  writeSite(MIXED, MIXED_CONFIG, ENTRIES);
  try {
    await build(MIXED);
  } finally {
    delete (globalThis as { __pagedeckLayoutCalls?: string[] })
      .__pagedeckLayoutCalls;
  }

  expect(calls).toEqual(["/list/"]);
  const page = (path: string): string =>
    readFileSync(join(MIXED, "site", path, "index.html"), "utf8");
  expect(page("list")).toContain("<p>from the callback</p>");
  expect(page("about")).toContain("<h1>About</h1><div><p>about</p></div>");
  expect(page("counter")).toMatch(/<fw-island\b[^>]*data-fw-component="Counter"/);
}, 180_000);
