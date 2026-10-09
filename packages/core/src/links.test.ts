import { expect, test, vi } from "vitest";
import { ConfigError } from "./exit.js";
import { imageAttributes, urlTemplate } from "./images.js";
import type { EmittedFile } from "./manifest.js";
import {
  checkLinks,
  checkSiteLinks,
  movedReferenceReport,
  movedReferences,
  probeExternalLinks,
  resolveLinkCheck,
} from "./links.js";
import type { RoutingManifest } from "./routing.js";
import { planRouting } from "./routing.js";
import type { Page } from "./pages.js";

function page(path: `/${string}`, domain?: string): Page {
  return {
    locale: "en",
    path,
    output: path,
    dependencies: [],
    ...(domain === undefined ? {} : { domain }),
  };
}

function document(input: {
  path: string;
  body: string;
  domain?: string;
}): EmittedFile {
  const base = input.path.replace(/\/+$/, "");
  return {
    path: `${base}/index.html`,
    kind: "html",
    page: { locale: "en", path: input.path },
    contents: `<!doctype html><html lang="en"><body>${input.body}</body></html>`,
    ...(input.domain === undefined ? {} : { domain: input.domain }),
  };
}

function routingOf(pages: readonly Page[]): RoutingManifest {
  return planRouting({ pages, trailingSlash: "never" });
}

test("a route resolves whether the href spells it with a trailing slash or without", () => {
  const home = document({
    path: "/",
    body: '<a href="/about">a</a><a href="/about/">b</a>',
  });
  const about = document({ path: "/about", body: "" });

  expect(
    checkLinks({
      documents: [home, about],
      emitted: [home, about],
      routing: routingOf([page("/"), page("/about")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });
});

test("an href naming an emitted file resolves against that file, not a route", () => {
  const home = document({
    path: "/",
    body: '<a href="/report.pdf">p</a><a href="/downloads/kit.zip">k</a>',
  });
  const file = (path: string): EmittedFile => ({
    path,
    kind: "asset",
    contents: "x",
  });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, file("/report.pdf"), file("/downloads/kit.zip")],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });
});

function imagePage(attributes: { src: string; srcSet: string }): EmittedFile {
  return document({
    path: "/",
    body: `<img src="${attributes.src}" srcset="${attributes.srcSet}">`,
  });
}

test("an image an adapter routes through a query is left alone", () => {
  const home = imagePage(
    imageAttributes({
      images: {
        adapter: urlTemplate("/_image?src={srcParam}&w={width}&q={quality}"),
        widths: [640, 1280],
        quality: 70,
        format: "auto",
      },
      image: { src: "/uploads/hero.jpg", width: 1600, height: 900 },
      page: { locale: "en", path: "/" },
    }),
  );

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });
});

test("a query-less dynamic endpoint is still reported, and that is the limit", () => {
  const home = imagePage(
    imageAttributes({
      images: {
        adapter: urlTemplate("/_image/{width}/{srcParam}"),
        widths: [640],
        quality: 70,
        format: "auto",
      },
      image: { src: "/uploads/hero.jpg", width: 1600, height: 900 },
      page: { locale: "en", path: "/" },
    }),
  );

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }).broken,
  ).toEqual([{ page: "en /", href: "/_image/640/%2Fuploads%2Fhero.jpg" }]);
});

test("an asset URL's fragment is cut, because a fragment reaches no server", () => {
  const home = document({
    path: "/",
    body: '<img src="/sprite.svg#icon"><img src="/missing.svg#icon">',
  });
  const sprite: EmittedFile = {
    path: "/sprite.svg",
    kind: "asset",
    contents: "x",
  };

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, sprite],
      routing: routingOf([page("/")]),
    }).broken,
  ).toEqual([{ page: "en /", href: "/missing.svg#icon" }]);
});

test("one page naming one broken URL twice is one line", () => {
  const home = document({
    path: "/",
    body: '<img src="/gone.png" srcset="/gone.png 1x, /gone.png 2x"><a href="/gone.png">g</a>',
  });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }).broken,
  ).toEqual([{ page: "en /", href: "/gone.png" }]);
});

test("an href naming a route this build did not emit is broken, page and href", () => {
  const home = document({ path: "/", body: '<a href="/gone">g</a>' });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [{ page: "en /", href: "/gone" }],
    redirected: [],
    external: [],
  });
});

