import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const PLAIN_SITE = join(SITES, ".pagedeck-feed-plain-test");
const FEED_SITE = join(SITES, ".pagedeck-feed-declared-test");
const TWICE_SITE = join(SITES, ".pagedeck-feed-twice-test");
const TREES_SITE = join(SITES, ".pagedeck-feed-trees-test");

const ONE_TREE = `en: { label: "English", direction: "ltr" },`;
const TWO_TREES = `en: { label: "English", direction: "ltr", domain: "example.com" },
        de: { label: "Deutsch", direction: "ltr", domain: "example.de" },`;

const POSTS: Record<string, Record<string, string>> = {
  first: {
    title: "First post",
    summary: "The first one",
    date: "2026-06-01T09:00:00Z",
  },
  second: {
    title: 'Tom & "Jerry"',
    summary: "1 < 2",
    date: "2026-06-02T09:00:00Z",
  },
  later: {
    title: "Not yet",
    summary: "Scheduled",
    date: "2999-01-01T00:00:00Z",
  },
};

const COMPONENT = `export default function Copy() { return "marker-copy-324a"; }\n`;

const DECLARED = `feed: {
      collection: "posts",
      title: "My Site",
      description: "Recent posts",
      item: { title: "title", description: "summary", pubDate: "date" },
    },`;

function site(
  root: string,
  declared = "",
  locales = ONE_TREE,
  contentLocales: readonly string[] = ["en"],
): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COMPONENT);
  for (const locale of contentLocales) {
    for (const [slug, data] of Object.entries(POSTS)) {
      const file = join(root, "content", locale, "posts", `${slug}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
    }
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
  publishField: "date",
};

export default defineConfig({
  store: "./content.db",
  collections: [posts],
  build: {
    outDir: "./dist",
    origin: ${JSON.stringify(ORIGIN)},
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
  declared = "",
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
  for (const root of [PLAIN_SITE, FEED_SITE, TWICE_SITE, TREES_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function read(dist: string, path: string): string {
  return readFileSync(join(dist, path), "utf8");
}

function treeRelative(key: string): string {
  return key.startsWith("//") ? key.slice(2) : key.slice(1);
}

function items(xml: string, tag: string): readonly string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))]
    .map((match) => match[1] ?? "")
    .slice(tag === "link" || tag === "title" || tag === "description" ? 1 : 0);
}

test("a declared feed is emitted at /rss.xml, over the collection's entries", async () => {
  const feed = await build(FEED_SITE, DECLARED);
  const xml = read(feed.dist, "rss.xml");

  expect(xml).toContain("<title>My Site</title>");
  expect(xml).toContain("<link>https://example.com</link>");
  expect(xml).toContain("<description>Recent posts</description>");
  expect(items(xml, "link")).toEqual([
    "https://example.com/posts/second",
    "https://example.com/posts/first",
  ]);
  expect(items(xml, "title")).toEqual([
    "Tom &amp; &quot;Jerry&quot;",
    "First post",
  ]);
  expect(items(xml, "description")).toEqual(["1 &lt; 2", "The first one"]);
  expect(items(xml, "pubDate")).toEqual([
    "Tue, 02 Jun 2026 09:00:00 GMT",
    "Mon, 01 Jun 2026 09:00:00 GMT",
  ]);
}, 120_000);

test("an entry outside its publication window is in neither the pages nor the feed", async () => {
  const feed = await build(FEED_SITE, DECLARED);
  const xml = read(feed.dist, "rss.xml");

  expect(feed.manifest.pages.map((page) => page.path).sort()).toEqual([
    "/posts/first",
    "/posts/second",
  ]);
  expect(xml).not.toContain("Not yet");
  expect(xml).not.toContain("/posts/later");
}, 120_000);

test("two builds of one store write one feed, byte for byte", async () => {
  const dir = site(TWICE_SITE, DECLARED);
  await run(dir, "sync");
  await run(dir, "build");
  const first = read(join(dir, "dist"), "rss.xml");
  await run(dir, "build");

  expect(read(join(dir, "dist"), "rss.xml")).toBe(first);
}, 120_000);

test("the feed is written inside the tree that serves the origin, and every page's link resolves to it", async () => {
  const feed = await build(TREES_SITE, DECLARED, TWO_TREES, ["en", "de"]);
  const href = `${ORIGIN}/rss.xml`;
  const url = new URL(href);

  const served = join(url.hostname, url.pathname.slice(1));
  expect(read(feed.dist, served)).toContain('<rss version="2.0"');

  expect(existsSync(join(feed.dist, "rss.xml"))).toBe(false);
  expect(existsSync(join(feed.dist, "example.de", "rss.xml"))).toBe(false);
  expect(
    feed.manifest.files
      .filter((one) => one.path === "/rss.xml")
      .map((one) => `${one.domain ?? ""}|${one.path}`),
  ).toEqual(["example.com|/rss.xml"]);

  expect(feed.manifest.pages.map((page) => page.domain).sort()).toEqual([
    "example.com",
    "example.com",
    "example.de",
    "example.de",
  ]);
  for (const page of feed.manifest.pages) {
    expect(read(feed.dist, treeRelative(page.html))).toContain(href);
  }
}, 120_000);

test("the feed is linked from every page's head, and only where the site asked", async () => {
  const plain = await build(PLAIN_SITE);
  const feed = await build(FEED_SITE, DECLARED);
  const link =
    '<link rel="alternate" type="application/rss+xml" title="My Site" href="https://example.com/rss.xml">';

  for (const page of feed.manifest.pages) {
    expect(read(feed.dist, page.html.slice(1))).toContain(link);
  }
  for (const page of plain.manifest.pages) {
    expect(read(plain.dist, page.html.slice(1))).not.toContain("rss+xml");
  }

  const moved = diffOutputTrees(plain.dist, feed.dist);
  expect(moved.filter((one) => one.difference === "second-only")).toEqual([
    { path: "rss.xml", difference: "second-only" },
  ]);
  expect(moved.filter((one) => one.difference === "first-only")).toEqual([]);
  expect(
    moved
      .filter((one) => one.difference === "bytes")
      .map((one) => one.path)
      .sort(),
  ).toEqual([
    "manifest.json",
    ...feed.manifest.pages.map((page) => page.html.slice(1)).sort(),
  ]);
}, 120_000);
