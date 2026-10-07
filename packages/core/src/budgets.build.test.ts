import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { budgetReportPath, islandPropsLimit } from "./budgets.js";
import type { BudgetReport } from "./budgets.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-9c14"; }\n`,
  "Widget.js": `import "./Widget.css";\nexport default function Widget() { return "marker-widget-5ab7"; }\n`,
  "Widget.css": `.fw-widget { color: rgb(1, 2, 3); }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-2fd8"; }\n`,
  "Tabs.js": `import { Children, createElement } from "react";\nexport default function Tabs({ children }) { return createElement("div", null, Children.toArray(children)[1]); }\n`,
};

// Padded past `/about`'s `0b` budget, so counting this sheet against it would fail.
// Each declaration is distinct because Brotli collapses a repeated rule.
const GLOBAL_CSS = Array.from(
  { length: 400 },
  (_, index) => `.fw-pad-${String(index)} { margin: ${String(index)}px; }`,
).join("\n");

let siteCount = 0;
const written: string[] = [];

interface Layers {
  scripts?: boolean;
  beacon?: boolean;
  widgetProps?: Record<string, unknown>;
  islandPropsBudget?: string;
  tabbed?: boolean;
}

// A fresh directory per call: Node caches the config module by URL, so a reused
// path would build the first site's config.
function site(
  budget?: Record<string, string>,
  layers: Layers = {},
): string {
  siteCount += 1;
  const root = join(SITES, `.pagedeck-budgets-test-${String(siteCount)}`);
  written.push(root);
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  writeFileSync(join(root, "global.css"), `${GLOBAL_CSS}\n`);
  for (const [path, title] of [
    ["home", "Home"],
    ["about", "About"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeFileSync(join(root, "pagedeck.config.ts"), configSource(root, budget, layers));
  return root;
}

function configSource(
  root: string,
  budget: Record<string, string> | undefined,
  layers: Layers,
): string {
  return `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { defineScripts } from ${JSON.stringify(join(CORE, "scripts.ts"))};
import { SECURITY_HEADERS } from ${JSON.stringify(join(CORE, "routing.ts"))};
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
    // Declared: a site with no headers warns on stderr (#318), and this build must be silent.
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
    css: ["./global.css"],
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
      Widget: { path: "./components/Widget.js", hydrate: "load" },
      Copy: "./components/Copy.js",
      Tabs: { path: "./components/Tabs.js", hydrate: "load" },
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    // The islands are excluded so each keeps its own chunk; core would otherwise take both.
    tierPolicy: { minSize: 0, exclude: ["Hero", "Widget"] },${
      budget === undefined ? "" : `\n    budget: ${JSON.stringify(budget)},`
    }${
      layers.scripts === true
        ? `\n    scripts: defineScripts({ scripts: [{ name: "cmp", src: "https://consent.example/cmp.js", strategy: "idle", category: "analytics" }] }),`
        : ""
    }${
      layers.beacon === true
        ? `\n    beacon: { endpoint: "https://rum.example/collect" },`
        : ""
    }${
      layers.islandPropsBudget === undefined
        ? ""
        : `\n    islandPropsBudget: ${JSON.stringify(layers.islandPropsBudget)},`
    }
    content: (page) => ({
      tree:
        page.path === "/"
          ? ${
            layers.tabbed === true
              ? `[{ component: "Tabs", children: [{ component: "Widget", props: ${JSON.stringify(layers.widgetProps ?? {})} }, { component: "Copy" }] }]`
              : `[{ component: "Widget"${
                  layers.widgetProps === undefined
                    ? ""
                    : `, props: ${JSON.stringify(layers.widgetProps)}`
                } }, { component: "Hero" }]`
          }
          : [{ component: "Copy" }],
    }),
  },
});
`;
}

// A copy, not the config rewritten in place: Node caches the config module by URL.
function redeclared(
  from: string,
  budget: Record<string, string> | undefined,
  layers: Layers,
): string {
  siteCount += 1;
  const root = join(SITES, `.pagedeck-budgets-test-${String(siteCount)}`);
  written.push(root);
  rmSync(root, { recursive: true, force: true });
  cpSync(from, root, { recursive: true });
  writeFileSync(join(root, "pagedeck.config.ts"), configSource(root, budget, layers));
  return root;
}

afterEach(() => {
  for (const dir of written.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Run {
  code: number;
  err: string;
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
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

function reportIn(root: string): BudgetReport {
  return JSON.parse(
    readFileSync(budgetReportPath(root), "utf8"),
  ) as BudgetReport;
}

test("a page over its budget fails the build, naming the page, the limit, the spend and its largest chunks", async () => {
  const dir = site({ "/": "1b", "/about": "0b" });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows",
  );
  expect(result.err).toMatch(
    /en \/ — "\/" allows 1 B, the page transfers (\d+) B over \d+ chunks?/,
  );
  const spend = Number(/the page transfers (\d+) B/.exec(result.err)?.[1]);
  expect(spend).toBeGreaterThan(10_000);

  const contributors = [
    ...result.err.matchAll(/^ {4}(\/assets\/\S+\.js) — (\d+) B$/gm),
  ];
  expect(contributors.length).toBeGreaterThan(0);
  const counted = reportIn(dir).pages.find(
    (page) => page.path === "/",
  )?.chunks;
  expect(counted?.map((chunk) => chunk.path)).toEqual(
    expect.arrayContaining(contributors.map(([, path]) => path)),
  );
  const bytes = contributors.map(([, , size]) => Number(size));
  expect([...bytes].sort((a, b) => b - a)).toEqual(bytes);
}, 60_000);

test("a breaching build still writes the report", async () => {
  const dir = site({ "/": "1b", "/about": "0b" });
  await run(dir, "sync");

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.configError);

  const report = reportIn(dir);
  expect(report.pages.find((page) => page.path === "/")?.breach).toBe(true);
}, 60_000);

test("an eagerly hydrated island counts and a lazily hydrated one does not", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const home = reportIn(dir).pages.find(
    (page) => page.path === "/",
  );
  const counted = home?.chunks.map((chunk) => chunk.path) ?? [];

  expect(counted.filter((path) => path.includes("/Widget-"))).toHaveLength(1);
  expect(counted.filter((path) => path.includes("/Hero-"))).toHaveLength(0);
}, 60_000);

test("a content-only page reports 0 bytes and passes a zero budget", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);

  const about = reportIn(dir).pages.find(
    (page) => page.path === "/about",
  );
  expect(about?.actual).toBe(0);
  expect(about?.chunks).toEqual([]);
  expect(about?.breach).toBe(false);
}, 60_000);

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(
    (tag) => /\bhref="([^"]*)"/.exec(tag[0])?.[1] ?? "",
  );
}

