import { expect, test } from "vitest";
import {
  compareParity,
  pageFacts,
  redactOrigin,
  type ExpectationRule,
  type ParityBaseline,
  type BuiltSite,
  type RedirectFact,
} from "./parity.js";

const FULL = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<title>  Pricing  </title>
<meta name="description" content="What the plans cost.">
<link rel="canonical" href="https://example.test/en/pricing">
<link rel="alternate" hreflang="en" href="https://example.test/en/pricing">
<link rel="alternate" hreflang="de" href="https://example.test/de/pricing">
<style>.hidden { display: none }</style>
</head>
<body>
<main>
  <h1>Plans</h1>
  <p>Pick   one.</p>
  <h2>Starter</h2>
  <a href="/en/legal/terms">Terms</a>
  <a href="https://elsewhere.test/docs">Docs</a>
  <a href="//cdn.elsewhere.test/x">CDN</a>
  <a href="mailto:hello@example.test">Mail</a>
</main>
<script type="module" src="/assets/en/pricing-abc.js"></script>
</body>
</html>
`;

test("the extractor reads a document's comparable facts, whitespace normalized", () => {
  const facts = pageFacts("/en/pricing", 200, FULL);

  expect(facts.url).toBe("/en/pricing");
  expect(facts.status).toBe(200);
  expect(facts.lang).toBe("en");
  expect(facts.title).toBe("Pricing");
  expect(facts.metaDescription).toBe("What the plans cost.");
  expect(facts.canonical).toBe("https://example.test/en/pricing");
  expect(facts.alternates).toEqual({
    de: "https://example.test/de/pricing",
    en: "https://example.test/en/pricing",
  });
  expect(facts.headings).toEqual([
    { level: 1, text: "Plans" },
    { level: 2, text: "Starter" },
  ]);
});

test("only same-origin and relative anchors are internal hrefs, sorted and deduped", () => {
  const facts = pageFacts("/en/pricing", 200, FULL);

  // The protocol-relative `//cdn…` is offsite however it looks, and `mailto:` is no page.
  expect(facts.internalHrefs).toEqual(["/en/legal/terms"]);
});

test("the visible text is what a reader sees: no script bytes, no style bytes", () => {
  const facts = pageFacts("/en/pricing", 200, FULL);

  expect(facts.text).toBe("Plans Pick one. Starter Terms Docs CDN Mail");
  expect(facts.text).not.toContain("display");
  expect(facts.text).not.toContain("pricing-abc.js");
});

test("a comment between two text runs adds no space: React's separator reads as the text a reader sees", () => {
  // React writes `<!-- -->` between adjacent text expressions; a reader sees `#docs` (#331).
  const rendered = pageFacts(
    "/tags",
    200,
    `<body><a href="/tags/docs">#<!-- -->docs</a> <p>Page <!-- -->1<!-- --> of <!-- -->2</p></body>`,
  );
  const written = pageFacts(
    "/tags",
    200,
    `<body><a href="/tags/docs">#docs</a> <p>Page 1 of 2</p></body>`,
  );

  expect(rendered.text).toBe("#docs Page 1 of 2");
  expect(rendered.text).toBe(written.text);
});

const TRAP = `<!doctype html>
<html lang="en">
<head><title>Home</title></head>
<body>
<a href="/en/pricing">Pricing</a>
<script>var wrong = "/assets/assets/fw-core.js"; var page = "/en/nowhere";</script>
<script type="module" src="/assets/assets/fw-core.js"></script>
</body>
</html>
`;

test("an href inside a script's source text is not an href the page has", () => {
  const facts = pageFacts("/en", 200, TRAP);

  expect(facts.internalHrefs).toEqual(["/en/pricing"]);
  expect(facts.internalHrefs).not.toContain("/en/nowhere");
  expect(facts.internalHrefs).not.toContain("/assets/assets/fw-core.js");
  expect(facts.text).toBe("Pricing");
});

function baselineOf(pages: readonly string[]): ParityBaseline {
  return {
    origin: { kind: "declared", why: "a unit test's stated intent" },
    pages: pages.map((html, index) =>
      pageFacts(`/p${String(index)}`, 200, html),
    ),
    redirects: [],
  };
}

function builtOf(pages: readonly string[]): BuiltSite {
  return {
    pages: pages.map((html, index) =>
      pageFacts(`/p${String(index)}`, 200, html),
    ),
    redirects: [],
  };
}

