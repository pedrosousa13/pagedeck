// @vitest-environment jsdom
import { expect, test } from "vitest";
import {
  absorbedHeadConflicts,
  escapeAttributeValue,
  headElements,
} from "./head.js";
import type { AbsorbedMetadata } from "./render.js";

// Declared here rather than adding the `DOM` lib to the workspace tsconfig, which would
// let `document` typecheck in node-only packages. jsdom supplies it at runtime.
interface TestElement {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
}
interface TestDocument extends TestElement {
  readonly title: string;
  readonly body: TestElement;
}
declare const DOMParser: {
  new (): { parseFromString(html: string, type: string): TestDocument };
};

const CHARSET = '<meta charset="utf-8">';

function children(
  head: Parameters<typeof headElements>[0]["head"],
  styles: readonly string[] = [],
  inlineStyles: readonly string[] = [],
  links: Parameters<typeof headElements>[0]["links"] = undefined,
  absorbed: Parameters<typeof headElements>[0]["absorbed"] = [],
  socialImage: Parameters<typeof headElements>[0]["socialImage"] = undefined,
): readonly string[] {
  return headElements({
    head,
    styles,
    inlineStyles,
    links,
    absorbed,
    ...(socialImage === undefined ? {} : { socialImage }),
  });
}

function parseHead(
  head: Parameters<typeof headElements>[0]["head"],
  links: Parameters<typeof headElements>[0]["links"] = undefined,
): TestDocument {
  const html = [
    "<!doctype html>",
    "<html>",
    "<head>",
    ...children(head, [], [], links),
    "</head>",
    "<body></body>",
    "</html>",
  ].join("\n");
  return new DOMParser().parseFromString(html, "text/html");
}

test("a site with no head callback emits no scaffolding", () => {
  expect(children(undefined)).toEqual([CHARSET]);
});

test("a head callback that returns an empty object emits no scaffolding", () => {
  expect(children({})).toEqual([CHARSET]);
});

test("an explicitly empty title is a declaration, not an absence", () => {
  expect(children({ title: "" })).toEqual([
    CHARSET,
    "<title></title>",
    '<meta property="og:title" content="">',
  ]);
});

test("a field the site did not declare emits nothing of its own", () => {
  expect(children({ title: "Pricing" })).toEqual([
    CHARSET,
    "<title>Pricing</title>",
    '<meta property="og:title" content="Pricing">',
  ]);
});

test("the head's children are written in one fixed order", () => {
  expect(
    children(
      {
        title: "Pricing",
        description: "What it costs",
        image: "/og/pricing.png",
        jsonLd: { "@context": "https://schema.org", "@type": "WebPage" },
      },
      ["/assets/core.css", "/assets/pricing.css"],
      ["<style>.a{color:red}</style>"],
    ),
  ).toEqual([
    CHARSET,
    "<title>Pricing</title>",
    '<meta name="description" content="What it costs">',
    '<meta property="og:title" content="Pricing">',
    '<meta property="og:description" content="What it costs">',
    '<meta property="og:image" content="/og/pricing.png">',
    '<link rel="stylesheet" href="/assets/core.css">',
    '<link rel="stylesheet" href="/assets/pricing.css">',
    "<style>.a{color:red}</style>",
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>',
  ]);
});