function brotliOf(dist: string, url: string): number {
  return brotliCompressSync(readFileSync(join(dist, url))).byteLength;
}

test("the report weighs the stylesheets a page links and its own document, and neither can fail a build", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  await run(dir, "sync");
  const result = await run(dir, "build");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  const documentOf = new Map(
    manifest.pages.map((page) => [page.path, page.html]),
  );

  for (const page of reportIn(dir).pages) {
    const document = documentOf.get(page.path) as string;
    const hrefs = hrefsOf(readFileSync(join(dist, document), "utf8"));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(page.css).toBe(
      hrefs.reduce((sum, href) => sum + brotliOf(dist, href), 0),
    );
    expect(page.html).toBe(brotliOf(dist, document));
  }

  const rows = new Map(reportIn(dir).pages.map((page) => [page.path, page]));
  expect(
    hrefsOf(readFileSync(join(dist, documentOf.get("/") as string), "utf8"))
      .length,
  ).toBeGreaterThan(1);
  expect(
    hrefsOf(readFileSync(join(dist, documentOf.get("/about") as string), "utf8")),
  ).toHaveLength(1);

  const about = rows.get("/about");
  expect(about?.actual).toBe(0);
  expect(about?.limit).toBe(0);
  expect(about?.breach).toBe(false);
  expect(about?.css).toBeGreaterThan(100);
  expect(about?.html).toBeGreaterThan(0);
}, 60_000);

// The build's rule spelled again rather than imported, so the figure is not
// checked against itself.
function inlineScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map((m) => m[0]);
}

test("a page charged for its inlined script loader fails a budget it has no chunks to breach", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" }, { scripts: true });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows",
  );
  expect(result.err).toMatch(
    /^ {2}en \/about — "\/about" allows 0 B, the page transfers \d+ B, all of it inlined into its document:\n {4}inlined into the document — \d+ B$/m,
  );

  const about = reportIn(dir).pages.find(
    (page) => page.path === "/about",
  );
  expect(about?.chunks).toEqual([]);
  expect(about?.jsInlined).toBeGreaterThan(0);
  expect(about?.actual).toBe(about?.jsInlined);
  expect(about?.breach).toBe(true);
}, 60_000);

