// One site directory per setting: Node's ESM cache is keyed by URL, and a verb never
// re-executes a config it has imported.
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

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const ORIGIN = "https://example.com";

const PREFIXED_SITE = join(SITES, ".pagedeck-prefixed-locale-test");
const UNPREFIXED_LINK_SITE = join(
  SITES,
  ".pagedeck-prefixed-locale-root-link-test",
);
const ABSENT_SITE = join(SITES, ".pagedeck-prefixed-locale-absent-test");
const FALSE_SITE = join(SITES, ".pagedeck-prefixed-locale-false-test");
const DOMAIN_SITE = join(SITES, ".pagedeck-prefixed-locale-domain-test");

const NAV = `import { createElement } from "react";
export default function Nav({ links }) {
  return createElement(
    "nav",
    null,
    links.map((href) => createElement("a", { key: href, href }, href)),
  );
}
`;

interface Fixture {
  readonly locales: string;
  readonly links: Readonly<Record<string, readonly string[]>>;
  readonly content?: Readonly<Record<string, readonly string[]>>;
}

function site(root: string, fixture: Fixture): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Nav.js"), NAV);
  const content = fixture.content ?? { en: ["home", "about"] };
  for (const [locale, paths] of Object.entries(content)) {
    for (const path of paths) {
      const file = join(root, "content", locale, `${path}.json`);
      mkdirSync(dirname(file), { recursive: true });
      const links = fixture.links[path] ?? [];
      writeFileSync(file, `${JSON.stringify({ rev: 1, data: { links } })}\n`);
    }
  }

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
    origin: ${JSON.stringify(ORIGIN)},
    xDefault: "en",
    sitemap: { pattern: "suffix" },
    pages: definePages({
      trailingSlash: "always",
      locales: defineLocales(${fixture.locales}),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: { Nav: "./components/Nav.js" },
    content: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return { tree: [{ component: "Nav", props: { links: entry.data.links } }] };
    },
  },
});
`,
  );
  return root;
}

interface Run {
  readonly code: number;
  readonly err: string;
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

async function build(root: string, fixture: Fixture): Promise<Run> {
  site(root, fixture);
  const sync = await run(root, "sync");
  if (sync.code !== EXIT_CODES.success) throw new Error(sync.err);
  return run(root, "build");
}

function read(root: string, path: string): string {
  return readFileSync(join(root, "dist", path), "utf8");
}

function canonical(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1];
}

function hreflangs(html: string): readonly string[] {
  return [
    ...html.matchAll(
      /<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g,
    ),
  ].map((match) => `${match[1] ?? ""} ${match[2] ?? ""}`);
}

function locations(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(
    (match) => match[1] ?? "",
  );
}

const ONE_PREFIXED = `{ en: { label: "English", direction: "ltr", prefixed: true } }`;
const ONE_ABSENT = `{ en: { label: "English", direction: "ltr" } }`;
const ONE_FALSE = `{ en: { label: "English", direction: "ltr", prefixed: false } }`;
const ROOT_LINKS = { home: ["/about/"], about: ["/"] };

afterAll(() => {
  for (const root of [
    PREFIXED_SITE,
    UNPREFIXED_LINK_SITE,
    ABSENT_SITE,
    FALSE_SITE,
    DOMAIN_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a one-locale site with prefixed: true writes its pages, canonicals and sitemap under /en/ and nothing at / (#173)", async () => {
  const built = await build(PREFIXED_SITE, {
    locales: ONE_PREFIXED,
    links: { home: ["/en/about/"], about: ["/en/"] },
  });
  expect(built.code, built.err).toBe(EXIT_CODES.success);

  expect(existsSync(join(PREFIXED_SITE, "dist", "en", "index.html"))).toBe(
    true,
  );
  expect(
    existsSync(join(PREFIXED_SITE, "dist", "en", "about", "index.html")),
  ).toBe(true);
  expect(existsSync(join(PREFIXED_SITE, "dist", "index.html"))).toBe(false);
  expect(existsSync(join(PREFIXED_SITE, "dist", "about"))).toBe(false);

  expect(canonical(read(PREFIXED_SITE, "en/index.html"))).toBe(
    "https://example.com/en/",
  );
  expect(canonical(read(PREFIXED_SITE, "en/about/index.html"))).toBe(
    "https://example.com/en/about/",
  );
  expect(locations(read(PREFIXED_SITE, "sitemap-en.xml"))).toEqual([
    "https://example.com/en/",
    "https://example.com/en/about/",
  ]);
}, 120_000);

test("the link checker refuses a link to / on a one-locale site with prefixed: true (#173)", async () => {
  const built = await build(UNPREFIXED_LINK_SITE, {
    locales: ONE_PREFIXED,
    links: ROOT_LINKS,
  });

  expect(built.code).toBe(EXIT_CODES.configError);
  expect(built.err).toMatch(/^ {2}en \/ — "\/about\/"$/m);
  expect(built.err).toMatch(/^ {2}en \/about\/ — "\/"$/m);
}, 120_000);

test("prefixed: false on a one-locale site builds the tree leaving the field out builds (#173)", async () => {
  const absent = await build(ABSENT_SITE, {
    locales: ONE_ABSENT,
    links: ROOT_LINKS,
  });
  const written = await build(FALSE_SITE, {
    locales: ONE_FALSE,
    links: ROOT_LINKS,
  });
  expect(absent.code, absent.err).toBe(EXIT_CODES.success);
  expect(written.code, written.err).toBe(EXIT_CODES.success);

  expect(existsSync(join(ABSENT_SITE, "dist", "index.html"))).toBe(true);
  expect(existsSync(join(ABSENT_SITE, "dist", "en"))).toBe(false);
  expect(
    diffOutputTrees(join(ABSENT_SITE, "dist"), join(FALSE_SITE, "dist")),
  ).toEqual([]);
}, 120_000);

test("hreflang names a prefixed locale's page under its key when another locale has a tree of its own (#173)", async () => {
  const built = await build(DOMAIN_SITE, {
    locales: `{
      en: { label: "English", direction: "ltr", prefixed: true },
      de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
    }`,
    links: {},
    content: { en: ["home", "about"], de: ["home", "about"] },
  });
  expect(built.code, built.err).toBe(EXIT_CODES.success);

  expect(hreflangs(read(DOMAIN_SITE, "example.de/about/index.html"))).toEqual([
    "de https://example.de/about/",
    "en https://example.com/en/about/",
    "x-default https://example.com/en/about/",
  ]);
}, 120_000);
