import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import type { RedirectRecord } from "./incremental.js";
import type { Page, TrailingSlash } from "./pages.js";
import { normalizeOutputPath, normalizeOutputPrefix } from "./pages.js";
import {
  notFoundPages,
  planRouting,
  redirectIndex,
  ROUTING_VERSION,
  SECURITY_HEADERS,
  undeclaredHeadersWarning,
  VARIANT_SEGMENT,
  variantPath,
} from "./routing.js";
import type { RoutingConfig, RoutingInput } from "./routing.js";

const HEADER_VALUE_FIX =
  "remove the character; RFC 9110 forbids CR, LF and NUL in a field value, where a line break can write a second header, and a Worker's Headers refuses any character above U+00FF";

function page(
  locale: string,
  path: `/${string}`,
  output: string,
  domain?: string,
): Page {
  return {
    locale,
    path,
    output,
    ...(domain === undefined ? {} : { domain }),
    dependencies: [],
  };
}

const PAGES: readonly Page[] = [
  page("en", "/", "/"),
  page("en", "/about", "/about"),
  page("en", "/pricing", "/pricing"),
  page("en", "/404", "/404"),
  page("de-ch", "/about", "/de/about", "shop.example"),
  page("fr-ch", "/about", "/fr/about", "shop.example"),
  page("de-ch", "/404", "/de/404", "shop.example"),
];

function plan(overrides: Partial<RoutingInput> = {}) {
  return planRouting({
    pages: PAGES,
    trailingSlash: "never",
    ...overrides,
  });
}

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

test("the routing document is the golden shape", () => {
  const config: RoutingConfig = {
    redirects: [
      { from: "/plans/", to: "/pricing", status: 302 },
      { from: "/de/alt", to: "/de/about", domain: "shop.example" },
    ],
    notFound: [
      { locale: "en", path: "/404" },
      { domain: "shop.example", locale: "de-ch", path: "/404" },
    ],
    headers: [
      {
        prefix: "/",
        set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
      },
      {
        prefix: "/pricing",
        set: [{ name: "Cache-Control", value: "public, max-age=60" }],
      },
    ],
  };
  const removals: readonly RedirectRecord[] = [
    {
      from: "/legacy",
      to: "/about",
      status: 308,
      reason: "deleted-page",
    },
  ];
  expect(plan({ config, removals })).toEqual({
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [
          {
            from: "/legacy",
            to: "/about",
            status: 308,
            source: "deleted-page",
            via: [],
          },
          {
            from: "/plans",
            to: "/pricing",
            status: 302,
            source: "config",
            via: [],
          },
        ],
        notFound: "/404",
        headers: [
          {
            prefix: "/pricing",
            set: [{ name: "Cache-Control", value: "public, max-age=60" }],
          },
          {
            prefix: "/",
            set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
          },
        ],
      },
      {
        domain: "shop.example",
        redirects: [
          {
            from: "/de/alt",
            to: "/de/about",
            status: 308,
            source: "config",
            via: [],
          },
        ],
        notFound: "/de/404",
        headers: [],
      },
    ],
  });
});

test("an omitted status is 308, the deletion policy's", () => {
  const [tree] = plan({
    config: { redirects: [{ from: "/plans", to: "/pricing" }] },
  }).trees;
  expect(tree?.redirects[0]?.status).toBe(308);
});

test("a chain collapses onto its terminus and records the hops", () => {
  const manifest = plan({
    config: {
      redirects: [
        { from: "/a", to: "/b" },
        { from: "/b", to: "/pricing" },
      ],
    },
  });
  expect(manifest.trees[0]?.redirects).toEqual([
    { from: "/a", to: "/pricing", status: 308, source: "config", via: ["/b"] },
    { from: "/b", to: "/pricing", status: 308, source: "config", via: [] },
  ]);
});

test("the first hop's status survives a flattening, and the later ones do not", () => {
  const manifest = plan({
    config: {
      redirects: [
        { from: "/a", to: "/b", status: 302 },
        { from: "/b", to: "/pricing", status: 308 },
      ],
    },
  });
  expect(manifest.trees[0]?.redirects[0]).toEqual({
    from: "/a",
    to: "/pricing",
    status: 302,
    source: "config",
    via: ["/b"],
  });
});

test("a deletion record chains through a config rule", () => {
  const manifest = plan({
    config: { redirects: [{ from: "/old", to: "/pricing" }] },
    removals: [
      { from: "/gone", to: "/old", status: 301, reason: "deleted-page" },
    ],
  });
  expect(manifest.trees[0]?.redirects[0]).toEqual({
    from: "/gone",
    to: "/pricing",
    status: 301,
    source: "deleted-page",
    via: ["/old"],
  });
});

test("a loop is refused, in hop order, once per loop", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [
          { from: "/a", to: "/b" },
          { from: "/b", to: "/a" },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect chain is a loop — point one of these at a page this build routes:",
      '  the default tree — "/a" → "/b" → "/a"',
    ].join("\n"),
  );
});