test("a query and a fragment are not part of a deploy key", () => {
  const home = document({
    path: "/",
    body: '<a href="/about?q=1#top">a</a><a href="/?q=1">home</a>',
  });
  const about = document({ path: "/about", body: "" });

  expect(
    checkLinks({
      documents: [home, about],
      emitted: [home, about],
      routing: routingOf([page("/"), page("/about")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });
});

test("an entity-escaped character in a reference is decoded before it is resolved", () => {
  const home = document({
    path: "/",
    body: '<a href="/a&amp;b">a</a><a href="/c&#x26;d">c</a><a href="/e&#38;f">e</a>',
  });
  const emitted = ["/a&b", "/c&d", "/e&f"].map((path) =>
    document({ path: path as `/${string}`, body: "" }),
  );

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, ...emitted],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });
});

test("a URL naming another origin is never resolved against the emitted set", () => {
  const home = document({
    path: "/",
    body: '<a href="https://example.com/x">a</a><script src="//cdn.example/x.js"></script><a href="#top">t</a>',
  });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [],
    redirected: [],
    external: [{ url: "https://example.com/x", pages: ["en /"] }],
  });
});

test("an href a redirect answers is redirected rather than broken, with its target", () => {
  const home = document({ path: "/", body: '<a href="/old">o</a>' });
  const about = document({ path: "/about", body: "" });
  const routing = planRouting({
    pages: [page("/"), page("/about")],
    trailingSlash: "never",
    config: { redirects: [{ from: "/old", to: "/about" }] },
  });

  expect(
    checkLinks({ documents: [home, about], emitted: [home, about], routing }),
  ).toEqual({
    broken: [],
    redirected: [{ page: "en /", href: "/old", to: "/about" }],
    external: [],
  });
});

test("each srcset candidate is resolved, descriptor and all", () => {
  const home = document({
    path: "/",
    body: '<img srcset="/one.png 2x, /two.png 640w"><source srcset="/one.png">',
  });
  const one: EmittedFile = { path: "/one.png", kind: "asset", contents: "1" };

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, one],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [{ page: "en /", href: "/two.png" }],
    redirected: [],
    external: [],
  });
});

test.each(["srcset", "srcSet", "SRCSET"])(
  "a missing candidate in an img's and a source's %s is reported, whatever the attribute's case",
  (name) => {
    const home = document({
      path: "/",
      body: `<img src="/hero.png" ${name}="/hero.png 1x, /hero-2x.png 2x"><picture><source ${name}="/hero.avif"></picture>`,
    });
    const hero: EmittedFile = {
      path: "/hero.png",
      kind: "asset",
      contents: "h",
    };

    expect(
      checkLinks({
        documents: [home],
        emitted: [home, hero],
        routing: routingOf([page("/")]),
      }).broken,
    ).toEqual([
      { page: "en /", href: "/hero-2x.png" },
      { page: "en /", href: "/hero.avif" },
    ]);
  },
);

test("an asset reference resolves against the deploy key and not against a route", () => {
  const home = document({
    path: "/",
    body: '<script type="module" src="/assets/x.js"></script><link rel="stylesheet" href="/assets/x.css"><img src="/hero.png"><source src="/clip.webm">',
  });
  const asset = (path: string): EmittedFile => ({
    path,
    kind: "asset",
    contents: "x",
  });

  expect(
    checkLinks({
      documents: [home],
      emitted: [
        home,
        asset("/assets/x.js"),
        asset("/assets/x.css"),
        asset("/hero.png"),
      ],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [{ page: "en /", href: "/clip.webm" }],
    redirected: [],
    external: [],
  });
});

test("a media element's own sources are read, the way its <source> children are", () => {
  const home = document({
    path: "/",
    body: '<video src="/clip.mp4" poster="/still.png"></video><audio src="/theme.mp3"></audio>',
  });
  const still: EmittedFile = {
    path: "/still.png",
    kind: "asset",
    contents: "x",
  };

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, still],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [
      { page: "en /", href: "/clip.mp4" },
      { page: "en /", href: "/theme.mp3" },
    ],
    redirected: [],
    external: [],
  });
});

