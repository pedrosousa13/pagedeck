import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import {
  budgetFaultReport,
  budgetReportJson,
  checkBudgets,
  DEFAULT_ISLAND_PROPS_BUDGET,
  islandPropsBudgetFaultReport,
  islandPropsLimit,
  planBudgets,
  weighIslandProps,
} from "./budgets.js";
import type {
  BudgetChunk,
  BudgetStylesheet,
  IslandPropsBudget,
} from "./budgets.js";
import { ConfigError } from "./exit.js";
import { islandMarker, islandProps } from "./tree.js";

const STAMP = { id: "b1", createdAt: "2026-08-29T10:00:00.000Z" };

const CHUNKS: readonly BudgetChunk[] = [
  { path: "/assets/en_pricing-1111.js", imports: ["/assets/fw-core-2222.js"], bytes: 400 },
  { path: "/assets/fw-core-2222.js", imports: ["/assets/vendor-3333.js"], bytes: 1000 },
  { path: "/assets/vendor-3333.js", imports: [], bytes: 100 },
  { path: "/assets/orphan-4444.js", imports: [], bytes: 9000 },
  { path: "/assets/eager-5555.js", imports: ["/assets/vendor-3333.js"], bytes: 2000 },
  { path: "/assets/lazy-6666.js", imports: [], bytes: 5000 },
];

const ENTRIES = new Map([["en /pricing", "/assets/en_pricing-1111.js"]]);

const STYLESHEETS: readonly BudgetStylesheet[] = [
  { path: "/assets/fw-core-2222.css", bytes: 700 },
  { path: "/assets/en_pricing-1111.css", bytes: 300 },
  { path: "/assets/unlinked-7777.css", bytes: 40_000 },
];

const STYLES = new Map([
  [
    "en /pricing",
    ["/assets/fw-core-2222.css", "/assets/en_pricing-1111.css"],
  ],
]);

const NO_ISLAND_PROPS: IslandPropsBudget = {
  ...islandPropsLimit(undefined),
  byPage: new Map(),
};

const HTML = new Map([
  ["en /pricing", 250],
  ["en /about", 180],
]);

function report(
  budget: Record<string, string>,
  pages = [{ locale: "en", path: "/pricing" }],
  eagerChunksByPage: ReadonlyMap<string, readonly string[]> = new Map(),
  assets: {
    stylesheets?: readonly BudgetStylesheet[];
    stylesheetsByPage?: ReadonlyMap<string, readonly string[]>;
    inlinedPages?: ReadonlySet<string>;
    inlinedStylesheetsByPage?: ReadonlyMap<string, readonly string[]>;
    causesByPage?: ReadonlyMap<string, readonly string[]>;
    htmlBytesByPage?: ReadonlyMap<string, number>;
    inlinedScriptBytesByPage?: ReadonlyMap<string, number>;
    islandProps?: IslandPropsBudget;
  } = {},
) {
  return planBudgets({
    build: STAMP,
    budget,
    pages,
    inlinedPages: assets.inlinedPages ?? new Set(),
    entryChunkByPage: ENTRIES,
    eagerChunksByPage,
    chunks: CHUNKS,
    stylesheets: assets.stylesheets ?? STYLESHEETS,
    stylesheetsByPage: assets.stylesheetsByPage ?? STYLES,
    inlinedStylesheetsByPage: assets.inlinedStylesheetsByPage ?? new Map(),
    causesByPage: assets.causesByPage ?? new Map(),
    htmlBytesByPage: assets.htmlBytesByPage ?? HTML,
    inlinedScriptBytesByPage: assets.inlinedScriptBytesByPage ?? new Map(),
    islandProps: assets.islandProps ?? NO_ISLAND_PROPS,
  });
}

test("a page's spend is its entry chunk plus its static closure, each chunk once", () => {
  const row = report({ "/pricing": "15kb" }).pages[0];

  expect(row?.actual).toBe(1500);
  expect(row?.chunks).toEqual([
    { path: "/assets/fw-core-2222.js", bytes: 1000 },
    { path: "/assets/en_pricing-1111.js", bytes: 400 },
    { path: "/assets/vendor-3333.js", bytes: 100 },
  ]);
  expect(row?.limit).toBe(15 * 1024);
  expect(row?.breach).toBe(false);
});

