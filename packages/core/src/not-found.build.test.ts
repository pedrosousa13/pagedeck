import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const BASELINE_SITE = join(SITES, ".pagedeck-not-found-baseline-test");
const RULED_SITE = join(SITES, ".pagedeck-not-found-ruled-test");
const BARE_SITE = join(SITES, ".pagedeck-not-found-bare-test");
const INCREMENTAL_SITE = join(SITES, ".pagedeck-not-found-incremental-test");
const ADDED_SITE = join(SITES, ".pagedeck-not-found-added-test");
const REMOVED_SITE = join(SITES, ".pagedeck-not-found-removed-test");
const DEFAULT_ONLY_SITE = join(SITES, ".pagedeck-not-found-default-only-test");

const CONTENT: Record<string, readonly string[]> = {
  en: ["home", "about", "missing"],
  de: ["home", "about", "missing"],
  fr: ["home"],
};

const ORIGIN = `origin: "https://example.com",\n    xDefault: "en",\n    sitemap: { pattern: "suffix" },`;

const RULES = `routing: {
      notFound: [
        { locale: "en", path: "/404" },
        { domain: "example.de", locale: "de", path: "/404" },
      ],
    },`;

const RULES_DEFAULT_ONLY = `routing: {
      notFound: [{ locale: "en", path: "/404" }],
    },`;

const NOT_FOUND = ["en /404", "de /404"];

const ROBOTS = '<meta name="robots" content="noindex">';

const COMPONENT = `export default function Copy() { return "marker-copy-5920"; }\n`;

function site(root: string, build: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const [locale, paths] of Object.entries(CONTENT)) {
    for (const path of paths) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);
    }
  }
  configure(root, build);
  return root;
}

function configure(root: string, build: string): void {
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
    ${build}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
        fr: { label: "Français", direction: "ltr", fallback: "en" },
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) =>
            entry.path === "home"
              ? "/"
              : entry.path === "missing"
                ? "/404"
                : "/" + entry.path,
        }),
      ],
    }),
    components: {
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
}

async function run(cwd: string, ...argv: string[]): Promise<string> {
  const { runCli } = await import("./cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return out.join("\n");
}

interface Built {
  readonly documents: ReadonlyMap<string, string>;
  readonly sitemaps: string;
}

const built = new Map<string, Promise<Built>>();

function build(root: string, declared: string): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declared);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(root: string, declared: string): Promise<Built> {
  const dir = site(root, declared);
  await run(dir, "sync");
  await run(dir, "build");
  return read(dir);
}

function read(dir: string): Built {
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return {
    documents: new Map(
      manifest.pages.map((page) => [
        `${page.locale} ${page.path}`,
        readFileSync(
          join(
            dist,
            page.html.startsWith("//") ? page.html.slice(2) : page.html,
          ),
          "utf8",
        ),
      ]),
    ),
    sitemaps: readdirSync(dist, { recursive: true, encoding: "utf8" })
      .filter((path) => /sitemap[^/\\]*\.xml$/.test(path))
      .sort()
      .map((path) => readFileSync(join(dist, path), "utf8"))
      .join("\n"),
  };
}