test("a data-* attribute is not read as the attribute its name ends with", () => {
  const home = document({
    path: "/",
    body: '<link rel="preload" href="/gone.css" data-href="/lazy.css"><img src="/gone.png" data-src="/lazy.png" srcset="/gone-2x.png 2x" data-srcset="/lazy-2x.png 2x"><picture><source srcset="/gone.avif" data-srcset="/lazy.avif"></picture><video src="/gone.mp4" poster="/gone-still.png" data-poster="/lazy-still.png"></video><a href="/gone" data-href="/lazy">a</a>',
  });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }).broken,
  ).toEqual([
    { page: "en /", href: "/gone.css" },
    { page: "en /", href: "/gone.png" },
    { page: "en /", href: "/gone-2x.png" },
    { page: "en /", href: "/gone.avif" },
    { page: "en /", href: "/gone.mp4" },
    { page: "en /", href: "/gone-still.png" },
    { page: "en /", href: "/gone" },
  ]);
});

test("only the documents handed over are read", () => {
  const home = document({ path: "/", body: "" });
  const other = document({ path: "/other", body: '<a href="/gone">g</a>' });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home, other],
      routing: routingOf([page("/"), page("/other")]),
    }),
  ).toEqual({ broken: [], redirected: [], external: [] });

  expect(
    checkLinks({
      documents: [home, other],
      emitted: [home, other],
      routing: routingOf([page("/"), page("/other")]),
    }),
  ).toEqual({
    broken: [{ page: "en /other", href: "/gone" }],
    redirected: [],
    external: [],
  });
});