test("a page carrying only a RUM beacon is charged for it", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" }, { beacon: true });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  const about = reportIn(dir).pages.find(
    (page) => page.path === "/about",
  );
  expect(about?.jsInlined).toBeGreaterThan(0);
  expect(about?.breach).toBe(true);
}, 60_000);

test("a page carrying both a loader and a beacon is charged for both, once each", async () => {
  const dir = site(
    { "/": "500kb", "/about": "500kb" },
    { scripts: true, beacon: true },
  );
  await run(dir, "sync");
  const result = await run(dir, "build");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  const documentOf = new Map(
    manifest.pages.map((page) => [page.path, page.html]),
  );

  for (const page of reportIn(dir).pages) {
    const html = readFileSync(
      join(dist, documentOf.get(page.path) as string),
      "utf8",
    );
    const inline = inlineScriptsOf(html);
    expect(inline).toHaveLength(2);
    expect(page.jsInlined).toBe(
      brotliCompressSync(Buffer.from(inline.join("\n"), "utf8")).byteLength,
    );
    expect(page.actual).toBe(
      page.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) + page.jsInlined,
    );
    expect(page.cssInlined).toBe(0);
  }
}, 60_000);

test("a site that inlines no JavaScript spends its chunks and nothing else", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  for (const page of reportIn(dir).pages) {
    expect(page.jsInlined).toBe(0);
    expect(page.actual).toBe(
      page.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    );
  }
}, 60_000);

test("a carried page is charged for the document on the tree, not for a config it was not rebuilt against", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const rebuilt = redeclared(
    dir,
    { "/": "500kb", "/about": "0b" },
    { scripts: true },
  );
  const result = await run(rebuilt, "build", "--incremental");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);

  const dist = join(rebuilt, "dist");
  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  const documentOf = new Map(
    manifest.pages.map((page) => [page.path, page.html]),
  );
  for (const page of reportIn(rebuilt).pages) {
    const html = readFileSync(
      join(dist, documentOf.get(page.path) as string),
      "utf8",
    );
    expect(inlineScriptsOf(html)).toEqual([]);
    expect(page.jsInlined).toBe(0);
  }
}, 60_000);

test("the report lists every budgeted page of a green build, outside the site", async () => {
  const dir = site({ "/": "500kb", "/about": "0b" });
  await run(dir, "sync");
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const dist = join(dir, "dist");
  const report = reportIn(dir);

  expect(report.version).toBe(2);
  expect(report.pages.map((page) => `${page.locale} ${page.path}`)).toEqual([
    "en /",
    "en /about",
  ]);
  expect(report.pages.map((page) => page.pattern)).toEqual(["/", "/about"]);
  expect(report.pages.map((page) => page.limitText)).toEqual(["500kb", "0b"]);
  const manifest = readManifest(
    readFileSync(join(dist, "manifest.json"), "utf8"),
    "manifest.json",
  );
  expect(report.build).toEqual(manifest.build);

  expect(
    manifest.files.some((file) => file.path.includes("budget-report")),
  ).toBe(false);
}, 60_000);

test("a site that declares no budget and breaches nothing writes no report", async () => {
  const dir = site();
  await run(dir, "sync");

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  expect(existsSync(budgetReportPath(dir))).toBe(false);
}, 60_000);

test("a build leaves no budget report anywhere inside the output tree", async () => {
  const dir = site({ "/": "500kb", "/about": "500kb" });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);

  const emitted = readdirSync(join(dir, "dist"), { recursive: true }).map(
    (entry) => String(entry),
  );
  expect(emitted).not.toHaveLength(0);
  expect(emitted.filter((entry) => entry.includes("budget-report"))).toEqual([]);
  expect(existsSync(budgetReportPath(dir))).toBe(true);
  expect(reportIn(dir).version).toBe(2);
}, 60_000);

const CMS_ENTRY = {
  title: "Linen shirt",
  body: Array.from(
    { length: 600 },
    (_, index) => `Paragraph ${String(index)} of the product story, in full.`,
  ),
  variants: [
    { id: "s", label: "Small" },
    { id: "m", label: "Medium" },
  ],
};

