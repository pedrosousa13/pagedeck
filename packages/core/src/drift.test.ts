import { expect, test } from "vitest";
import {
  checkDrift,
  DEFAULT_DRIFT_THRESHOLD,
  driftWarnings,
} from "./drift.js";
import type { ReRenderedPage } from "./drift.js";
import type { AffectedPage, AffectedReason } from "./incremental.js";
import { planIncremental } from "./incremental.js";
import type { Manifest } from "./manifest.js";
import { MANIFEST_VERSION } from "./manifest.js";
import type { Page } from "./pages.js";
import { planRouting } from "./routing.js";
import { planTiers } from "./tiers.js";

function page(locale: string, path: `/${string}`, entry: string): Page {
  return {
    locale,
    path,
    output: `/${locale}${path === "/" ? "" : path}`,
    collection: "pages",
    entry: { locale, path: entry },
    dependencies: [
      { collection: "pages", locale, path: entry },
      { collection: "globals", locale: "en", path: "nav" },
    ],
  };
}

function affected(
  one: Page,
  reasons: readonly AffectedReason[],
): AffectedPage {
  return { page: one, reasons };
}

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

const PRICING = page("en", "/pricing", "pricing");
const HOME = page("en", "/", "home");
const ABOUT = page("de", "/about", "about");

const PINNED = ["bg-white", "grid-cols-1", "text-slate-900"];

function rendered(one: Page, html: string, reasons?: readonly AffectedReason[]): ReRenderedPage {
  return { affected: affected(one, reasons ?? [ownEntry(one)]), html };
}

test("a build with nothing drifted reports that, as a value", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-white text-slate-900"></div>'),
      rendered(HOME, '<div class="grid-cols-1"></div>'),
    ],
  });

  expect(report.pages).toEqual([]);
  expect(report.fullRebuild).toBeUndefined();
  expect(report.threshold).toBe(DEFAULT_DRIFT_THRESHOLD);
  expect(driftWarnings(report)).toEqual([]);
});

test("one page's one missing class is reported with the entry that re-rendered it", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [rendered(PRICING, '<div class="bg-white bg-lime-300"></div>')],
  });

  expect(report.pages).toEqual([
    {
      page: PRICING,
      classes: ["bg-lime-300"],
      reasons: [ownEntry(PRICING)],
    },
  ]);
  expect(driftWarnings(report)).toEqual([
    'Class drift: 1 re-rendered page uses classes the last full build\'s class manifest does not hold — spec §9\'s invariant is that classes derive from code and never from content, so a class in rendered HTML that no recorded class covers is either a class this site\'s code states and the site\'s declared "build.safelist" does not — a CMS-exposed styling option, or a class a component writes for itself — or a component writing a class name out of a content value; check "build.safelist" for the option the source entry below sets and for the components that entry renders, then read those components. This is a warning and not a refusal because the supplement spec §9 inlines into each page below leaves that page correctly styled and the site\'s stylesheets byte-identical:\n  en /pricing — "bg-lime-300" — own entry "pages en pricing"',
  ]);
});

const SAFELIST = {
  "hero.theme": ["bg-slate-900", "text-white"],
  "button.variant": ["bg-indigo-600", "text-white"],
  hero: ["hero"],
};

test("a declared safelist class the class manifest never recorded is not drift", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-slate-900 text-white"></div>'),
      rendered(HOME, '<div class="hero bg-indigo-600 bg-white"></div>'),
    ],
    safelist: SAFELIST,
  });

  expect(report.pages).toEqual([]);
  expect(driftWarnings(report)).toEqual([]);

  const undeclared = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-slate-900 text-white"></div>'),
      rendered(HOME, '<div class="hero bg-indigo-600 bg-white"></div>'),
    ],
  });
  expect(undeclared.pages.map((one) => one.classes)).toEqual([
    ["bg-slate-900", "text-white"],
    ["hero", "bg-indigo-600"],
  ]);
});

test("a class outside the declared safelist is still drift", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-slate-900 badge-clearance"></div>'),
    ],
    safelist: SAFELIST,
  });

  expect(report.pages).toEqual([
    {
      page: PRICING,
      classes: ["badge-clearance"],
      reasons: [ownEntry(PRICING)],
    },
  ]);
});