test("a site with no origin gets no canonical and no alternates", () => {
  expect(children({ title: "Pricing" }, ["/assets/core.css"])).toEqual([
    CHARSET,
    "<title>Pricing</title>",
    '<meta property="og:title" content="Pricing">',
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("the canonical and the hreflang links are written in head:addresses", () => {
  expect(
    children(
      { title: "Pricing", jsonLd: { "@type": "WebPage" } },
      ["/assets/core.css", "/assets/pricing.css"],
      [],
      {
        canonical: "https://example.com/en/pricing",
        alternates: [
          { hreflang: "de", href: "https://example.de/pricing" },
          { hreflang: "en", href: "https://example.com/en/pricing" },
          { hreflang: "x-default", href: "https://example.com/en/pricing" },
        ],
      },
    ),
  ).toEqual([
    CHARSET,
    "<title>Pricing</title>",
    '<meta property="og:title" content="Pricing">',
    '<link rel="canonical" href="https://example.com/en/pricing">',
    '<link rel="alternate" hreflang="de" href="https://example.de/pricing">',
    '<link rel="alternate" hreflang="en" href="https://example.com/en/pricing">',
    '<link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing">',
    '<link rel="stylesheet" href="/assets/core.css">',
    '<link rel="stylesheet" href="/assets/pricing.css">',
    '<script type="application/ld+json">{"@type":"WebPage"}</script>',
  ]);
});

test("a canonical with no alternates beside it is one element, not a block", () => {
  expect(
    children(undefined, [], [], {
      canonical: "https://example.com/pricing",
      alternates: [],
    }),
  ).toEqual([CHARSET, '<link rel="canonical" href="https://example.com/pricing">']);
});

test("an emitted URL is escaped as a double-quoted attribute value", () => {
  const document = parseHead(undefined, {
    canonical: "https://example.com/a&b",
    alternates: [{ hreflang: "de", href: "https://example.de/a&b" }],
  });

  expect(
    document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
  ).toBe("https://example.com/a&b");
  expect(
    document.querySelector('link[rel="alternate"]')?.getAttribute("href"),
  ).toBe("https://example.de/a&b");
  expect(
    children(undefined, [], [], {
      canonical: "https://example.com/a&b",
      alternates: [{ hreflang: "de", href: 'https://example.de/"' }],
    }),
  ).toEqual([
    CHARSET,
    '<link rel="canonical" href="https://example.com/a&amp;b">',
    '<link rel="alternate" hreflang="de" href="https://example.de/&quot;">',
  ]);
});

test("a title is escaped as the character data of an element", () => {
  expect(children({ title: 'Tom & <b>Jerry</b> "quoted"' })).toContain(
    '<title>Tom &amp; &lt;b>Jerry&lt;/b> "quoted"</title>',
  );
});

test("a title holding a closing title tag cannot end the element", () => {
  const payload = "</title><script>alert(1)</script>";
  const document = parseHead({ title: payload });

  expect([...document.querySelectorAll("script")]).toHaveLength(0);
  expect(document.title).toBe(payload);
  expect(
    document.querySelector('meta[property="og:title"]')?.getAttribute("content"),
  ).toBe(payload);
});

test("a meta content value is escaped as a double-quoted attribute value", () => {
  expect(
    children({ description: 'a "quoted" phrase & <b>markup</b>' }),
  ).toContain(
    '<meta name="description" content="a &quot;quoted&quot; phrase &amp; <b>markup</b>">',
  );
});

test("an ampersand is escaped once, not twice", () => {
  expect(escapeAttributeValue('&amp; and "')).toBe("&amp;amp; and &quot;");
});

test("an OG image URL is a plain head field, escaped like any other", () => {
  expect(
    children({ image: "https://cdn.example/og.png?w=1200&h=630" }),
  ).toContain(
    '<meta property="og:image" content="https://cdn.example/og.png?w=1200&amp;h=630">',
  );
});

test("a generated card writes its dimensions and its card kind after og:image", () => {
  expect(
    children({ image: "/social/pricing.abc12345.png" }, [], [], undefined, [], {
      width: 1200,
      height: 630,
    }),
  ).toEqual([
    CHARSET,
    '<meta property="og:image" content="/social/pricing.abc12345.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
  ]);
});

test("a card below Twitter's large-image floor declares the summary it will get", () => {
  expect(
    children({ image: "/social/tiny.abc12345.png" }, [], [], undefined, [], {
      width: 240,
      height: 240,
    }),
  ).toContain('<meta name="twitter:card" content="summary">');
});

test("a page the site asked for no image for gets the head it got before the field existed", () => {
  const head = { title: "Pricing", description: "What it costs" };

  expect(children(head)).toEqual([
    CHARSET,
    "<title>Pricing</title>",
    '<meta name="description" content="What it costs">',
    '<meta property="og:title" content="Pricing">',
    '<meta property="og:description" content="What it costs">',
  ]);
});

test("every < in a JSON-LD payload is encoded, whatever it is part of", () => {
  const html = children({
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "a < b, b < c, so a < c",
    },
  }).join("");
  expect(html).not.toContain("a < b");
  expect(html).toContain("a \\u003c b, b \\u003c c, so a \\u003c c");
});

test("a JSON-LD payload holding a script tag round-trips inert", () => {
  const payload = "</script><script>alert(1)</script>";
  const node = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: payload,
  };
  const document = parseHead({ jsonLd: node });

  const scripts = [...document.querySelectorAll("script")];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]?.getAttribute("type")).toBe("application/ld+json");
  expect(document.body.textContent?.trim()).toBe("");

  expect(JSON.parse(scripts[0]?.textContent ?? "")).toEqual(node);
});

