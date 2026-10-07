import { openStore } from "@pagedeck/content";
import type { ContentStore } from "@pagedeck/content";
import { afterEach, expect, test } from "vitest";
import { feedFaultReport, feedFiles } from "./feed.js";
import type { FeedSetting } from "./feed.js";
import type { LocaleSet } from "./locales.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";

const ORIGIN = "https://example.com";

const SETTING = {
  collection: "posts",
  title: "My Site",
  description: "Recent posts",
  item: { title: "title" },
};

test("a feed setting that is not an object is refused with the shape as the fix", () => {
  expect(feedFaultReport(true, ORIGIN, DEFAULT_TREE, "Config")).toBe(
    'Config: "build.feed" must be an object naming the collection its items come from — feed: { collection: "posts", title: "My Site", description: "Recent posts", item: { title: "title" } }',
  );
});

test("a valid setting reports nothing", () => {
  expect(feedFaultReport(SETTING, ORIGIN, DEFAULT_TREE, "Config")).toBe(undefined);
});

test("a feed declared without an origin is refused, because an item link is absolute", () => {
  expect(feedFaultReport(SETTING, undefined, DEFAULT_TREE, "Config")).toBe(
    'Config: "build.feed" is declared without "build.origin", and every <link> a feed item carries is an absolute URL — declare origin: "https://example.com", or remove feed',
  );
});

test("a feed on a site no tree of which serves the origin is refused, naming the origin and the domains", () => {
  expect(
    feedFaultReport(
      SETTING,
      "https://www.example.com",
      localeSet("example.com", "example.de"),
      "Config",
    ),
  ).toBe(
    `Config: "build.feed" is declared on a site with no output tree to write it in — every locale is served from a domain of its own, none of them is the origin's host, and the feed is one file at the origin's own address — declare a locale with no domain, or point origin at one of the declared domains:\n  "https://www.example.com" — the declared domains are "example.com", "example.de"`,
  );
});

test("a site with a default tree is served at its origin and is not refused", () => {
  expect(
    feedFaultReport(
      SETTING,
      "https://www.example.com",
      localeSet(undefined, "example.de"),
      "Config",
    ),
  ).toBe(undefined);
});

test("a site whose origin is one of its declared domains is not refused, in any legal spelling of it", () => {
  expect(
    feedFaultReport(
      SETTING,
      "https://example.de",
      localeSet("EXAMPLE.de", "example.fr"),
      "Config",
    ),
  ).toBe(undefined);
  expect(
    feedFaultReport(
      SETTING,
      "https://xn--mnchen-3ya.de",
      localeSet("münchen.de", "example.fr"),
      "Config",
    ),
  ).toBe(undefined);
});

test("a locale map this check cannot read leaves the verdict to the field that can", () => {
  expect(feedFaultReport(SETTING, ORIGIN, undefined, "Config")).toBe(undefined);
  expect(
    feedFaultReport(SETTING, "not-a-url", localeSet("example.de"), "Config"),
  ).toBe(undefined);
});

test("a missing collection is refused, naming the field and the fix", () => {
  expect(
    feedFaultReport(
      { ...SETTING, collection: undefined },
      ORIGIN,
      DEFAULT_TREE,
      "Config",
    ),
  ).toContain(
    '  "collection" — undefined — not the name of a collection to draw items from',
  );
});

test("every missing field is reported, not the first", () => {
  const report = feedFaultReport({ item: {} }, ORIGIN, DEFAULT_TREE, "Config") ?? "";

  expect(report).toContain('"collection"');
  expect(report).toContain('"title"');
  expect(report).toContain('"description"');
  expect(report).toContain('"item.title"');
  expect(report).toContain(
    'Config: "build.feed" declares 4 fields this build cannot write a feed from',
  );
});

test("an item that is not an object is one fault, not four", () => {
  const report = feedFaultReport(
    { ...SETTING, item: 7 },
    ORIGIN,
    DEFAULT_TREE,
    "Config",
  );

  expect(report).toContain('  "item" — 7 — not an entry-to-item mapping');
  expect(report).not.toContain('"item.title"');
  expect(report).toContain('declares 1 field this build cannot write a feed');
});

test("an optional item field declared as the wrong type is refused, not ignored", () => {
  expect(
    feedFaultReport(
      { ...SETTING, item: { title: "title", pubDate: 3 } },
      ORIGIN,
      DEFAULT_TREE,
      "Config",
    ),
  ).toContain('  "item.pubDate" — 3 — not an entry field name');
});

