// Drives the two module-private predicates through their public callers; neither is
// exported or extracted, on purpose (#354).
import { expect, test } from "vitest";
import { crossPageAffected, pageKey, planIncremental } from "./incremental.js";
import type { IncrementalPlan } from "./incremental.js";
import { MANIFEST_VERSION } from "./manifest.js";
import type { Manifest, ManifestPage } from "./manifest.js";
import type { EntryRef, Page } from "./pages.js";
import { planRouting } from "./routing.js";
import { speculationRules } from "./speculation.js";
import { planTiers } from "./tiers.js";

const SEQ = 40;

const NOTHING = "no target";

function row(fields: {
  locale: string;
  path: `/${string}`;
  collection?: string;
  entry?: { locale: string; path: string };
  fallbackFrom?: string;
  relations?: readonly EntryRef[];
}): Page {
  const { locale, path, collection, entry, fallbackFrom, relations } = fields;
  return {
    locale,
    path,
    output: `/${locale}${path}`,
    ...(collection === undefined ? {} : { collection }),
    ...(entry === undefined ? {} : { entry }),
    ...(fallbackFrom === undefined ? {} : { fallbackFrom }),
    dependencies:
      collection === undefined || entry === undefined
        ? []
        : [{ collection, locale: entry.locale, path: entry.path }],
    ...(relations === undefined ? {} : { relations }),
  };
}

function manifestRow(page: Page): ManifestPage {
  return {
    locale: page.locale,
    path: page.path,
    output: page.output,
    ...(page.collection === undefined ? {} : { collection: page.collection }),
    ...(page.entry === undefined ? {} : { entry: page.entry }),
    ...(page.fallbackFrom === undefined
      ? {}
      : { fallbackFrom: page.fallbackFrom }),
    dependencies: page.dependencies,
    html: `${page.output}/index.html`,
    components: [],
    foldTuning: [],
  };
}

function manifest(pages: readonly ManifestPage[]): Manifest {
  return {
    version: MANIFEST_VERSION,
    build: { id: "build-1", createdAt: "2026-08-25T10:00:00.000Z" },
    store: { seq: SEQ },
    site: { trailingSlash: "never" },
    routing: planRouting({ pages: [], trailingSlash: "never" }),
    files: [],
    pages,
    tiers: planTiers({ entries: [], ranking: [] }),
    classes: [],
  };
}

interface Candidate {
  what: string;
  page: Page;
  probe: EntryRef;
}

const CANDIDATES: readonly Candidate[] = [
  {
    what: "an ordinary row",
    page: row({
      locale: "en",
      path: "/guide",
      collection: "docs",
      entry: { locale: "en", path: "guide" },
    }),
    probe: { collection: "docs", locale: "en", path: "guide" },
  },
  {
    what: "a row whose entry differs only by locale",
    page: row({
      locale: "fr",
      path: "/guide",
      collection: "docs",
      entry: { locale: "fr", path: "guide" },
    }),
    probe: { collection: "docs", locale: "fr", path: "guide" },
  },
  {
    what: "a row whose entry differs only by path",
    page: row({
      locale: "en",
      path: "/guide-two",
      collection: "docs",
      entry: { locale: "en", path: "guide-two" },
    }),
    probe: { collection: "docs", locale: "en", path: "guide-two" },
  },
  {
    what: "a row whose entry differs only by collection",
    page: row({
      locale: "en",
      path: "/notes/guide",
      collection: "notes",
      entry: { locale: "en", path: "guide" },
    }),
    probe: { collection: "notes", locale: "en", path: "guide" },
  },
  {
    what: "a row whose locale is not its entry's",
    page: row({
      locale: "en",
      path: "/rapport",
      collection: "docs",
      entry: { locale: "fr", path: "rapport" },
    }),
    probe: { collection: "docs", locale: "fr", path: "rapport" },
  },
  {
    what: "a fallback row",
    page: row({
      locale: "fr",
      path: "/handbook",
      collection: "docs",
      entry: { locale: "en", path: "handbook" },
      fallbackFrom: "en",
    }),
    probe: { collection: "docs", locale: "en", path: "handbook" },
  },
  {
    what: "a row with no collection",
    page: row({
      locale: "en",
      path: "/composed",
      entry: { locale: "en", path: "composed" },
    }),
    probe: { collection: "docs", locale: "en", path: "composed" },
  },
  {
    what: "a row with no entry",
    page: row({ locale: "en", path: "/listing", collection: "docs" }),
    probe: { collection: "docs", locale: "en", path: "listing" },
  },
  {
    what: "a row with no own entry at all",
    page: row({ locale: "en", path: "/literal" }),
    probe: { collection: "docs", locale: "en", path: "literal" },
  },
];