test("two pages that share one entry chunk are each charged all of it", () => {
  const shared = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/pricing": "15kb", "/checkout": "15kb" },
    pages: [
      { locale: "en", path: "/pricing" },
      { locale: "en", path: "/checkout" },
    ],
    entryChunkByPage: new Map([
      ["en /pricing", "/assets/en_pricing-1111.js"],
      ["en /checkout", "/assets/en_pricing-1111.js"],
    ]),
    eagerChunksByPage: new Map(),
    chunks: CHUNKS,
    stylesheets: [],
    stylesheetsByPage: new Map(),
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  });

  expect(shared.pages.map((page) => [page.path, page.actual])).toEqual([
    ["/pricing", 1500],
    ["/checkout", 1500],
  ]);
});

test("an eagerly hydrated island's chunk and its static closure count", () => {
  const row = report(
    { "/pricing": "15kb" },
    undefined,
    new Map([["en /pricing", ["/assets/eager-5555.js"]]]),
  ).pages[0];

  expect(row?.actual).toBe(3500);
  expect(row?.chunks).toEqual([
    { path: "/assets/eager-5555.js", bytes: 2000 },
    { path: "/assets/fw-core-2222.js", bytes: 1000 },
    { path: "/assets/en_pricing-1111.js", bytes: 400 },
    { path: "/assets/vendor-3333.js", bytes: 100 },
  ]);
});

test("a lazily hydrated island's chunk is not a first-render transfer", () => {
  const row = report({ "/pricing": "15kb" }).pages[0];

  expect(row?.chunks.map((chunk) => chunk.path)).not.toContain(
    "/assets/lazy-6666.js",
  );
  expect(row?.actual).toBe(1500);
});

test("a page with no entry chunk reports 0 and trivially passes", () => {
  const rows = report(
    { "/about": "0b" },
    [{ locale: "en", path: "/about" }],
  ).pages;

  expect(rows).toEqual([
    {
      locale: "en",
      path: "/about",
      pattern: "/about",
      limitText: "0b",
      limit: 0,
      actual: 0,
      jsInlined: 0,
      css: 0,
      cssInlined: 0,
      html: 180,
      breach: false,
      chunks: [],
      causes: [],
      largestIslandProps: 0,
      islandPropsBreaches: [],
    },
  ]);
  expect(() => {
    checkBudgets(report({ "/about": "0b" }, [{ locale: "en", path: "/about" }]));
  }).not.toThrow();
});

test("a page's CSS figure is every stylesheet it links, each once, and its HTML figure is its own document", () => {
  const row = report({ "/pricing": "15kb" }, undefined, undefined, {
    stylesheetsByPage: new Map([
      [
        "en /pricing",
        [
          "/assets/fw-core-2222.css",
          "/assets/en_pricing-1111.css",
          "/assets/fw-core-2222.css",
        ],
      ],
    ]),
  }).pages[0];

  expect(row?.css).toBe(1000);
  expect(row?.html).toBe(250);
  expect(row?.actual).toBe(1500);
});

test("an enormous CSS payload never breaches a JavaScript budget", () => {
  const huge = report({ "/pricing": "15kb" }, undefined, undefined, {
    stylesheets: [{ path: "/assets/huge.css", bytes: 5_000_000 }],
    stylesheetsByPage: new Map([["en /pricing", ["/assets/huge.css"]]]),
    inlinedStylesheetsByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map([["en /pricing", 2_000_000]]),
  });
  const row = huge.pages[0];

  expect(row?.css).toBe(5_000_000);
  expect(row?.html).toBe(2_000_000);
  expect(row?.actual).toBe(1500);
  expect(row?.breach).toBe(false);
  expect(() => {
    checkBudgets(huge);
  }).not.toThrow();
});