const PAGE = "<html lang=\"en\"><head><title>One</title></head><body><h1>One</h1></body></html>";
const RETITLED =
  "<html lang=\"en\"><head><title>Two</title></head><body><h1>One</h1></body></html>";

test("a difference nobody explained is a defect, and it names the field and both values", () => {
  const report = compareParity({
    baseline: baselineOf([PAGE]),
    built: builtOf([RETITLED]),
  });

  expect(report.defects).toEqual([
    { url: "/p0", field: "title", baseline: "One", built: "Two" },
  ]);
  expect(report.expected).toEqual([]);
  expect(report.coverage.compared).toBe(1);
});

test("a difference an expectation rule covers is expected, and carries the rule's reason", () => {
  const rules: readonly ExpectationRule[] = [
    {
      url: "/p0",
      field: "title",
      why: "the twin appends its brand to every title; the framework does not",
    },
  ];
  const report = compareParity({
    baseline: baselineOf([PAGE]),
    built: builtOf([RETITLED]),
    rules,
  });

  expect(report.defects).toEqual([]);
  expect(report.expected).toEqual([
    {
      url: "/p0",
      field: "title",
      baseline: "One",
      built: "Two",
      why: "the twin appends its brand to every title; the framework does not",
    },
  ]);
});

test("an expectation rule with no reason is refused rather than applied", () => {
  expect(() =>
    compareParity({
      baseline: baselineOf([PAGE]),
      built: builtOf([RETITLED]),
      rules: [{ field: "title", why: "   " }],
    }),
  ).toThrow(
    /Parity expectation rules: 1 rule has no reason — a rule with no reason is not a rule/,
  );
});

test("every reasonless rule is reported together, not one run at a time", () => {
  let message = "";
  try {
    compareParity({
      baseline: baselineOf([PAGE]),
      built: builtOf([RETITLED]),
      rules: [
        { field: "title", why: "  " },
        { url: "/p0", field: "text", why: "" },
      ],
    });
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain("Parity expectation rules: 2 rules have no reason");
  expect(message).toContain('\n  "title" — on every page');
  expect(message).toContain('\n  "text" — on "/p0"');
});

test("a baseline with no pages is refused, because a comparison over it compares nothing", () => {
  expect(() =>
    compareParity({ baseline: baselineOf([]), built: builtOf([]) }),
  ).toThrow(/Parity baseline \(declared\): holds no pages/);
});

test("a baseline URL accounted for other than once is refused", () => {
  const baseline: ParityBaseline = {
    origin: { kind: "declared", why: "a unit test's stated intent" },
    pages: [pageFacts("/p0", 200, PAGE), pageFacts("/p0", 200, PAGE)],
    redirects: [],
  };

  expect(() => compareParity({ baseline, built: builtOf([PAGE]) })).toThrow(
    /Parity baseline: 1 URL is listed more than once[\s\S]*"\/p0" — 2 times/,
  );
});

test("a built URL accounted for other than once is refused", () => {
  const built: BuiltSite = {
    pages: [pageFacts("/p0", 200, PAGE), pageFacts("/p0", 200, PAGE)],
    redirects: [],
  };

  expect(() => compareParity({ baseline: baselineOf([PAGE]), built })).toThrow(
    /Parity build: 1 URL is listed more than once[\s\S]*"\/p0" — 2 times/,
  );
});

test("duplicates on both sides are reported by one run, not a run apart", () => {
  const baseline: ParityBaseline = {
    origin: { kind: "declared", why: "a unit test's stated intent" },
    pages: [pageFacts("/p0", 200, PAGE), pageFacts("/p0", 200, PAGE)],
    redirects: [],
  };
  const built: BuiltSite = {
    pages: [pageFacts("/p1", 200, PAGE), pageFacts("/p1", 200, PAGE)],
    redirects: [],
  };

  let message = "";
  try {
    compareParity({ baseline, built });
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain('Parity baseline: 1 URL is listed more than once');
  expect(message).toContain('Parity build: 1 URL is listed more than once');
  expect(message).toContain('"/p0" — 2 times');
  expect(message).toContain('"/p1" — 2 times');
});

test("no expectation rule can explain away a URL the build does not serve", () => {
  // A site-wide `status` rule would match the difference a missing page is recorded
  // as, so coverage consults no rule.
  const report = compareParity({
    baseline: baselineOf([PAGE, PAGE]),
    built: builtOf([PAGE]),
    rules: [{ field: "status", why: "the twin serves a status this build does not" }],
  });

  expect(report.coverage.missingFromBuild).toEqual(["/p1"]);
  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/p1", field: "status", baseline: "200", built: "absent" },
  ]);
});

