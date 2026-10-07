import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const ORIGIN = "https://example.com";
const PLAIN_SITE = join(SITES, ".pagedeck-robots-plain-test");
const ROBOTS_SITE = join(SITES, ".pagedeck-robots-declared-test");
const TREES_SITE = join(SITES, ".pagedeck-robots-trees-test");
const TWICE_SITE = join(SITES, ".pagedeck-robots-twice-test");
const NO_ORIGIN_SITE = join(SITES, ".pagedeck-robots-no-origin-test");
const LIVE_SITE = join(SITES, ".pagedeck-robots-live-file-test");

const ONE_TREE = `en: { label: "English", direction: "ltr" },`;
const TWO_TREES = `en: { label: "English", direction: "ltr", domain: "example.com" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },`;

const COMPONENT = `export default function Copy() { return "marker-copy-325a"; }\n`;

const ORIGIN_LINE = `origin: ${JSON.stringify(ORIGIN)},`;
const SITEMAP = `${ORIGIN_LINE}
    sitemap: { pattern: "suffix" },`;
const DECLARED = `${SITEMAP}
    robots: { disallow: ["/admin", "/drafts"], allow: ["/admin/public"] },`;

const NO_ORIGIN = `robots: { disallow: ["/admin"] },`;

const LIVE_ORIGIN = "https://example.org";
const LIVE_LINES: readonly string[] = [
  "User-agent: Googlebot",
  "Disallow: /nogooglebot/",
  "",
  "# Content usage preferences for automated crawlers.",
  "# search: indexing for search results.",
  "# ai-input: grounding an AI answer with this content (RAG), with attribution.",
  "# ai-train: use as training data for AI models.",
  "# See https://contentsignals.org",
  "",
  "User-agent: *",
  "Content-Signal: search=yes, ai-input=yes, ai-train=no",
  "Allow: /",
];
const LIVE = `origin: ${JSON.stringify(LIVE_ORIGIN)},
    sitemap: { pattern: "suffix" },
    robots: { verbatim: ${JSON.stringify(LIVE_LINES)} },`;

function site(
  root: string,
  declared = SITEMAP,
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const locale of contentLocales) {
    const file = join(root, "content", locale, "posts", "first.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ rev: 1, data: { title: "First" } })}\n`,
    );
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const posts = {
  name: "posts",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    ${declared}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        ${locales}
      }),
      sources: [fromCollection(posts)],
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
  return root;
}

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
  readonly dist: string;
  readonly manifest: Manifest;
}

const built = new Map<string, Promise<Built>>();

function build(
  root: string,
  declared = SITEMAP,
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): Promise<Built> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, declared, locales, contentLocales);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  declared: string,
  locales: string,
  contentLocales: readonly string[],
): Promise<Built> {
  const dir = site(root, declared, locales, contentLocales);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  return { dist, manifest: readManifest(readFileSync(file, "utf8"), file) };
}