test("the encoding is lossless for every character it touches", () => {
  // U+2028 and U+2029 are in the string on purpose: the pair a payload is usually escaped
  // for, which this element never needs (it is never parsed as JavaScript).
  const headline = "<<< </script </SCRIPT <!-- --> & \" '     ✓";
  const document = parseHead({
    jsonLd: { "@context": "https://schema.org", "@type": "Thing", headline },
  });
  const text = document.querySelector("script")?.textContent ?? "";
  expect((JSON.parse(text) as { headline: string }).headline).toBe(headline);
});

test("a list of JSON-LD nodes is one block, as a JSON array", () => {
  expect(
    children({
      jsonLd: [
        { "@context": "https://schema.org", "@type": "Article" },
        { "@context": "https://schema.org", "@type": "BreadcrumbList" },
      ],
    }),
  ).toContain(
    '<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Article"},{"@context":"https://schema.org","@type":"BreadcrumbList"}]</script>',
  );
});

test("a JSON-LD payload carrying no term emits no block", () => {
  expect(children({ jsonLd: {} })).toEqual([CHARSET]);
  expect(children({ jsonLd: [{}] })).toEqual([CHARSET]);
  expect(children({ jsonLd: [{}, {}] })).toEqual([CHARSET]);
});

test("a payload with one empty node beside a real one is emitted whole", () => {
  expect(
    children({ jsonLd: [{ "@type": "Article" }, {}] }),
  ).toContain(
    '<script type="application/ld+json">[{"@type":"Article"},{}]</script>',
  );
});

test("an empty list of JSON-LD nodes emits no block", () => {
  expect(children({ jsonLd: [] })).toEqual([CHARSET]);
});

test("key order in the emitted JSON is the order the site wrote", () => {
  expect(
    children({ jsonLd: { b: 1, a: 2, "@type": "Thing" } })[1],
  ).toBe(
    '<script type="application/ld+json">{"b":1,"a":2,"@type":"Thing"}</script>',
  );
});

function absorbed(
  component: string,
  tag: string,
  singleton?: string,
  value = "",
): AbsorbedMetadata {
  return {
    component,
    tag,
    ...(singleton === undefined ? {} : { claim: { singleton, value } }),
  };
}

const TITLE_A = absorbed("Alpha", "<title>from Alpha</title>", "<title>", "from Alpha");
const TITLE_B = absorbed("Beta", "<title>from Beta</title>", "<title>", "from Beta");

test("an absorbed element is written after the metadata the site declared", () => {
  expect(
    children({ description: "Declared" }, [], [], undefined, [TITLE_B]),
  ).toEqual([
    CHARSET,
    '<meta name="description" content="Declared">',
    '<meta property="og:description" content="Declared">',
    "<title>from Beta</title>",
  ]);
});

