import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";
import { afterAll, expect, test } from "vitest";
import { budgetReportPath } from "./budgets.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Hero.js": `import "./Hero.css";\nexport default function Hero() { return "marker-hero-9c14"; }\n`,
  "Hero.css": `.fw-hero { color: rgb(1, 2, 3); }\n`,
  "Panel.js": `import "./Panel.css";\nexport default function Panel() { return "marker-panel-4b71"; }\n`,
  "Panel.css": `.fw-panel { color: rgb(7, 8, 9); }\n`,
  "Chart.js": `import "./Chart.css";\nexport default function Chart() { return "marker-chart-2ad8"; }\n`,
  "Chart.css": `.fw-chart { color: rgb(4, 5, 6); }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-2fd8"; }\n`,
};

// An arbitrary-value colour: a named utility like `underline` also matches preflight.
// No component rule may share it, since the minifier folds `rgb()` to hex.
const UTILITY = "text-[#a1b2c3]";
const UTILITY_BYTES = "a1b2c3";

const TAILWIND_BYTES = ["--font-sans", "text-size-adjust"];

const TAILWIND_COMPONENTS: Record<string, string> = {
  "theme.css": `@import "tailwindcss";\n`,
  "Hero.js": `import "./Hero.css";\nexport default function Hero() { return "${UTILITY} marker-hero-8e02"; }\n`,
  "Hero.css": `.fw-hero { color: rgb(11, 12, 13); }\n`,
  "Panel.js": `import "./Panel.css";\nexport default function Panel() { return "marker-panel-1c63"; }\n`,
  "Panel.css": `.fw-panel { color: rgb(17, 18, 19); }\n`,
  "Chart.js": `import "./Chart.css";\nexport default function Chart() { return "${UTILITY} marker-chart-5f47"; }\n`,
  "Chart.css": `.fw-chart { color: rgb(14, 15, 16); }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-3ba9"; }\n`,
};

const GLOBAL_RULE = ".fw-global";
const GLOBAL_COMPONENTS: Record<string, string> = {
  ...COMPONENTS,
  "global.css": `${GLOBAL_RULE} { color: rgb(21, 22, 23); }\n`,
};

const SITE = join(SITES, ".pagedeck-css-tiers-test");
const TAILWIND_SITE = join(SITES, ".pagedeck-css-tiers-tailwind-test");
const GLOBAL_SITE = join(SITES, ".pagedeck-css-tiers-global-test");
const CRITICAL_SITE = join(SITES, ".pagedeck-css-tiers-critical-test");

interface SiteExtras {
  imports?: string;
  build?: string;
}