const DEFAULT_LIMIT = islandPropsLimit(undefined).limit;

test("an island handed a whole CMS entry fails the build, naming the page, the island and its largest props", async () => {
  const props = { entry: CMS_ENTRY, label: "Size" };
  const dir = site(undefined, { widgetProps: props });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const result = await run(dir, "build");

  const bytes = Buffer.byteLength(JSON.stringify(props), "utf8");
  expect(bytes).toBeGreaterThan(DEFAULT_LIMIT);
  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `Island props budget: 1 island carries more props in its marker than the limit allows — pass the island only the fields it renders, or raise the limit in pagedeck.config.ts's build.islandPropsBudget:`,
  );
  expect(result.err).toMatch(
    new RegExp(
      `^  en / — "Widget" at prefix "i[0-9a-f]{12}" carries ${String(bytes)} B of props against a limit of ${String(DEFAULT_LIMIT)} B, over 2 top-level props:\n {4}"entry" — ${String(Buffer.byteLength(JSON.stringify(CMS_ENTRY)))} B\n {4}"label" — 6 B$`,
      "m",
    ),
  );

  const home = reportIn(dir).pages.find((page) => page.path === "/");
  expect(home?.largestIslandProps).toBe(bytes);
  expect(home?.islandPropsBreaches.map((island) => island.component)).toEqual([
    "Widget",
  ]);
}, 60_000);

test("an island handed only the fields it renders builds, and a site with no budget still writes no report", async () => {
  const dir = site(undefined, {
    widgetProps: { label: "Size", variants: CMS_ENTRY.variants },
  });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(budgetReportPath(dir))).toBe(false);
}, 60_000);

test("a declared island props budget replaces the default, and every row reports its page's largest island", async () => {
  const props = { label: "Size", variants: CMS_ENTRY.variants };
  const bytes = Buffer.byteLength(JSON.stringify(props), "utf8");
  const dir = site({ "/": "500kb", "/about": "0b" }, {
    widgetProps: props,
    islandPropsBudget: `${String(bytes - 1)}b`,
  });
  await run(dir, "sync");

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `carries ${String(bytes)} B of props against a limit of ${String(bytes - 1)} B`,
  );
  const report = reportIn(dir);
  expect(report.islandPropsLimit).toEqual({
    limitText: `${String(bytes - 1)}b`,
    limit: bytes - 1,
  });
  expect(
    report.pages.map((page) => [page.path, page.breach, page.largestIslandProps]),
  ).toEqual([
    ["/", false, bytes],
    ["/about", false, 0],
  ]);
}, 60_000);

test("a carried page's island props are weighed off its document, so a lowered limit fails an incremental build", async () => {
  const props = { label: "Size", variants: CMS_ENTRY.variants };
  const bytes = Buffer.byteLength(JSON.stringify(props), "utf8");
  const dir = site({ "/": "500kb", "/about": "0b" }, { widgetProps: props });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);
  expect((await run(dir, "build")).code).toBe(EXIT_CODES.success);
  expect(reportIn(dir).pages.find((page) => page.path === "/")?.largestIslandProps).toBe(
    bytes,
  );

  const rebuilt = redeclared(
    dir,
    { "/": "500kb", "/about": "0b" },
    { widgetProps: props, islandPropsBudget: "10b" },
  );
  const result = await run(rebuilt, "build", "--incremental");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    `en / — "Widget" at prefix "`,
  );
  expect(reportIn(rebuilt).pages.find((page) => page.path === "/")?.largestIslandProps).toBe(
    bytes,
  );
}, 60_000);

test("an island in a slot its container stashes is weighed, and fails the build over the limit", async () => {
  const props = { entry: CMS_ENTRY, label: "Size" };
  const dir = site(undefined, { widgetProps: props, tabbed: true });
  expect((await run(dir, "sync")).code).toBe(EXIT_CODES.success);

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("Island props budget: 1 island carries");
  expect(result.err).toContain(
    `"Widget" at prefix "i`,
  );
  const home = reportIn(dir).pages.find((page) => page.path === "/");
  expect(home?.islandPropsBreaches.map((island) => island.component)).toEqual([
    "Widget",
  ]);
  expect(home?.islandPropsBreaches[0]?.bytes).toBe(
    Buffer.byteLength(JSON.stringify(props), "utf8"),
  );
}, 60_000);