test("no expectation rule can explain away a URL only the build serves", () => {
  const report = compareParity({
    baseline: baselineOf([PAGE]),
    built: builtOf([PAGE, PAGE]),
    rules: [{ field: "status", why: "the twin serves a status this build does not" }],
  });

  expect(report.coverage.newInBuild).toEqual(["/p1"]);
  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/p1", field: "status", baseline: "absent", built: "200" },
  ]);
});

function withRedirects(
  baseline: readonly RedirectFact[],
  built: readonly RedirectFact[],
): { baseline: ParityBaseline; built: BuiltSite } {
  return {
    baseline: {
      origin: { kind: "declared", why: "a unit test's stated intent" },
      pages: [pageFacts("/p0", 200, PAGE)],
      redirects: baseline,
    },
    built: { pages: [pageFacts("/p0", 200, PAGE)], redirects: built },
  };
}

const MOVED: RedirectFact = { from: "/gone", to: "/p0", status: 301 };

test("no expectation rule can explain away a redirect the build dropped", () => {
  const report = compareParity({
    ...withRedirects([MOVED], []),
    rules: [{ field: "redirect", why: "the twin's table is not this build's" }],
  });

  expect(report.redirects).toEqual([
    { from: "/gone", outcome: "missing", baseline: MOVED },
  ]);
  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/gone", field: "redirect", baseline: JSON.stringify(MOVED), built: "absent" },
  ]);
});

test("no expectation rule can explain away a redirect nobody declared", () => {
  const report = compareParity({
    ...withRedirects([], [MOVED]),
    rules: [{ field: "redirect", why: "the twin's table is not this build's" }],
  });

  expect(report.redirects).toEqual([
    { from: "/gone", outcome: "unexpected", built: MOVED },
  ]);
  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/gone", field: "redirect", baseline: "absent", built: JSON.stringify(MOVED) },
  ]);
});

test("a redirect both sides declare, differing, is a field difference a rule can explain", () => {
  const report = compareParity({
    ...withRedirects([MOVED], [{ ...MOVED, status: 308 }]),
    rules: [
      { field: "redirect", why: "the twin answers 301 where this build answers 308" },
    ],
  });

  expect(report.defects).toEqual([]);
  expect(report.expected).toEqual([
    {
      url: "/gone",
      field: "redirect",
      baseline: JSON.stringify(MOVED),
      built: JSON.stringify({ ...MOVED, status: 308 }),
      why: "the twin answers 301 where this build answers 308",
    },
  ]);
});

test("an origin is quoted with its credentials and its query dropped", () => {
  expect(redactOrigin("https://user:pass@site.test/base?token=SECRET")).toBe(
    "https://site.test/base",
  );
  expect(redactOrigin("https://site.test")).toBe("https://site.test");
  expect(redactOrigin("https://site.test/#SECRET")).toBe("https://site.test");
});

test("a baseline URL the build does not serve is missing from the build, and is a defect", () => {
  const report = compareParity({
    baseline: baselineOf([PAGE, PAGE]),
    built: builtOf([PAGE]),
  });

  expect(report.coverage).toEqual({
    baselineUrls: 2,
    builtUrls: 1,
    compared: 1,
    missingFromBuild: ["/p1"],
    newInBuild: [],
  });
  expect(report.defects).toEqual([
    { url: "/p1", field: "status", baseline: "200", built: "absent" },
  ]);
});

test("a URL only the build has is new in the build, and is a defect until somebody explains it", () => {
  const report = compareParity({
    baseline: baselineOf([PAGE]),
    built: builtOf([PAGE, PAGE]),
  });

  expect(report.coverage.newInBuild).toEqual(["/p1"]);
  expect(report.defects).toEqual([
    { url: "/p1", field: "status", baseline: "absent", built: "200" },
  ]);
});