const PAGES: readonly Page[] = CANDIDATES.map((one) => one.page);

const BY_OUTPUT = new Map(
  CANDIDATES.map((one) => [one.page.output, pageKey(one.page)]),
);

function prober(probe: EntryRef): Page {
  return row({
    locale: "en",
    path: "/prober",
    collection: "pages",
    entry: { locale: "en", path: "prober" },
    relations: [probe],
  });
}

function documentNaming(url: string): string {
  return JSON.stringify({ prefetch: [{ source: "list", urls: [url] }] });
}

function rendererTarget(probe: EntryRef): string {
  const source = prober(probe);
  const emitted = speculationRules({
    setting: { action: "prefetch", max: 5 },
    pages: [source, ...PAGES],
  });
  const text = emitted.get(`${source.locale} ${source.path}`);
  if (text === undefined) return NOTHING;
  for (const [output, identity] of BY_OUTPUT) {
    if (text === documentNaming(output)) return identity;
  }
  return text;
}

const QUIET = {
  since: SEQ,
  head: SEQ + 1,
  changed: [],
  vanished: [],
  requested: [],
} as const;

function widenedBy(plan: IncrementalPlan, source: Page): string {
  if (!plan.reuse.some((one) => pageKey(one.page) === pageKey(source)))
    throw new Error("the prober was rendered, so it has nothing to be widened");

  const widened = crossPageAffected({
    plan,
    alternates: false,
    speculation: true,
  });
  const named = widened
    .filter((one) => pageKey(one.page) === pageKey(source))
    .flatMap((one) => one.reasons)
    .map((reason) =>
      reason.kind === "sibling-changed" ? pageKey(reason.page) : reason.kind,
    );
  return named.length === 0 ? NOTHING : named.join(", ");
}

function plannerTarget(probe: EntryRef): string {
  const source = prober(probe);
  return widenedBy(
    planIncremental({
      previous: manifest([manifestRow(source)]),
      pages: [source, ...PAGES],
      delta: QUIET,
    }),
    source,
  );
}

function plannerRemovalTarget(probe: EntryRef): string {
  const source = prober(probe);
  const plan = planIncremental({
    previous: manifest([manifestRow(source), ...PAGES.map(manifestRow)]),
    pages: [source],
    delta: QUIET,
  });
  if (plan.remove.length !== PAGES.length)
    throw new Error("the candidates were not planned as removals");
  return widenedBy(plan, source);
}

test("the renderer's speculation-target index and the planner's mirror agree", () => {
  const renderer = CANDIDATES.map(
    (one) => `${one.what} → ${rendererTarget(one.probe)}`,
  );
  const planner = CANDIDATES.map(
    (one) => `${one.what} → ${plannerTarget(one.probe)}`,
  );
  const removed = CANDIDATES.map(
    (one) => `${one.what} → ${plannerRemovalTarget(one.probe)}`,
  );

  expect(renderer).toEqual(planner);
  expect(renderer).toEqual(removed);

  expect(renderer).toEqual([
    "an ordinary row → en /guide",
    "a row whose entry differs only by locale → fr /guide",
    "a row whose entry differs only by path → en /guide-two",
    "a row whose entry differs only by collection → en /notes/guide",
    "a row whose locale is not its entry's → en /rapport",
    `a fallback row → ${NOTHING}`,
    `a row with no collection → ${NOTHING}`,
    `a row with no entry → ${NOTHING}`,
    `a row with no own entry at all → ${NOTHING}`,
  ]);
});