test("a document carrying no page tag is reported by its file path", () => {
  const orphan: EmittedFile = {
    path: "/fragment.html",
    kind: "html",
    contents: '<a href="/gone">g</a>',
  };

  expect(
    checkLinks({
      documents: [orphan],
      emitted: [orphan],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [{ page: "/fragment.html", href: "/gone" }],
    redirected: [],
    external: [],
  });
});

test("an href the path normalizer refuses is broken rather than thrown", () => {
  const home = document({ path: "/", body: '<a href="/a%zz">a</a>' });

  expect(
    checkLinks({
      documents: [home],
      emitted: [home],
      routing: routingOf([page("/")]),
    }),
  ).toEqual({
    broken: [{ page: "en /", href: "/a%zz" }],
    redirected: [],
    external: [],
  });
});

test("references are resolved inside their own output tree", () => {
  const shop = document({
    path: "/",
    body: '<a href="/about">a</a>',
    domain: "shop.example",
  });
  const about = document({ path: "/about", body: "" });

  expect(
    checkLinks({
      documents: [shop, about],
      emitted: [shop, about],
      routing: routingOf([page("/", "shop.example"), page("/about")]),
    }),
  ).toEqual({
    broken: [{ page: "en /", href: "/about" }],
    redirected: [],
    external: [],
  });
});

test("a site that declares nothing gets the refusal, and false is the pass off", () => {
  const probe = async (): Promise<number> => 200;
  expect(resolveLinkCheck(undefined)).toEqual({ broken: "error" });
  expect(resolveLinkCheck({})).toEqual({ broken: "error" });
  expect(resolveLinkCheck({ broken: "warn" })).toEqual({ broken: "warn" });
  expect(resolveLinkCheck({ external: { probe } })).toEqual({
    broken: "error",
    external: { probe },
  });
  expect(resolveLinkCheck({ broken: false })).toBeUndefined();
  expect(
    resolveLinkCheck({ broken: false, external: { probe } }),
  ).toBeUndefined();
});

test("an absolute reference is collected once, naming every page that links it", () => {
  const home = document({
    path: "/",
    body: '<a href="https://example.com/a">a</a><a href="mailto:x@example.com">m</a><script src="//cdn.example/x.js"></script>',
  });
  const about = document({
    path: "/about",
    body: '<a href="https://example.com/a">a</a><img src="http://img.example/b.png">',
  });

  expect(
    checkLinks({
      documents: [home, about],
      emitted: [home, about],
      routing: routingOf([page("/"), page("/about")]),
    }),
  ).toEqual({
    broken: [],
    redirected: [],
    external: [
      { url: "https://example.com/a", pages: ["en /", "en /about"] },
      { url: "http://img.example/b.png", pages: ["en /about"] },
    ],
  });
});

test("a probe answering under 400 says nothing, and 400 and over warns", async () => {
  const asked: string[] = [];
  const probe = async (url: string): Promise<number> => {
    asked.push(url);
    return url.endsWith("/gone") ? 404 : 200;
  };

  expect(
    await probeExternalLinks({
      references: [
        { url: "https://example.com/live", pages: ["en /"] },
        { url: "https://example.com/gone", pages: ["en /", "en /about"] },
      ],
      external: { probe },
    }),
  ).toEqual([
    [
      "Site build: 1 external reference answered with a status a reader will not see the page at — check the link, or the host behind it; this build asks each URL once and takes the status its probe answers with. This is a warning and never a refusal, because a host this site does not control is not this site's wiring and the same URL usually answers on the next run:",
      '  "https://example.com/gone" — 404 — linked from en /, en /about',
    ].join("\n"),
  ]);
  expect(asked).toEqual([
    "https://example.com/live",
    "https://example.com/gone",
  ]);
});

test("a probe that throws is a warning naming the URL, not a failure", async () => {
  const probe = async (): Promise<number> => {
    throw new Error("ETIMEDOUT");
  };

  expect(
    await probeExternalLinks({
      references: [{ url: "https://example.com/slow", pages: ["en /"] }],
      external: { probe },
    }),
  ).toEqual([
    [
      "Site build: 1 external reference could not be checked, because the external link probe this site declared threw — the fault is the network, the host or the probe's own client rather than the page, so nothing here says the link is broken. This is a warning and never a refusal, because a build whose success depends on another host's uptime fails on a Sunday for a reason no reader can act on:",
      '  "https://example.com/slow" — Error: ETIMEDOUT — linked from en /',
    ].join("\n"),
  ]);
});

test("every unusable answer is collected before the probe's own fault is thrown", async () => {
  const asked: string[] = [];
  const probe = async (url: string): Promise<number> => {
    asked.push(url);
    if (url.endsWith("/a")) return "200" as unknown as number;
    if (url.endsWith("/b")) return 404;
    return Number.NaN;
  };

  await expect(
    probeExternalLinks({
      references: ["a", "b", "c"].map((name) => ({
        url: `https://example.com/${name}`,
        pages: ["en /"],
      })),
      external: { probe, intervalMs: 0 },
    }),
  ).rejects.toThrow(
    new ConfigError(
      [
        'Site build: the external link probe answered with something that is not an HTTP status 2 times — return the status code the request came back with, as probe: async (url) => (await fetch(url, { method: "HEAD" })).status:',
        '  "https://example.com/a" — answered "200"',
        '  "https://example.com/c" — answered NaN',
      ].join("\n"),
    ),
  );
  expect(asked).toEqual([
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
  ]);
});

test("the limit caps one build's requests, and what it did not reach is reported", async () => {
  let asked = 0;
  const probe = async (): Promise<number> => {
    asked += 1;
    return 200;
  };
  const references = ["a", "b", "c"].map((name) => ({
    url: `https://example.com/${name}`,
    pages: ["en /"],
  }));

  const warnings = await probeExternalLinks({
    references,
    external: { probe, limit: 2 },
  });

  expect(asked).toBe(2);
  expect(warnings).toEqual([
    [
      'Site build: 1 external reference was not checked, because this build reached the 2 requests "build.links.external.limit" allows — raise the limit, or read this as the check having stopped rather than as a link that answered:',
      '  "https://example.com/c" — linked from en /',
    ].join("\n"),
  ]);
});

test("requests are spaced by the declared interval, and nothing waits after the last", async () => {
  vi.useFakeTimers();
  try {
    const started: number[] = [];
    const probe = async (): Promise<number> => {
      started.push(Date.now());
      return 200;
    };
    let settled = false;
    const run = probeExternalLinks({
      references: ["a", "b", "c"].map((name) => ({
        url: `https://example.com/${name}`,
        pages: ["en /"],
      })),
      external: { probe, intervalMs: 20 },
    }).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(3);
    expect(started.map((at, index) => at - (started[index - 1] ?? at))).toEqual([0, 20, 20]);

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await run;
  } finally {
    vi.useRealTimers();
  }
});

test("external references are probed one at a time", async () => {
  let running = 0;
  let most = 0;
  const probe = async (): Promise<number> => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return 200;
  };

  await probeExternalLinks({
    references: ["a", "b", "c"].map((name) => ({
      url: `https://example.com/${name}`,
      pages: ["en /"],
    })),
    external: { probe },
  });

  expect(most).toBe(1);
});

