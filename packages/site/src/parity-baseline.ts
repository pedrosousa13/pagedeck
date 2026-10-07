// Hand-written, never dumped from a build (only the URL set is read off a manifest,
// #161), and values `./site` declares are spelled again, so a quiet change there fails.
import type { ExpectationRule, PageFacts, ParityBaseline, RedirectFact } from "./parity.js";

const WHY =
  "written by hand from the site's own entries and the design system, as this site's stated intent, with each page's description the site's own copy written again; not a recording of production (see docs/dogfood-parity.md)";

const ORIGIN = "https://dogfood.example";

const HOME_ALTERNATES: Readonly<Record<string, string>> = {
  de: `${ORIGIN}/de`,
  en: `${ORIGIN}/en`,
};

const PAGES: readonly PageFacts[] = [
  {
    url: "/de",
    status: 200,
    lang: "de",
    title: "Startseite",
    metaDescription:
      "Bau die Seite mit einem Build, der im Terminal fertig wird.",
    canonical: `${ORIGIN}/de`,
    alternates: HOME_ALTERNATES,
    headings: [{ level: 1, text: "Bau die Seite" }],
    // The German hero has no `cta`, so it renders no anchor.
    internalHrefs: [],
    text: "Bau die Seite",
  },
  {
    url: "/en",
    status: 200,
    lang: "en",
    title: "Home",
    metaDescription:
      "Ship the site with a build that is fast and small, then see what each plan costs.",
    canonical: `${ORIGIN}/en`,
    alternates: HOME_ALTERNATES,
    // `<h2>`: a card sits directly under the page's `<h1>` (#296).
    headings: [
      { level: 1, text: "Ship the site" },
      { level: 2, text: "Fast" },
      { level: 2, text: "Small" },
    ],
    internalHrefs: ["/en/pricing"],
    text: "Ship the site See pricing Fast Small",
  },
  {
    // Its `related` and `unset_link` fields never reach the document.
    url: "/en/legal/terms",
    status: 200,
    lang: "en",
    title: "Terms",
    metaDescription: "The terms that apply to this site.",
    canonical: `${ORIGIN}/en/legal/terms`,
    alternates: {},
    headings: [{ level: 1, text: "Terms" }],
    internalHrefs: [],
    text: "Terms The terms.",
  },
  {
    url: "/en/pricing",
    status: 200,
    lang: "en",
    title: "Pricing",
    metaDescription:
      "The two plans and their monthly prices: Starter at 0 and Team at 49, with a yearly option.",
    canonical: `${ORIGIN}/en/pricing`,
    alternates: {},
    headings: [{ level: 1, text: "Plans" }],
    internalHrefs: [],
    text: "Plans Billed monthly Starter 0 Team 49",
  },
];

const REDIRECTS: readonly RedirectFact[] = [
  { from: "/en/plans", to: "/en/pricing", status: 301 },
  { from: "/en/terms", to: "/en/legal/terms", status: 301 },
];

export const DECLARED_BASELINE: ParityBaseline = {
  origin: { kind: "declared", why: WHY },
  pages: PAGES,
  redirects: REDIRECTS,
};

export const BASELINE_URLS: readonly string[] = PAGES.map((page) => page.url);

export const BASELINE_REDIRECTS: readonly string[] = REDIRECTS.map(
  (rule) => rule.from,
);

// Empty on purpose: a rule belongs here only when a captured baseline turns up a
// difference somebody has established is expected.
export const EXPECTATION_RULES: readonly ExpectationRule[] = [];