test("an enormous inlined CSS payload never breaches a JavaScript budget", () => {
  const huge = report({ "/pricing": "15kb" }, undefined, undefined, {
    stylesheets: [{ path: "/assets/huge.css", bytes: 5_000_000 }],
    stylesheetsByPage: new Map(),
    inlinedStylesheetsByPage: new Map([
      ["en /pricing", ["/assets/huge.css", "/assets/huge.css"]],
    ]),
  });
  const row = huge.pages[0];

  expect(row?.cssInlined).toBe(5_000_000);
  expect(row?.css).toBe(0);
  expect(row?.actual).toBe(1500);
  expect(row?.breach).toBe(false);
  expect(() => {
    checkBudgets(huge);
  }).not.toThrow();
});

test("a page over its JavaScript limit breaches whatever its CSS weighs", () => {
  const breaching = report({ "/pricing": "1kb" }, undefined, undefined, {
    stylesheets: [{ path: "/assets/tiny.css", bytes: 1 }],
    stylesheetsByPage: new Map([["en /pricing", ["/assets/tiny.css"]]]),
  });

  expect(breaching.pages[0]?.breach).toBe(true);
  expect(() => {
    checkBudgets(breaching);
  }).toThrow(ConfigError);
});

test("a page's inlined JavaScript is in its spend and can breach on its own", () => {
  const inlined = report({ "/pricing": "2kb" }, undefined, undefined, {
    inlinedScriptBytesByPage: new Map([["en /pricing", 600]]),
  });
  const row = inlined.pages[0];

  expect(row?.jsInlined).toBe(600);
  expect(row?.actual).toBe(2100);
  expect(row?.breach).toBe(true);
  expect(() => {
    checkBudgets(inlined);
  }).toThrow(ConfigError);
});

test("a page with no chunks at all still spends what it inlined", () => {
  const zero = report(
    { "/about": "0b" },
    [{ locale: "en", path: "/about" }],
    undefined,
    { inlinedScriptBytesByPage: new Map([["en /about", 365]]) },
  );
  const row = zero.pages[0];

  expect(row?.chunks).toEqual([]);
  expect(row?.jsInlined).toBe(365);
  expect(row?.actual).toBe(365);
  expect(row?.breach).toBe(true);
});

test("a breach names inlined bytes on a line of their own, apart from the chunks", () => {
  const breaching = report({ "/pricing": "1kb" }, undefined, undefined, {
    inlinedScriptBytesByPage: new Map([["en /pricing", 600]]),
  });

  let thrown: unknown;
  try {
    checkBudgets(breaching);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as Error).message).toContain(
    `  en /pricing — "/pricing" allows 1024 B, the page transfers 2100 B, 1500 B of it over 3 chunks and 600 B inlined into its document:
    /assets/fw-core-2222.js — 1000 B
    /assets/en_pricing-1111.js — 400 B
    /assets/vendor-3333.js — 100 B
    inlined into the document — 600 B`,
  );
});

test("a chunkless page's headline attributes its whole spend to what it inlined", () => {
  const zero = report(
    { "/about": "0b" },
    [{ locale: "en", path: "/about" }],
    undefined,
    { inlinedScriptBytesByPage: new Map([["en /about", 365]]) },
  );

  let thrown: unknown;
  try {
    checkBudgets(zero);
  } catch (error) {
    thrown = error;
  }
  const message = (thrown as Error).message;
  expect(message).toContain(
    `  en /about — "/about" allows 0 B, the page transfers 365 B, all of it inlined into its document:
    inlined into the document — 365 B`,
  );
  expect(message).not.toContain("chunk");
});

test("a page that inlines nothing spends its chunks and prints no inlined line", () => {
  const breaching = report({ "/pricing": "1kb" });

  expect(breaching.pages[0]?.jsInlined).toBe(0);
  expect(breaching.pages[0]?.actual).toBe(1500);

  let thrown: unknown;
  try {
    checkBudgets(breaching);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as Error).message).not.toContain("inlined into the document");
});

test("a page no pattern matches is left out of the report", () => {
  expect(report({ "/blog": "1kb" }).pages).toEqual([]);
});

