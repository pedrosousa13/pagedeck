import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import type { Manifest, ManifestPage } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const ROOT = join(SITES, ".pagedeck-shared-entries-test");
const DIST = join(ROOT, "dist");

const DOMAIN = "example.de";

const TREES: Record<string, readonly string[]> = {
  "/": ["Hero"],
  "/pricing": ["Hero"],
  "/about": ["Hero"],
  "/blog": ["Hero", "Nav"],
  "/legal": [],
};

const CONTENT: Record<string, readonly string[]> = {
  en: ["home", "pricing", "about", "blog", "legal"],
  de: ["home"],
};

function writeSite(): void {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "components"), { recursive: true });
  writeFileSync(
    join(ROOT, "components", "Hero.js"),
    `export default function Hero() { return "marker-hero-5b71"; }\n`,
  );
  writeFileSync(
    join(ROOT, "components", "Nav.js"),
    `export default function Nav() { return "marker-nav-c93e"; }\n`,
  );
  for (const [locale, paths] of Object.entries(CONTENT)) {
    for (const path of paths) {
      const file = join(ROOT, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title: path } })}\n`);
    }
  }
  writeFileSync(
    join(ROOT, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(ROOT, "content"))}),
  schema: false,
};

const TREES = ${JSON.stringify(TREES)};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "en", direction: "ltr" },
        de: { label: "de", direction: "ltr", domain: ${JSON.stringify(DOMAIN)} },
      }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
      Nav: { path: "./components/Nav.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: (page) => ({
      tree: TREES[page.path].map((component) => ({ component })),
    }),
  },
});
`,
  );
}

async function ok(...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd: ROOT,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
}

let built: Promise<Manifest> | undefined;

function build(): Promise<Manifest> {
  built ??= (async () => {
    writeSite();
    await ok("sync");
    await ok("build");
    const file = join(DIST, MANIFEST_FILE);
    return readManifest(readFileSync(file, "utf8"), file);
  })();
  return built;
}

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function row(manifest: Manifest, locale: string, path: string): ManifestPage {
  const found = manifest.pages.find(
    (page) => page.locale === locale && page.path === path,
  );
  if (found === undefined) throw new Error(`no row for ${locale} ${path}`);
  return found;
}

function located(key: string): { domain?: string; path: string } {
  const found = /^\/\/([^/]+)(\/.*)$/.exec(key);
  return found === null
    ? { path: key }
    : { domain: found[1] as string, path: found[2] as string };
}

function fileOf(key: string): string {
  const { domain, path } = located(key);
  return join(DIST, domain ?? "", path);
}

function documentOf(page: ManifestPage): string {
  return readFileSync(fileOf(page.html), "utf8");
}

function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

function entryChunksIn(domain?: string): string[] {
  return readdirSync(join(DIST, domain ?? "", "assets"))
    .filter((name) => /^entry-[0-9a-f]{16}-.+\.js$/.test(name))
    .sort();
}

test("pages with one island set emit one entry chunk, and every one of their documents loads it", async () => {
  const manifest = await build();
  const shared = ["/", "/pricing", "/about"].map((path) =>
    row(manifest, "en", path),
  );

  const [home] = shared;
  expect(home?.entryChunk).toBeDefined();
  for (const page of shared) expect(page.entryChunk).toBe(home?.entryChunk);

  expect(entryChunksIn()).toHaveLength(2);

  const src = located(home?.entryChunk as string).path;
  for (const page of shared) expect(scriptSources(documentOf(page))).toEqual([src]);
}, 240_000);

test("a page on another tree with the same set loads the same chunk from its own tree", async () => {
  const manifest = await build();
  const en = row(manifest, "en", "/");
  const de = row(manifest, "de", "/");

  const inDefault = located(en.entryChunk as string);
  const inDomain = located(de.entryChunk as string);
  expect(inDomain).toEqual({ domain: DOMAIN, path: inDefault.path });
  expect(scriptSources(documentOf(de))).toEqual([inDomain.path]);

  expect(entryChunksIn(DOMAIN)).toEqual([inDomain.path.replace("/assets/", "")]);
}, 240_000);

test("two pages whose sets differ by one component emit two chunks, each importing its own page's components", async () => {
  const manifest = await build();
  const home = row(manifest, "en", "/");
  const blog = row(manifest, "en", "/blog");

  expect(blog.entryChunk).toBeDefined();
  expect(blog.entryChunk).not.toBe(home.entryChunk);

  const homeChunk = readFileSync(fileOf(home.entryChunk as string), "utf8");
  const blogChunk = readFileSync(fileOf(blog.entryChunk as string), "utf8");
  expect(homeChunk).toMatch(/\bHero\b/);
  expect(homeChunk).not.toMatch(/\bNav\b/);
  expect(blogChunk).toMatch(/\bHero\b/);
  expect(blogChunk).toMatch(/\bNav\b/);

  expect(home.components.map((component) => component.name)).toEqual(["Hero"]);
  expect(blog.components.map((component) => component.name)).toEqual([
    "Hero",
    "Nav",
  ]);
}, 240_000);

test("a content-only page still emits no entry and no script", async () => {
  const manifest = await build();
  const legal = row(manifest, "en", "/legal");

  expect(legal.entryChunk).toBeUndefined();
  expect(legal.components).toEqual([]);
  expect(documentOf(legal)).not.toContain("<script");
}, 240_000);

test("every islanded page's entry chunk names a file in that page's own output tree", async () => {
  const manifest = await build();
  const islanded = manifest.pages.filter((page) => page.entryChunk !== undefined);
  expect(islanded).toHaveLength(5);

  const keys = new Set(
    manifest.files.map((file) =>
      file.domain === undefined ? file.path : `//${file.domain}${file.path}`,
    ),
  );
  for (const page of islanded) {
    const key = page.entryChunk as string;
    expect(located(key).domain).toBe(page.domain);
    expect(keys.has(key)).toBe(true);
    expect(existsSync(fileOf(key))).toBe(true);
  }
}, 240_000);
