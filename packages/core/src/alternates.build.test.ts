import {
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
import type { ManifestPage } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const ORIGIN = "https://example.com";
const PLAIN_SITE = join(SITES, ".pagedeck-alternates-plain-test");
const LINKED_SITE = join(SITES, ".pagedeck-alternates-linked-test");

const CONTENT: Record<string, readonly string[]> = {
  en: ["home", "pricing", "about"],
  de: ["home", "pricing", "impressum"],
  fr: ["home"],
};

const COMPONENT = `export default function Copy() { return "marker-copy-6a04"; }\n`;

function site(root: string, build = ""): string {
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
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
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
  return root;
}

const DECLARED = `origin: ${JSON.stringify(ORIGIN)},\n    xDefault: "en",`;

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
  readonly documents: ReadonlyMap<string, string>;
  readonly pages: readonly ManifestPage[];
}

const built = new Map<string, Promise<Built>>();

function build(root: string, declared = ""): Promise<Built> {
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
    pages: manifest.pages,
  };
}

afterAll(() => {
  for (const root of [PLAIN_SITE, LINKED_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

function linkLines(html: string): readonly string[] {
  return html
    .split("\n")
    .filter((line) => /^<link rel="(canonical|alternate)"/.test(line));
}

function hreflangs(html: string): ReadonlyMap<string, string> {
  return new Map(
    linkLines(html)
      .map((line) => /hreflang="([^"]*)" href="([^"]*)"/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
}

function canonical(html: string): string {
  return /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1] ?? "";
}

test("a build with a domain tree writes one manifest, at the root of outDir (#556)", async () => {
  const plain = await build(PLAIN_SITE);
  expect(plain.pages.some((page) => page.domain === "example.de")).toBe(true);
  const manifests = readdirSync(join(PLAIN_SITE, "dist"), {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => file.split(/[\\/]/).includes("manifest.json"));
  expect(manifests).toEqual(["manifest.json"]);
}, 120_000);

test("a site that declares no origin emits the document it always did", async () => {
  const plain = await build(PLAIN_SITE);
  expect(plain.documents.size).toBe(9);
  for (const html of plain.documents.values()) {
    expect(linkLines(html)).toEqual([]);
  }
}, 120_000);

test("declaring an origin adds these links and moves nothing else", async () => {
  const plain = await build(PLAIN_SITE);
  const linked = await build(LINKED_SITE, DECLARED);

  expect([...linked.documents.keys()].sort()).toEqual(
    [...plain.documents.keys()].sort(),
  );
  for (const [key, html] of linked.documents) {
    const stripped = html
      .split("\n")
      .filter((line) => !/^<link rel="(canonical|alternate)"/.test(line))
      .join("\n");
    expect(`${key}: ${stripped}`).toBe(`${key}: ${plain.documents.get(key) ?? ""}`);
  }
}, 120_000);

test("a page's alternates are every variant that exists, on the right domain", async () => {
  const linked = await build(LINKED_SITE, DECLARED);

  expect(linkLines(linked.documents.get("en /pricing") ?? "")).toEqual([
    '<link rel="canonical" href="https://example.com/en/pricing">',
    '<link rel="alternate" hreflang="de" href="https://example.de/pricing">',
    '<link rel="alternate" hreflang="en" href="https://example.com/en/pricing">',
    '<link rel="alternate" hreflang="fr" href="https://example.com/fr/pricing">',
    '<link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing">',
  ]);
  expect(linkLines(linked.documents.get("de /pricing") ?? "")).toEqual([
    '<link rel="canonical" href="https://example.de/pricing">',
    '<link rel="alternate" hreflang="de" href="https://example.de/pricing">',
    '<link rel="alternate" hreflang="en" href="https://example.com/en/pricing">',
    '<link rel="alternate" hreflang="fr" href="https://example.com/fr/pricing">',
    '<link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing">',
  ]);
}, 120_000);

test("a fallback page canonicalizes to itself and lists its supplier", async () => {
  const linked = await build(LINKED_SITE, DECLARED);
  const page = linked.pages.find(
    (row) => row.locale === "fr" && row.path === "/pricing",
  );
  expect(page?.fallbackFrom).toBe("en");

  const html = linked.documents.get("fr /pricing") ?? "";
  expect(canonical(html)).toBe("https://example.com/fr/pricing");
  expect(hreflangs(html).get("fr")).toBe("https://example.com/fr/pricing");
}, 120_000);

test("a locale with no page at a path is in no page's alternates", async () => {
  const linked = await build(LINKED_SITE, DECLARED);

  expect(linked.documents.has("de /about")).toBe(false);
  for (const locale of ["en", "fr"]) {
    expect([
      ...hreflangs(linked.documents.get(`${locale} /about`) ?? "").keys(),
    ]).toEqual(["en", "fr", "x-default"]);
  }
}, 120_000);

test("a path only one locale has gets a canonical and no annotation", async () => {
  const linked = await build(LINKED_SITE, DECLARED);

  expect(linkLines(linked.documents.get("de /impressum") ?? "")).toEqual([
    '<link rel="canonical" href="https://example.de/impressum">',
  ]);
}, 120_000);

test("x-default is absent from a path its locale has no page at", async () => {
  const linked = await build(LINKED_SITE, DECLARED);
  const html = linked.documents.get("de /impressum") ?? "";

  expect(html).not.toContain("x-default");
}, 120_000);

test("every href a document writes is a URL this build emitted", async () => {
  const linked = await build(LINKED_SITE, DECLARED);
  const emitted = new Set(
    linked.pages.map(
      (page) => `${page.domain ?? "example.com"}${page.output}`,
    ),
  );
  expect(emitted.size).toBe(9);

  let checked = 0;
  for (const html of linked.documents.values()) {
    for (const href of [
      canonical(html),
      ...hreflangs(html).values(),
    ]) {
      const url = new URL(href);
      expect(url.protocol).toBe("https:");
      expect(emitted).toContain(`${url.host}${url.pathname}`);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(20);
}, 120_000);

test("if one document lists another locale, that locale's document lists it back", async () => {
  const linked = await build(LINKED_SITE, DECLARED);
  const byHref = new Map(
    linked.pages.map((page) => [
      `${ORIGIN.replace("example.com", page.domain ?? "example.com")}${page.output}`,
      linked.documents.get(`${page.locale} ${page.path}`) ?? "",
    ]),
  );

  let pairs = 0;
  for (const [key, html] of linked.documents) {
    const self = canonical(html);
    for (const [hreflang, href] of hreflangs(html)) {
      if (hreflang === "x-default") continue;
      if (href === self) continue;
      pairs += 1;
      const other = byHref.get(href) ?? "";
      expect(`${key} -> ${href}`).toBe(`${key} -> ${canonical(other)}`);
      expect([...hreflangs(other).values()]).toContain(self);
    }
  }
  expect(pairs).toBeGreaterThan(0);
}, 120_000);