test("a flagged page with no matching budget pattern still gets a row", () => {
  const rows = report({}, [{ locale: "en", path: "/pricing" }], undefined, {
    inlinedPages: new Set(["en /pricing"]),
    stylesheetsByPage: new Map(),
    inlinedStylesheetsByPage: new Map([
      ["en /pricing", ["/assets/fw-core-2222.css"]],
    ]),
  }).pages;

  expect(rows).toEqual([
    {
      locale: "en",
      path: "/pricing",
      actual: 1500,
      jsInlined: 0,
      css: 0,
      cssInlined: 700,
      html: 250,
      breach: false,
      chunks: [
        { path: "/assets/fw-core-2222.js", bytes: 1000 },
        { path: "/assets/en_pricing-1111.js", bytes: 400 },
        { path: "/assets/vendor-3333.js", bytes: 100 },
      ],
      causes: [],
      largestIslandProps: 0,
      islandPropsBreaches: [],
    },
  ]);
  expect("limit" in (rows[0] as object)).toBe(false);
});

test("flagging a page cannot give it a limit it can breach", () => {
  const flagged = report({}, [{ locale: "en", path: "/pricing" }], undefined, {
    inlinedPages: new Set(["en /pricing"]),
    stylesheets: [{ path: "/assets/huge.css", bytes: 5_000_000 }],
    stylesheetsByPage: new Map(),
    inlinedStylesheetsByPage: new Map([["en /pricing", ["/assets/huge.css"]]]),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map([["en /pricing", 5_000_000]]),
  });

  expect(flagged.pages[0]?.cssInlined).toBe(5_000_000);
  expect(flagged.pages[0]?.breach).toBe(false);
  expect(() => {
    checkBudgets(flagged);
  }).not.toThrow();
});

test("a budgeted page and a flagged page share one report", () => {
  const rows = report(
    { "/about": "1kb" },
    [
      { locale: "en", path: "/pricing" },
      { locale: "en", path: "/about" },
    ],
    undefined,
    { inlinedPages: new Set(["en /pricing"]) },
  ).pages;

  expect(rows.map((row) => [row.path, row.pattern])).toEqual([
    ["/pricing", undefined],
    ["/about", "/about"],
  ]);
});

test("* matches within one segment and ** across them", () => {
  const pages = [
    { locale: "en", path: "/blog/a" },
    { locale: "en", path: "/blog/2026/a" },
  ];
  const within = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/blog/*": "1kb" },
    pages,
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  });
  expect(within.pages.map((row) => row.path)).toEqual(["/blog/a"]);

  const across = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/blog/**": "1kb" },
    pages,
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  });
  expect(across.pages.map((row) => row.path)).toEqual([
    "/blog/a",
    "/blog/2026/a",
  ]);
});

test("an unscoped pattern applies to every locale and a scoped one to its own", () => {
  const pages = [
    { locale: "en", path: "/pricing" },
    { locale: "de", path: "/pricing" },
  ];
  const rows = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/pricing": "1kb", "de:/pricing": "2kb" },
    pages,
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  }).pages;

  expect(rows.map((row) => [row.locale, row.pattern, row.limit])).toEqual([
    ["en", "/pricing", 1024],
    ["de", "de:/pricing", 2048],
  ]);
});

test("the most specific pattern wins: scope first, then literal characters, then wildcards", () => {
  const pages = [{ locale: "en", path: "/blog/2026/hello" }];
  const rows = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: {
      "/**": "1kb",
      "/blog/**": "2kb",
      "/blog/*/hello": "3kb",
    },
    pages,
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  }).pages;

  expect(rows[0]?.pattern).toBe("/blog/*/hello");
});

