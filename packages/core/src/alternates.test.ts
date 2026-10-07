import { expect, expectTypeOf, test } from "vitest";
import { localeAlternates, pageLinks, variantUrl } from "./alternates.js";
import type { LocaleAlternate } from "./alternates.js";
import type { Page } from "./pages.js";

function row(page: {
  locale: string;
  path: `/${string}`;
  domain?: string;
  declaredDomain?: string;
  output?: string;
  fallbackFrom?: string;
}): Page {
  return {
    locale: page.locale,
    path: page.path,
    domain: page.domain,
    declaredDomain: page.declaredDomain ?? page.domain,
    output: page.output ?? `/${page.locale}${page.path}`,
    fallbackFrom: page.fallbackFrom,
    dependencies: [],
  };
}

test("a path lists every locale that has it, each with its own tree and output", () => {
  const table = [
    row({ locale: "en", path: "/pricing" }),
    row({
      locale: "de",
      path: "/pricing",
      domain: "example.de",
      output: "/pricing",
    }),
  ];
  expect(localeAlternates(table).get("/pricing")).toEqual([
    { locale: "de", declaredDomain: "example.de", output: "/pricing" },
    { locale: "en", output: "/en/pricing" },
  ]);
});

test("a page lists itself, so the set is the whole hreflang set and not the rest of it", () => {
  const table = [row({ locale: "en", path: "/pricing" })];
  expect(localeAlternates(table).get("/pricing")).toEqual([
    { locale: "en", output: "/en/pricing" },
  ]);
});

test("a locale with no page at the path is absent, so no alternate points at a 404", () => {
  const table = [
    row({ locale: "en", path: "/about" }),
    row({ locale: "de", path: "/pricing" }),
    row({ locale: "en", path: "/pricing" }),
  ];
  expect(localeAlternates(table).get("/about")).toEqual([
    { locale: "en", output: "/en/about" },
  ]);
});

test("a fallback page is a variant like any other, because it is a real row", () => {
  const table = [
    row({ locale: "en", path: "/pricing" }),
    row({ locale: "de", path: "/pricing", fallbackFrom: "en" }),
  ];
  expect(localeAlternates(table).get("/pricing")).toEqual([
    { locale: "de", output: "/de/pricing" },
    { locale: "en", output: "/en/pricing" },
  ]);
});

test("two locales serving one page at two paths are not variants of each other", () => {
  const table = [
    row({ locale: "en", path: "/pricing" }),
    row({ locale: "de", path: "/preise" }),
  ];
  const alternates = localeAlternates(table);
  expect(alternates.get("/pricing")).toEqual([
    { locale: "en", output: "/en/pricing" },
  ]);
  expect(alternates.get("/preise")).toEqual([
    { locale: "de", output: "/de/preise" },
  ]);
});

const LOCALES = [
  { code: "de", domain: "example.de" },
  { code: "en", domain: undefined },
  { code: "fr", domain: "example.fr" },
] as const;
const PATHS = ["/a", "/b", "/c"] as const;

function everyTable(): Page[][] {
  const cells = LOCALES.flatMap((locale) =>
    PATHS.map((path) => ({ locale, path })),
  );
  return [...Array(2 ** cells.length).keys()].map((mask) =>
    cells
      .filter((_cell, index) => (mask & (1 << index)) !== 0)
      .map(({ locale, path }) =>
        row({
          locale: locale.code,
          path,
          domain: locale.domain,
          output: locale.domain === undefined ? `/${locale.code}${path}` : path,
        }),
      ),
  );
}

test("if one page lists another locale, that locale's page lists it back", () => {
  let pairs = 0;
  for (const table of everyTable()) {
    const alternates = localeAlternates(table);
    const listed = new Map(
      table.map((page) => [
        `${page.locale} ${page.path}`,
        new Set((alternates.get(page.path) ?? []).map((it) => it.locale)),
      ]),
    );
    for (const page of table) {
      for (const other of listed.get(`${page.locale} ${page.path}`) ?? []) {
        if (other === page.locale) continue;
        pairs += 1;
        expect(listed.get(`${other} ${page.path}`)).toContain(page.locale);
      }
    }
  }
  expect(pairs).toBeGreaterThan(0);
});

test("every generated table lists only locales that have a page at that path", () => {
  for (const table of everyTable()) {
    const present = new Set(table.map((page) => `${page.locale} ${page.path}`));
    for (const [path, variants] of localeAlternates(table)) {
      for (const variant of variants) {
        expect(present).toContain(`${variant.locale} ${path}`);
      }
    }
  }
});

test("two runs over one table are identical, whatever order its rows arrived in", () => {
  const table = [
    row({ locale: "en", path: "/pricing" }),
    row({
      locale: "fr",
      path: "/pricing",
      domain: "example.fr",
      output: "/pricing",
    }),
    row({ locale: "de", path: "/pricing", fallbackFrom: "en" }),
  ];
  const spell = (pages: readonly Page[]): string =>
    JSON.stringify([...localeAlternates(pages)]);
  expect(spell(table)).toEqual(spell(table));
  expect(spell([...table].reverse())).toEqual(spell(table));
});

test("a variant carries the parts of a URL and never a composed one", () => {
  expect(
    localeAlternates([
      row({
        locale: "de",
        path: "/pricing",
        domain: "example.de",
        output: "/pricing",
      }),
    ]).get("/pricing"),
  ).toEqual([{ locale: "de", declaredDomain: "example.de", output: "/pricing" }]);
  expectTypeOf<keyof LocaleAlternate>().toEqualTypeOf<
    "locale" | "declaredDomain" | "output"
  >();
});

