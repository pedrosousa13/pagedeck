import { expect, test, vi } from "vitest";
import { checkDrift } from "./drift.js";
import type { DriftReport } from "./drift.js";
import { ConfigError } from "./exit.js";
import { headElements } from "./head.js";
import type { AffectedReason } from "./incremental.js";
import type { Page } from "./pages.js";
import {
  compileSupplements,
  driftSupplementFaultReport,
} from "./supplement.js";

function page(locale: string, path: `/${string}`, entry: string): Page {
  return {
    locale,
    path,
    output: `/${locale}${path === "/" ? "" : path}`,
    collection: "pages",
    entry: { locale, path: entry },
    dependencies: [{ collection: "pages", locale, path: entry }],
  };
}

const PRICING = page("en", "/pricing", "pricing");
const HOME = page("en", "/", "home");

const PINNED = ["fw-hero", "fw-nav"];

function ownEntry(one: Page): AffectedReason {
  return {
    kind: "own-entry",
    ref: {
      collection: "pages",
      locale: one.locale,
      path: (one.entry as { path: string }).path,
    },
  };
}

function report(pages: readonly [Page, string][]): DriftReport {
  return checkDrift({
    pinned: PINNED,
    rendered: pages.map(([one, html]) => ({
      affected: { page: one, reasons: [ownEntry(one)] },
      html,
    })),
  });
}

function fakeCompiler(classes: readonly string[]): string {
  return classes.map((name) => `.${name}{--fw-supplement:1}`).join("");
}

test("a build with nothing drifted compiles nothing and asks the compiler nothing", async () => {
  const compile = vi.fn(fakeCompiler);

  const result = await compileSupplements({
    report: report([
      [PRICING, '<div class="fw-hero"></div>'],
      [HOME, '<div class="fw-nav"></div>'],
    ]),
    compile,
  });

  expect(result.styles.size).toBe(0);
  expect(result.warnings).toEqual([]);
  expect(compile).not.toHaveBeenCalled();
});

test("a drifted page inlines a supplement holding only its own missing classes", async () => {
  const compile = vi.fn(fakeCompiler);

  const result = await compileSupplements({
    report: report([
      [PRICING, '<div class="fw-hero badge-rogue"></div>'],
      [HOME, '<div class="fw-nav"></div>'],
    ]),
    compile,
  });

  expect(compile.mock.calls).toEqual([[["badge-rogue"]]]);
  expect([...result.styles]).toEqual([
    ["en /pricing", "<style>.badge-rogue{--fw-supplement:1}</style>"],
  ]);
  expect(result.warnings).toEqual([]);
});

test("an async compiler is awaited", async () => {
  const result = await compileSupplements({
    report: report([[PRICING, '<div class="badge-rogue"></div>']]),
    compile: (classes) => Promise.resolve(fakeCompiler(classes)),
  });

  expect(result.styles.get("en /pricing")).toBe(
    "<style>.badge-rogue{--fw-supplement:1}</style>",
  );
});

test("a supplement is written into the head after the sheets the page links", async () => {
  const result = await compileSupplements({
    report: report([[PRICING, '<div class="badge-rogue"></div>']]),
    compile: fakeCompiler,
  });

  const children = headElements({
    head: { title: "Pricing" },
    styles: ["/assets/core.css", "/assets/pricing.css"],
    inlineStyles: [],
    links: undefined,
    absorbed: [],
    supplement: result.styles.get("en /pricing"),
  });

  expect(children).toEqual([
    '<meta charset="utf-8">',
    "<title>Pricing</title>",
    '<meta property="og:title" content="Pricing">',
    '<link rel="stylesheet" href="/assets/core.css">',
    '<link rel="stylesheet" href="/assets/pricing.css">',
    "<style>.badge-rogue{--fw-supplement:1}</style>",
  ]);
});

test("a page with no supplement gets the head it would have got without the feature", () => {
  const input = {
    head: { title: "Home" },
    styles: ["/assets/core.css"],
    inlineStyles: [],
    links: undefined,
    absorbed: [],
  };

  // The two calls differ only in a key holding `undefined`, which catches a writer
  // that tests `"supplement" in input`.
  expect(headElements({ ...input, supplement: undefined })).toEqual(
    headElements(input),
  );

  expect(headElements({ ...input, supplement: "" })).not.toEqual(
    headElements(input),
  );
  expect(headElements({ ...input, supplement: "" }).join("")).toEqual(
    headElements(input).join(""),
  );
});