test("two components claiming one title agree, and the head gets one element", () => {
  const twice = [TITLE_A, absorbed("Beta", "<title>from Alpha</title>", "<title>", "from Alpha")];

  expect(children(undefined, [], [], undefined, twice)).toEqual([
    CHARSET,
    "<title>from Alpha</title>",
  ]);
});

test("a meta that claims nothing is written as often as it was rendered", () => {
  const two = [
    absorbed("Alpha", '<meta content="one"/>'),
    absorbed("Beta", '<meta content="two"/>'),
  ];

  expect(children(undefined, [], [], undefined, two)).toEqual([
    CHARSET,
    '<meta content="one"/>',
    '<meta content="two"/>',
  ]);
});

test("two components claiming one title differently are refused", () => {
  expect(
    absorbedHeadConflicts({
      entry: "/en/home",
      head: undefined,
      absorbed: [TITLE_A, TITLE_B],
    }),
  ).toBe(
    "Entry /en/home: 2 claims on <title> disagree — a document holds one <title>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:\n" +
      '  "Alpha" — "from Alpha"\n' +
      '  "Beta" — "from Beta"',
  );
});

test("a component contradicting the site's own head is refused too", () => {
  expect(
    absorbedHeadConflicts({
      entry: "/en/home",
      head: { title: "Declared" },
      absorbed: [TITLE_A],
    }),
  ).toBe(
    "Entry /en/home: 2 claims on <title> disagree — a document holds one <title>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:\n" +
      '  build.head — "Declared"\n' +
      '  "Alpha" — "from Alpha"',
  );
});

test("a component contradicting the charset the build writes is refused", () => {
  expect(
    absorbedHeadConflicts({
      entry: "/en/home",
      head: undefined,
      absorbed: [
        absorbed("Alpha", '<meta charSet="utf-16"/>', "<meta charset>", "utf-16"),
      ],
    }),
  ).toBe(
    "Entry /en/home: 2 claims on <meta charset> disagree — a document holds one <meta charset>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:\n" +
      '  the build\'s own <head> — "utf-8"\n' +
      '  "Alpha" — "utf-16"',
  );
});

test("every disagreed-over singleton is reported in one run", () => {
  const report = absorbedHeadConflicts({
    entry: "/en/home",
    head: undefined,
    absorbed: [
      TITLE_A,
      TITLE_B,
      absorbed("Alpha", '<meta name="description" content="a"/>', '<meta name="description">', "a"),
      absorbed("Beta", '<meta name="description" content="b"/>', '<meta name="description">', "b"),
    ],
  });

  expect(report).toContain("2 claims on <title> disagree");
  expect(report).toContain('2 claims on <meta name="description"> disagree');
  expect(report?.split("\n\n")).toHaveLength(2);
});

const CARD = { width: 1200, height: 630 };

test("a component contradicting any tag the card derived is refused", () => {
  const report = absorbedHeadConflicts({
    entry: "/en/home",
    head: { image: "/social/en.abc12345.png" },
    socialImage: CARD,
    absorbed: [
      absorbed("Alpha", '<meta property="og:image:width" content="800"/>', '<meta property="og:image:width">', "800"),
      absorbed("Alpha", '<meta property="og:image:height" content="418"/>', '<meta property="og:image:height">', "418"),
      absorbed("Alpha", '<meta name="twitter:card" content="summary"/>', '<meta name="twitter:card">', "summary"),
    ],
  });

  expect(report).toContain('2 claims on <meta property="og:image:width"> disagree');
  expect(report).toContain('2 claims on <meta property="og:image:height"> disagree');
  expect(report).toContain('2 claims on <meta name="twitter:card"> disagree');
  expect(report).toContain('the build\'s own <head> — "1200"');
  expect(report).toContain('the build\'s own <head> — "630"');
  expect(report).toContain('the build\'s own <head> — "summary_large_image"');
  expect(report?.split("\n\n")).toHaveLength(3);
});