test("a warned site reports every broken reference instead of throwing", async () => {
  const home = document({
    path: "/",
    body: '<a href="/zebra">z</a><a href="/apple">a</a>',
  });
  const routing = routingOf([page("/")]);

  expect(
    await checkSiteLinks({ files: [home], routing, check: { broken: "warn" } }),
  ).toEqual([
    [
      'Site build: 2 references name nothing this build emitted — check each against the page or the file it should name: an asset URL and its file name are minted at two stages (see chunkPath in client-build.ts), and a route is served only where a page renders one. This is a warning and not a refusal because "build.links" declares broken: "warn":',
      '  en / — "/apple"',
      '  en / — "/zebra"',
    ].join("\n"),
  ]);
});

test("a reported href is cut at its query, whatever the reference holds", async () => {
  const home = document({
    path: "/",
    body: '<a href="/gone?token=SECRET">g</a>',
  });

  const report = checkLinks({
    documents: [home],
    emitted: [home],
    routing: routingOf([page("/")]),
  });
  expect(report.broken).toEqual([{ page: "en /", href: "/gone?token=SECRET" }]);

  const [warning] = await checkSiteLinks({
    files: [home],
    routing: routingOf([page("/")]),
    check: { broken: "warn" },
  });
  expect(warning).toContain('  en / — "/gone?…"');
  expect(warning).not.toContain("SECRET");
});

test("a reported href and redirect target are escaped inside their quotes", async () => {
  const home = document({
    path: "/",
    body: '<a href="/gone\u001b[2K\r\n\u009b\u2028">g</a><a href="/old">o</a>',
  });
  const about = document({ path: "/about", body: "" });
  const planned = planRouting({
    pages: [page("/"), page("/about")],
    trailingSlash: "never",
    config: { redirects: [{ from: "/old", to: "/about" }] },
  });
  // Planning refuses a target holding a control; a quote is what the line itself must handle.
  const routing: RoutingManifest = {
    ...planned,
    trees: planned.trees.map((tree) => ({
      ...tree,
      redirects: tree.redirects.map((rule) => ({ ...rule, to: '/about"\u2028' })),
    })),
  };

  const warnings = await checkSiteLinks({
    files: [home, about],
    routing,
    check: { broken: "warn" },
  });
  const text = warnings.join("\n");

  expect(text).toContain('  en / — "/gone\\u001b[2K\\r\\n\\u009b\\u2028"');
  expect(text).toContain('  en / — "/old" → "/about\\"\\u2028"');
  expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/);
});

test("a redirected reference warns with its direct target at either setting", async () => {
  const home = document({ path: "/", body: '<a href="/old">o</a>' });
  const about = document({ path: "/about", body: "" });
  const routing = planRouting({
    pages: [page("/"), page("/about")],
    trailingSlash: "never",
    config: { redirects: [{ from: "/old", to: "/about" }] },
  });
  const warning = [
    "Site build: 1 reference resolves through a redirect — point it at the target on the line below, so a visitor's first request is the page rather than a hop. This is a warning and not a refusal because the redirect works and the page it lands on is one this build emitted:",
    '  en / — "/old" → "/about"',
  ].join("\n");

  expect(
    await checkSiteLinks({
      files: [home, about],
      routing,
      check: { broken: "error" },
    }),
  ).toEqual([warning]);
  expect(
    await checkSiteLinks({
      files: [home, about],
      routing,
      check: { broken: "warn" },
    }),
  ).toEqual([warning]);
});

test("a deliberately broken prefix fails the link check", async () => {
  const chunk: EmittedFile = {
    path: "/assets/index-abc123.js",
    kind: "js",
    name: "index",
    contents: "console.log(0)",
  };
  const routing = routingOf([page("/")]);
  const withScript = (src: string): EmittedFile =>
    document({
      path: "/",
      body: `<script type="module" src="${src}"></script>`,
    });

  const minted = [chunk, withScript(chunk.path)];
  expect(
    await checkSiteLinks({
      files: minted,
      routing,
      check: { broken: "error" },
    }),
  ).toEqual([]);

  const files = [chunk, withScript("/assets/assets/index-abc123.js")];
  const doubled = (): Promise<readonly string[]> =>
    checkSiteLinks({ files, routing, check: { broken: "error" } });
  await expect(doubled()).rejects.toThrow(ConfigError);
  await expect(doubled()).rejects.toThrow(/\/assets\/assets\/index-abc123\.js/);
});