function site(
  root: string,
  components: Record<string, string>,
  extras: SiteExtras = {},
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(components)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
    ["blog", "Blog"],
    ["careers", "Careers"],
    ["about", "About"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};
${extras.imports ?? ""}

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
    ${extras.build ?? ""}
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
      Hero: { path: "./components/Hero.js", hydrate: "load" },
      Panel: { path: "./components/Panel.js", hydrate: "load" },
      Chart: { path: "./components/Chart.js", hydrate: "load" },
      Copy: "./components/Copy.js",
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    // Shipping tiers over four pages: \`Hero\` on all is core, \`Panel\` on two mid, \`Chart\` tail.
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree:
        page.path === "/"
          ? [{ component: "Hero" }, { component: "Panel" }, { component: "Chart" }]
          : page.path === "/pricing"
            ? [{ component: "Hero" }, { component: "Panel" }]
            : page.path === "/about"
              ? [{ component: "Copy" }]
              : [{ component: "Hero" }],
    }),
  },
});
`,
  );
  return root;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(TAILWIND_SITE, { recursive: true, force: true });
  rmSync(GLOBAL_SITE, { recursive: true, force: true });
  rmSync(CRITICAL_SITE, { recursive: true, force: true });
});

const TAILWIND_EXTRAS: SiteExtras = {
  imports: `import tailwindcss from "@tailwindcss/vite";`,
  build: `css: ["./components/theme.css"], vite: { plugins: [tailwindcss()] },`,
};

const GLOBAL_EXTRAS: SiteExtras = {
  build: `css: ["./components/global.css"],`,
};

const CRITICAL_EXTRAS: SiteExtras = {
  build: `criticalCss: { "/pricing": true },`,
};

async function run(cwd: string, ...argv: string[]): Promise<number> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return code;
}

interface Built {
  dist: string;
  root: string;
  htmlOf: Map<string, string>;
}

const built = new Map<string, Promise<Built>>();

function build(
  root: string = SITE,
  components: Record<string, string> = COMPONENTS,
  extras: SiteExtras = {},
): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, components, extras);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  components: Record<string, string>,
  extras: SiteExtras,
): Promise<Built> {
  const dir = site(root, components, extras);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const htmlOf = new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
  return { dist, root: dir, htmlOf };
}

function stylesheetTags(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(
    (match) => match[0],
  );
}

function hrefsOf(html: string): string[] {
  return stylesheetTags(html).map(
    (tag) => /\bhref="([^"]*)"/.exec(tag)?.[1] ?? "",
  );
}

function read(dist: string, url: string): string {
  return readFileSync(join(dist, url), "utf8");
}

function stylesheets(dist: string): string[] {
  return readdirSync(join(dist, "assets"))
    .filter((file) => file.endsWith(".css"))
    .sort()
    .map((file) => `/assets/${file}`);
}

test("a page whose components are all core-tier links only the core stylesheet", async () => {
  const { dist, htmlOf } = await build();

  const hrefs = hrefsOf(htmlOf.get("/blog") ?? "");
  expect(hrefs).toHaveLength(1);
  expect(hrefs[0]).toMatch(/^\/assets\/fw-core-[\w-]+\.css$/);
  expect(read(dist, hrefs[0] as string)).toContain(".fw-hero");
}, 120_000);

test("a page links every tier it reaches, widest cached first", async () => {
  const { dist, htmlOf } = await build();

  const hrefs = hrefsOf(htmlOf.get("/") ?? "");
  expect(hrefs).toHaveLength(3);

  expect(read(dist, hrefs[0] as string)).toContain(".fw-hero");
  expect(read(dist, hrefs[1] as string)).toContain(".fw-panel");
  expect(read(dist, hrefs[2] as string)).toContain(".fw-chart");
  expect(hrefs[0]).toMatch(/^\/assets\/fw-core-[\w-]+\.css$/);
}, 120_000);

test("a component's CSS lands in the tier its JS tier implies", async () => {
  const { dist, htmlOf } = await build();

  const [core, mid, tail] = hrefsOf(htmlOf.get("/") ?? "");
  const coreCss = read(dist, core as string);

  expect(coreCss).toContain(".fw-hero");
  expect(coreCss).not.toContain(".fw-panel");
  expect(coreCss).not.toContain(".fw-chart");
  expect(read(dist, mid as string)).toEqual(
    expect.stringContaining(".fw-panel"),
  );
  expect(read(dist, tail as string)).not.toContain(".fw-panel");
  expect(read(dist, tail as string)).toContain(".fw-chart");

  expect(hrefsOf(htmlOf.get("/blog") ?? "")[0]).toBe(core);
  expect(hrefsOf(htmlOf.get("/pricing") ?? "")).toEqual([core, mid]);
}, 120_000);

test("a content-only page of a site declaring no global CSS links no stylesheet at all", async () => {
  const { htmlOf } = await build();

  expect(hrefsOf(htmlOf.get("/about") ?? "")).toEqual([]);
}, 120_000);

test("a declared global stylesheet is core-tier and linked on every page", async () => {
  const { dist, htmlOf } = await build(
    GLOBAL_SITE,
    GLOBAL_COMPONENTS,
    GLOBAL_EXTRAS,
  );

  const core = hrefsOf(htmlOf.get("/") ?? "").find((href) =>
    /^\/assets\/fw-core-[\w-]+\.css$/.test(href),
  );
  expect(core).toBeDefined();
  expect(read(dist, core as string)).toContain(GLOBAL_RULE);

  expect(
    stylesheets(dist).filter((href) => read(dist, href).includes(GLOBAL_RULE)),
  ).toEqual([core]);

  for (const path of ["/", "/pricing", "/blog", "/careers", "/about"]) {
    expect(hrefsOf(htmlOf.get(path) ?? "")).toContain(core);
  }
  expect(hrefsOf(htmlOf.get("/about") ?? "")).toEqual([core]);
}, 120_000);

test("a Tailwind utility two tiers use is emitted into core and nowhere else", async () => {
  const { dist, htmlOf } = await build(
    TAILWIND_SITE,
    TAILWIND_COMPONENTS,
    TAILWIND_EXTRAS,
  );

  const core = hrefsOf(htmlOf.get("/") ?? "").find((href) =>
    /^\/assets\/fw-core-[\w-]+\.css$/.test(href),
  );
  expect(core).toBeDefined();

  const carrying = stylesheets(dist).filter((href) =>
    read(dist, href).includes(UTILITY_BYTES),
  );
  expect(carrying).toEqual([core]);

  for (const marker of TAILWIND_BYTES) {
    expect(
      stylesheets(dist).filter((href) => read(dist, href).includes(marker)),
    ).toEqual([core]);
  }

  expect(hrefsOf(htmlOf.get("/blog") ?? "")).toEqual([core]);
  expect(htmlOf.get("/blog") ?? "").toContain(UTILITY);
}, 120_000);

test("a site declaring no toolkit emits no Tailwind bytes", async () => {
  const { dist } = await build();

  for (const href of stylesheets(dist)) {
    const css = read(dist, href);
    for (const marker of TAILWIND_BYTES) expect(css).not.toContain(marker);
  }
}, 120_000);

// Indices, not a regex: a lazy match would stop at the first `</style` inside a sheet.
function styleBlocks(html: string): string[] {
  const blocks: string[] = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf("<style>", at);
    if (open === -1) return blocks;
    const close = html.indexOf("</style>", open);
    if (close === -1) return blocks;
    blocks.push(html.slice(open + "<style>".length, close));
    at = close + "</style>".length;
  }
}

function budgetRows(root: string): Map<
  string,
  {
    css: number;
    cssInlined: number;
    html: number;
    limit?: number;
  }
> {
  const report = JSON.parse(
    readFileSync(budgetReportPath(root), "utf8"),
  ) as {
    pages: {
      locale: string;
      path: string;
      css: number;
      cssInlined: number;
      html: number;
      limit?: number;
    }[];
  };
  return new Map(
    report.pages.map((page) => [`${page.locale} ${page.path}`, page]),
  );
}

test("a flagged page inlines the stylesheets covering its components, in tier order", async () => {
  const { htmlOf } = await build(CRITICAL_SITE, COMPONENTS, CRITICAL_EXTRAS);
  const html = htmlOf.get("/pricing") ?? "";

  const blocks = styleBlocks(html);
  expect(blocks.join("\n")).toContain(".fw-hero");
  expect(blocks.join("\n")).toContain(".fw-panel");
  expect(blocks.join("\n")).not.toContain(".fw-chart");
  expect(blocks.findIndex((css) => css.includes(".fw-hero"))).toBeLessThan(
    blocks.findIndex((css) => css.includes(".fw-panel")),
  );

  expect(hrefsOf(html)).toEqual([]);
}, 120_000);

test("an unflagged page in a flagged build still links its tiers and inlines nothing", async () => {
  const { htmlOf } = await build(CRITICAL_SITE, COMPONENTS, CRITICAL_EXTRAS);

  for (const path of ["/", "/blog", "/careers", "/about"]) {
    expect(styleBlocks(htmlOf.get(path) ?? "")).toEqual([]);
  }
  expect(hrefsOf(htmlOf.get("/") ?? "")).toHaveLength(3);
  expect(hrefsOf(htmlOf.get("/blog") ?? "")).toHaveLength(1);
  expect(hrefsOf(htmlOf.get("/about") ?? "")).toEqual([]);
}, 120_000);

test("the size report shows a flagged page's inlined bytes", async () => {
  const { dist, root, htmlOf } = await build(
    CRITICAL_SITE,
    COMPONENTS,
    CRITICAL_EXTRAS,
  );

  const [core, mid] = hrefsOf(htmlOf.get("/") ?? "");
  const expected =
    brotliCompressSync(readFileSync(join(dist, core as string))).byteLength +
    brotliCompressSync(readFileSync(join(dist, mid as string))).byteLength;

  const rows = budgetRows(root);
  expect(rows.get("en /pricing")?.cssInlined).toBe(expected);
  expect(rows.get("en /pricing")?.css).toBe(0);

  expect([...rows.keys()]).toEqual(["en /pricing"]);
  expect(rows.get("en /pricing")?.limit).toBeUndefined();
}, 120_000);

test("the tier links carry no data-precedence", async () => {
  const { htmlOf } = await build();

  for (const html of htmlOf.values()) {
    for (const tag of stylesheetTags(html)) {
      expect(tag).not.toContain("data-precedence");
    }
  }
}, 120_000);
