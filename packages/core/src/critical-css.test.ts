import { expect, test } from "vitest";
import {
  criticalCssFaultReport,
  inlineStyleElements,
  inlinedPages,
} from "./critical-css.js";
import { ConfigError } from "./exit.js";

const PAGES = [
  { locale: "en", path: "/landing" },
  { locale: "en", path: "/landing/legal" },
  { locale: "de", path: "/landing" },
  { locale: "en", path: "/pricing" },
];

test("a flag reaches the pages its pattern names, and false opts one back out", () => {
  const flagged = inlinedPages(
    { "/landing/**": true, "/landing/legal": false },
    PAGES,
  );

  expect([...flagged]).toEqual(["en /landing", "de /landing"]);
});

test("a page no pattern matches and a page a pattern un-flags are the same answer", () => {
  expect([...inlinedPages({}, PAGES)]).toEqual([]);
  expect([...inlinedPages({ "/pricing": false }, PAGES)]).toEqual([]);
});

test("a criticalCss value that is not a flag is quoted as the author typed it", () => {
  const report = criticalCssFaultReport(
    { "/a": "yes", "/b": 1, "/c": undefined },
    'Config "/site/pagedeck.config.ts"',
  );

  expect(report).toBe(
    `Config "/site/pagedeck.config.ts": "build.criticalCss" declares 3 values that are not true or false — write true to inline a page's stylesheets into its HTML, or false to leave it linking them:
  "/a" — "yes"
  "/b" — 1
  "/c" — undefined`,
  );
});

const CSS = new Map([
  ["/assets/core.css", ".fw-hero{color:red}"],
  ["/assets/page.css", ".fw-panel{color:blue}"],
  ["/assets/other.css", ".fw-chart{color:green}"],
]);

test("a flagged page's sheets become style elements in link order, byte for byte", () => {
  const tags = inlineStyleElements(
    new Map([
      ["en /landing", ["/assets/core.css", "/assets/page.css"]],
      ["en /pricing", []],
    ]),
    CSS,
  );

  expect(tags.get("en /landing")).toEqual([
    "<style>.fw-hero{color:red}</style>",
    "<style>.fw-panel{color:blue}</style>",
  ]);
  expect(tags.has("en /pricing")).toBe(false);
});

test("an inlined href nothing emitted is refused, in checkSiteLinks' words", () => {
  const thrown = (): unknown => {
    inlineStyleElements(
      new Map([
        ["en /landing", ["/assets/core.css", "/assets/gone.css"]],
        ["de /landing", ["/assets/gone.css"]],
      ]),
      CSS,
    );
    return undefined;
  };

  expect(thrown).toThrow(ConfigError);
  expect(thrown).toThrow(
    `Critical CSS: 2 inlined stylesheets were never emitted, so the pages they are on would render unstyled — the inlined URL and the file name must be one spelling: see chunkPath in client-build.ts:
  "/assets/gone.css" — inlined into en /landing, emitted by nothing
  "/assets/gone.css" — inlined into de /landing, emitted by nothing`,
  );
});

test("a sheet holding </style is refused, and the line says where the sequence is", () => {
  const thrown = (): unknown => {
    inlineStyleElements(
      new Map([["en /landing", ["/assets/quote.css"]]]),
      new Map([
        ["/assets/quote.css", '.a{color:red}\n.b::after{content:"</style>"}'],
      ]),
    );
    return undefined;
  };

  expect(thrown).toThrow(ConfigError);
  expect(thrown).toThrow(
    `Critical CSS: 1 stylesheet cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — remove the "</style" sequence from the stylesheet, or drop the page from build.criticalCss so the sheet is linked instead:
  "/assets/quote.css" — inlined into en /landing, "</style" at line 2, column 20`,
  );
});

test("a closing sequence with no > and in the wrong case is still refused", () => {
  // `</style`, not `</style>`: an HTML parser closes the element at the tag name, so
  // `</STYLE\n>` is a close. Column 1 also pins the offset as 1-based.
  expect(() => {
    inlineStyleElements(
      new Map([["en /landing", ["/assets/loud.css"]]]),
      new Map([["/assets/loud.css", "</STYLE\n>"]]),
    );
  }).toThrow(
    '"/assets/loud.css" — inlined into en /landing, "</style" at line 1, column 1',
  );
});

test("both refusals are reported in one throw, as a paragraph each", () => {
  let message = "";
  try {
    inlineStyleElements(
      new Map([["en /landing", ["/assets/gone.css", "/assets/quote.css"]]]),
      new Map([["/assets/quote.css", "@media all{}</style"]]),
    );
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message.split("\n\n")).toHaveLength(2);
  expect(message).toBe(
    `Critical CSS: 1 inlined stylesheet was never emitted, so the page it is on would render unstyled — the inlined URL and the file name must be one spelling: see chunkPath in client-build.ts:
  "/assets/gone.css" — inlined into en /landing, emitted by nothing

Critical CSS: 1 stylesheet cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — remove the "</style" sequence from the stylesheet, or drop the page from build.criticalCss so the sheet is linked instead:
  "/assets/quote.css" — inlined into en /landing, "</style" at line 1, column 13`,
  );
});