test("a single-segment * beats a same-length **, and the pair is not a fault", () => {
  expect(
    budgetFaultReport({ "/blog/*": "10kb", "/blog/**": "20kb" }, "Config"),
  ).toBeUndefined();

  const rows = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/blog/*": "10kb", "/blog/**": "20kb" },
    pages: [
      { locale: "en", path: "/blog/hello" },
      { locale: "en", path: "/blog/2026/hello" },
    ],
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  }).pages;

  expect(rows.map((row) => [row.path, row.pattern])).toEqual([
    ["/blog/hello", "/blog/*"],
    ["/blog/2026/hello", "/blog/**"],
  ]);
});

test("the documented pattern examples cover the pages the doc says they do", () => {
  const pages = [
    { locale: "en", path: "/pricing" },
    { locale: "de", path: "/pricing" },
    { locale: "en", path: "/blog" },
    { locale: "en", path: "/blog/hello" },
    { locale: "de", path: "/blog/hello" },
    { locale: "de", path: "/blog/2026/hello" },
  ];
  const covered = (budget: Record<string, string>) =>
    planBudgets({
      build: STAMP,
      islandProps: NO_ISLAND_PROPS,
      budget,
      pages,
      entryChunkByPage: new Map(),
      eagerChunksByPage: new Map(),
      chunks: [],
      stylesheetsByPage: new Map(),
      stylesheets: [],
      inlinedPages: new Set(),
      inlinedStylesheetsByPage: new Map(),
      causesByPage: new Map(),
      inlinedScriptBytesByPage: new Map(),
      htmlBytesByPage: new Map(),
    }).pages.map((row) => `${row.locale} ${row.path}`);

  expect(covered({ "/pricing": "1kb" })).toEqual(["en /pricing", "de /pricing"]);
  expect(covered({ "en:/pricing": "1kb" })).toEqual(["en /pricing"]);
  expect(covered({ "/blog/**": "1kb" })).toEqual([
    "en /blog",
    "en /blog/hello",
    "de /blog/hello",
    "de /blog/2026/hello",
  ]);
  expect(covered({ "de:/blog/*": "1kb" })).toEqual(["de /blog/hello"]);
});

test("a size is a number and one of b, kb or mb, and kb is 1024 bytes", () => {
  const rows = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "en:/a": "900b", "en:/b": "15kb", "en:/c": "1.5mb", "en:/d": "2MB" },
    pages: [
      { locale: "en", path: "/a" },
      { locale: "en", path: "/b" },
      { locale: "en", path: "/c" },
      { locale: "en", path: "/d" },
    ],
    entryChunkByPage: new Map(),
    eagerChunksByPage: new Map(),
    chunks: [],
    stylesheetsByPage: new Map(),
    stylesheets: [],
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  }).pages;

  expect(rows.map((row) => row.limit)).toEqual([
    900,
    15 * 1024,
    1.5 * 1024 * 1024,
    2 * 1024 * 1024,
  ]);
});

test("the report is deterministic JSON, in route-table order, carrying the build stamp", () => {
  const json = budgetReportJson(report({ "/pricing": "15kb" }));

  expect(JSON.parse(json)).toEqual({
    version: 2,
    build: STAMP,
    islandPropsLimit: islandPropsLimit(undefined),
    pages: [
      {
        locale: "en",
        path: "/pricing",
        pattern: "/pricing",
        limitText: "15kb",
        limit: 15360,
        actual: 1500,
        jsInlined: 0,
        css: 1000,
        cssInlined: 0,
        html: 250,
        breach: false,
        chunks: [
          { path: "/assets/fw-core-2222.js", bytes: 1000 },
          { path: "/assets/en_pricing-1111.js", bytes: 400 },
          { path: "/assets/vendor-3333.js", bytes: 100 },
        ],
        causes: [],
        largestIslandProps: 0,
        islandPropsBreaches: [],
      },
    ],
  });
  expect(json.endsWith("\n")).toBe(true);
});

test("a breach reports every page, its limit, its spend and the largest contributors", () => {
  const breaching = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/pricing": "1kb", "/checkout": "1b" },
    pages: [
      { locale: "en", path: "/pricing" },
      { locale: "en", path: "/checkout" },
    ],
    entryChunkByPage: new Map([
      ["en /pricing", "/assets/en_pricing-1111.js"],
      ["en /checkout", "/assets/orphan-4444.js"],
    ]),
    eagerChunksByPage: new Map(),
    chunks: CHUNKS,
    stylesheets: STYLESHEETS,
    stylesheetsByPage: STYLES,
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: HTML,
  });

  let thrown: unknown;
  try {
    checkBudgets(breaching);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `JavaScript budget: 2 pages transfer more JavaScript for first render than their budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /pricing — "/pricing" allows 1024 B, the page transfers 1500 B over 3 chunks:
    /assets/fw-core-2222.js — 1000 B
    /assets/en_pricing-1111.js — 400 B
    /assets/vendor-3333.js — 100 B
  en /checkout — "/checkout" allows 1 B, the page transfers 9000 B over 1 chunk:
    /assets/orphan-4444.js — 9000 B`,
  );
});

test("the breach report names the three largest contributors and no more", () => {
  const many: BudgetChunk[] = [
    { path: "/assets/e.js", imports: ["/a.js", "/b.js", "/c.js", "/d.js"], bytes: 1 },
    { path: "/a.js", imports: [], bytes: 40 },
    { path: "/b.js", imports: [], bytes: 30 },
    { path: "/c.js", imports: [], bytes: 20 },
    { path: "/d.js", imports: [], bytes: 10 },
  ];
  const breaching = planBudgets({
    build: STAMP,
    islandProps: NO_ISLAND_PROPS,
    budget: { "/x": "1b" },
    pages: [{ locale: "en", path: "/x" }],
    entryChunkByPage: new Map([["en /x", "/assets/e.js"]]),
    eagerChunksByPage: new Map(),
    chunks: many,
    stylesheets: [],
    stylesheetsByPage: new Map(),
    inlinedPages: new Set(),
    inlinedStylesheetsByPage: new Map(),
    causesByPage: new Map(),
    inlinedScriptBytesByPage: new Map(),
    htmlBytesByPage: new Map(),
  });

  expect(() => {
    checkBudgets(breaching);
  }).toThrow(
    `over 5 chunks, the 3 largest:
    /a.js — 40 B
    /b.js — 30 B
    /c.js — 20 B`,
  );
});

test("a budget that is not an object, a bad size and a bad pattern are all reported at once", () => {
  expect(budgetFaultReport("15kb", 'Config "/site/pagedeck.config.ts"')).toBe(
    `Config "/site/pagedeck.config.ts": "build.budget" must be an object — budget: { "/pricing": "15kb" }`,
  );

  expect(
    budgetFaultReport(
      { "/pricing": "big", "en:/blog": 15, pricing: "1kb" },
      'Config "/site/pagedeck.config.ts"',
    ),
  ).toBe(
    `Config "/site/pagedeck.config.ts": "build.budget" declares 2 limits that are not sizes — write a number and a unit, one of b, kb or mb, such as "15kb":
  "/pricing" — "big"
  "en:/blog" — not a string

Config "/site/pagedeck.config.ts": "build.budget" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  "pricing" — the path does not start with "/"`,
  );
});

test("a colon-less key too short to hold a scope is reported as a missing slash", () => {
  expect(budgetFaultReport({ "": "1kb", x: "1kb" }, "Config")).toBe(
    `Config: "build.budget" declares 2 keys that are not page patterns — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  "" — the path does not start with "/"
  "x" — the path does not start with "/"`,
  );
});

test("a key whose locale scope is empty says so", () => {
  expect(budgetFaultReport({ ":/pricing": "1kb" }, "Config")).toBe(
    `Config: "build.budget" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  ":/pricing" — the locale scope before ":" is empty`,
  );
});

test("a key with both faults is reported as the one that refused it", () => {
  expect(budgetFaultReport({ ":x": "1kb" }, "Config")).toBe(
    `Config: "build.budget" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  ":x" — the path does not start with "/"`,
  );
});

test("two equally specific patterns that disagree are a config fault naming both and a page they share", () => {
  expect(
    budgetFaultReport(
      { "/a/*": "1kb", "/*/b": "2kb" },
      'Config "/site/pagedeck.config.ts"',
    ),
  ).toBe(
    `Config "/site/pagedeck.config.ts": "build.budget" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same limit:
  "/a/*" and "/*/b" — equally specific, and both match "/a/b"`,
  );
});