test("a component repeating a tag the card derived writes one element, not two", () => {
  const same = absorbed("Alpha", '<meta name="twitter:card" content="summary_large_image"/>', '<meta name="twitter:card">', "summary_large_image");

  expect(
    children({ image: "/social/en.abc12345.png" }, [], [], undefined, [same], CARD),
  ).toEqual([
    CHARSET,
    '<meta property="og:image" content="/social/en.abc12345.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
  ]);
});

test("claims that agree are not a conflict", () => {
  expect(
    absorbedHeadConflicts({
      entry: "/en/home",
      head: { title: "from Alpha" },
      absorbed: [TITLE_A, TITLE_A],
    }),
  ).toBeUndefined();
});

test("a hoist with no component to name says so rather than leaving a blank", () => {
  expect(
    absorbedHeadConflicts({
      entry: "/en/home",
      head: { title: "Declared" },
      absorbed: [{ tag: "<title>x</title>", claim: { singleton: "<title>", value: "x" } }],
    }),
  ).toContain('  the entry\'s own tree — "x"');
});

test("a URL a claim carries is redacted before it is quoted", () => {
  const report = absorbedHeadConflicts({
    entry: "/en/home",
    head: { image: "https://cdn.example/a.png?X-Amz-Signature=SECRET" },
    absorbed: [
      absorbed(
        "Alpha",
        "<meta/>",
        '<meta property="og:image">',
        "https://cdn.example/b.png?X-Amz-Signature=ALSOSECRET",
      ),
    ],
  });

  expect(report).toContain('  build.head — "https://cdn.example/a.png"');
  expect(report).toContain('  "Alpha" — "https://cdn.example/b.png"');
  expect(report).not.toContain("SECRET");
});

test("a path-shaped value is cut at its query, delimiter kept", () => {
  const report = absorbedHeadConflicts({
    entry: "/en/home",
    head: { image: "/og/a.png" },
    absorbed: [
      absorbed("Alpha", "<meta/>", '<meta property="og:image">', "/og/b.png?token=SECRET"),
    ],
  });

  expect(report).toContain('  "Alpha" — "/og/b.png?…"');
  expect(report).not.toContain("SECRET");
});

test("a title is quoted whole, question mark and all", () => {
  const report = absorbedHeadConflicts({
    entry: "/en/home",
    head: undefined,
    absorbed: [
      absorbed("Alpha", "<title/>", "<title>", "Why is it slow?"),
      absorbed("Beta", "<title/>", "<title>", "Why is it slow? Read on"),
    ],
  });

  expect(report).toContain('  "Alpha" — "Why is it slow?"');
  expect(report).toContain('  "Beta" — "Why is it slow? Read on"');
});

function fullHead(
  extra: Partial<Parameters<typeof headElements>[0]> = {},
): readonly string[] {
  return headElements({
    head: undefined,
    styles: [],
    inlineStyles: [],
    links: undefined,
    absorbed: [],
    ...extra,
  });
}

