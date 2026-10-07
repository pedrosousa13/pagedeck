import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { diffOutputTrees } from "./determinism.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import type { SearchDocument } from "./search.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const COMPONENTS: Record<string, string> = {
  "Hero.js": `export default function Hero() { return "marker-hero-5b17"; }\n`,
  "Copy.js": `export default function Copy() { return "marker-copy-9d40"; }\n`,
};

const PLAIN_SITE = join(SITES, ".pagedeck-search-plain-test");
const SILENT_SITE = join(SITES, ".pagedeck-search-silent-test");
const INDEXED_SITE = join(SITES, ".pagedeck-search-indexed-test");

const INDEX_PATH = "/search-index.json";

const INDEXING_ADAPTER = `search: {
      name: "lunr",
      index: (documents) => [
        {
          path: ${JSON.stringify(INDEX_PATH)},
          kind: "asset",
          contents: JSON.stringify(documents),
        },
      ],
    },`;

const SILENT_ADAPTER = `search: { name: "lunr", index: () => [] },`;

function site(root: string, search = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const [path, title] of [
    ["home", "Home"],
    ["pricing", "Pricing"],
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

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: (entry) => (entry.path === "home" ? "landing" : "article"),
    byTemplate: { landing: usage("Hero"), article: usage("Copy") },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${search}
    head: (page, store) => ({
      title: store.getEntry("pages", page.locale, page.entry.path).data.title,
    }),
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
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree: page.path === "/" ? [{ component: "Hero" }] : [{ component: "Copy" }],
    }),
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

const built = new Map<string, Promise<string>>();

function build(root: string, search = ""): Promise<string> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, search);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(root: string, search: string): Promise<string> {
  const dir = site(root, search);
  await run(dir, "sync");
  await run(dir, "build");
  return join(dir, "dist");
}

afterAll(() => {
  for (const root of [PLAIN_SITE, SILENT_SITE, INDEXED_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site that declares no search adapter builds the tree it built without the field", async () => {
  const plain = await build(PLAIN_SITE);
  const silent = await build(SILENT_SITE, SILENT_ADAPTER);

  expect(diffOutputTrees(plain, silent)).toEqual([]);
}, 120_000);

test("an adapter's files are written into the site and hashed into the manifest", async () => {
  const dist = await build(INDEXED_SITE, INDEXING_ADAPTER);

  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const row = manifest.files.find((one) => one.path === INDEX_PATH);
  expect(row?.kind).toBe("asset");
  expect(row?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(row?.size).toBe(
    readFileSync(join(dist, INDEX_PATH.slice(1))).byteLength,
  );
}, 120_000);

test("indexing adds the adapter's files and changes no other file", async () => {
  const plain = await build(PLAIN_SITE);
  const dist = await build(INDEXED_SITE, INDEXING_ADAPTER);

  expect(diffOutputTrees(plain, dist)).toEqual([
    { path: "manifest.json", difference: "bytes" },
    { path: INDEX_PATH.slice(1), difference: "second-only" },
  ]);
}, 120_000);

test("each document carries the page's route, its deployed location and its title", async () => {
  const dist = await build(INDEXED_SITE, INDEXING_ADAPTER);

  const documents = JSON.parse(
    readFileSync(join(dist, INDEX_PATH.slice(1)), "utf8"),
  ) as SearchDocument[];

  expect(
    documents.map(({ locale, path, output, title }) => ({
      locale,
      path,
      output,
      title,
    })),
  ).toEqual([
    { locale: "en", path: "/", output: "/", title: "Home" },
    { locale: "en", path: "/pricing", output: "/pricing", title: "Pricing" },
  ]);
}, 120_000);

test("a document's html is the page's rendered body and not the document around it", async () => {
  const dist = await build(INDEXED_SITE, INDEXING_ADAPTER);

  const documents = JSON.parse(
    readFileSync(join(dist, INDEX_PATH.slice(1)), "utf8"),
  ) as SearchDocument[];
  const home = documents.find((one) => one.path === "/");
  const page = readFileSync(join(dist, "index.html"), "utf8");

  expect(home?.html).toContain("marker-hero-5b17");
  expect(home?.html).not.toContain("<html");
  expect(home?.html).not.toContain("<title>");
  expect(home?.html).not.toContain("<script");
  expect(page).toContain("<html");
  expect(page).toContain("<title>Home</title>");
  expect(page).toContain("<script");
}, 120_000);