test("an item field off the prototype is not read as a declaration the site wrote", () => {
  const inherited = Object.create({ title: "title" }) as object;

  expect(
    feedFaultReport(
      { ...SETTING, item: inherited },
      ORIGIN,
      DEFAULT_TREE,
      "Config",
    ),
  ).toContain('"item.title" — undefined');
});

test("a missing field and a missing origin are one report, two paragraphs", () => {
  const report = feedFaultReport(
    { ...SETTING, title: "" },
    undefined,
    DEFAULT_TREE,
    "Config",
  );

  expect(report).toBe(
    `Config: "build.feed" declares 1 field this build cannot write a feed from — declare each as the type its own line names:\n  "title" — "" — not a channel title — write the name a reader's feed list should show — title: "My Site"\n\nConfig: "build.feed" is declared without "build.origin", and every <link> a feed item carries is an absolute URL — declare origin: "https://example.com", or remove feed`,
  );
});

function row(page: {
  path: `/${string}`;
  locale?: string;
  collection?: string;
  fallbackFrom?: string;
  domain?: string;
}): Page {
  const locale = page.locale ?? "en";
  const path = page.path;
  return {
    locale,
    path,
    domain: page.domain,
    output: `/${locale}${path}`,
    collection: page.collection ?? COLLECTION,
    entry: { locale, path: path.slice(1) },
    ...(page.fallbackFrom === undefined
      ? {}
      : { fallbackFrom: page.fallbackFrom }),
    dependencies: [],
  };
}

const COLLECTION = "posts";

const stores: ContentStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function storeWith(
  entries: readonly {
    locale?: string;
    path: string;
    collection?: string;
    data: Record<string, unknown>;
  }[],
): ContentStore {
  const store = openStore(":memory:");
  stores.push(store);
  for (const entry of entries) {
    store.upsertEntry({
      collection: entry.collection ?? COLLECTION,
      locale: entry.locale ?? "en",
      path: entry.path,
      data: entry.data,
    });
  }
  return store;
}

const ITEM = { title: "title", description: "summary", pubDate: "date" };

function localeSet(...domains: readonly (string | undefined)[]): LocaleSet {
  return new Map(
    domains.map((domain, index) => {
      const code = `l${String(index)}`;
      return [
        code,
        {
          code,
          label: code,
          direction: "ltr" as const,
          prefix: "",
          ...(domain === undefined ? {} : { domain }),
        },
      ];
    }),
  );
}

const DEFAULT_TREE = localeSet(undefined);

function feedFile(input: {
  store: ContentStore;
  pages: readonly Page[];
  setting?: Partial<FeedSetting>;
  emitted?: readonly EmittedFile[];
  locales?: LocaleSet;
  origin?: string;
}): EmittedFile {
  const files = feedFiles({
    setting: { ...SETTING, item: ITEM, ...input.setting },
    origin: input.origin ?? ORIGIN,
    store: input.store,
    pages: input.pages,
    locales: input.locales ?? DEFAULT_TREE,
    emitted: input.emitted ?? [],
  });
  const one = files[0];
  if (files.length !== 1 || one === undefined) {
    throw new Error(`expected one feed, got ${String(files.length)}`);
  }
  expect(one.path).toBe("/rss.xml");
  expect(one.kind).toBe("asset");
  return one;
}

function feed(input: {
  store: ContentStore;
  pages: readonly Page[];
  setting?: Partial<FeedSetting>;
  emitted?: readonly EmittedFile[];
}): string {
  const one = feedFile(input);
  expect(one.domain).toBe(undefined);
  return typeof one.contents === "string"
    ? one.contents
    : new TextDecoder().decode(one.contents);
}

function links(xml: string): readonly string[] {
  return [...xml.matchAll(/<link>([^<]*)<\/link>/g)]
    .map((match) => match[1] ?? "")
    .slice(1);
}