test("a redirect the build lost, one it changed, and one it gained are three verdicts", () => {
  const report = compareParity({
    baseline: {
      origin: { kind: "declared", why: "a unit test's stated intent" },
      pages: [pageFacts("/p0", 200, PAGE)],
      redirects: [
        { from: "/gone", to: "/p0", status: 301 },
        { from: "/moved", to: "/p0", status: 301 },
      ],
    },
    built: {
      pages: [pageFacts("/p0", 200, PAGE)],
      redirects: [
        { from: "/moved", to: "/p0", status: 308 },
        { from: "/extra", to: "/p0", status: 301 },
      ],
    },
  });

  expect(report.redirects).toEqual([
    {
      from: "/gone",
      outcome: "missing",
      baseline: { from: "/gone", to: "/p0", status: 301 },
    },
    {
      from: "/moved",
      outcome: "differs",
      baseline: { from: "/moved", to: "/p0", status: 301 },
      built: { from: "/moved", to: "/p0", status: 308 },
    },
    {
      from: "/extra",
      outcome: "unexpected",
      built: { from: "/extra", to: "/p0", status: 301 },
    },
  ]);
  expect(report.defects.map((one) => one.url)).toEqual([
    "/gone",
    "/moved",
    "/extra",
  ]);
  expect(report.defects.every((one) => one.field === "redirect")).toBe(true);
});

test("the report carries the baseline's origin, so no claim it makes is unqualified", () => {
  const report = compareParity({
    baseline: baselineOf([PAGE]),
    built: builtOf([PAGE]),
  });

  expect(report.baselineOrigin).toEqual({
    kind: "declared",
    why: "a unit test's stated intent",
  });
  expect(report.defects).toEqual([]);
});

const LINKED = `<html lang="en"><head><title>One</title></head><body>
<p>Read on</p><a href="/about/">About</a><a href="/posts">Posts</a>
<p>5 min read</p></body></html>`;
const RELINKED = `<html lang="en"><head><title>One</title></head><body>
<p>Read on</p><a href="/about">About</a><a href="/archive">Posts</a>
<p>Load comments</p></body></html>`;

test("a value-level rule excuses one href and still reports another in the same field", () => {
  const report = compareParity({
    baseline: baselineOf([LINKED]),
    built: builtOf([RELINKED]),
    rules: [
      {
        url: "/p0",
        field: "internalHrefs",
        baselineOnly: ["/about/"],
        builtOnly: ["/about"],
        why: "the twin spells its links with a trailing slash",
      },
      { url: "/p0", field: "text", why: "not what this test is about" },
    ],
  });

  expect(report.expected).toContainEqual({
    url: "/p0",
    field: "internalHrefs",
    baseline: '["/about/"]',
    built: '["/about"]',
    why: "the twin spells its links with a trailing slash",
  });
  expect(report.defects).toEqual([
    { url: "/p0", field: "internalHrefs", baseline: '["/posts"]', built: '["/archive"]' },
  ]);
  expect(report.stale).toEqual([]);
});

test("a span-level rule excuses one text span and still reports another in the same field", () => {
  const report = compareParity({
    baseline: baselineOf([LINKED]),
    built: builtOf([RELINKED]),
    rules: [
      {
        url: "/p0",
        field: "text",
        builtOnly: ["Load comments"],
        why: "the build loads comments behind a button",
      },
      { url: "/p0", field: "internalHrefs", why: "not what this test is about" },
    ],
  });

  expect(report.expected).toContainEqual({
    url: "/p0",
    field: "text",
    baseline: "[]",
    built: '["Load comments"]',
    why: "the build loads comments behind a button",
  });
  expect(report.defects).toEqual([
    { url: "/p0", field: "text", baseline: "Read on About Posts 5 min read", built: "Read on About Posts" },
  ]);
  expect(report.stale).toEqual([]);
});

test("a span excuses whole words only, not a piece of one", () => {
  const report = compareParity({
    baseline: baselineOf(["<body><p>Posts archive</p></body>"]),
    built: builtOf(["<body><p>Posts archived</p></body>"]),
    rules: [{ url: "/p0", field: "text", builtOnly: ["d"], why: "a letter is not a span" }],
  });

  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/p0", field: "text", baseline: "Posts archive", built: "Posts archived" },
  ]);
});

test("a span both sides carry is excused once, where one side carries it more often", () => {
  const report = compareParity({
    baseline: baselineOf(["<body><p>Home</p><p>Pedro Sousa</p></body>"]),
    built: builtOf(["<body><h1>Pedro Sousa</h1><p>Home</p><p>Pedro Sousa</p></body>"]),
    rules: [{ url: "/p0", field: "text", builtOnly: ["Pedro Sousa"], why: "a hidden heading" }],
  });

  expect(report.defects.filter((one) => one.field === "text")).toEqual([]);
  expect(report.expected).toContainEqual({
    url: "/p0",
    field: "text",
    baseline: "[]",
    built: '["Pedro Sousa"]',
    why: "a hidden heading",
  });
});

