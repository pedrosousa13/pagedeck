import { expect, test } from "vitest";
import { localeAlternates } from "./alternates.js";
import { defineLocales } from "./locales.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import { sitemapFaultReport, sitemapFiles } from "./sitemap.js";

const ORIGIN = "https://example.com";

function row(page: {
  locale: string;
  path: `/${string}`;
  domain?: string;
  output?: string;
}): Page {
  return {
    locale: page.locale,
    path: page.path,
    domain: page.domain,
    declaredDomain: page.domain,
    output: page.output ?? `/${page.locale}${page.path}`,
    dependencies: [],
  };
}

const LOCALES = defineLocales({
  en: { label: "English", direction: "ltr" },
  fr: { label: "Français", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
});

function byKey(files: readonly EmittedFile[]): ReadonlyMap<string, string> {
  return new Map(
    files.map((file) => [
      file.domain === undefined ? file.path : `//${file.domain}${file.path}`,
      typeof file.contents === "string"
        ? file.contents
        : new TextDecoder().decode(file.contents),
    ]),
  );
}

function build(
  input: Partial<Parameters<typeof sitemapFiles>[0]> = {},
): readonly EmittedFile[] {
  const pages = input.pages ?? [];
  return sitemapFiles({
    setting: { pattern: "suffix" },
    origin: ORIGIN,
    xDefault: undefined,
    locales: LOCALES,
    emitted: [],
    ...input,
    pages,
    alternates: input.alternates ?? localeAlternates(pages),
  });
}

test("the suffix pattern writes one sitemap per locale, named for the locale", () => {
  const files = build({ pages: [row({ locale: "en", path: "/pricing" })] });

  expect([...byKey(files).keys()].sort()).toEqual([
    "//example.de/sitemap-de.xml",
    "//example.de/sitemap.xml",
    "/sitemap-en.xml",
    "/sitemap-fr.xml",
    "/sitemap.xml",
  ]);
});

test("the directory pattern writes each locale's sitemap under its own segment", () => {
  const files = build({
    setting: { pattern: "directory" },
    pages: [row({ locale: "en", path: "/pricing" })],
  });

  expect([...byKey(files).keys()].sort()).toEqual([
    "//example.de/de/sitemap.xml",
    "//example.de/sitemap.xml",
    "/en/sitemap.xml",
    "/fr/sitemap.xml",
    "/sitemap.xml",
  ]);
});

test("a page's entry carries the URL this build emits it at", () => {
  const files = build({ pages: [row({ locale: "en", path: "/pricing" })] });

  expect(byKey(files).get("/sitemap-en.xml")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url>
<loc>https://example.com/en/pricing</loc>
</url>
</urlset>
`,
  );
});

test("an entry's alternates are the links the page's own head carries", () => {
  const files = build({
    xDefault: "en",
    pages: [
      row({ locale: "en", path: "/pricing" }),
      row({
        locale: "de",
        path: "/pricing",
        domain: "example.de",
        output: "/pricing",
      }),
    ],
  });

  expect(byKey(files).get("/sitemap-en.xml")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url>
<loc>https://example.com/en/pricing</loc>
<xhtml:link rel="alternate" hreflang="de" href="https://example.de/pricing"/>
<xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/pricing"/>
<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing"/>
</url>
</urlset>
`,
  );
});

test("a tree's index names that tree's sitemaps and no other tree's", () => {
  const files = build({
    pages: [
      row({ locale: "en", path: "/pricing" }),
      row({
        locale: "de",
        path: "/pricing",
        domain: "example.de",
        output: "/pricing",
      }),
    ],
  });
  const trees = byKey(files);

  expect(trees.get("/sitemap.xml")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
<loc>https://example.com/sitemap-en.xml</loc>
</sitemap>
<sitemap>
<loc>https://example.com/sitemap-fr.xml</loc>
</sitemap>
</sitemapindex>
`,
  );
  expect(trees.get("//example.de/sitemap.xml")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
<loc>https://example.de/sitemap-de.xml</loc>
</sitemap>
</sitemapindex>
`,
  );
});

test("entries are in a total order over the rows, not the order they arrived", () => {
  const paths = ["/pricing", "/about", "/", "/legal/terms"] as const;
  const forwards = build({
    pages: paths.map((path) => row({ locale: "en", path })),
  });
  const backwards = build({
    pages: [...paths].reverse().map((path) => row({ locale: "en", path })),
  });

  expect(byKey(forwards).get("/sitemap-en.xml")).toBe(
    byKey(backwards).get("/sitemap-en.xml"),
  );
  expect(
    [...(byKey(forwards).get("/sitemap-en.xml") ?? "").matchAll(
      /<loc>([^<]*)<\/loc>/g,
    )].map((match) => match[1]),
  ).toEqual([
    "https://example.com/en/",
    "https://example.com/en/about",
    "https://example.com/en/legal/terms",
    "https://example.com/en/pricing",
  ]);
});

test("a locale with no page gets an empty sitemap, so the index is the locale map", () => {
  const files = build({ pages: [row({ locale: "en", path: "/pricing" })] });

  expect(byKey(files).get("/sitemap-fr.xml")).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
</urlset>
`,
  );
});

test("a URL holding XML delimiters is escaped in both the text and the attribute", () => {
  const files = build({
    pages: [
      row({ locale: "en", path: "/a&b" }),
      row({ locale: "fr", path: "/a&b" }),
    ],
  });

  expect(byKey(files).get("/sitemap-en.xml")).toContain(
    "<loc>https://example.com/en/a&amp;b</loc>",
  );
  expect(byKey(files).get("/sitemap-en.xml")).toContain(
    'href="https://example.com/fr/a&amp;b"/>',
  );
});

test("a sitemap at a deploy key the build already wrote is refused, naming both", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/sitemap-en.xml", kind: "html", contents: "" },
  ];
  expect(() => build({ emitted })).toThrow(
    /"\/sitemap-en\.xml" — the build already emitted an html file there/,
  );
});

test("every colliding key is reported, not the first", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/sitemap-en.xml", kind: "html", contents: "" },
    { path: "/sitemap.xml", kind: "asset", contents: "" },
  ];
  let message = "";
  try {
    build({ emitted });
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain('"/sitemap-en.xml"');
  expect(message).toContain('"/sitemap.xml"');
});

test("a colliding directory-pattern site is offered the suffix pattern", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/en/sitemap.xml", kind: "html", contents: "" },
  ];
  expect(() => build({ setting: { pattern: "directory" }, emitted })).toThrow(
    /declare the other URL pattern — sitemap: \{ pattern: "suffix" \}/,
  );
});

test("a colliding suffix-pattern site is offered the directory pattern", () => {
  const emitted: readonly EmittedFile[] = [
    { path: "/sitemap-en.xml", kind: "html", contents: "" },
  ];
  expect(() => build({ emitted })).toThrow(
    /declare the other URL pattern — sitemap: \{ pattern: "directory" \}/,
  );
});

test("a sitemap setting that is not an object is refused with the shape as the fix", () => {
  expect(sitemapFaultReport(true, ORIGIN, "Config")).toBe(
    'Config: "build.sitemap" must be an object naming the URL pattern its files take — sitemap: { pattern: "suffix" }',
  );
});

test("a pattern that is neither of the two is refused, naming both", () => {
  expect(sitemapFaultReport({ pattern: "flat" }, ORIGIN, "Config")).toContain(
    '"pattern" — "flat" — not a sitemap URL pattern',
  );
});

test("a sitemap declared without an origin is refused, because a loc is absolute", () => {
  expect(
    sitemapFaultReport({ pattern: "suffix" }, undefined, "Config"),
  ).toContain('"build.sitemap" is declared without "build.origin"');
});

test("a misspelled pattern and a missing origin are one report, two paragraphs", () => {
  const report = sitemapFaultReport({ pattern: "flat" }, undefined, "Config");

  expect(report).toBe(
    `Config: "build.sitemap" declares 1 field this build cannot write sitemaps from — declare each as the type its own line names:\n  "pattern" — "flat" — not a sitemap URL pattern — write "suffix" for /sitemap-en.xml, or "directory" for /en/sitemap.xml\n\nConfig: "build.sitemap" is declared without "build.origin", and every <loc> a sitemap holds is an absolute URL — declare origin: "https://example.com", or remove sitemap`,
  );
});

test("a valid setting reports nothing", () => {
  expect(sitemapFaultReport({ pattern: "directory" }, ORIGIN, "Config")).toBe(
    undefined,
  );
});