test("a path that is not a path is refused with the spelling's own reason", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [{ from: "/old?token=SECRET", to: "/about" }],
        headers: [{ prefix: "/a%2", set: [] }],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 configured paths are not usable paths:",
      '  build.routing.redirects[0].from — Path "/old?…": holds a query or fragment — pass the path alone, or escape the delimiter as "%3F" or "%23"',
      '  build.routing.headers[0].prefix — Path "/a%…": holds a malformed percent-escape — complete it with two hex digits, or write "%25" for a literal percent sign',
    ].join("\n"),
  );
});

test("a 404 page's path that is not a path is collected with every other one", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [{ from: "/old?token=SECRET", to: "/about" }],
        notFound: [{ locale: "en", path: "/404#SECRET" }],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 configured paths are not usable paths:",
      '  build.routing.redirects[0].from — Path "/old?…": holds a query or fragment — pass the path alone, or escape the delimiter as "%3F" or "%23"',
      '  build.routing.notFound[0].path — Path "/404#…": holds a query or fragment — pass the path alone, or escape the delimiter as "%3F" or "%23"',
    ].join("\n"),
  );
  expect(failure.message).not.toContain("SECRET");
});

test("a not-found page is its rule's identity, spelled under the site's policy (#592)", () => {
  const notFound = notFoundPages(
    { notFound: [{ locale: "en", path: "/404/" }] },
    "never",
  );
  expect(
    PAGES.filter(notFound).map((row) => `${row.locale} ${row.path}`),
  ).toEqual(["en /404"]);
  expect(
    PAGES.filter(
      notFoundPages({ notFound: [{ locale: "en", path: "/404#x" }] }, "never"),
    ),
  ).toEqual([]);
  expect(PAGES.filter(notFoundPages(undefined, "never"))).toEqual([]);
});

test("each tree's not-found page is the page notFoundPages names in it", () => {
  const config: RoutingConfig = {
    notFound: [
      { locale: "en", path: "/404" },
      { domain: "shop.example", locale: "de-ch", path: "/404" },
    ],
  };
  const notFound = notFoundPages(config, "never");
  const trees = plan({ config }).trees;
  expect(trees.map((tree) => tree.notFound)).toEqual(["/404", "/de/404"]);
  for (const tree of trees) {
    expect(
      PAGES.filter((row) => row.domain === tree.domain && notFound(row)).map(
        (row) => row.output,
      ),
    ).toEqual([tree.notFound]);
  }
});

test("an off-site target is refused at the config door, and never quoted", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [
          { from: "/a", to: "https://evil.example/?token=SECRET" },
          { from: "/b", to: "//evil.example" },
          { from: "/c", to: "/\\evil.example" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      'Routing manifest: 3 redirect targets are not paths on this site — write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge:',
      "  build.routing.redirects[0] — the target holds a scheme",
      '  build.routing.redirects[1] — the target begins "//", which is a host',
      "  build.routing.redirects[2] — the target holds a backslash",
    ].join("\n"),
  );
  expect(failure.message).not.toContain("SECRET");
});

test("an off-site source is refused too, with its own fix", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [
          { from: "https://old.example/x?token=SECRET", to: "/about" },
          { from: "//old.example/y", to: "/about" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      'Routing manifest: 2 redirect sources are not paths on this site — write a tree-relative path like "/pricing"; the edge matches the path alone, so a source spelled as a URL is a rule that can never fire:',
      "  build.routing.redirects[0] — the source holds a scheme",
      '  build.routing.redirects[1] — the source begins "//", which is a host',
    ].join("\n"),
  );
  expect(failure.message).not.toContain("SECRET");
});

test("a header field holding a line break is refused, and its value is not quoted", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [
          {
            prefix: "/",
            set: [
              {
                name: "X-Frame-Options",
                value: "DENY\r\nSet-Cookie: s=SECRET",
              },
              { name: "Bad\nName", value: "x" },
            ],
          },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 header name holds a line break — remove it — a header field that can hold a line break can write a second header:",
      "  build.routing.headers[0].set[1] — the header name holds a line break",
      "",
      `Routing manifest: 1 header value cannot be sent — ${HEADER_VALUE_FIX}:`,
      '  build.routing.headers[0].set[0] — "X-Frame-Options" — the header value holds U+000D',
    ].join("\n"),
  );
  expect(failure.message).not.toContain("SECRET");
});

test("a header value holding NUL or a character above U+00FF is refused, by code point", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [
          {
            prefix: "/",
            set: [{ name: "X-Note", value: "SECRET\u0000" }],
          },
          {
            prefix: "/de/",
            domain: "shop.example",
            set: [
              { name: "X-Frame-Options", value: "DENY" },
              { name: "Link", value: "</next>; rel=next → SECRET" },
            ],
          },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      `Routing manifest: 2 header values cannot be sent — ${HEADER_VALUE_FIX}:`,
      '  build.routing.headers[0].set[0] — "X-Note" — the header value holds U+0000',
      '  build.routing.headers[1].set[1] — "Link" — the header value holds U+2192',
    ].join("\n"),
  );
  expect(failure.message).not.toContain("SECRET");
});