test("a variant on the default tree is written at the origin's own host", () => {
  expect(variantUrl("https://example.com", { output: "/en/pricing" })).toBe(
    "https://example.com/en/pricing",
  );
});

test("a variant's domain replaces the host and keeps the origin's scheme", () => {
  expect(
    variantUrl("https://example.com", {
      declaredDomain: "example.de",
      output: "/pricing",
    }),
  ).toBe("https://example.de/pricing");
  expect(
    variantUrl("http://example.com", {
      declaredDomain: "example.de",
      output: "/pricing",
    }),
  ).toBe("http://example.de/pricing");
});

test("a port on the origin is carried onto every tree, domain-mapped included", () => {
  expect(
    variantUrl("http://example.com:8080", { output: "/en/pricing" }),
  ).toBe("http://example.com:8080/en/pricing");
  expect(
    variantUrl("http://example.com:8080", {
      declaredDomain: "example.de",
      output: "/pricing",
    }),
  ).toBe("http://example.de:8080/pricing");
});

test("the output is joined as it stands, under either trailing-slash policy", () => {
  expect(variantUrl("https://example.com", { output: "/de/pricing/" })).toBe(
    "https://example.com/de/pricing/",
  );
  expect(variantUrl("https://example.com", { output: "/" })).toBe(
    "https://example.com/",
  );
  expect(
    variantUrl("https://example.com", { output: "/a%20b/c%C3%A9" }),
  ).toBe("https://example.com/a%20b/c%C3%A9");
});

function links(input: {
  origin?: string;
  xDefault?: string;
  page: Page;
  table?: readonly Page[];
}): ReturnType<typeof pageLinks> {
  const table = input.table ?? [input.page];
  return pageLinks({
    origin: input.origin,
    xDefault: input.xDefault,
    page: input.page,
    variants: localeAlternates(table).get(input.page.path) ?? [],
  });
}

test("a site that declares no origin gets no links at all", () => {
  const page = row({ locale: "en", path: "/pricing" });
  expect(links({ page })).toBeUndefined();
});

test("a page canonicalizes to its own absolute URL", () => {
  const page = row({ locale: "en", path: "/pricing" });
  expect(links({ origin: "https://example.com", page })?.canonical).toBe(
    "https://example.com/en/pricing",
  );
});

test("a fallback page canonicalizes to itself and not to its supplier", () => {
  const en = row({ locale: "en", path: "/pricing" });
  const de = row({ locale: "de", path: "/pricing", fallbackFrom: "en" });
  expect(
    links({ origin: "https://example.com", page: de, table: [en, de] }),
  ).toEqual({
    canonical: "https://example.com/de/pricing",
    alternates: [
      { hreflang: "de", href: "https://example.com/de/pricing" },
      { hreflang: "en", href: "https://example.com/en/pricing" },
    ],
  });
});

test("a path with one variant gets a canonical and no hreflang links", () => {
  const page = row({ locale: "en", path: "/pricing" });
  expect(links({ origin: "https://example.com", page })).toEqual({
    canonical: "https://example.com/en/pricing",
    alternates: [],
  });
});

test("every variant is listed, the page's own included, in locale order", () => {
  const en = row({ locale: "en", path: "/pricing" });
  const de = row({
    locale: "de",
    path: "/pricing",
    domain: "example.de",
    output: "/pricing",
  });
  expect(
    links({ origin: "https://example.com", page: en, table: [en, de] })
      ?.alternates,
  ).toEqual([
    { hreflang: "de", href: "https://example.de/pricing" },
    { hreflang: "en", href: "https://example.com/en/pricing" },
  ]);
});

test("a page's links are written on its declared domain, never on its tree key", () => {
  const de = row({
    locale: "de",
    path: "/pricing",
    domain: "xn--mnchen-3ya.de",
    declaredDomain: "münchen.de",
    output: "/de/pricing",
  });
  const at = row({
    locale: "de-AT",
    path: "/pricing",
    domain: "xn--mnchen-3ya.de",
    output: "/de-AT/pricing",
  });
  expect(
    links({ origin: "https://example.com", page: de, table: [de, at] }),
  ).toEqual({
    canonical: "https://münchen.de/de/pricing",
    alternates: [
      { hreflang: "de", href: "https://münchen.de/de/pricing" },
      { hreflang: "de-AT", href: "https://xn--mnchen-3ya.de/de-AT/pricing" },
    ],
  });
});

test("x-default points at the locale the config names, and comes last", () => {
  const en = row({ locale: "en", path: "/pricing" });
  const de = row({ locale: "de", path: "/pricing" });
  expect(
    links({
      origin: "https://example.com",
      xDefault: "en",
      page: de,
      table: [en, de],
    })?.alternates,
  ).toEqual([
    { hreflang: "de", href: "https://example.com/de/pricing" },
    { hreflang: "en", href: "https://example.com/en/pricing" },
    { hreflang: "x-default", href: "https://example.com/en/pricing" },
  ]);
});

test("x-default is dropped on a path the named locale has no page at", () => {
  const de = row({ locale: "de", path: "/impressum" });
  const fr = row({ locale: "fr", path: "/impressum" });
  expect(
    links({
      origin: "https://example.com",
      xDefault: "en",
      page: de,
      table: [de, fr],
    })?.alternates,
  ).toEqual([
    { hreflang: "de", href: "https://example.com/de/impressum" },
    { hreflang: "fr", href: "https://example.com/fr/impressum" },
  ]);
});

test("x-default is silent on a one-variant path, like the set it belongs to", () => {
  const page = row({ locale: "en", path: "/pricing" });
  expect(
    links({ origin: "https://example.com", xDefault: "en", page })?.alternates,
  ).toEqual([]);
});