test("two equally specific patterns that agree are not a fault", () => {
  expect(
    budgetFaultReport({ "/a/*": "1kb", "/*/b": "1kb" }, "Config"),
  ).toBeUndefined();
});

test("patterns scoped to different locales never collide", () => {
  expect(
    budgetFaultReport({ "en:/a/*": "1kb", "de:/*/b": "2kb" }, "Config"),
  ).toBeUndefined();
});

test("a valid budget reports no faults", () => {
  expect(
    budgetFaultReport({ "/pricing": "15kb", "en:/**": "200kb" }, "Config"),
  ).toBeUndefined();
});

const PROPS_LIMIT = { limitText: "1kb", limit: 1024 };

function markerFor(
  component: string,
  prefix: string,
  props: Record<string, unknown>,
): string {
  const payload = islandProps(props, component);
  if (!("props" in payload)) throw new Error("props did not serialize");
  return renderToStaticMarkup(
    islandMarker(
      { island: { component, mode: "load", prefix, html: "<p>x</p>" }, props: payload.props },
      "0",
    ),
  );
}

test("an island's props weigh the UTF-8 bytes islandProps serialized, not the escaped marker", () => {
  const props = { quote: `"<&>'`, accent: "café", emoji: "🙂" };
  const html = markerFor("Widget", "i0123456789ab", props);
  const serialized = (islandProps(props, "Widget") as { props: string }).props;

  expect(html).toContain("&quot;");
  const weighed = weighIslandProps(html, 1_000_000);
  expect(weighed.largest).toBe(Buffer.byteLength(serialized, "utf8"));
  expect(weighed.largest).toBeGreaterThan(serialized.length);
  expect(weighed.breaches).toEqual([]);
});