test("a header value every edge target sends is accepted", () => {
  const set = [
    { name: "X-Tab", value: "a\tb" },
    { name: "X-Latin", value: "caf\u00e9 \u00ff" },
  ];
  expect(
    plan({ config: { headers: [{ prefix: "/", set }] } }).trees[0]?.headers,
  ).toEqual([{ prefix: "/", set }]);
});

test("a header name that is not a token is refused, in its own section", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [
          {
            prefix: "/",
            set: [
              { name: "/evil/*", value: "x" },
              { name: "X: Injected", value: "v" },
              { name: "", value: "e" },
              { name: "Bad\nName", value: "y" },
            ],
          },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 header name holds a line break — remove it — a header field that can hold a line break can write a second header:",
      "  build.routing.headers[0].set[3] — the header name holds a line break",
      "",
      'Routing manifest: 3 header names are not tokens — write the name as a header field name, such as "X-Frame-Options"; a name that is not one is emitted verbatim, and each target then either reads that line as a different field than the one written, or refuses it outright after the build has already reported success:',
      '  build.routing.headers[0].set[0] — "/evil/*" — the header name holds "/", and a header name is one RFC 9110 token',
      '  build.routing.headers[0].set[1] — "X: Injected" — the header name holds ":", and a header name is one RFC 9110 token',
      '  build.routing.headers[0].set[2] — "" — the header name is empty',
    ].join("\n"),
  );
});

test('a header field named "Location" is refused, in any case, in its own section', () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [
          {
            prefix: "/",
            set: [
              { name: "X-Frame-Options", value: "DENY" },
              { name: "Location", value: "https://elsewhere.example/" },
            ],
          },
          { prefix: "/docs/", set: [{ name: "location", value: "/x" }] },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      'Routing manifest: 2 header fields are named "Location" in some letter case — remove each; every target writes "Location" itself on the redirects it answers and it means nothing on any other response, so it is refused wherever it is declared — to send a path elsewhere, write a redirect rule:',
      '  build.routing.headers[0].set[1] — "Location"',
      '  build.routing.headers[1].set[0] — "location"',
    ].join("\n"),
  );
});

test('one header field named "Location" is told to remove it', () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [{ prefix: "/", set: [{ name: "LOCATION", value: "/x" }] }],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      'Routing manifest: 1 header field is named "Location" in some letter case — remove it; every target writes "Location" itself on the redirects it answers and it means nothing on any other response, so it is refused wherever it is declared — to send a path elsewhere, write a redirect rule:',
      '  build.routing.headers[0].set[0] — "LOCATION"',
    ].join("\n"),
  );
});

test('a header name of "__proto__" is a token, so this pass does not refuse it', () => {
  const manifest = plan({
    config: {
      headers: [{ prefix: "/", set: [{ name: "__proto__", value: "x" }] }],
    },
  });
  expect(manifest.trees[0]?.headers[0]?.set).toEqual([
    { name: "__proto__", value: "x" },
  ]);
});

test("a header prefix keeps the boundary its author wrote", () => {
  const prefixOf = (prefix: string, trailingSlash: TrailingSlash) =>
    planRouting({
      pages: [
        page("en", "/docs", "/docs"),
        page("en", "/docsearch", "/docsearch"),
      ],
      trailingSlash,
      config: { headers: [{ prefix, set: [] }] },
    }).trees[0]?.headers[0]?.prefix;
  expect(prefixOf("/docs/", "never")).toBe("/docs/");
  expect(prefixOf("/docs", "always")).toBe("/docs");
  expect(prefixOf("docs//a/../%7Eb/", "never")).toBe("/docs/~b/");
  expect(prefixOf("/", "never")).toBe("/");
});

test("two header rules over one prefix are refused", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        headers: [
          { prefix: "/a", set: [{ name: "X", value: "1" }] },
          { prefix: "/a", set: [{ name: "X", value: "2" }] },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 prefix carries more than one header set — give each prefix one header set:",
      '  "/a" in the default tree — build.routing.headers[0], build.routing.headers[1]',
    ].join("\n"),
  );
});

test("a deletion record is spelled under this build's trailing-slash policy", () => {
  const manifest = plan({
    removals: [
      { from: "/legacy/", to: "/about/", status: 308, reason: "deleted-page" },
    ],
  });
  expect(manifest.trees[0]?.redirects).toEqual([
    {
      from: "/legacy",
      to: "/about",
      status: 308,
      source: "deleted-page",
      via: [],
    },
  ]);
  expect(redirectIndex(manifest)(undefined, "/legacy")?.to).toBe("/about");
});

test("a status no static host serves is refused", () => {
  const failure = failureOf(() =>
    plan({
      removals: [
        { from: "/gone", to: "/about", status: 200, reason: "deleted-page" },
      ],
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect declares a status no static host serves — use 301, 302, 307 or 308:",
      "  a redirect for a page this build deleted — status 200",
    ].join("\n"),
  );
});

test("a rule naming a domain no page occupies is refused alone", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [{ domain: "gone.example", from: "/a", to: "/b" }],
        headers: [{ domain: "gone.example", prefix: "/", set: [] }],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 rules name domains no page occupies — route a locale to that domain, or move the rule to a tree this build emits:",
      '  build.routing.headers[0] — "gone.example"',
      '  build.routing.redirects[0] — "gone.example"',
    ].join("\n"),
  );
});