afterAll(() => {
  for (const root of [
    PLAIN_SITE,
    ROBOTS_SITE,
    TREES_SITE,
    TWICE_SITE,
    NO_ORIGIN_SITE,
    LIVE_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function read(dist: string, path: string): string {
  return readFileSync(join(dist, path), "utf8");
}

function served(href: string): string {
  const url = new URL(href);
  return join(url.hostname, url.pathname.slice(1));
}

function sitemapLine(text: string): string {
  return /^Sitemap: (.+)$/m.exec(text)?.[1] ?? "";
}

test("a declared robots.txt is emitted, and its Sitemap line names a file this build wrote", async () => {
  const robots = await build(ROBOTS_SITE, DECLARED);
  const text = read(robots.dist, "robots.txt");

  expect(text).toBe(
    `User-agent: *
Disallow: /admin
Disallow: /drafts
Allow: /admin/public

Sitemap: ${ORIGIN}/sitemap.xml
`,
  );
  expect(
    read(robots.dist, new URL(sitemapLine(text)).pathname.slice(1)),
  ).toContain("<sitemapindex");
  expect(
    robots.manifest.files
      .filter((one) => one.path === "/robots.txt")
      .map((one) => one.kind),
  ).toEqual(["asset"]);
}, 120_000);

test("a site that declares no robots gets none, and declaring one adds exactly one file", async () => {
  const plain = await build(PLAIN_SITE);
  const robots = await build(ROBOTS_SITE, DECLARED);

  expect(existsSync(join(plain.dist, "robots.txt"))).toBe(false);
  expect(plain.manifest.files.some((one) => one.path === "/robots.txt")).toBe(
    false,
  );

  const moved = diffOutputTrees(plain.dist, robots.dist);
  expect(moved.filter((one) => one.difference === "second-only")).toEqual([
    { path: "robots.txt", difference: "second-only" },
  ]);
  expect(moved.filter((one) => one.difference === "first-only")).toEqual([]);
  expect(
    moved.filter((one) => one.difference === "bytes").map((one) => one.path),
  ).toEqual(["manifest.json"]);
}, 120_000);

test("every output tree gets a robots.txt naming its own tree's sitemap", async () => {
  const robots = await build(TREES_SITE, DECLARED, TWO_TREES, ["en", "de"]);

  expect(read(robots.dist, join("example.com", "robots.txt"))).toContain(
    "Sitemap: https://example.com/sitemap.xml\n",
  );
  expect(read(robots.dist, join("example.de", "robots.txt"))).toContain(
    "Sitemap: https://example.de/sitemap.xml\n",
  );
  expect(existsSync(join(robots.dist, "robots.txt"))).toBe(false);
  for (const tree of ["example.com", "example.de"]) {
    const line = sitemapLine(read(robots.dist, join(tree, "robots.txt")));
    expect(read(robots.dist, served(line))).toContain("<sitemapindex");
  }
  expect(
    robots.manifest.files
      .filter((one) => one.path === "/robots.txt")
      .map((one) => `${one.domain ?? ""}|${one.path}`)
      .sort(),
  ).toEqual(["example.com|/robots.txt", "example.de|/robots.txt"]);
}, 120_000);

test("two builds of one store write one robots.txt, byte for byte", async () => {
  const dir = site(TWICE_SITE, DECLARED);
  await run(dir, "sync");
  await run(dir, "build");
  const first = read(join(dir, "dist"), "robots.txt");
  await run(dir, "build");

  expect(read(join(dir, "dist"), "robots.txt")).toBe(first);
}, 120_000);

test("a site with no origin gets the directives it declared and no Sitemap line", async () => {
  const robots = await build(NO_ORIGIN_SITE, NO_ORIGIN);

  expect(read(robots.dist, "robots.txt")).toBe(
    "User-agent: *\nDisallow: /admin\n",
  );
  expect(
    robots.manifest.files
      .filter((one) => one.path === "/robots.txt")
      .map((one) => one.kind),
  ).toEqual(["asset"]);
}, 120_000);

test("a site declares a live site's whole file, and this build writes it", async () => {
  // Against a literal, not a re-join of `LIVE_LINES`, which would pass with the order
  // reversed.
  const robots = await build(LIVE_SITE, LIVE);

  expect(read(robots.dist, "robots.txt")).toBe(
    `User-agent: Googlebot
Disallow: /nogooglebot/

# Content usage preferences for automated crawlers.
# search: indexing for search results.
# ai-input: grounding an AI answer with this content (RAG), with attribution.
# ai-train: use as training data for AI models.
# See https://contentsignals.org

User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Allow: /

Sitemap: ${LIVE_ORIGIN}/sitemap.xml
`,
  );
  expect(
    read(
      robots.dist,
      new URL(sitemapLine(read(robots.dist, "robots.txt"))).pathname.slice(1),
    ),
  ).toContain("<sitemapindex");
}, 120_000);