test("a page's figure is its largest island, and a page with none weighs 0", () => {
  const html =
    markerFor("Small", "i000000000001", { a: "x" }) +
    markerFor("Large", "i000000000002", { a: "x".repeat(50) });

  expect(weighIslandProps(html, 1_000_000).largest).toBe(
    Buffer.byteLength(JSON.stringify({ a: "x".repeat(50) })),
  );
  expect(weighIslandProps("<main><p>static</p></main>", 0)).toEqual({
    largest: 0,
    breaches: [],
  });
});

test("every island over the limit is a breach, listing its top-level props largest first", () => {
  const html =
    markerFor("Picker", "i000000000001", { label: "Size", entry: { body: "y".repeat(80) } }) +
    markerFor("Fine", "i000000000002", { label: "ok" }) +
    markerFor("Bigger", "i000000000003", { entry: "z".repeat(200) });

  expect(weighIslandProps(html, 64).breaches).toEqual([
    {
      component: "Bigger",
      prefix: "i000000000003",
      bytes: Buffer.byteLength(JSON.stringify({ entry: "z".repeat(200) })),
      props: [{ name: "entry", bytes: 202 }],
    },
    {
      component: "Picker",
      prefix: "i000000000001",
      bytes: Buffer.byteLength(
        JSON.stringify({ label: "Size", entry: { body: "y".repeat(80) } }),
      ),
      props: [
        { name: "entry", bytes: 91 },
        { name: "label", bytes: 6 },
      ],
    },
  ]);
});

test("each row carries its largest island props, and a breaching page gets a row without a budget", () => {
  const rows = report({ "/pricing": "15kb" }, [
    { locale: "en", path: "/pricing" },
    { locale: "en", path: "/about" },
    { locale: "en", path: "/quiet" },
  ], undefined, {
    islandProps: {
      ...PROPS_LIMIT,
      byPage: new Map([
        ["en /pricing", { largest: 300, breaches: [] }],
        [
          "en /about",
          {
            largest: 2000,
            breaches: [
              { component: "Picker", prefix: "i1", bytes: 2000, props: [{ name: "entry", bytes: 1990 }] },
            ],
          },
        ],
        ["en /quiet", { largest: 900, breaches: [] }],
      ]),
    },
  });

  expect(rows.islandPropsLimit).toEqual({ limitText: "1kb", limit: 1024 });
  expect(
    rows.pages.map((row) => [row.path, row.pattern, row.breach, row.largestIslandProps, row.islandPropsBreaches.length]),
  ).toEqual([
    ["/pricing", "/pricing", false, 300, 0],
    ["/about", undefined, false, 2000, 1],
  ]);
});