const SPELLED: readonly Page[] = [
  {
    ...page("de", "/about", "/de/about", "xn--mnchen-3ya.de"),
    declaredDomain: "münchen.de",
  },
  {
    ...page("de-AT", "/about", "/de-AT/about", "xn--mnchen-3ya.de"),
    declaredDomain: "xn--mnchen-3ya.de",
  },
];

test("a rule may name its tree by any spelling a locale declared", () => {
  const pages = SPELLED;
  const manifest = plan({
    pages,
    config: {
      redirects: [
        { domain: "münchen.de", from: "/old", to: "/de/about" },
        { domain: "xn--mnchen-3ya.de", from: "/older", to: "/de-AT/about" },
      ],
    },
  });
  expect(manifest.trees.map((tree) => tree.domain)).toEqual([
    "xn--mnchen-3ya.de",
  ]);
  expect(manifest.trees[0]?.redirects.map((rule) => rule.from)).toEqual([
    "/old",
    "/older",
  ]);
});

test("a rule may name its tree by a spelling no locale declared, where the host is the same", () => {
  const manifest = plan({
    pages: SPELLED,
    config: {
      redirects: [{ domain: "MÜNCHEN.de", from: "/old", to: "/de/about" }],
      headers: [{ domain: "Xn--Mnchen-3ya.de", prefix: "/", set: [] }],
    },
  });
  expect(manifest.trees.map((tree) => tree.domain)).toEqual([
    "xn--mnchen-3ya.de",
  ]);
  expect(manifest.trees[0]?.redirects.map((rule) => rule.from)).toEqual([
    "/old",
  ]);
});