test("the refusal collects every broken reference and ignores the redirected ones", async () => {
  const home = document({
    path: "/",
    body: '<a href="/zebra">z</a><a href="/apple">a</a><a href="/old">o</a>',
  });
  const about = document({ path: "/about", body: "" });
  const routing = planRouting({
    pages: [page("/"), page("/about")],
    trailingSlash: "never",
    config: { redirects: [{ from: "/old", to: "/about" }] },
  });

  await expect(
    checkSiteLinks({
      files: [home, about],
      routing,
      check: { broken: "error" },
    }),
  ).rejects.toThrow(
    new ConfigError(
      [
        "Site build: 2 references name nothing this build emitted — check each against the page or the file it should name: an asset URL and its file name are minted at two stages (see chunkPath in client-build.ts), and a route is served only where a page renders one:",
        '  en / — "/apple"',
        '  en / — "/zebra"',
      ].join("\n"),
    ),
  );
});

test("each reference a reused page makes to a file the previous build emitted and this one did not is found, and nothing else is", () => {
  const faq = document({
    path: "/faq",
    body: '<script type="module" src="/assets/entry-a-OLD.js"></script><a href="/gone">x</a>',
  });
  const signup = document({
    path: "/signup",
    body: '<link rel="stylesheet" href="/assets/fw-core-OLD.css"><script type="module" src="/assets/entry-b-NEW.js"></script>',
  });
  const kept = document({
    path: "/about",
    body: '<script type="module" src="/assets/entry-b-NEW.js"></script>',
  });

  expect(
    movedReferences({
      reused: [faq, signup, kept],
      emitted: [faq, signup, kept, { path: "/assets/entry-b-NEW.js", kind: "js", contents: "" }],
      routing: routingOf([page("/faq"), page("/signup"), page("/about")]),
      previous: new Set(["/assets/entry-a-OLD.js", "/assets/fw-core-OLD.css", "/assets/entry-b-NEW.js"]),
    }),
  ).toEqual([
    { page: "en /faq", href: "/assets/entry-a-OLD.js" },
    { page: "en /signup", href: "/assets/fw-core-OLD.css" },
  ]);
});

const UNSETTLED_FIX =
  "each bundle after the first renders again every reused page the one before found naming a file it did not emit, and an incremental build runs no more bundles than that — run pagedeck build to write the whole site again";

test("references a build could not settle are one line each, counted by page, after the bundles it ran", () => {
  expect(
    movedReferenceReport(
      [
        { page: "en /faq", href: "/assets/entry-a-OLD.js" },
        { page: "en /faq", href: "/assets/fw-core-OLD.css" },
      ],
      3,
    ),
  ).toBe(
    `Site build: 1 page this build reuses still names chunks or stylesheets this build did not emit after 3 bundles — ${UNSETTLED_FIX}:\n  en /faq — "/assets/entry-a-OLD.js"\n  en /faq — "/assets/fw-core-OLD.css"`,
  );
  expect(
    movedReferenceReport(
      [
        { page: "en /signup", href: "/assets/fw-core-OLD.css" },
        { page: "en /faq", href: "/assets/entry-a-OLD.js" },
      ],
      3,
    ),
  ).toBe(
    `Site build: 2 pages this build reuses still name chunks or stylesheets this build did not emit after 3 bundles — ${UNSETTLED_FIX}:\n  en /faq — "/assets/entry-a-OLD.js"\n  en /signup — "/assets/fw-core-OLD.css"`,
  );
  expect(movedReferenceReport([{ page: "en /faq", href: "/assets/entry-a-OLD.js" }], 1)).toBe(
    `Site build: 1 page this build reuses still names a chunk or stylesheet this build did not emit after 1 bundle — ${UNSETTLED_FIX}:\n  en /faq — "/assets/entry-a-OLD.js"`,
  );
});