test("an island props breach fails the build naming the page, the island, its size against the limit and its largest props", () => {
  const breaching = report({}, [{ locale: "en", path: "/server-data" }], undefined, {
    islandProps: {
      limitText: "3kb",
      limit: 3072,
      byPage: new Map([
        [
          "en /server-data",
          {
            largest: 68513,
            breaches: [
              {
                component: "VariantPicker",
                prefix: "i3f2a0b1c2d3e",
                bytes: 68513,
                props: [
                  { name: "entry", bytes: 66000 },
                  { name: "variants", bytes: 2300 },
                  { name: "sku", bytes: 180 },
                  { name: "label", bytes: 12 },
                ],
              },
            ],
          },
        ],
      ]),
    },
  });

  let thrown: unknown;
  try {
    checkBudgets(breaching);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Island props budget: 1 island carries more props in its marker than the limit allows — pass the island only the fields it renders, or raise the limit in pagedeck.config.ts's build.islandPropsBudget:
  en /server-data — "VariantPicker" at prefix "i3f2a0b1c2d3e" carries 68513 B of props against a limit of 3072 B, over 4 top-level props, the 3 largest:
    "entry" — 66000 B
    "variants" — 2300 B
    "sku" — 180 B`,
  );
});

test("a JavaScript breach and an island props breach are reported in one throw", () => {
  const both = report({ "/pricing": "1b" }, undefined, undefined, {
    islandProps: {
      ...PROPS_LIMIT,
      byPage: new Map([
        [
          "en /pricing",
          {
            largest: 2000,
            breaches: [{ component: "Picker", prefix: "i1", bytes: 2000, props: [{ name: "entry", bytes: 1990 }] }],
          },
        ],
      ]),
    },
  });

  expect(() => {
    checkBudgets(both);
  }).toThrow(
    /^JavaScript budget: 1 page [\s\S]*\n\nIsland props budget: 1 island [\s\S]*"Picker" at prefix "i1" carries 2000 B of props against a limit of 1024 B, over 1 top-level prop:\n {4}"entry" — 1990 B$/,
  );
});

test("an island props budget that is not a size is a config fault", () => {
  expect(islandPropsBudgetFaultReport("big", 'Config "/site/pagedeck.config.ts"')).toBe(
    `Config "/site/pagedeck.config.ts": "build.islandPropsBudget" is not a size — write a number and a unit, one of b, kb or mb, such as "4kb":\n  "big"`,
  );
  expect(islandPropsBudgetFaultReport(8192, "Config")).toBe(
    `Config: "build.islandPropsBudget" is not a size — write a number and a unit, one of b, kb or mb, such as "4kb":\n  8192 — not a string`,
  );
  expect(islandPropsBudgetFaultReport("12kb", "Config")).toBeUndefined();
});

test("an undeclared island props budget is the default, and a declared one replaces it", () => {
  expect(islandPropsLimit(undefined)).toEqual({
    limitText: DEFAULT_ISLAND_PROPS_BUDGET,
    limit: Number.parseInt(DEFAULT_ISLAND_PROPS_BUDGET, 10) * 1024,
  });
  expect(islandPropsLimit("12kb")).toEqual({ limitText: "12kb", limit: 12288 });
});

// Written out as `stashMarkup` in render.tsx writes a stash.
function stashed(id: string, html: string): string {
  const text = html.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<template data-fw-template="${id}">${text}</template>`;
}

test("an island in a stashed slot is weighed once, at any depth of stash", () => {
  const shown = markerFor("Tabs", "i000000000001", { active: 1 });
  const hidden = markerFor("Picker", "i000000000002", { entry: "a&b<c".repeat(40) });
  const deeper = markerFor("Deep", "i000000000003", { entry: "é".repeat(150) });
  const html =
    shown + stashed("0.0", hidden + stashed("0.0.0", deeper));

  expect(
    weighIslandProps(html, 0).breaches.map((island) => [island.component, island.bytes]),
  ).toEqual([
    ["Deep", Buffer.byteLength(JSON.stringify({ entry: "é".repeat(150) }))],
    ["Picker", Buffer.byteLength(JSON.stringify({ entry: "a&b<c".repeat(40) }))],
    ["Tabs", Buffer.byteLength(JSON.stringify({ active: 1 }))],
  ]);
});

test("only the island tag itself is a marker, not a tag that starts with its name", () => {
  const html = `<fw-island-foo data-fw-props="${"x".repeat(100)}"></fw-island-foo>`;

  expect(weighIslandProps(html, 0)).toEqual({ largest: 0, breaches: [] });
});