test("a tree declared in another spelling is named by its key and by what the site wrote", () => {
  const failure = failureOf(() =>
    plan({
      pages: SPELLED,
      config: {
        redirects: [
          { domain: "münchen.de", from: "/de/about", to: "/de-AT/about" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect starts at a path this build serves — move the page or drop the rule — a page and a redirect cannot both answer one path, and the route table has no precedence rules:",
      '  "/de/about" in the "xn--mnchen-3ya.de" tree (declared "münchen.de") — build.routing.redirects[0], and the page de /about',
    ].join("\n"),
  );
});

test("a redirect from a path this build serves is refused", () => {
  const failure = failureOf(() =>
    plan({ config: { redirects: [{ from: "/about", to: "/pricing" }] } }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect starts at a path this build serves — move the page or drop the rule — a page and a redirect cannot both answer one path, and the route table has no precedence rules:",
      '  "/about" in the default tree — build.routing.redirects[0], and the page en /about',
    ].join("\n"),
  );
});

test("two rules over one path are refused, both claimants and both sources named", () => {
  const failure = failureOf(() =>
    plan({
      config: { redirects: [{ from: "/gone", to: "/pricing", status: 301 }] },
      removals: [
        { from: "/gone", to: "/about", status: 308, reason: "deleted-page" },
      ],
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 path is redirected by more than one rule — give each path one target and one status:",
      '  "/gone" in the default tree — build.routing.redirects[0] (config) to "/pricing" 301, a redirect for a page this build deleted (deleted-page) to "/about" 308',
    ].join("\n"),
  );
});

test("two rules that agree on one path are one rule", () => {
  const manifest = plan({
    config: { redirects: [{ from: "/gone", to: "/about" }] },
    removals: [
      { from: "/gone", to: "/about", status: 308, reason: "deleted-page" },
    ],
  });
  expect(manifest.trees[0]?.redirects).toHaveLength(1);
});

test("a target that is no page of this build is refused", () => {
  const failure = failureOf(() =>
    plan({ config: { redirects: [{ from: "/a", to: "/nowhere" }] } }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/nowhere" in the default tree',
    ].join("\n"),
  );
});

const EMITTED: RoutingInput["emitted"] = [
  { path: "/sitemap.xml" },
  { path: "/feed.xml" },
  { path: "/robots.txt" },
  { domain: "shop.example", path: "/sitemap-shop.xml" },
];

test("a target that is a file this build emits in the rule's tree is kept", () => {
  const manifest = plan({
    emitted: EMITTED,
    config: {
      redirects: [
        { from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301 },
        { from: "/rss.xml", to: "/feed.xml" },
        { from: "/de/sitemap", to: "/sitemap-shop.xml", domain: "shop.example" },
      ],
    },
  });
  expect(
    manifest.trees.map((tree) => tree.redirects.map(({ from, to }) => ({ from, to }))),
  ).toEqual([
    [
      { from: "/rss.xml", to: "/feed.xml" },
      { from: "/sitemap-index.xml", to: "/sitemap.xml" },
    ],
    [{ from: "/de/sitemap", to: "/sitemap-shop.xml" }],
  ]);
});

test("a target that is neither a page nor an emitted file is still refused", () => {
  const failure = failureOf(() =>
    plan({
      emitted: EMITTED,
      config: { redirects: [{ from: "/a", to: "/sitemap-index.xml" }] },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/sitemap-index.xml" in the default tree',
    ].join("\n"),
  );
});

test("a target that is a file emitted into another output tree is refused", () => {
  const failure = failureOf(() =>
    plan({
      emitted: EMITTED,
      config: {
        redirects: [
          { from: "/a", to: "/sitemap-shop.xml" },
          { from: "/de/a", to: "/robots.txt", domain: "shop.example" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 redirect targets are no pages of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/sitemap-shop.xml" in the default tree',
      '  build.routing.redirects[1] — "/robots.txt" in the "shop.example" tree',
    ].join("\n"),
  );
});

test("a page's own document file is no target", () => {
  const failure = failureOf(() =>
    plan({
      emitted: [
        { path: "/about.html", page: { locale: "en", path: "/about" } },
        { path: "/pricing/index.html", page: { locale: "en", path: "/pricing" } },
      ],
      config: {
        redirects: [
          { from: "/a", to: "/about.html" },
          { from: "/b", to: "/pricing/index.html" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 redirect targets are no pages of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/about.html" in the default tree',
      '  build.routing.redirects[1] — "/pricing/index.html" in the default tree',
    ].join("\n"),
  );
});

test("a file under the experiment segment is no target", () => {
  const failure = failureOf(() =>
    plan({
      emitted: [{ path: "/_v/notes.txt" }],
      config: { redirects: [{ from: "/a", to: "/_v/notes.txt" }] },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/_v/notes.txt" in the default tree',
    ].join("\n"),
  );
});

test("a redirect to an emitted file is marked as one, and a redirect to a page is not", () => {
  const manifest = plan({
    emitted: EMITTED,
    config: {
      redirects: [
        { from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301 },
        { from: "/hop", to: "/sitemap-index.xml" },
        { from: "/old", to: "/pricing" },
      ],
    },
  });
  expect(manifest.trees[0]?.redirects).toEqual([
    { from: "/hop", to: "/sitemap.xml", status: 308, source: "config", via: ["/sitemap-index.xml"], file: true },
    { from: "/old", to: "/pricing", status: 308, source: "config", via: [] },
    { from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301, source: "config", via: [], file: true },
  ]);
});

test("a file at a key the deploy keeps off the edge is no target", () => {
  const failure = failureOf(() =>
    plan({
      emitted: [{ path: "/manifest.json" }, { path: "/.pagedeck/notes.txt" }],
      config: {
        redirects: [
          { from: "/a", to: "/manifest.json" },
          { from: "/b", to: "/.pagedeck/notes.txt" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 redirect targets are no pages of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/manifest.json" in the default tree',
      '  build.routing.redirects[1] — "/.pagedeck/notes.txt" in the default tree',
    ].join("\n"),
  );
});

function planAlways(overrides: Partial<RoutingInput> = {}) {
  return planRouting({
    pages: PAGES.map((one) => ({
      ...one,
      path: normalizeOutputPath(one.path, "always"),
      output: normalizeOutputPath(one.output, "always"),
    })),
    trailingSlash: "always",
    ...overrides,
  });
}

test("under trailingSlash always, a file target keeps the file's own spelling", () => {
  const manifest = planAlways({
    emitted: EMITTED,
    config: {
      redirects: [
        { from: "/a", to: "/sitemap.xml" },
        { from: "/b", to: "/robots.txt" },
        { from: "/c", to: "/feed.xml", status: 301 },
        { from: "/hop", to: "/c" },
      ],
    },
  });
  expect(manifest.trees[0]?.redirects).toEqual([
    { from: "/a/", to: "/sitemap.xml", status: 308, source: "config", via: [], file: true },
    { from: "/b/", to: "/robots.txt", status: 308, source: "config", via: [], file: true },
    { from: "/c/", to: "/feed.xml", status: 301, source: "config", via: [], file: true },
    { from: "/hop/", to: "/feed.xml", status: 308, source: "config", via: ["/c/"], file: true },
  ]);
});

test("a file target written with a trailing slash is the file under either policy", () => {
  const rules = { redirects: [{ from: "/a", to: "/sitemap.xml/" }] };
  for (const manifest of [
    plan({ emitted: EMITTED, config: rules }),
    planAlways({ emitted: EMITTED, config: rules }),
  ])
    expect(manifest.trees[0]?.redirects[0]).toMatchObject({
      to: "/sitemap.xml",
      file: true,
    });
});

test("under trailingSlash always, a page target is still slashed and carries no file mark", () => {
  const manifest = planAlways({
    emitted: EMITTED,
    config: { redirects: [{ from: "/old", to: "/pricing" }] },
  });
  expect(manifest.trees[0]?.redirects).toEqual([
    { from: "/old/", to: "/pricing/", status: 308, source: "config", via: [] },
  ]);
});

test("under trailingSlash always, a target that is neither a page nor a file is refused", () => {
  const failure = failureOf(() =>
    planAlways({
      emitted: EMITTED,
      config: { redirects: [{ from: "/a", to: "/sitemap-index.xml" }] },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/sitemap-index.xml/" in the default tree',
    ].join("\n"),
  );
});

test("under trailingSlash always, a file of another output tree is still refused", () => {
  const failure = failureOf(() =>
    planAlways({
      emitted: EMITTED,
      config: { redirects: [{ from: "/a", to: "/sitemap-shop.xml" }] },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/sitemap-shop.xml/" in the default tree',
    ].join("\n"),
  );
});

test("a target in another output tree is named as one", () => {
  const failure = failureOf(() =>
    plan({ config: { redirects: [{ from: "/a", to: "/de/about" }] } }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect target is a page in another output tree — redirect within one tree — a tree-relative path cannot name a page on another host:",
      '  build.routing.redirects[0] — "/de/about" is a page of the "shop.example" tree, and the rule is in the default tree',
    ].join("\n"),
  );
});

test("a 404 page the route table does not hold is refused", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        notFound: [
          { locale: "en", path: "/missing" },
          { domain: "shop.example", locale: "en", path: "/about" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 configured 404 pages are no pages of their trees — name a page by the locale and path the route table spells it with:",
      "  build.routing.notFound[0] — the route table holds no en /missing",
      "  build.routing.notFound[1] — en /about renders into the default tree",
    ].join("\n"),
  );
});

test("two 404 pages for one tree are refused", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        notFound: [
          { locale: "en", path: "/404" },
          { locale: "en", path: "/about" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 output tree has more than one 404 page — give each output tree one 404 page:",
      "  the default tree — build.routing.notFound[0], build.routing.notFound[1]",
    ].join("\n"),
  );
});

test("faults of one pass are reported together", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        redirects: [
          { from: "/a", to: "/nowhere" },
          { from: "/about", to: "/pricing" },
        ],
      },
    }),
  );
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 redirect starts at a path this build serves — move the page or drop the rule — a page and a redirect cannot both answer one path, and the route table has no precedence rules:",
      '  "/about" in the default tree — build.routing.redirects[1], and the page en /about',
      "",
      "Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:",
      '  build.routing.redirects[0] — "/nowhere" in the default tree',
    ].join("\n"),
  );
});

function pathsOf(manifest: ReturnType<typeof planRouting>): string[] {
  return manifest.trees.flatMap((tree) => [
    ...tree.redirects.flatMap((rule) => [rule.from, rule.to, ...rule.via]),
    ...(tree.notFound === undefined ? [] : [tree.notFound]),
  ]);
}

function prefixesOf(manifest: ReturnType<typeof planRouting>): string[] {
  return manifest.trees.flatMap((tree) =>
    tree.headers.map((rule) => rule.prefix),
  );
}

test.each<TrailingSlash>(["never", "always"])(
  "no emitted URL form differs from its canonical form (%s)",
  (trailingSlash) => {
    const pages = PAGES.map((one) => ({
      ...one,
      path: normalizeOutputPath(one.path, trailingSlash),
      output: normalizeOutputPath(one.output, trailingSlash),
    }));
    const manifest = planRouting({
      pages,
      trailingSlash,
      config: {
        redirects: [
          { from: "plans/", to: "/x/../pricing" },
          { from: "/a//b/", to: "/caf%c3%a9/../about" },
          { from: "/%7Eold", to: "/a//b" },
        ],
        notFound: [{ locale: "en", path: "404/" }],
        headers: [{ prefix: "assets/", set: [] }],
      },
      removals: [
        {
          from: trailingSlash === "never" ? "/legacy/" : "/legacy",
          to: trailingSlash === "never" ? "/about/" : "/about",
          status: 308,
          reason: "deleted-page",
        },
      ],
    });
    for (const path of pathsOf(manifest)) {
      expect(normalizeOutputPath(path, trailingSlash)).toBe(path);
    }
    for (const prefix of prefixesOf(manifest)) {
      expect(normalizeOutputPrefix(prefix)).toBe(prefix);
    }
    const lookup = redirectIndex(manifest);
    for (const tree of manifest.trees)
      for (const rule of tree.redirects)
        expect(lookup(tree.domain, rule.from)).toBe(rule);
  },
);

test("redirectIndex finds one rule from either spelling of its path", () => {
  const manifest = plan({
    config: {
      redirects: [
        { from: "/plans", to: "/pricing" },
        { from: "/de/alt", to: "/de/about", domain: "shop.example" },
      ],
    },
  });
  const lookup = redirectIndex(manifest);
  expect(lookup(undefined, "/plans")?.to).toBe("/pricing");
  expect(lookup(undefined, "/plans/")?.to).toBe("/pricing");
  expect(lookup("shop.example", "/de/alt")?.to).toBe("/de/about");
  expect(lookup(undefined, "/de/alt")).toBeUndefined();
  expect(lookup(undefined, "/about")).toBeUndefined();
});

test("a site with no config and no removals still describes every tree", () => {
  expect(plan()).toEqual({
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      { redirects: [], headers: [] },
      { domain: "shop.example", redirects: [], headers: [] },
    ],
  });
});

test("a declared split is recorded whole, per tree, in one order", () => {
  const manifest = plan({
    config: {
      experiments: [
        {
          locale: "en",
          path: "/pricing",
          cookie: "fw_pricing",
          variants: [
            { name: "c", weight: 25 },
            { name: "b", weight: 75 },
          ],
        },
        {
          locale: "en",
          path: "/about",
          cookie: "fw_about",
          variants: [{ name: "b", weight: 50 }],
        },
        {
          domain: "shop.example",
          locale: "de-ch",
          path: "/about",
          cookie: "fw_de_about",
          variants: [{ name: "b", weight: 10 }],
        },
      ],
    },
  });
  expect(manifest.trees[0]?.experiments).toEqual([
    {
      path: "/about",
      cookie: "fw_about",
      variants: [{ name: "b", weight: 50 }],
    },
    {
      path: "/pricing",
      cookie: "fw_pricing",
      variants: [
        { name: "b", weight: 75 },
        { name: "c", weight: 25 },
      ],
    },
  ]);
  expect(manifest.trees[1]?.experiments).toEqual([
    {
      path: "/de/about",
      cookie: "fw_de_about",
      variants: [{ name: "b", weight: 10 }],
    },
  ]);
});

test("a build with no declared variants writes no experiments key at all", () => {
  const withNothing = plan();
  const withEverythingElse = plan({
    config: {
      redirects: [{ from: "/plans", to: "/pricing" }],
      notFound: [{ locale: "en", path: "/404" }],
      headers: [{ prefix: "/", set: [] }],
    },
  });
  for (const manifest of [withNothing, withEverythingElse]) {
    expect(JSON.stringify(manifest)).not.toContain("experiments");
    for (const tree of manifest.trees)
      expect(Object.hasOwn(tree, "experiments")).toBe(false);
  }
  expect(withNothing.version).toBe(1);
});

test("a variant's address is the primary's, under the reserved segment", () => {
  // The literal `_v`, not `VARIANT_SEGMENT`: built from the constant, this would pass
  // whatever the constant said.
  expect(variantPath("b", "/en/pricing")).toBe("/_v/b/en/pricing");
  expect(VARIANT_SEGMENT).toBe("_v");
  expect(variantPath("b", "/en/pricing/index.html")).toBe(
    "/_v/b/en/pricing/index.html",
  );
  expect(variantPath("c", "/")).toBe("/_v/c/");
});

test("an experiment's shape faults are collected, each with its own fix", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        experiments: [
          { locale: "en", path: "/pricing", cookie: "", variants: [] },
          {
            locale: "en",
            path: "/about",
            cookie: "fw about",
            variants: [
              { name: "b", weight: 0 },
              { name: "b", weight: 10 },
              { name: "..", weight: 10 },
              { name: "b/c", weight: 10 },
            ],
          },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 experiment declares no variants — list at least one variant, or drop the experiment; an experiment with no variants emits nothing and assigns nobody:",
      "  experiments[0] — en /pricing",
      "",
      'Routing manifest: 2 variant names are not path segments, and each variant is written under "/_v/<name>/" — name each variant the way a path spells one segment, such as "b":',
      '  experiments[1].variants[2] — ".." — the variant name is a dot segment, which resolves out of the variant tree',
      '  experiments[1].variants[3] — "b/c" — the variant name holds "/", and a variant name is one path segment of a URL',
      "",
      "Routing manifest: 1 experiment declares one variant name more than once, and a name is what the experiment assigns a visitor to — give each variant of one page its own name:",
      '  experiments[1] — "b"',
      "",
      "Routing manifest: 1 variant weight is not a share of visitors — write a positive number, such as 50; the shares are relative, so they need not total anything in particular:",
      "  experiments[1].variants[0] — 0",
      "",
      'Routing manifest: 2 experiments declare cookie keys no browser will carry — write the key as a cookie name, such as "fw_pricing":',
      "  experiments[0] — the cookie key is empty",
      '  experiments[1] — the cookie key holds " ", which ends a cookie name',
    ].join("\n"),
  );
});

test("an experiment naming a page this build does not route is refused", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        experiments: [
          {
            locale: "en",
            path: "/plans",
            cookie: "fw_a",
            variants: [{ name: "b", weight: 1 }],
          },
          {
            locale: "de-ch",
            path: "/about",
            cookie: "fw_b",
            variants: [{ name: "b", weight: 1 }],
          },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 2 experiments name no page of their trees — name a page by the locale and path the route table spells it with, or drop the experiment:",
      "  experiments[0] — the route table holds no en /plans",
      '  experiments[1] — de-ch /about renders into the "shop.example" tree',
    ].join("\n"),
  );
});

test("one page carries one experiment", () => {
  const failure = failureOf(() =>
    plan({
      config: {
        experiments: [
          {
            locale: "en",
            path: "/pricing",
            cookie: "fw_a",
            variants: [{ name: "b", weight: 1 }],
          },
          {
            locale: "en",
            path: "/pricing",
            cookie: "fw_b",
            variants: [{ name: "c", weight: 1 }],
          },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Routing manifest: 1 page carries more than one experiment, and a visitor is assigned to one variant of one page — give each page one experiment:",
      "  en /pricing — experiments[0], experiments[1]",
    ].join("\n"),
  );
});

test("a page under the reserved segment collides with the variant tree", () => {
  const failure = failureOf(() =>
    plan({
      pages: [...PAGES, page("en", "/_v/b/en/pricing", "/_v/b/en/pricing")],
      config: {
        experiments: [
          {
            locale: "en",
            path: "/pricing",
            cookie: "fw_pricing",
            variants: [{ name: "b", weight: 1 }],
          },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Routing manifest: 1 page is written under "/_v/", the segment this build reserves for variant outputs — move the page out of "/_v/", or drop the experiments in its tree:',
      '  the default tree — en /_v/b/en/pricing is written to "/_v/b/en/pricing"',
    ].join("\n"),
  );
});

test("a page or a redirect at a key the deploy keeps off the edge is refused (#556)", () => {
  const failure = failureOf(() =>
    plan({
      pages: [...PAGES, page("en", "/.pagedeck", "/.pagedeck")],
      config: {
        redirects: [
          { from: "/manifest.json", to: "/about" },
          { from: "/.pagedeck/manifests/old", to: "/de/about", domain: "shop.example" },
        ],
      },
    }),
  );
  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Routing manifest: 3 pages or redirects are at paths this build keeps off the edge for the deploy\'s own manifest and history — move each off "/manifest.json" and out of "/.pagedeck/"; every target answers 404 there, so nothing routed at one of them is ever served:',
      '  "/.pagedeck" in the default tree — the page en /.pagedeck',
      '  "/.pagedeck/manifests/old" in the "shop.example" tree — build.routing.redirects[1]',
      '  "/manifest.json" in the default tree — build.routing.redirects[0]',
    ].join("\n"),
  );
});

test("a redirect spelled with a trailing slash onto a reserved deploy key is refused too", () => {
  const failure = failureOf(() =>
    plan({
      trailingSlash: "always",
      pages: [page("en", "/", "/"), page("en", "/about", "/about/")],
      config: { redirects: [{ from: "/manifest.json", to: "/about" }] },
    }),
  );
  expect(failure.message).toBe(
    [
      'Routing manifest: 1 page or redirect is at a path this build keeps off the edge for the deploy\'s own manifest and history — move each off "/manifest.json" and out of "/.pagedeck/"; every target answers 404 there, so nothing routed at one of them is ever served:',
      '  "/manifest.json/" in the default tree — build.routing.redirects[0]',
    ].join("\n"),
  );
});

test("the security-header constant is exactly the three a build can take a posture on", () => {
  expect(SECURITY_HEADERS).toEqual([
    { name: "X-Content-Type-Options", value: "nosniff" },
    { name: "X-Frame-Options", value: "DENY" },
    { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ]);
});

test("HSTS and CSP are not in it, and each is absent for its own reason", () => {
  const names = SECURITY_HEADERS.map((field) => field.name);
  expect(names).not.toContain("Strict-Transport-Security");
  expect(names).not.toContain("Content-Security-Policy");
});

test("spreading the constant into a set plans those three headers on that prefix", () => {
  const document = plan({
    config: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
  });
  expect(document.trees[0]?.headers).toEqual([
    {
      prefix: "/",
      set: [
        { name: "X-Content-Type-Options", value: "nosniff" },
        { name: "X-Frame-Options", value: "DENY" },
        { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ]);
});

test("a site that declares no header set is warned once, naming what it can spread", () => {
  expect(undeclaredHeadersWarning(undefined)).toBe(
    [
      "Security headers: this site declares no header set, so no response its output serves carries one — build.routing.headers is the only place a generated site can put a response header, and with the field absent no _headers file, no nginx add_header block and no CloudFront viewer-response function is emitted at all; this is a warning and not a refusal because every page this build emitted is correct and a host that already sets these headers would be handed duplicates by a default nobody wrote — spread SECURITY_HEADERS into the set of a rule over \"/\", which is these three, or declare a set of your own to say the host is doing it:",
      "  X-Content-Type-Options: nosniff",
      "  X-Frame-Options: DENY",
      "  Referrer-Policy: strict-origin-when-cross-origin",
    ].join("\n"),
  );
});

test("an empty headers list is the same silence, and one rule of any kind ends it", () => {
  expect(undeclaredHeadersWarning({ headers: [] })).toBe(
    undeclaredHeadersWarning(undefined),
  );
  expect(undeclaredHeadersWarning({})).toBe(undeclaredHeadersWarning(undefined));
  expect(
    undeclaredHeadersWarning({
      headers: [
        {
          prefix: "/",
          set: [{ name: "Cache-Control", value: "public, max-age=60" }],
        },
      ],
    }),
  ).toBeUndefined();
});