test("font preload links come after the canonical block and before the stylesheet block", () => {
  expect(
    fullHead({
      links: { canonical: "https://example.com/pricing", alternates: [] },
      fontPreloads: [
        '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
      ],
      styles: ["/assets/core.css"],
    }),
  ).toEqual([
    CHARSET,
    '<link rel="canonical" href="https://example.com/pricing">',
    '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("a page with no font preloads gets no block", () => {
  expect(fullHead({ styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("a pre-paint script comes after the font preloads and before the stylesheets", () => {
  expect(
    fullHead({
      links: { canonical: "https://example.com/pricing", alternates: [] },
      fontPreloads: [
        '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
      ],
      prePaint: ['document.documentElement.dataset.theme="dark"'],
      styles: ["/assets/core.css"],
    }),
  ).toEqual([
    CHARSET,
    '<link rel="canonical" href="https://example.com/pricing">',
    '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
    '<script>document.documentElement.dataset.theme="dark"</script>',
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("two pre-paint scripts are two elements, in the order the site declared them", () => {
  expect(fullHead({ prePaint: ["first()", "second()"] })).toEqual([
    CHARSET,
    "<script>first()</script>",
    "<script>second()</script>",
  ]);
});

test("a page on a site that declared no pre-paint script gets no element", () => {
  expect(fullHead({ styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
  expect(fullHead({ prePaint: [], styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("the view-transition rule opens the stylesheet block", () => {
  expect(
    fullHead({
      viewTransition: true,
      styles: ["/assets/core.css", "/assets/pricing.css"],
    }),
  ).toEqual([
    CHARSET,
    "<style>@view-transition { navigation: auto; }</style>",
    '<link rel="stylesheet" href="/assets/core.css">',
    '<link rel="stylesheet" href="/assets/pricing.css">',
  ]);
});

test("a page on a site that declared no view transitions gets no style", () => {
  expect(fullHead({ styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
  expect(fullHead({ viewTransition: false, styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("the speculation rules block is written last, after the JSON-LD", () => {
  expect(
    fullHead({
      head: { jsonLd: { "@type": "WebPage" } },
      styles: ["/assets/core.css"],
      speculation: '{"prefetch":[{"source":"list","urls":["/en/pricing"]}]}',
    }),
  ).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
    '<script type="application/ld+json">{"@type":"WebPage"}</script>',
    '<script type="speculationrules">{"prefetch":[{"source":"list","urls":["/en/pricing"]}]}</script>',
  ]);
});

test("a page with no speculation rules gets no block", () => {
  expect(fullHead()).toEqual([CHARSET]);
});

test("every < in a speculation rules document is encoded", () => {
  const rules = '{"prefetch":[{"source":"list","urls":["/a</script><b"]}]}';
  const [, element] = fullHead({ speculation: rules });
  const open = '<script type="speculationrules">';
  const text = (element ?? "").slice(open.length, -"</script>".length);

  expect(element?.startsWith(open)).toBe(true);
  expect(text).not.toContain("<");
  const parsed: unknown = JSON.parse(text);
  expect(parsed).toEqual({
    prefetch: [{ source: "list", urls: ["/a</script><b"] }],
  });
});

test("the feed link comes after the canonical block and before the font preloads", () => {
  expect(
    fullHead({
      links: { canonical: "https://example.com/pricing", alternates: [] },
      feed: { href: "https://example.com/rss.xml", title: "My Site" },
      fontPreloads: [
        '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
      ],
      styles: ["/assets/core.css"],
    }),
  ).toEqual([
    CHARSET,
    '<link rel="canonical" href="https://example.com/pricing">',
    '<link rel="alternate" type="application/rss+xml" title="My Site" href="https://example.com/rss.xml">',
    '<link rel="preload" href="/fonts/acme-sans.abc123.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("a page on a site that declared no feed gets no link", () => {
  expect(fullHead({ styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("a feed title holding a quotation mark cannot close its own attribute", () => {
  expect(
    fullHead({
      feed: { href: 'https://example.com/rss.xml?a="b', title: 'Tom & "Jerry"' },
    }),
  ).toEqual([
    CHARSET,
    '<link rel="alternate" type="application/rss+xml" title="Tom &amp; &quot;Jerry&quot;" href="https://example.com/rss.xml?a=&quot;b">',
  ]);
});

test("a not-found page's noindex opens head:addresses, before the feed link", () => {
  expect(
    fullHead({
      head: { title: "Not found" },
      noindex: true,
      feed: { href: "https://example.com/rss.xml", title: "My Site" },
      styles: ["/assets/core.css"],
    }),
  ).toEqual([
    CHARSET,
    "<title>Not found</title>",
    '<meta property="og:title" content="Not found">',
    '<meta name="robots" content="noindex">',
    '<link rel="alternate" type="application/rss+xml" title="My Site" href="https://example.com/rss.xml">',
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});

test("a page that is not a not-found page gets no robots element", () => {
  expect(fullHead({ noindex: false, styles: ["/assets/core.css"] })).toEqual([
    CHARSET,
    '<link rel="stylesheet" href="/assets/core.css">',
  ]);
});