test("the items are the collection's pages, with the declared fields", () => {
  const store = storeWith([
    {
      path: "posts/second",
      data: {
        title: "Second post",
        summary: "The second one",
        date: "2026-06-02T09:00:00Z",
      },
    },
  ]);

  expect(feed({ store, pages: [row({ path: "/posts/second" })] })).toBe(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>My Site</title>
<link>https://example.com</link>
<description>Recent posts</description>
<atom:link rel="self" type="application/rss+xml" href="https://example.com/rss.xml"/>
<item>
<title>Second post</title>
<link>https://example.com/en/posts/second</link>
<guid isPermaLink="true">https://example.com/en/posts/second</guid>
<pubDate>Tue, 02 Jun 2026 09:00:00 GMT</pubDate>
<description>The second one</description>
</item>
</channel>
</rss>
`,
  );
});

test("a page of another collection is not an item", () => {
  const store = storeWith([
    { path: "posts/a", data: { title: "A" } },
    { path: "pages/about", collection: "marketing", data: { title: "About" } },
  ]);

  expect(
    links(
      feed({
        store,
        pages: [
          row({ path: "/posts/a" }),
          row({ path: "/pages/about", collection: "marketing" }),
        ],
      }),
    ),
  ).toEqual(["https://example.com/en/posts/a"]);
});

test("an entry the route table does not hold is not an item", () => {
  const store = storeWith([
    { path: "posts/live", data: { title: "Live" } },
    { path: "posts/draft", data: { title: "Draft" } },
  ]);

  expect(
    links(feed({ store, pages: [row({ path: "/posts/live" })] })),
  ).toEqual(["https://example.com/en/posts/live"]);
});

test("a fallback page is not a second item for one post", () => {
  const store = storeWith([
    { path: "posts/a", data: { title: "A" } },
    { locale: "fr", path: "posts/a", data: { title: "A" } },
  ]);

  expect(
    links(
      feed({
        store,
        pages: [
          row({ path: "/posts/a" }),
          row({ locale: "fr", path: "/posts/a", fallbackFrom: "en" }),
        ],
      }),
    ),
  ).toEqual(["https://example.com/en/posts/a"]);
});

test("a natively translated page is its own item", () => {
  const store = storeWith([
    { path: "posts/a", data: { title: "A" } },
    { locale: "fr", path: "posts/a", data: { title: "A, en français" } },
  ]);

  expect(
    links(
      feed({
        store,
        pages: [
          row({ path: "/posts/a" }),
          row({ locale: "fr", path: "/posts/a" }),
        ],
      }),
    ),
  ).toEqual([
    "https://example.com/en/posts/a",
    "https://example.com/fr/posts/a",
  ]);
});

test("items are newest first, in a total order over the rows and not the order they arrived", () => {
  const entries = [
    { path: "posts/a", data: { title: "A", date: "2026-06-01T09:00:00Z" } },
    { path: "posts/b", data: { title: "B", date: "2026-06-03T09:00:00Z" } },
    { path: "posts/c", data: { title: "C", date: "2026-06-02T09:00:00Z" } },
  ];
  const paths = ["/posts/a", "/posts/b", "/posts/c"] as const;
  const forwards = feed({
    store: storeWith(entries),
    pages: paths.map((path) => row({ path })),
  });
  const backwards = feed({
    store: storeWith(entries),
    pages: [...paths].reverse().map((path) => row({ path })),
  });

  expect(forwards).toBe(backwards);
  expect(links(forwards)).toEqual([
    "https://example.com/en/posts/b",
    "https://example.com/en/posts/c",
    "https://example.com/en/posts/a",
  ]);
});

test("undated items sort after the dated ones, in link order", () => {
  const store = storeWith([
    { path: "posts/z", data: { title: "Z" } },
    { path: "posts/a", data: { title: "A" } },
    { path: "posts/m", data: { title: "M", date: "2026-06-01T09:00:00Z" } },
  ]);

  expect(
    links(
      feed({
        store,
        pages: [
          row({ path: "/posts/z" }),
          row({ path: "/posts/a" }),
          row({ path: "/posts/m" }),
        ],
      }),
    ),
  ).toEqual([
    "https://example.com/en/posts/m",
    "https://example.com/en/posts/a",
    "https://example.com/en/posts/z",
  ]);
});

// A named zone: CI runs in UTC, where a host-local read passes by accident, and
// +05:45 matches no rendering of a UTC instant.
function inZone<T>(zone: string, read: () => T): T {
  const before = process.env["TZ"];
  process.env["TZ"] = zone;
  try {
    return read();
  } finally {
    if (before === undefined) delete process.env["TZ"];
    else process.env["TZ"] = before;
  }
}

test("a stamp carrying no timezone designator is read as UTC, not as the machine's local time", () => {
  const store = storeWith([
    { path: "posts/a", data: { title: "A", date: "2026-06-01T09:00:00" } },
  ]);

  expect(
    inZone("Asia/Kathmandu", () =>
      feed({ store, pages: [row({ path: "/posts/a" })] }),
    ),
  ).toContain("<pubDate>Mon, 01 Jun 2026 09:00:00 GMT</pubDate>");
});

test("items are ordered by the instant a stamp names, not by how it is spelled", () => {
  // An hour apart and in the other order as text, so a sort on the raw string fails.
  const store = storeWith([
    {
      path: "posts/earlier",
      data: { title: "Earlier", date: "2026-06-01T10:00:00+02:00" },
    },
    {
      path: "posts/later",
      data: { title: "Later", date: "2026-06-01T09:00:00Z" },
    },
  ]);

  expect(
    links(
      feed({
        store,
        pages: [
          row({ path: "/posts/earlier" }),
          row({ path: "/posts/later" }),
        ],
      }),
    ),
  ).toEqual([
    "https://example.com/en/posts/later",
    "https://example.com/en/posts/earlier",
  ]);
});

test("a field an entry does not carry writes no element rather than an empty one", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);
  const xml = feed({ store, pages: [row({ path: "/posts/a" })] });

  expect(xml).toContain("<title>A</title>");
  expect(xml).not.toContain("<description></description>");
  expect(xml).not.toContain("<pubDate>");
});

test("a date this build cannot read as an instant writes no element", () => {
  const store = storeWith([
    { path: "posts/a", data: { title: "A", date: "last tuesday" } },
  ]);

  expect(feed({ store, pages: [row({ path: "/posts/a" })] })).not.toContain(
    "<pubDate>",
  );
});

test("XML delimiters in a title, a description and a URL are escaped", () => {
  const store = storeWith([
    {
      path: "posts/a&b",
      data: { title: 'Tom & "Jerry" <b>', summary: "1 < 2 & 3" },
    },
  ]);
  const xml = feed({ store, pages: [row({ path: "/posts/a&b" })] });

  expect(xml).toContain("<title>Tom &amp; &quot;Jerry&quot; &lt;b></title>");
  expect(xml).toContain("<description>1 &lt; 2 &amp; 3</description>");
  expect(xml).toContain("<link>https://example.com/en/posts/a&amp;b</link>");
  expect(xml).toContain(
    '<guid isPermaLink="true">https://example.com/en/posts/a&amp;b</guid>',
  );
});

test("a feed at a deploy key the build already wrote is refused, naming what is there", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(() =>
    feed({
      store,
      pages: [row({ path: "/posts/a" })],
      emitted: [{ path: "/rss.xml", kind: "html", contents: "" }],
    }),
  ).toThrow(
    /"\/rss\.xml" — the build already emitted an html file there — move the page off that address/,
  );
});

test("the feed lands in the tree that serves the origin, not at the root of a site that has no default tree", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a", domain: "example.com" })],
      locales: localeSet("example.com", "example.de"),
    }).domain,
  ).toBe("example.com");
});

test("a domain spelled in another legal case than the origin is still the origin's tree", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a", domain: "example.de" })],
      locales: localeSet("EXAMPLE.de", "example.fr"),
      origin: "https://example.de",
    }).domain,
  ).toBe("example.de");
});

test("a domain spelled in Unicode is the origin's tree when the origin is punycode, and the other way round", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a", domain: "xn--mnchen-3ya.de" })],
      locales: localeSet("münchen.de", "example.fr"),
      origin: "https://xn--mnchen-3ya.de",
    }).domain,
  ).toBe("xn--mnchen-3ya.de");
  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a", domain: "xn--mnchen-3ya.de" })],
      locales: localeSet("xn--mnchen-3ya.de", "example.fr"),
      origin: "https://münchen.de",
    }).domain,
  ).toBe("xn--mnchen-3ya.de");
});

test("a trailing dot is a host of its own, and a domain carrying one is not the tree of an origin without it", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a" })],
      locales: localeSet(undefined, "example.de."),
      origin: "https://example.de",
    }).domain,
  ).toBe(undefined);
});

test("a site with no locale on the origin's own host keeps the feed in the default tree", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(
    feedFile({
      store,
      pages: [row({ path: "/posts/a" })],
      locales: localeSet(undefined, "example.de"),
    }).domain,
  ).toBe(undefined);
});

test("the collision is checked at the key the feed is actually written to", () => {
  const store = storeWith([{ path: "posts/a", data: { title: "A" } }]);

  expect(() =>
    feedFile({
      store,
      pages: [row({ path: "/posts/a", domain: "example.com" })],
      locales: localeSet("example.com", "example.de"),
      emitted: [
        { domain: "example.com", path: "/rss.xml", kind: "html", contents: "" },
      ],
    }),
  ).toThrow(
    /"\/\/example\.com\/rss\.xml" — the build already emitted an html file there/,
  );
});

test("a channel with no item at all is still a channel", () => {
  const xml = feed({ store: storeWith([]), pages: [] });

  expect(xml).toContain("<title>My Site</title>");
  expect(xml).not.toContain("<item>");
});