test("every drifted page is reported, not the first", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-lime-300"></div>'),
      rendered(HOME, '<div class="bg-white"></div>'),
      rendered(ABOUT, '<div class="text-lime-900"></div>'),
    ],
  });

  expect(report.pages.map((one) => one.page)).toEqual([PRICING, ABOUT]);
  expect(report.pages.map((one) => one.classes)).toEqual([
    ["bg-lime-300"],
    ["text-lime-900"],
  ]);
});

test("every missing class of one page is reported, not the first", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(
        PRICING,
        '<div class="bg-lime-300 bg-white"><p class="text-lime-900 bg-lime-300"></p></div>',
      ),
    ],
  });

  expect(report.pages[0]?.classes).toEqual(["bg-lime-300", "text-lime-900"]);
});

test("a page re-rendered for a structural reason says it has no source entry", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-lime-300"></div>', [
        { kind: "new-page" },
      ]),
      rendered(HOME, '<div class="text-lime-900"></div>', [
        { kind: "no-previous-render" },
      ]),
      rendered(ABOUT, '<div class="grid-cols-7"></div>', [
        { kind: "moved", from: { output: "/de/about/" } },
      ]),
    ],
  });

  const [warning] = driftWarnings(report);
  expect(warning?.split("\n").slice(1)).toEqual([
    '  en /pricing — "bg-lime-300" — no source entry: the route table holds this page and the previous manifest does not',
    '  en / — "text-lime-900" — no source entry: the previous manifest records no HTML for this page',
    '  de /about — "grid-cols-7" — no source entry: the previous manifest puts this page at "/de/about/"',
  ]);
});

test("every reason a page re-rendered for is named, so no attribution is picked", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: [
      rendered(PRICING, '<div class="bg-lime-300"></div>', [
        { kind: "new-page" },
        ownEntry(PRICING),
        {
          kind: "dependency",
          ref: { collection: "globals", locale: "en", path: "nav" },
        },
        {
          kind: "deleted-dependency",
          ref: { collection: "globals", locale: "en", path: "footer" },
        },
        {
          kind: "requested",
          ref: { collection: "pages", locale: "en", path: "pricing" },
        },
      ]),
    ],
  });

  const [warning] = driftWarnings(report);
  expect(warning?.split("\n")[1]).toBe(
    '  en /pricing — "bg-lime-300" — no source entry: the route table holds this page and the previous manifest does not; own entry "pages en pricing"; dependency "globals en nav"; deleted dependency "globals en footer"; requested entry "pages en pricing"',
  );
});

function drifting(count: number): ReRenderedPage[] {
  return Array.from({ length: count }, (_unused, index) =>
    rendered(
      page("en", `/p${String(index)}`, `p${String(index)}`),
      '<div class="bg-lime-300"></div>',
    ),
  );
}

test("drift exactly at the threshold asks for no rebuild", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: drifting(DEFAULT_DRIFT_THRESHOLD),
    threshold: DEFAULT_DRIFT_THRESHOLD,
  });

  expect(report.pages).toHaveLength(DEFAULT_DRIFT_THRESHOLD);
  expect(report.fullRebuild).toBeUndefined();
  expect(driftWarnings(report)).toHaveLength(1);
});

test("one page past the threshold asks the manifest for a full rebuild", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: drifting(DEFAULT_DRIFT_THRESHOLD + 1),
    threshold: DEFAULT_DRIFT_THRESHOLD,
  });

  expect(report.fullRebuild).toEqual({
    reason: "class-drift",
    drifted: DEFAULT_DRIFT_THRESHOLD + 1,
    threshold: DEFAULT_DRIFT_THRESHOLD,
  });
  const warnings = driftWarnings(report);
  expect(warnings).toHaveLength(2);
  expect(warnings[1]).toBe(
    `Class drift: ${String(DEFAULT_DRIFT_THRESHOLD + 1)} pages drifted and "build.driftThreshold" allows ${String(DEFAULT_DRIFT_THRESHOLD)}, so this build's manifest records a full rebuild request — an incremental build carries the previous build's class manifest forward rather than re-extracting it, so every class above drifts again on every incremental build until a full build records it, and each of those builds inlines the same supplement into the same pages. This is a warning and not a refusal because every page this build emitted is correct: the request is the manifest's "fullRebuild" field, and spec §9 leaves scheduling the rebuild to the site's CI — run a full pagedeck build, and fix the safelist gap or the component the lines above name.`,
  );
});