test("a value-level rule names a heading by its level and text", () => {
  const report = compareParity({
    baseline: baselineOf(["<body><h2>Posts</h2></body>"]),
    built: builtOf(["<body><h1>Home</h1><h2>Posts</h2><h2>Extra</h2></body>"]),
    rules: [{ url: "/p0", field: "headings", builtOnly: ["h1 Home"], why: "a hidden heading" }],
  });

  expect(report.expected.map((one) => one.built)).toContain('["h1 Home"]');
  expect(report.defects.filter((one) => one.field === "headings")).toEqual([
    {
      url: "/p0",
      field: "headings",
      baseline: '[{"level":2,"text":"Posts"}]',
      built: '[{"level":2,"text":"Posts"},{"level":2,"text":"Extra"}]',
    },
  ]);
});

test("a rule that excuses nothing is reported stale, and so is the part of one that excuses nothing", () => {
  const whole: ExpectationRule = { url: "/p0", field: "title", why: "the titles never differ here" };
  const report = compareParity({
    baseline: baselineOf([LINKED]),
    built: builtOf([RELINKED]),
    rules: [
      whole,
      {
        url: "/p0",
        field: "internalHrefs",
        baselineOnly: ["/about/", "/gone/"],
        why: "the twin spells its links with a trailing slash",
      },
      { url: "/p9", field: "text", builtOnly: ["Load comments"], why: "a page nobody compared" },
    ],
  });

  expect(report.stale).toEqual([
    whole,
    {
      url: "/p0",
      field: "internalHrefs",
      baselineOnly: ["/gone/"],
      why: "the twin spells its links with a trailing slash",
    },
    { url: "/p9", field: "text", builtOnly: ["Load comments"], why: "a page nobody compared" },
  ]);
});

test("a coverage failure cannot be excused by any rule shape", () => {
  for (const field of ["status", "redirect", "alternates"] as const) {
    expect(() =>
      compareParity({
        baseline: baselineOf([PAGE]),
        built: builtOf([PAGE]),
        rules: [{ field, builtOnly: ["absent"], why: "an attempt at a narrower rule" }],
      }),
    ).toThrow(/Parity expectation rules: 1 rule names values in a field that has none/);
  }

  const report = compareParity({
    baseline: baselineOf([PAGE, LINKED]),
    built: builtOf([PAGE]),
    rules: [
      { url: "/p1", field: "status", why: "the whole field" },
      { url: "/p1", field: "text", baselineOnly: ["5 min read"], why: "a span" },
      { url: "/p1", field: "internalHrefs", baselineOnly: ["/about/"], why: "a value" },
    ],
  });
  expect(report.expected).toEqual([]);
  expect(report.defects).toEqual([
    { url: "/p1", field: "status", baseline: "200", built: "absent" },
  ]);
  expect(report.stale).toHaveLength(3);
});

test("a finer rule with a blank value is refused, since a blank matches everywhere", () => {
  expect(() =>
    compareParity({
      baseline: baselineOf([PAGE]),
      built: builtOf([RETITLED]),
      rules: [{ url: "/p0", field: "text", builtOnly: [" "], why: "nothing" }],
    }),
  ).toThrow(/Parity expectation rules: 1 rule names a blank value/);
});

test("a rule that names an empty list of values is refused, since it excuses nothing and could never be stale", () => {
  let message = "";
  try {
    compareParity({
      baseline: baselineOf([PAGE]),
      built: builtOf([RETITLED]),
      rules: [
        { url: "/p0", field: "text", baselineOnly: [], why: "nothing named" },
        { field: "internalHrefs", baselineOnly: [], builtOnly: [], why: "nothing named either" },
      ],
    });
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain("Parity expectation rules: 2 rules name no values");
  expect(message).toContain('\n  "text" — on "/p0"');
  expect(message).toContain('\n  "internalHrefs" — on every page');
});

test("a rule for every page whose value matches nowhere is reported stale", () => {
  const rule: ExpectationRule = {
    field: "text",
    builtOnly: ["Consent"],
    why: "a banner this build no longer renders",
  };
  const report = compareParity({
    baseline: baselineOf([LINKED, PAGE]),
    built: builtOf([RELINKED, RETITLED]),
    rules: [rule],
  });

  expect(report.stale).toEqual([rule]);
});