afterAll(() => {
  for (const root of [
    BASELINE_SITE,
    RULED_SITE,
    BARE_SITE,
    INCREMENTAL_SITE,
    ADDED_SITE,
    REMOVED_SITE,
    DEFAULT_ONLY_SITE,
    `${ADDED_SITE}-after`,
    `${REMOVED_SITE}-after`,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function read404(dist: string, domain?: string): string | undefined {
  try {
    return readFileSync(join(dist, domain ?? "", "404.html"), "utf8");
  } catch {
    return undefined;
  }
}

function addressLines(html: string): readonly string[] {
  return html
    .split("\n")
    .filter((line) =>
      /^<link rel="(canonical|alternate" hreflang)/.test(line),
    );
}

function robotsCount(html: string): number {
  return html.split(ROBOTS).length - 1;
}

function entries(xml: string): ReadonlyMap<string, string> {
  return new Map(
    [...xml.matchAll(/<url>\n<loc>([^<]*)<\/loc>\n[\s\S]*?<\/url>/g)].map(
      (match) => [match[1] ?? "", match[0]],
    ),
  );
}

test("a not-found page carries no canonical, no alternates and one noindex", async () => {
  const ruled = await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`);
  for (const key of NOT_FOUND) {
    const html = ruled.documents.get(key) ?? "";
    expect(html).toContain("marker-copy-5920");
    expect(`${key}: ${addressLines(html).join("\n")}`).toBe(`${key}: `);
    expect(`${key}: ${String(robotsCount(html))}`).toBe(`${key}: 1`);
  }
}, 120_000);

test("a not-found page carries noindex on a site with no origin", async () => {
  const bare = await build(BARE_SITE, RULES);
  let others = 0;
  for (const [key, html] of bare.documents) {
    const expected = NOT_FOUND.includes(key) ? 1 : 0;
    expect(`${key}: ${String(robotsCount(html))}`).toBe(
      `${key}: ${String(expected)}`,
    );
    if (expected === 0) others += 1;
  }
  expect(others).toBeGreaterThan(0);
}, 120_000);

test("every other page's document is the document it was", async () => {
  const baseline = await build(BASELINE_SITE, ORIGIN);
  const ruled = await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`);

  expect([...ruled.documents.keys()].sort()).toEqual(
    [...baseline.documents.keys()].sort(),
  );
  let compared = 0;
  for (const [key, html] of ruled.documents) {
    if (key.endsWith(" /404")) continue;
    expect(`${key}: ${html}`).toBe(
      `${key}: ${baseline.documents.get(key) ?? ""}`,
    );
    compared += 1;
  }
  expect(compared).toBe(6);
}, 240_000);

test("no page names a not-found page as an alternate", async () => {
  const ruled = await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`);
  const hrefs = [...ruled.documents.values()].flatMap(addressLines).join("\n");
  expect(hrefs).not.toContain("https://example.com/en/404");
  expect(hrefs).not.toContain("https://example.de/404");
  expect(addressLines(ruled.documents.get("fr /404") ?? "")).toEqual([
    '<link rel="canonical" href="https://example.com/fr/404">',
  ]);
}, 120_000);

test("no sitemap lists a not-found page, and every other row is unchanged", async () => {
  const baseline = await build(BASELINE_SITE, ORIGIN);
  const ruled = await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`);
  const before = entries(baseline.sitemaps);
  const after = entries(ruled.sitemaps);

  expect(before.has("https://example.com/en/404")).toBe(true);
  expect(before.has("https://example.de/404")).toBe(true);
  expect(ruled.sitemaps).not.toContain("https://example.com/en/404");
  expect(ruled.sitemaps).not.toContain("https://example.de/404");

  let compared = 0;
  for (const [loc, entry] of before) {
    if (loc.endsWith("/404")) continue;
    expect(after.get(loc)).toBe(entry);
    compared += 1;
  }
  expect(compared).toBe(6);
  expect(after.get("https://example.com/fr/404")).toBe(
    "<url>\n<loc>https://example.com/fr/404</loc>\n</url>",
  );
}, 240_000);

test("each output tree with a not-found rule also gets 404.html at its root, byte-identical to the page's document", async () => {
  const ruled = await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`);
  const dist = join(RULED_SITE, "dist");
  expect(read404(dist)).toBe(ruled.documents.get("en /404"));
  expect(read404(dist, "example.de")).toBe(ruled.documents.get("de /404"));
}, 120_000);

test("a tree with no not-found rule gets no 404.html, even when another tree of the same site has one", async () => {
  const baseline = await build(BASELINE_SITE, ORIGIN);
  const baselineDist = join(BASELINE_SITE, "dist");
  expect(read404(baselineDist)).toBeUndefined();
  expect(read404(baselineDist, "example.de")).toBeUndefined();

  const defaultOnly = await build(
    DEFAULT_ONLY_SITE,
    `${ORIGIN}\n    ${RULES_DEFAULT_ONLY}`,
  );
  const dist = join(DEFAULT_ONLY_SITE, "dist");
  expect(read404(dist)).toBe(defaultOnly.documents.get("en /404"));
  expect(read404(dist, "example.de")).toBeUndefined();
}, 240_000);

test("an incremental build that re-renders a not-found page writes what a full build wrote", async () => {
  const full = await build(INCREMENTAL_SITE, `${ORIGIN}\n    ${RULES}`);
  for (const [locale, path] of [
    ["en", "missing"],
    ["de", "missing"],
    ["en", "about"],
  ] as const) {
    writeFileSync(
      join(INCREMENTAL_SITE, "content", locale, `${path}.json`),
      `${JSON.stringify({ rev: 2, data: { edited: true } })}\n`,
    );
  }
  await run(INCREMENTAL_SITE, "sync");
  const out = await run(INCREMENTAL_SITE, "build", "--incremental");
  expect(out).toContain("incremental: 5 of 9 pages rendered, 4 reused, 0 removed");

  const second = read(INCREMENTAL_SITE);
  expect(second.sitemaps).toBe(full.sitemaps);
  expect([...second.documents.keys()].sort()).toEqual(
    [...full.documents.keys()].sort(),
  );
  for (const [key, html] of second.documents) {
    expect(`${key}: ${html}`).toBe(`${key}: ${full.documents.get(key) ?? ""}`);
  }
  expect(robotsCount(second.documents.get("en /404") ?? "")).toBe(1);

  const dist = join(INCREMENTAL_SITE, "dist");
  expect(read404(dist)).toBe(second.documents.get("en /404"));
  expect(read404(dist, "example.de")).toBe(second.documents.get("de /404"));
}, 240_000);

// A copy of the site: Node's ESM cache would hand back the config it already imported.
async function reconfigured(
  root: string,
  before: string,
  after: string,
): Promise<{ built: Built; out: string }> {
  await build(root, before);
  const copy = `${root}-after`;
  rmSync(copy, { recursive: true, force: true });
  cpSync(root, copy, { recursive: true });
  configure(copy, after);
  const out = await run(copy, "build", "--incremental");
  return { built: read(copy), out };
}

function expectSameTree(second: Built, first: Built): void {
  expect(second.sitemaps).toBe(first.sitemaps);
  expect([...second.documents.keys()].sort()).toEqual(
    [...first.documents.keys()].sort(),
  );
  for (const [key, html] of second.documents) {
    expect(`${key}: ${html}`).toBe(`${key}: ${first.documents.get(key) ?? ""}`);
  }
}

test("an incremental build after a not-found rule is added writes what a full build with it writes", async () => {
  const { built: second, out } = await reconfigured(
    ADDED_SITE,
    ORIGIN,
    `${ORIGIN}\n    ${RULES}`,
  );
  expectSameTree(second, await build(RULED_SITE, `${ORIGIN}\n    ${RULES}`));
  expect(out).toContain("incremental: 3 of 9 pages rendered, 6 reused, 0 removed");

  const after = join(`${ADDED_SITE}-after`, "dist");
  expect(read404(after)).toBe(second.documents.get("en /404"));
  expect(read404(after, "example.de")).toBe(second.documents.get("de /404"));
}, 360_000);

test("an incremental build after a not-found rule is removed writes what a full build without it writes", async () => {
  const { built: second, out } = await reconfigured(
    REMOVED_SITE,
    `${ORIGIN}\n    ${RULES}`,
    ORIGIN,
  );
  expectSameTree(second, await build(BASELINE_SITE, ORIGIN));
  expect(out).toContain("incremental: 3 of 9 pages rendered, 6 reused, 0 removed");

  const after = join(`${REMOVED_SITE}-after`, "dist");
  expect(read404(after)).toBeUndefined();
  expect(read404(after, "example.de")).toBeUndefined();
}, 360_000);