test("a threshold of zero asks for a rebuild on the first drifted page", () => {
  const report = checkDrift({
    pinned: PINNED,
    rendered: drifting(1),
    threshold: 0,
  });

  expect(report.fullRebuild).toEqual({
    reason: "class-drift",
    drifted: 1,
    threshold: 0,
  });
});

// A fresh input each call: comparing one object against itself misses state the
// function keeps between calls.
function deterministicInput() {
  return {
    pinned: [...PINNED],
    rendered: [
      rendered(ABOUT, '<div class="z-50 a-1"></div>'),
      rendered(PRICING, '<div class="bg-lime-300"></div>'),
      rendered(HOME, '<div class="bg-white"></div>'),
    ],
  };
}

test("two runs over one input produce one report, byte for byte", () => {
  const input = deterministicInput();
  const once = driftWarnings(checkDrift(input)).join("\n");

  expect(driftWarnings(checkDrift(input)).join("\n")).toBe(once);
  expect(driftWarnings(checkDrift(deterministicInput())).join("\n")).toBe(once);

  const reordered = deterministicInput();
  reordered.rendered.reverse();
  expect(driftWarnings(checkDrift(reordered)).join("\n")).not.toBe(once);

  expect(checkDrift(input).pages.map((one) => one.page.path)).toEqual([
    "/about",
    "/pricing",
  ]);
});

test("the source entry a report names is the one the plan attributed", () => {
  const previous: Manifest = {
    version: MANIFEST_VERSION,
    build: { id: "b1", createdAt: "2026-08-30T00:00:00.000Z" },
    store: { seq: 4 },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [PRICING], trailingSlash: "never" }),
    files: [],
    pages: [
      {
        locale: "en",
        path: "/pricing",
        output: "/en/pricing",
        collection: "pages",
        entry: { locale: "en", path: "pricing" },
        dependencies: PRICING.dependencies,
        html: "/en/pricing/index.html",
        components: [],
        foldTuning: [],
      },
    ],
    tiers: planTiers({ entries: [], ranking: [] }),
    classes: PINNED,
  };
  const plan = planIncremental({
    previous,
    pages: [PRICING],
    delta: {
      since: 4,
      head: 9,
      changed: [{ collection: "globals", locale: "en", path: "nav" }],
      vanished: [],
      requested: [],
    },
  });

  const report = checkDrift({
    pinned: plan.pinned.classes,
    rendered: plan.render.map((one) => ({
      affected: one,
      html: '<div class="bg-lime-300"></div>',
    })),
  });

  expect(driftWarnings(report)[0]?.split("\n")[1]).toBe(
    '  en /pricing — "bg-lime-300" — dependency "globals en nav"',
  );
});

// An attribute selector, not a class selector: `classesOfHtml` looks for `class=`, and
// `[class="prose-invert"]` is byte-for-byte a rendered attribute.
const RENDER = '<div class="bg-white text-slate-900"></div>';
const DOCUMENT =
  '<!doctype html><html lang="en" dir="ltr"><head>' +
  '<style>[class="prose-invert"] :where(a){color:inherit}</style>' +
  `</head><body>${RENDER}</body></html>`;

test("a caller handing over the emitted document instead of the render drifts on its own inlined CSS", () => {
  expect(
    checkDrift({ pinned: PINNED, rendered: [rendered(PRICING, RENDER)] }).pages,
  ).toEqual([]);

  const document = checkDrift({
    pinned: PINNED,
    rendered: [rendered(PRICING, DOCUMENT)],
  });

  expect(document.pages.map((one) => one.classes)).toEqual([["prose-invert"]]);
});