test("a drifted page with no compiler declared is reported, and nothing is inlined", async () => {
  const result = await compileSupplements({
    report: report([
      [PRICING, '<div class="badge-rogue"></div>'],
      [HOME, '<div class="badge-loud"></div>'],
    ]),
  });

  expect(result.styles.size).toBe(0);
  expect(result.warnings).toEqual([
    'Class drift: 2 drifted pages have no supplement, because this site declares no supplement compiler — spec §9 inlines a stylesheet holding only the missing rules into each page below, and this framework names no CSS toolkit to compile one with, so the compiler is the site\'s to declare; without it each page below ships the classes it drifted on with no rules behind them, which is a page that renders unstyled where those classes are used. This is a warning and not a refusal because a site whose CSS is hand-written has no compiler to declare and the fault is the drift itself — fix the safelist gap or the component the drift report names, or declare build.driftSupplement, as driftSupplement: (classes) => compile(classes):\n  en /pricing — "badge-rogue"\n  en / — "badge-loud"',
  ]);
});

test("a compiler that answers with no rules is reported, and no empty element is written", async () => {
  const result = await compileSupplements({
    report: report([
      [PRICING, '<div class="badge-rogue"></div>'],
      [HOME, '<div class="badge-loud"></div>'],
    ]),
    compile: (classes) => (classes.includes("badge-rogue") ? "" : "  \n "),
  });

  expect(result.styles.size).toBe(0);
  expect(result.warnings).toEqual([
    'Class drift: 2 supplements compiled to no rules, so each page below ships the classes it drifted on with no rules behind them — "build.driftSupplement" was handed those classes and returned a stylesheet holding nothing, which is what a compiler answers about a class it does not generate: a name somebody typed by hand, or a safelist the toolkit was never told about. This is a warning and not a refusal because the page renders and only the rules for these classes are missing, and an empty answer is the compiler\'s rather than a fault in this build — fix the safelist gap or the component the drift report names, or generate rules for these classes:\n  en /pricing — "badge-rogue"\n  en / — "badge-loud"',
  ]);
});

test("a compiler that throws stops the pass and carries its throw as the cause", async () => {
  const boom = new Error("no such utility");

  const thrown: unknown = await compileSupplements({
    report: report([[PRICING, '<div class="badge-rogue"></div>']]),
    compile: () => {
      throw boom;
    },
  }).catch((error: unknown) => error);

  expect(thrown).not.toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    'Class drift: the supplement compiler threw on en /pricing — "build.driftSupplement" is called with the classes one page used that the last full build\'s class manifest does not hold, "badge-rogue" here; fix the compiler, or fix the safelist gap or the component the drift report names so the page does not drift',
  );
  expect((thrown as Error).cause).toBe(boom);
});

test("a supplement that would end its own element is refused, with the position in it", async () => {
  const thrown: unknown = await compileSupplements({
    report: report([[PRICING, '<div class="badge-rogue"></div>']]),
    compile: () => '.badge-rogue{content:"</style>"}',
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    'Class drift: 1 supplement cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — return a stylesheet with no "</style" sequence in it, or fix the safelist gap or the component the drift report names so the page does not drift:\n  en /pricing — "</style" at line 1, column 23',
  );
});

test("a build section reports a drift supplement that is not a compiler", () => {
  expect(
    driftSupplementFaultReport("./theme.css", 'Config "/site/pagedeck.config.ts"'),
  ).toBe(
    'Config "/site/pagedeck.config.ts": "build.driftSupplement" must be a function returning a stylesheet for the classes it is handed — driftSupplement: (classes) => compile(classes)',
  );
  expect(
    driftSupplementFaultReport(() => "", 'Config "/site/pagedeck.config.ts"'),
  ).toBeUndefined();
});

test("a compiler that answers with something other than a stylesheet is refused", async () => {
  const thrown: unknown = await compileSupplements({
    report: report([[PRICING, '<div class="badge-rogue"></div>']]),
    compile: () => undefined as unknown as string,
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    'Class drift: the supplement compiler answered with undefined on en /pricing, and a supplement is a stylesheet — return the CSS covering the classes it is handed, as driftSupplement: (classes) => compile(classes)',
  );
});
