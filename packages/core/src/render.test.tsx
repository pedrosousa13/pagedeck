import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Suspense, use, useId } from "react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { RegistryError, StoreError } from "@pagedeck/islands";
import type { ComponentDefinition, ComponentRegistry } from "@pagedeck/islands";
import { openStore } from "@pagedeck/content";
import { SITE_FIXTURES } from "@pagedeck/fixtures";
import type { TreePage } from "@pagedeck/fixtures";
import {
  faultsInEmittedHtml,
  renderPage,
  RenderError,
  unescapedHtml,
  useBuildData,
  useLocale,
  useSocialCard,
} from "./render.js";
import type { EntryNode, RenderedIsland, RootProvider } from "./render.js";
import { buildPageTree } from "./tree.js";
import type { PlacedLocale } from "./locales.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function component(module: unknown): ComponentDefinition {
  return { import: async () => ({ default: module }) };
}

const PAGE = { locale: "en", path: "/home" } as const;

function Hero({
  background,
  children,
}: {
  background: string;
  children?: ReactNode;
}) {
  return <section className={`hero hero--${background}`}>{children}</section>;
}

function Heading({ level, text }: { level: number; text: string }) {
  const Tag = `h${level}` as "h1";
  return <Tag>{text}</Tag>;
}

function CtaButton({ label, href }: { label: string; href: string }) {
  return (
    <a className="cta" href={href}>
      {label}
    </a>
  );
}

function FeatureGrid({
  columns,
  children,
}: {
  columns: number;
  children?: ReactNode;
}) {
  return (
    <div className="grid" data-columns={columns}>
      {children}
    </div>
  );
}

function FeatureCard({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <article className="card">
      {children}
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function Icon({ name }: { name: string }) {
  return <i className={`icon icon--${name}`} />;
}

function NewsletterSignup({ list }: { list: string }) {
  return <form className="signup" data-list={list} />;
}

const SITE_REGISTRY = {
  Hero: component(Hero),
  Heading: component(Heading),
  CtaButton: component(CtaButton),
  FeatureGrid: component(FeatureGrid),
  FeatureCard: component(FeatureCard),
  Icon: component(Icon),
  NewsletterSignup: component(NewsletterSignup),
} satisfies ComponentRegistry;

function fixtureTree(locale: string, path: string): readonly EntryNode[] {
  const file = join(SITE_FIXTURES, locale, `${path}.json`);
  const entry = JSON.parse(readFileSync(file, "utf8")) as { data: TreePage };
  return entry.data.tree;
}

test("a fixture tree entry renders to its expected HTML", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: fixtureTree("en", "home"),
    registry: SITE_REGISTRY,
  });

  expect(html).toBe(
    '<section class="hero hero--gradient">' +
      "<h1>Ship faster</h1>" +
      '<a class="cta" href="/en/pricing">Start free</a>' +
      "</section>" +
      '<div class="grid" data-columns="2">' +
      '<article class="card"><i class="icon icon--bolt"></i>' +
      "<h3>No runtime</h3><p>Content pages ship 0 kB of JS.</p></article>" +
      '<article class="card"><i class="icon icon--clock"></i>' +
      "<h3>Incremental</h3><p>A content edit rebuilds one page.</p></article>" +
      "</div>" +
      '<form class="signup" data-list="product-updates"></form>',
  );
});

test("a name the registry does not hold fails naming the component and the entry", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Testimonials" }],
      registry: SITE_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RegistryError(
      'Component "Testimonials": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
    ),
  );
});

test("every name the registry does not hold is reported, not the first", async () => {
  const failure = await renderPage({
    page: PAGE,
    tree: [
      { component: "Testimonials", children: [{ component: "Quote" }] },
      { component: "Icon", props: { name: "bolt" } },
    ],
    registry: SITE_REGISTRY,
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RegistryError);
  expect((failure as RegistryError).message).toBe(
    "Entry /en/home: 2 components are not registered — declare each under build.components, or add each to the registry passed to renderPage, or remove the reference from the entry:\n" +
      "  Testimonials\n" +
      "  Quote",
  );
});

test("a module with no default export fails naming the component and the entry", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Hero" }],
      registry: { Hero: { import: async () => ({}) } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Hero": its module has no default export, and entry /en/home renders it — export the component as its module\'s default',
    ),
  );
});

test("an unregistered name outranks a missing default export on the same page", async () => {
  const failure = await renderPage({
    page: PAGE,
    tree: [{ component: "Hero" }, { component: "Missing" }],
    registry: { Hero: { import: async () => ({}) } },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RegistryError);
  expect((failure as RegistryError).message).toBe(
    'Component "Missing": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
  );
});

test("every module with no default export is reported, not the first", async () => {
  const failure = await renderPage({
    page: PAGE,
    tree: [
      { component: "Hero", children: [{ component: "Heading" }] },
      { component: "Icon" },
    ],
    registry: {
      Hero: { import: async () => ({}) },
      Heading: { import: async () => ({}) },
      Icon: { import: async () => ({}) },
    },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  expect((failure as RenderError).message).toBe(
    "Entry /en/home: 3 components have no default export — export each component as its module's default:\n" +
      "  Hero\n" +
      "  Heading\n" +
      "  Icon",
  );
});

test("only the components the entry uses are imported", async () => {
  const imported: string[] = [];
  const registry = {
    Icon: { import: async () => (imported.push("Icon"), { default: Icon }) },
    Unused: {
      import: async () => (imported.push("Unused"), { default: Icon }),
    },
  } satisfies ComponentRegistry;

  await renderPage({
    page: PAGE,
    tree: [{ component: "Icon", props: { name: "bolt" } }],
    registry,
  });

  expect(imported).toEqual(["Icon"]);
});

test("script-injection content in an entry field renders inert", async () => {
  const hostile =
    '</script><script>alert(1)</script><img src=x onerror="alert(2)">';
  const { html } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "CtaButton",
        props: { label: hostile, href: `" onmouseover="alert(3)` },
      },
    ],
    registry: SITE_REGISTRY,
  });

  const tags = html.match(/<[^>]*>/g) ?? [];
  expect(tags).toEqual([
    '<a class="cta" href="&quot; onmouseover=&quot;alert(3)">',
    "</a>",
  ]);
  const attributes = [
    ...(tags[0] as string).replace(/"[^"]*"/g, '""').matchAll(/([a-zA-Z-]+)=/g),
  ].map((match) => match[1]);
  expect(attributes).toEqual(["class", "href"]);

  expect(html).toBe(
    '<a class="cta" href="&quot; onmouseover=&quot;alert(3)">' +
      "&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;" +
      "&lt;img src=x onerror=&quot;alert(2)&quot;&gt;" +
      "</a>",
  );
});

test("the unescaped-HTML sink is the one way rich text reaches the output raw", async () => {
  function RichText({ body }: { body: string }) {
    return <div className="rich" {...unescapedHtml(body)} />;
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "RichText",
        props: { body: "<p>Trusted <em>rich</em> text.</p>" },
      },
    ],
    registry: { RichText: component(RichText) },
  });

  expect(html).toBe('<div class="rich"><p>Trusted <em>rich</em> text.</p></div>');
});

// Reserved names written as literal HTML, not built from `@pagedeck/islands`' constants: they
// are a wire format, and a test built from the writer's constants passes any rename.
function RichText({ body }: { body: string }) {
  return <div className="rich" {...unescapedHtml(body)} />;
}

const RICH_TEXT = { RichText: component(RichText) } satisfies ComponentRegistry;

async function richText(body: string): Promise<string> {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "RichText", props: { body } }],
    registry: RICH_TEXT,
  });
  return html;
}

test("a hydration marker typed into rich text does not reach the page", async () => {
  const html = await richText(
    '<p>Before</p><fw-island data-fw-prefix="ideadbeef0000"' +
      ' data-fw-component="Counter" data-fw-mode="load"' +
      ' data-fw-props="{&quot;evil&quot;:true}"><span>hi</span></fw-island>' +
      "<p>After</p>",
  );

  expect(html).toBe(
    '<div class="rich"><p>Before</p><span>hi</span><p>After</p></div>',
  );
});

test("a slot wrapper typed into rich text does not reach the page either", async () => {
  const html = await richText(
    '<fw-slot data-fw-slot="0.0" role="presentation"><p>decoy</p></fw-slot>' +
      '<span data-fw-slot="0.0">decoy</span>' +
      '<template data-fw-template="0.0"><p>decoy</p></template>',
  );

  expect(html).toBe(
    '<div class="rich"><p>decoy</p>' +
      "<span>decoy</span>" +
      "<template><p>decoy</p></template></div>",
  );
});

test("a facade placeholder typed into rich text does not reach the page", async () => {
  const html = await richText(
    '<span data-fw-facade="ab12cd34-1">x</span>' +
      "<span data-fw-facade='ab12cd34-1'>x</span>" +
      "<span data-fw-facade=ab12cd34-1>x</span>" +
      "<span data-fw-facade>x</span>",
  );

  expect(html).toBe(
    '<div class="rich"><span>x</span><span>x</span><span>x</span><span>x</span></div>',
  );
});

test("a search-exclusion attribute typed into rich text does not reach the page", async () => {
  const html = await richText(
    '<div data-fw-search="ignore">x</div>' +
      "<div data-fw-search='ignore'>x</div>" +
      "<div data-fw-search=ignore>x</div>" +
      "<div DATA-FW-SEARCH>x</div>",
  );

  expect(html).toBe(
    '<div class="rich"><div>x</div><div>x</div><div>x</div><div>x</div></div>',
  );
});

test("a data-fw-* name the strip does not enumerate is left alone", async () => {
  const html = await richText('<span data-fw-consent="denied">x</span>');

  expect(html).toBe('<div class="rich"><span data-fw-consent="denied">x</span></div>');
});

test("rich text that names the marker element in prose still says so", async () => {
  const html = await richText(
    "<p>The build writes <code>&lt;fw-island&gt;</code> for you.</p>",
  );

  expect(html).toBe(
    '<div class="rich"><p>The build writes <code>&lt;fw-island&gt;</code>' +
      " for you.</p></div>",
  );
});

test("an attribute name in prose goes, because the strip reads bytes not tags", async () => {
  const html = await richText('<p>Set data-fw-slot="0.0" to address it.</p>');

  expect(html).toBe('<div class="rich"><p>Set to address it.</p></div>');
});

test("a reserved name that removing another one would spell is removed too", async () => {
  const html = await richText(
    '<fw-isl<fw-island data-fw-mode="load">and role="x">' +
      '<span>data-fw-sl<fw-island>ot="0.0"</span>',
  );

  expect(html).not.toContain("fw-island");
  expect(html).not.toContain("data-fw-slot");
});

test("a longer name a site owns is not the framework's and is left alone", async () => {
  const html = await richText('<div data-fw-slotted="x">hi</div>');

  expect(html).toBe('<div class="rich"><div data-fw-slotted="x">hi</div></div>');
});

test("a reserved name that another word ends with is that word's, not ours", async () => {
  const html = await richText("<p>my-data-fw-mode</p>");

  expect(html).toBe('<div class="rich"><p>my-data-fw-mode</p></div>');
});

test("a whole reserved name inside a URL goes, and that is the stated limit", async () => {
  const html = await richText('<a href="/docs/data-fw-slot">doc</a>');

  expect(html).toBe('<div class="rich"><a href="/docs/">doc</a></div>');
});

test("providers wrap the page outermost-first and receive the caller's props", async () => {
  const seen: Array<Record<string, unknown>> = [];

  function ThemeProvider({
    theme,
    children,
  }: {
    theme: string;
    children?: ReactNode;
  }) {
    seen.push({ theme });
    return <div data-provider="theme" data-theme={theme}>{children}</div>;
  }

  function StoreProvider({
    storeId,
    children,
  }: {
    storeId: string;
    children?: ReactNode;
  }) {
    seen.push({ storeId });
    return <div data-provider="store" data-store={storeId}>{children}</div>;
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Icon", props: { name: "bolt" } }],
    registry: SITE_REGISTRY,
    providers: [
      { component: ThemeProvider, props: { theme: "dark" } },
      { component: StoreProvider, props: { storeId: "site" } },
    ],
  });

  expect(html).toBe(
    '<div data-provider="theme" data-theme="dark">' +
      '<div data-provider="store" data-store="site">' +
      '<i class="icon icon--bolt"></i>' +
      "</div></div>",
  );
  expect(seen).toEqual([{ theme: "dark" }, { storeId: "site" }]);
});

test("a component suspending on framework-resolved data renders its real content", async () => {
  function Stats() {
    const stats = useBuildData<{ users: number }>("stats");
    return <p>{`${stats.users} users`}</p>;
  }

  function StatsPanel() {
    return (
      <Suspense fallback={<p>loading</p>}>
        <Stats />
      </Suspense>
    );
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "StatsPanel" }],
    registry: { StatsPanel: component(StatsPanel) },
    data: { stats: { users: 42 } },
  });

  expect(html).toContain("<p>42 users</p>");
  expect(html).not.toContain("loading");
});

test("a component suspending on a raw fetch fails the build naming it", async () => {
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ json: async () => ({ users: 1 }) }), 50);
      }),
  );

  function SlowFetch() {
    const data = use(
      fetch("https://example.test/stats").then((response) =>
        (response as Response).json(),
      ),
    );
    return <p>{(data as { users: number }).users} users</p>;
  }

  function FetchPanel() {
    return (
      <Suspense fallback={<p>loading</p>}>
        <SlowFetch />
      </Suspense>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "FetchPanel" }],
      registry: { FetchPanel: component(FetchPanel) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "SlowFetch": suspended on data the framework did not resolve, while rendering entry /en/home — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection\'s loader and read it with useBuildData()',
    ),
  );
});

test("a component suspending on a local file read fails the build naming it", async () => {
  function LocalFile() {
    const text = use(
      readFile(new URL("./render.tsx", import.meta.url), "utf8"),
    ) as string;
    return <p>{text.length} bytes</p>;
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "LocalFile" }],
      registry: { LocalFile: component(LocalFile) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "LocalFile": suspended on data the framework did not resolve, while rendering entry /en/home — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection\'s loader and read it with useBuildData()',
    ),
  );
});

const FASTEST_IO: ReadonlyArray<[string, () => Promise<void>]> = [
  ["a zero-delay timer", () => new Promise((resolve) => { setTimeout(resolve, 0); })],
  ["the next event-loop turn", () => new Promise((resolve) => { setImmediate(resolve); })],
];

for (const [what, start] of FASTEST_IO) {
  test(`a component suspending on ${what} fails the build naming it`, async () => {
    const pending = start();
    function Immediate() {
      use(pending);
      return <p>done</p>;
    }

    await expect(
      renderPage({
        page: PAGE,
        tree: [{ component: "Immediate" }],
        registry: { Immediate: component(Immediate) },
      }),
    ).rejects.toThrowError(
      new RenderError(
        'Component "Immediate": suspended on data the framework did not resolve, while rendering entry /en/home — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection\'s loader and read it with useBuildData()',
      ),
    );
  });
}

test("a failure React's stack does not name still names the entry", async () => {
  // A bare `{}`, not `undefined`: `wrapInProviders` treats an unrenderable entry as no
  // stack (#66), so only an object still reaches `createElement` and throws at the root.
  const failure = await renderPage({
    page: PAGE,
    tree: [{ component: "Icon", props: { name: "bolt" } }],
    registry: SITE_REGISTRY,
    providers: [{ component: {} } as unknown as RootProvider],
  }).catch((error: unknown) => error);

  expect((failure as RenderError).message).toBe(
    "Entry /en/home: a component threw while rendering — fix the component, or the props the entry gives it",
  );
});

test("a page whose components read the seam in a chain is not ruled foreign", async () => {
  function Level({ at }: { at: number }) {
    const value = useBuildData<string>(`level-${at}`);
    return at < 3 ? (
      <div data-level={value}>
        <Level at={at + 1} />
      </div>
    ) : (
      <div data-level={value} />
    );
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Levels" }],
    registry: {
      Levels: component(() => <Level at={0} />),
    },
    data: { "level-0": "a", "level-1": "b", "level-2": "c", "level-3": "d" },
  });

  expect(html).toBe(
    '<div data-level="a"><div data-level="b">' +
      '<div data-level="c"><div data-level="d"></div></div>' +
      "</div></div>",
  );
});

test("a large tree is not ruled foreign for taking longer to render", async () => {
  function Rows() {
    return (
      <ul>
        {Array.from({ length: 5000 }, (_, at) => (
          <li key={at}>{`row ${at}`}</li>
        ))}
      </ul>
    );
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Rows" }],
    registry: { Rows: component(Rows) },
  });

  expect(html).toContain("<li>row 4999</li>");
});

test("build data the page did not resolve fails naming the key and the entry", async () => {
  function Stats() {
    return <p>{useBuildData<number>("stats")}</p>;
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Stats" }],
      registry: { Stats: component(Stats) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Build data "stats": not resolved for entry /en/home — resolve it in the collection\'s loader and pass it in this page\'s render data',
    ),
  );
});

test("a promise in build data fails naming the key instead of waiting on it", async () => {
  function Stats() {
    return <p>{useBuildData<string>("stats")}</p>;
  }
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Stats" }],
      registry: { Stats: component(Stats) },
      data: {
        stats: new Promise((resolve) => {
          setTimeout(() => {
            resolve("late");
          }, 300).unref?.();
        }),
      },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Build data "stats": is a promise for entry /en/home — a build render must not wait on it, so await it in the collection\'s loader and pass the resolved value',
    ),
  );
});

test("a promise in build data that never settles fails rather than hanging", async () => {
  function Stats() {
    return <p>{useBuildData<string>("stats")}</p>;
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Stats" }],
      registry: { Stats: component(Stats) },
      data: { stats: new Promise(() => {}) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Build data "stats": is a promise for entry /en/home — a build render must not wait on it, so await it in the collection\'s loader and pass the resolved value',
    ),
  );
}, 2000);

test("every promise in build data is reported, not the first", async () => {
  function Stats() {
    return <p>{useBuildData<string>("stats")}</p>;
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Stats" }],
      registry: { Stats: component(Stats) },
      data: {
        stats: Promise.resolve(1),
        prices: { then: () => {} },
        theme: "dark",
      },
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 2 build data values are promises — await them in the collection's loader and pass the resolved values:\n" +
        "  stats\n" +
        "  prices",
    ),
  );
});

test("a build data value whose then getter changes between reads is never adopted", async () => {
  let reads = 0;
  const twoFaced = {
    get then() {
      reads += 1;
      if (reads === 1) return undefined;
      return (resolve: (value: unknown) => void) => {
        setTimeout(() => {
          resolve("late");
        }, 200).unref?.();
      };
    },
  };
  function Stats() {
    return <p>{String(useBuildData<unknown>("stats"))}</p>;
  }

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Stats" }],
    registry: { Stats: component(Stats) },
    data: { stats: twoFaced },
  });

  expect(reads).toBe(1);
  expect(html).not.toContain("late");
});

test("a build data value whose then getter throws is refused naming the key", async () => {
  function Stats() {
    return <p>{useBuildData<string>("stats")}</p>;
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Stats" }],
      registry: { Stats: component(Stats) },
      data: {
        stats: {
          get then(): undefined {
            throw new TypeError("boom");
          },
        },
      },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Build data "stats": is a promise for entry /en/home — a build render must not wait on it, so await it in the collection\'s loader and pass the resolved value',
    ),
  );
});

test("a component that throws fails naming the component and the entry", async () => {
  function Boom(): ReactNode {
    throw new Error("props.rows is undefined");
  }

  await expect(
    renderPage({
      page: { locale: "de", path: "/pricing" },
      tree: [{ component: "Boom" }],
      registry: { Boom: component(Boom) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Boom": threw while rendering entry /de/pricing — fix the component, or the props the entry gives it',
    ),
  );
});

test("a component render failure keeps the original error as its cause", async () => {
  const original = new Error("props.rows is undefined");
  function Boom(): ReactNode {
    throw original;
  }

  const failure = await renderPage({
    page: { locale: "de", path: "/pricing" },
    tree: [{ component: "Boom" }],
    registry: { Boom: component(Boom) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  expect((failure as RenderError).cause).toBe(original);
});

test("every component that suspended outside the seam is reported, not the first", async () => {
  function Weather() {
    use(readFile(new URL("./render.tsx", import.meta.url), "utf8"));
    return <p>never</p>;
  }
  function Prices() {
    use(readFile(new URL("./render.test.tsx", import.meta.url), "utf8"));
    return <p>never</p>;
  }

  const failure = await renderPage({
    page: PAGE,
    tree: [{ component: "Weather" }, { component: "Prices" }],
    registry: {
      Weather: component(Weather),
      Prices: component(Prices),
    },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  expect((failure as RenderError).message).toBe(
    "Entry /en/home: 2 components failed to render — fix the components, or the props the entry gives them:\n" +
      "  Weather: suspended on data the framework did not resolve — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection's loader and read it with useBuildData()\n" +
      "  Prices: suspended on data the framework did not resolve — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection's loader and read it with useBuildData()",
  );
});

test("failures of both kinds on one page are reported together", async () => {
  function Boom(): ReactNode {
    throw new Error("props.rows is undefined");
  }
  function Bust(): ReactNode {
    throw new Error("cannot read length of null");
  }
  function Weather() {
    use(
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
    );
    return <p>never</p>;
  }
  function Dashboard() {
    return (
      <>
        <Suspense fallback={<p>a</p>}>
          <Boom />
        </Suspense>
        <Suspense fallback={<p>b</p>}>
          <Bust />
        </Suspense>
        <Suspense fallback={<p>c</p>}>
          <Weather />
        </Suspense>
      </>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    tree: [{ component: "Dashboard" }],
    registry: { Dashboard: component(Dashboard) },
  }).catch((error: unknown) => error);

  expect((failure as RenderError).message).toBe(
    "Entry /en/home: 3 components failed to render — fix the components, or the props the entry gives them:\n" +
      "  Boom: threw — props.rows is undefined\n" +
      "  Bust: threw — cannot read length of null\n" +
      "  Weather: suspended on data the framework did not resolve — a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection's loader and read it with useBuildData()",
  );
});

test("every failing island is reported, not the first", async () => {
  function Boom(): ReactNode {
    throw new Error("props.rows is undefined");
  }
  function Bust(): ReactNode {
    throw new Error("cannot read length of null");
  }

  const failure = await renderPage({
    page: PAGE,
    tree: [{ component: "Boom" }, { component: "Bust" }],
    registry: {
      Boom: component(Boom),
      Bust: component(Bust),
    },
    modules: { Boom: { useClient: true }, Bust: { useClient: true } },
  }).catch((error: unknown) => error);

  expect((failure as RenderError).message).toBe(
    "Entry /en/home: 2 components failed to render — fix the components, or the props the entry gives them:\n" +
      "  Boom: threw — props.rows is undefined\n" +
      "  Bust: threw — cannot read length of null",
  );
});

test("a component error React recovered into a fallback still fails the page", async () => {
  function Boom(): ReactNode {
    throw new Error("props.rows is undefined");
  }
  function Guarded() {
    return (
      <Suspense fallback={<p>loading</p>}>
        <Boom />
      </Suspense>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Guarded" }],
      registry: { Guarded: component(Guarded) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Boom": threw while rendering entry /en/home — fix the component, or the props the entry gives it',
    ),
  );
});

test("rendering the same page twice returns byte-identical HTML", async () => {
  const input = {
    page: PAGE,
    tree: fixtureTree("en", "home"),
    registry: SITE_REGISTRY,
  };

  const first = await renderPage(input);
  const second = await renderPage(input);

  expect(second.html).toBe(first.html);
});

test("interleaved page renders do not bleed state into each other", async () => {
  const home = { page: PAGE, tree: fixtureTree("en", "home"), registry: SITE_REGISTRY };
  const de = {
    page: { locale: "de", path: "/home" } as const,
    tree: fixtureTree("de", "home"),
    registry: SITE_REGISTRY,
  };

  const serialHome = (await renderPage(home)).html;
  const serialDe = (await renderPage(de)).html;

  const [a, b, c, d] = await Promise.all([
    renderPage(home),
    renderPage(de),
    renderPage(home),
    renderPage(de),
  ]);

  expect([a.html, c.html]).toEqual([serialHome, serialHome]);
  expect([b.html, d.html]).toEqual([serialDe, serialDe]);
  expect(serialHome).not.toBe(serialDe);
});

function Counter({ label }: { label: string }) {
  const id = useId();
  return (
    <button className="counter" id={id}>
      {label}
    </button>
  );
}

const ISLAND_REGISTRY = {
  Hero: component(Hero),
  Icon: component(Icon),
  Counter: component(Counter),
} satisfies ComponentRegistry;

const COUNTER_IS_CLIENT = { Counter: { useClient: true } };

// Written out on purpose: the marker is a wire format, so a test assembled from the
// build's own constants would pass any rename of them.
function marker(island: RenderedIsland, props: string): string {
  return (
    `<fw-island data-fw-prefix="${island.prefix}"` +
    ` data-fw-component="${island.component}"` +
    ` data-fw-mode="${island.mode}"` +
    ` data-fw-props="${props}"` +
    ` role="presentation" style="display:contents">${island.html}</fw-island>`
  );
}

const ISLAND_TREE: readonly EntryNode[] = [
  {
    component: "Hero",
    props: { background: "gradient" },
    children: [{ component: "Counter", props: { label: "Add" } }],
  },
  { component: "Icon", props: { name: "bolt" } },
];

test("an island instance renders in its own pass and composes into the page", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: ISLAND_TREE,
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(islands).toHaveLength(1);
  const [island] = islands as [(typeof islands)[number]];
  expect(island.component).toBe("Counter");
  expect(island.mode).toBe("visible");
  expect(island.path).toEqual([0, 0]);

  expect(html).toContain(island.html);
  expect(html).toBe(
    '<section class="hero hero--gradient">' +
      marker(island, "{&quot;label&quot;:&quot;Add&quot;}") +
      "</section>" +
      '<i class="icon icon--bolt"></i>',
  );

  expect(island.html).toContain(island.prefix);
  expect(island.html).toMatch(/^<button class="counter" id="[^"]+">Add<\/button>$/);
});

test("an island's prefix is derived from the page and the node's position", async () => {
  const home = await renderPage({
    page: PAGE,
    tree: ISLAND_TREE,
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(home.islands[0]?.prefix).toBe("i51e0b4fd775a");

  const again = await renderPage({
    page: PAGE,
    tree: ISLAND_TREE,
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });
  expect(again.islands[0]?.prefix).toBe(home.islands[0]?.prefix);

  const moved = await renderPage({
    page: PAGE,
    tree: [ISLAND_TREE[1] as EntryNode, { component: "Counter", props: { label: "Add" } }],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });
  expect(moved.islands[0]?.prefix).toBe("i07a07dfa412c");

  const other = await renderPage({
    page: { locale: "de", path: "/home" },
    tree: ISLAND_TREE,
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });
  expect(other.islands[0]?.prefix).toBe("i646cebc1d525");
});

test("two island instances of one component get distinct prefixes", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      { component: "Counter", props: { label: "One" } },
      { component: "Counter", props: { label: "Two" } },
    ],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(islands).toHaveLength(2);
  expect(islands[0]?.prefix).not.toBe(islands[1]?.prefix);
  expect(islands[0]?.html).not.toBe(islands[1]?.html);
});

test("each marker carries that instance's own props and no other's", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      { component: "Counter", props: { label: "One" } },
      { component: "Counter", props: { label: "Two" } },
    ],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toBe(
    marker(islands[0] as RenderedIsland, "{&quot;label&quot;:&quot;One&quot;}") +
      marker(
        islands[1] as RenderedIsland,
        "{&quot;label&quot;:&quot;Two&quot;}",
      ),
  );
});

test("an island with no props carries an empty payload rather than none", async () => {
  function Clock() {
    return <time />;
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Clock" }],
    registry: { Clock: component(Clock) },
    modules: { Clock: { useClient: true } },
  });

  expect(html).toBe(marker(islands[0] as RenderedIsland, "{}"));
});

test("props that will not serialize fail the build naming the component and the entry", async () => {
  const cyclic: Record<string, unknown> = { label: "Add" };
  cyclic.self = cyclic;

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: cyclic }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": its props do not serialize to JSON, and entry /en/home renders it as an island — a hydration marker carries each instance\'s own props inline, so give it props that are JSON',
    ),
  );
});

test("every island whose props will not serialize is reported, not the first", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Counter", props: cyclic },
        { component: "Counter", props: { at: 1n } },
      ],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 2 islands have props that do not serialize to JSON — a hydration marker carries each instance's own props inline, so give them props that are JSON:\n" +
        "  Counter: Converting circular structure to JSON\n" +
        "    --> starting at object with constructor 'Object'\n" +
        "    --- property 'self' closes the circle\n" +
        "  Counter: Do not know how to serialize a BigInt",
    ),
  );
});

test("a prop React reads as markup fails the build naming the component and the entry", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Counter",
          props: {
            dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
          },
        },
      ],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("a refused name nested in the props tree is named by its dotted path", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Counter",
          props: { card: { dangerouslySetInnerHTML: { __html: "<b>x</b>" } } },
        },
      ],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("the guard cannot be walked around with __proto__", async () => {
  // From `JSON.parse`, not a literal: a literal's `__proto__:` sets the prototype and
  // leaves no own property behind.
  const props = JSON.parse(
    String.raw`{"__proto__":{"dangerouslySetInnerHTML":{"__html":"<img src=x onerror=alert(1)>"}}}`,
  ) as Record<string, unknown>;
  expect(Reflect.ownKeys(props)).toEqual(["__proto__"]);

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "__proto__" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("every refused prop name is reported, not the first", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Counter", props: { items: [{ ref: "one" }] } },
        { component: "Counter", props: { key: "two", constructor: "three" } },
      ],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 3 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Counter: items.0.ref is a name the framework refuses — rename the field\n" +
        "  Counter: key is a name the framework refuses — rename the field\n" +
        "  Counter: constructor is a name the framework refuses — rename the field",
    ),
  );
});

test("an accessor prop is refused, whatever it would have returned", async () => {
  const props: Record<string, unknown> = {};
  Object.defineProperty(props, "evil", {
    enumerable: true,
    get: () => ({ dangerouslySetInnerHTML: { __html: "<b>x</b>" } }),
  });

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "evil" is an accessor, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so give it a value JSON can hold',
    ),
  );
});

test("a toJSON is refused, so it cannot rewrite the props on the way out", async () => {
  const card = {
    toJSON: () => ({ dangerouslySetInnerHTML: { __html: "<b>x</b>" } }),
  };

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: { card } }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "card.toJSON" is a function, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so give it a value JSON can hold',
    ),
  );
});

test("a cycle a toJSON hides is still a build error and not a stack overflow", async () => {
  const card: Record<string, unknown> = {
    toJSON: () => ({ dangerouslySetInnerHTML: { __html: "<b>x</b>" } }),
  };
  card.self = card;

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: { card } }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "card.toJSON" is a function, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so give it a value JSON can hold',
    ),
  );
});

test("a toJSON cannot hide a refused name from the static HTML", async () => {
  function Spread(props: Record<string, unknown>) {
    return <div {...props} />;
  }
  const props = {
    dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
    toJSON: () => ({ className: "clean" }),
  };

  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Spread", props }],
      registry: { Spread: component(Spread) },
      modules: { Spread: { useClient: true } },
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 2 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Spread: dangerouslySetInnerHTML is a name the framework refuses — rename the field\n" +
        "  Spread: toJSON is a function — give it a value JSON can hold",
    ),
  );
  expect(html).toBeUndefined();
});

test("a getter that answers differently each time is refused unread", async () => {
  let reads = 0;
  const props: Record<string, unknown> = {};
  Object.defineProperty(props, "evil", {
    enumerable: true,
    get: () => {
      reads += 1;
      return reads === 1
        ? { dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" } }
        : { className: "clean" };
    },
  });

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "evil" is an accessor, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so give it a value JSON can hold',
    ),
  );
  expect(reads).toBe(0);
});

test("a function prop is refused, because an entry cannot hold one", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: { onSelect: () => undefined } }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": prop "onSelect" is a function, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so give it a value JSON can hold',
    ),
  );
});

test("props nested past the depth limit fail the build rather than the stack", async () => {
  let deep: Record<string, unknown> = { end: true };
  for (let at = 0; at < 50_000; at += 1) deep = { deep };
  const card = { toJSON: () => ({ className: "clean" }), deep };
  const at = ["card", ...Array<string>(32).fill("deep")].join(".");

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: { card } }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 2 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Counter: card.toJSON is a function — give it a value JSON can hold\n" +
        `  Counter: ${at} is nested more than 32 levels deep — the walk stops at a depth so a chain from outside cannot overflow the stack, and props nested this far are not content, so flatten it`,
    ),
  );
});

function SpreadCard({ card }: { card: Record<string, unknown> }) {
  return <div {...card} />;
}

const SPREAD_CARD = { SpreadCard: component(SpreadCard) } satisfies ComponentRegistry;

test("a toJSON on a prototype is caught, where own keys cannot see it", async () => {
  class Card {
    safe = "ok";
    toJSON() {
      return {
        dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
      };
    }
  }

  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "SpreadCard", props: { card: new Card() } }],
      registry: SPREAD_CARD,
      modules: { SpreadCard: { useClient: true } },
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "SpreadCard": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it as an island — island props are content and a marker hands them to React unchanged, so rename the field',
    ),
  );
  expect(html).toBeUndefined();
});

test("a toJSON inherited without a class is caught the same way", async () => {
  const card = Object.create({
    toJSON: () => ({ dangerouslySetInnerHTML: { __html: "<b>x</b>" } }),
  }) as Record<string, unknown>;

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "SpreadCard", props: { card } }],
      registry: SPREAD_CARD,
      modules: { SpreadCard: { useClient: true } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "SpreadCard": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it as an island — island props are content and a marker hands them to React unchanged, so rename the field',
    ),
  );
});

test("a Date prop builds, because a difference is not a refused name", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Counter", props: { when: new Date(0) } }],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toBe(
    marker(
      islands[0] as RenderedIsland,
      "{&quot;when&quot;:&quot;1970-01-01T00:00:00.000Z&quot;}",
    ),
  );
});

test("props nested to the depth limit build, and one level past it do not", async () => {
  const chain = (depth: number): Record<string, unknown> => {
    let built: Record<string, unknown> = { end: true };
    for (let at = 1; at < depth; at += 1) built = { deep: built };
    return { deep: built };
  };

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: chain(32) }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).resolves.toBeDefined();

  const at = Array<string>(33).fill("deep").join(".");
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: chain(33) }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      `Component "Counter": prop "${at}" is nested more than 32 levels deep, and entry /en/home renders it — the walk stops at a depth so a chain from outside cannot overflow the stack, and props nested this far are not content, so flatten it`,
    ),
  );
});

test("a depth refusal states its own reason, not the one the others share", async () => {
  let deep: Record<string, unknown> = { end: true };
  for (let at = 1; at < 33; at += 1) deep = { deep };
  const at = Array<string>(33).fill("deep").join(".");

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props: { ref: "held", deep } }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 2 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Counter: ref is a name the framework refuses — rename the field\n" +
        `  Counter: ${at} is nested more than 32 levels deep — the walk stops at a depth so a chain from outside cannot overflow the stack, and props nested this far are not content, so flatten it`,
    ),
  );
});

test("props whose toJSON yields no JSON value at all fail the build", async () => {
  // The `toJSON` is inherited so this reaches serialization at all: an own one is a
  // function value, which the pre-pass refuses first.
  const props = Object.create({ toJSON: () => undefined }) as Record<
    string,
    unknown
  >;

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Counter", props }],
      registry: ISLAND_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": its props do not serialize to JSON, and entry /en/home renders it as an island — a hydration marker carries each instance\'s own props inline, so give it props that are JSON',
    ),
  );
});

function Spread(props: Record<string, unknown>) {
  return <div {...props} />;
}

function Box({ children }: { children?: ReactNode }) {
  return <section>{children}</section>;
}

const SPREAD_REGISTRY = {
  Box: component(Box),
  Spread: component(Spread),
  Counter: component(Counter),
} satisfies ComponentRegistry;

const BOX_IS_CLIENT = { Box: { useClient: true } };

test("a refused prop name on a top-level non-island node fails the build", async () => {
  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Spread",
          props: {
            dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
          },
        },
      ],
      registry: SPREAD_REGISTRY,
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Spread": prop "dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
  expect(html).toBeUndefined();
});

test("a refused prop name on a node slotted inside an island fails the build", async () => {
  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Box",
          props: { a: "1" },
          children: [
            {
              component: "Spread",
              props: {
                dangerouslySetInnerHTML: {
                  __html: "<img src=x onerror=alert(1)>",
                },
              },
            },
          ],
        },
      ],
      registry: SPREAD_REGISTRY,
      modules: BOX_IS_CLIENT,
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Spread": prop "dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
  expect(html).toBeUndefined();
});

test("a refused name nested in a non-island node's props is named by its path", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "SpreadCard",
          props: { card: { dangerouslySetInnerHTML: { __html: "<b>x</b>" } } },
        },
      ],
      registry: SPREAD_CARD,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "SpreadCard": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("an accessor on a non-island node hides a refused prop name", async () => {
  // Pinned on purpose (#135).
  const props = {
    get card() {
      return {
        dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
      };
    },
  };

  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "SpreadCard", props }],
    registry: SPREAD_CARD,
  });

  expect(html).toContain("<img src=x onerror=alert(1)>");
});

test("the same accessor, once it has been through the store, no longer hides the name", async () => {
  const store = openStore(":memory:");
  const props = {
    get card() {
      return {
        dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
      };
    },
  };
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "home",
    data: props,
  });
  const stored = store.getEntry<Record<string, unknown>>("pages", "en", "home");
  store.close();

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "SpreadCard", props: stored?.data }],
      registry: SPREAD_CARD,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "SpreadCard": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("the key the build adds to every node refuses none of them", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: fixtureTree("en", "home"),
      registry: SITE_REGISTRY,
    }),
  ).resolves.toBeDefined();

  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Spread", props: { key: "authored" } }],
      registry: SPREAD_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Spread": prop "key" is a name the framework refuses, and entry /en/home renders it — an entry\'s props are content and the build hands them to React unchanged, so rename the field',
    ),
  );
});

test("every refused prop on a page's non-island nodes is reported, not the first", async () => {
  // The second node's props come from `JSON.parse`: a literal's `__proto__:` sets the
  // prototype and leaves no own property behind.
  const authored = JSON.parse(
    String.raw`{"__proto__":"two","constructor":"x"}`,
  ) as Record<string, unknown>;

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Box",
          props: { a: "1" },
          children: [
            { component: "Spread", props: { items: [{ ref: "one" }] } },
          ],
        },
        { component: "Spread", props: authored },
      ],
      registry: SPREAD_REGISTRY,
      modules: BOX_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 3 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Spread: items.0.ref is a name the framework refuses — rename the field\n" +
        "  Spread: __proto__ is a name the framework refuses — rename the field\n" +
        "  Spread: constructor is a name the framework refuses — rename the field",
    ),
  );
});

test("a refused name on an ordinary node and one on an island are one report", async () => {
  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Spread",
          props: {
            dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
          },
        },
        { component: "Box", props: { ref: "authored" } },
      ],
      registry: SPREAD_REGISTRY,
      modules: BOX_IS_CLIENT,
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 2 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Spread: dangerouslySetInnerHTML is a name the framework refuses — rename the field\n" +
        "  Box: ref is a name the framework refuses — rename the field",
    ),
  );
  expect(html).toBeUndefined();
});

test("an island's non-name refusal joins an ordinary node's name in one report", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Spread", props: { ref: "authored" } },
        { component: "Box", props: { onSelect: () => undefined } },
      ],
      registry: SPREAD_REGISTRY,
      modules: BOX_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: the framework refuses 2 component props — an entry's props are content and the build hands them to React unchanged, so rename, replace or flatten each one below:\n" +
        "  Spread: ref is a name the framework refuses — rename the field\n" +
        "  Box: onSelect is a function — give it a value JSON can hold",
    ),
  );
});

test("what only islandProps can see is still refused, where it is serialized", async () => {
  const props = {
    card: Object.create({
      toJSON: () => ({ dangerouslySetInnerHTML: { __html: "<b>x</b>" } }),
    }) as Record<string, unknown>,
  };

  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Box", props }],
      registry: SPREAD_REGISTRY,
      modules: BOX_IS_CLIENT,
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Box": prop "card.dangerouslySetInnerHTML" is a name the framework refuses, and entry /en/home renders it as an island — island props are content and a marker hands them to React unchanged, so rename the field',
    ),
  );
  expect(html).toBeUndefined();
});

function SpreadDeep({ chain }: { chain: Record<string, unknown> }) {
  let at = chain;
  while (typeof at["next"] === "object" && at["next"] !== null) {
    at = at["next"] as Record<string, unknown>;
  }
  return <div {...at} />;
}

const SPREAD_DEEP = { SpreadDeep: component(SpreadDeep) } satisfies ComponentRegistry;

const DEEP_LINKS = 40;

test("a refused prop name far below any depth limit fails the build", async () => {
  let deep: Record<string, unknown> = {
    dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
  };
  for (let link = 0; link < DEEP_LINKS; link++) {
    deep = { next: deep };
  }
  const path = `chain${".next".repeat(DEEP_LINKS)}.dangerouslySetInnerHTML`;

  let html: string | undefined;
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "SpreadDeep", props: { chain: deep } }],
      registry: SPREAD_DEEP,
    }).then((result) => {
      html = result.html;
    }),
  ).rejects.toThrowError(
    new RenderError(
      `Component "SpreadDeep": prop "${path}" is a name the framework refuses, and entry /en/home renders it — an entry's props are content and the build hands them to React unchanged, so rename the field`,
    ),
  );
  expect(html).toBeUndefined();
});

function Table({ children }: { children?: ReactNode }) {
  return (
    <table>
      <tbody>
        <tr>{children}</tr>
      </tbody>
    </table>
  );
}

function Cell({ children }: { children?: ReactNode }) {
  return <td>{children}</td>;
}

const TABLE_REGISTRY = {
  Table: component(Table),
  Cell: component(Cell),
  Counter: component(Counter),
} satisfies ComponentRegistry;

test("an island directly inside table markup fails the build", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Table",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: TABLE_REGISTRY,
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <tr>, and entry /en/home renders it — the HTML parser moves an unknown element out of table markup before any CSS applies, so the hydration marker would not survive to be hydrated; put the island inside a <td> or <th>, or drop its hydration',
    ),
  );
});

test("an island inside a colgroup fails the build", async () => {
  function Columns({ children }: { children?: ReactNode }) {
    return (
      <table>
        <colgroup>{children}</colgroup>
        <tbody>
          <tr>
            <td>cell</td>
          </tr>
        </tbody>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Columns",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Columns: component(Columns),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <colgroup>, and entry /en/home renders it — the HTML parser moves an unknown element out of table markup before any CSS applies, so the hydration marker would not survive to be hydrated; put the island inside a <td> or <th>, or drop its hydration',
    ),
  );
});

test("a wrapper between the island and the table does not hide it", async () => {
  function Form({ children }: { children?: ReactNode }) {
    return (
      <table>
        <form>{children}</form>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Form",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Form: component(Form),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <table>, and entry /en/home renders it — the HTML parser moves an unknown element out of table markup before any CSS applies, so the hydration marker would not survive to be hydrated; put the island inside a <td> or <th>, or drop its hydration',
    ),
  );
});

test("a wrapper between the island and the row does not hide it either", async () => {
  function Rows({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>
            <div>{children}</div>
          </tr>
        </tbody>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Rows",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Rows: component(Rows),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <tr>, and entry /en/home renders it — the HTML parser moves an unknown element out of table markup before any CSS applies, so the hydration marker would not survive to be hydrated; put the island inside a <td> or <th>, or drop its hydration',
    ),
  );
});

test("a wrapper inside a cell keeps the island legal", async () => {
  function Wrapped({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>
            <td>
              <div>{children}</div>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Wrapped",
        children: [{ component: "Counter", props: { label: "Add" } }],
      },
    ],
    registry: {
      Wrapped: component(Wrapped),
      Counter: component(Counter),
    },
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toContain(
    `<div>${marker(islands[0] as RenderedIsland, "{&quot;label&quot;:&quot;Add&quot;}")}</div>`,
  );
});

test("a table nested inside a cell keeps its own cells legal", async () => {
  function Nested({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>
            <td>
              <table>
                <tbody>
                  <tr>
                    <td>{children}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    );
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Nested",
        children: [{ component: "Counter", props: { label: "Add" } }],
      },
    ],
    registry: {
      Nested: component(Nested),
      Counter: component(Counter),
    },
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toContain(
    `<td>${marker(islands[0] as RenderedIsland, "{&quot;label&quot;:&quot;Add&quot;}")}</td>`,
  );
});

test("an island inside a table cell is fine", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Table",
        children: [
          {
            component: "Cell",
            children: [{ component: "Counter", props: { label: "Add" } }],
          },
        ],
      },
    ],
    registry: TABLE_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toContain(
    `<td>${marker(islands[0] as RenderedIsland, "{&quot;label&quot;:&quot;Add&quot;}")}</td>`,
  );
});

test("every island inside table markup is reported, not the first", async () => {
  function Rows({ children }: { children?: ReactNode }) {
    return (
      <table>
        <thead>{children}</thead>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Rows",
          children: [
            { component: "Counter", props: { label: "One" } },
            { component: "Counter", props: { label: "Two" } },
          ],
        },
      ],
      registry: {
        Rows: component(Rows),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 2 islands are inside table markup — the HTML parser moves an unknown element out of table markup before any CSS applies, so their hydration markers would not survive to be hydrated; put each island inside a <td> or <th>, or drop its hydration:\n" +
        "  Counter: inside <thead>\n" +
        "  Counter: inside <thead>",
    ),
  );
});

test("an island after a void element in a row is still refused", async () => {
  function Rows({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>
            <img src="/x.png" alt="" />
            {children}
          </tr>
        </tbody>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Rows",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Rows: component(Rows),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <tr>, and entry /en/home renders it — the HTML parser moves an unknown element out of table markup before any CSS applies, so the hydration marker would not survive to be hydrated; put the island inside a <td> or <th>, or drop its hydration',
    ),
  );
});

test("rich text that leaves a table open does not swallow the island after it", async () => {
  function Article({ children }: { children?: ReactNode }) {
    return (
      <div>
        <div {...unescapedHtml("<table><tbody><tr>")} />
        {children}
      </div>
    );
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Article",
        children: [{ component: "Counter", props: { label: "Add" } }],
      },
    ],
    registry: {
      Article: component(Article),
      Counter: component(Counter),
    },
    modules: COUNTER_IS_CLIENT,
  });

  expect(html).toContain(
    `</div>${marker(islands[0] as RenderedIsland, "{&quot;label&quot;:&quot;Add&quot;}")}`,
  );
});

test("React writes every void element self-closed, which the marker scan leans on", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Rule" }],
    registry: {
      Rule: component(() => (
        <div>
          <br />
          <hr />
          <img alt="" />
        </div>
      )),
    },
  });

  expect(html).toBe("<div><br/><hr/><img alt=\"\"/></div>");
});

function Chooser({ children }: { children?: ReactNode }) {
  return <select>{children}</select>;
}

function Inert({ children }: { children?: ReactNode }) {
  return <template>{children}</template>;
}

test("an island inside a select fails the build", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Chooser",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Chooser: component(Chooser),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <select>, and entry /en/home renders it — the HTML parser discards content a <select> does not recognise, so the hydration marker would not be in the document at all; move the island out of the <select>, or drop its hydration',
    ),
  );
});

test("an island inside a template fails the build with no table anywhere", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Inert",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Inert: component(Inert),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <template>, and entry /en/home renders it — the HTML parser diverts a <template>\'s content into a document fragment of its own, so the hydration marker would not be in the document the runtime searches; move the island out of the <template>, or drop its hydration',
    ),
  );
});

test("a template inside a table names the template, not the table around it", async () => {
  function Boxed({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>
            <template>{children}</template>
          </tr>
        </tbody>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Boxed",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
      ],
      registry: {
        Boxed: component(Boxed),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <template>, and entry /en/home renders it — the HTML parser diverts a <template>\'s content into a document fragment of its own, so the hydration marker would not be in the document the runtime searches; move the island out of the <template>, or drop its hydration',
    ),
  );
});

test("a template inside a select is refused as the template it is", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Chooser",
          children: [
            {
              component: "Inert",
              children: [{ component: "Counter", props: { label: "Add" } }],
            },
          ],
        },
      ],
      registry: {
        Chooser: component(Chooser),
        Inert: component(Inert),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <template>, and entry /en/home renders it — the HTML parser diverts a <template>\'s content into a document fragment of its own, so the hydration marker would not be in the document the runtime searches; move the island out of the <template>, or drop its hydration',
    ),
  );
});

test("a select inside a template is refused as the select it is", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Inert",
          children: [
            {
              component: "Chooser",
              children: [{ component: "Counter", props: { label: "Add" } }],
            },
          ],
        },
      ],
      registry: {
        Chooser: component(Chooser),
        Inert: component(Inert),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <select>, and entry /en/home renders it — the HTML parser discards content a <select> does not recognise, so the hydration marker would not be in the document at all; move the island out of the <select>, or drop its hydration',
    ),
  );
});

test("all three kinds of defeated marker are reported in one run", async () => {
  function Rows({ children }: { children?: ReactNode }) {
    return (
      <table>
        <tbody>
          <tr>{children}</tr>
        </tbody>
      </table>
    );
  }

  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Chooser",
          children: [{ component: "Counter", props: { label: "One" } }],
        },
        {
          component: "Inert",
          children: [{ component: "Counter", props: { label: "Two" } }],
        },
        {
          component: "Rows",
          children: [
            { component: "Counter", props: { label: "Three" } },
            { component: "Counter", props: { label: "Four" } },
          ],
        },
      ],
      registry: {
        Chooser: component(Chooser),
        Inert: component(Inert),
        Rows: component(Rows),
        Counter: component(Counter),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 1 island is inside <select> — the HTML parser discards content a <select> does not recognise, so its hydration marker would not be in the document at all; move the island out of the <select>, or drop its hydration:\n" +
        "  Counter\n" +
        "\n" +
        "Entry /en/home: 1 island is inside <template> — the HTML parser diverts a <template>'s content into a document fragment of its own, so its hydration marker would not be in the document the runtime searches; move the island out of the <template>, or drop its hydration:\n" +
        "  Counter\n" +
        "\n" +
        "Entry /en/home: 2 islands are inside table markup — the HTML parser moves an unknown element out of table markup before any CSS applies, so their hydration markers would not survive to be hydrated; put each island inside a <td> or <th>, or drop its hydration:\n" +
        "  Counter: inside <tr>\n" +
        "  Counter: inside <tr>",
    ),
  );
});

test("a component the directive scan did not flag is not an island", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: ISLAND_TREE,
    registry: ISLAND_REGISTRY,
  });

  expect(islands).toEqual([]);
  expect(html).not.toContain("fw-island");
});

test("a content-only fixture page emits no marker and no script tag", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: fixtureTree("en", "home"),
    registry: SITE_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(islands).toEqual([]);
  expect(html).not.toContain("fw-island");
  expect(html).not.toContain("<script");
});

test("a registry hydrate override islands a component with no directive", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Counter", props: { label: "Add" } }],
    registry: {
      Counter: { ...component(Counter), hydrate: "idle" },
    },
  });

  expect(islands.map((island) => island.mode)).toEqual(["idle"]);
});

test("the provider stack wraps every island root as it wraps the page", async () => {
  function ThemeProvider({
    theme,
    children,
  }: {
    theme: string;
    children?: ReactNode;
  }) {
    return <div data-theme={theme}>{children}</div>;
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Counter", props: { label: "Add" } }],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
    providers: [{ component: ThemeProvider, props: { theme: "dark" } }],
  });

  expect(islands[0]?.html).toMatch(/^<div data-theme="dark"><button /);
  expect(html).toBe(
    '<div data-theme="dark">' +
      marker(
        islands[0] as RenderedIsland,
        "{&quot;label&quot;:&quot;Add&quot;}",
      ) +
      "</div>",
  );
});

test("an island's subtree reads the page's build data", async () => {
  function Panel() {
    const stats = useBuildData<{ users: number }>("stats");
    return <p>{`${stats.users} users`}</p>;
  }

  const { islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Panel" }],
    registry: { Panel: component(Panel) },
    modules: { Panel: { useClient: true } },
    data: { stats: { users: 42 } },
  });

  expect(islands[0]?.html).toBe("<p>42 users</p>");
});

test("an island the entry nested inside an island is a root of its own", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Counter",
        props: { label: "Add" },
        children: [{ component: "Counter", props: { label: "Nested" } }],
      },
    ],
    registry: ISLAND_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });

  expect(islands.map((island) => island.path)).toEqual([[0], [0, 0]]);
  expect(islands[0]?.prefix).not.toBe(islands[1]?.prefix);
});

test("an island component that throws fails naming the component and the entry", async () => {
  function Boom(): ReactNode {
    throw new Error("props.rows is undefined");
  }

  await expect(
    renderPage({
      page: { locale: "de", path: "/pricing" },
      tree: [{ component: "Boom" }],
      registry: { Boom: component(Boom) },
      modules: { Boom: { useClient: true } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Boom": threw while rendering entry /de/pricing — fix the component, or the props the entry gives it',
    ),
  );
});

function Sheeted({ href }: { href: string }) {
  return (
    <div className="sheeted">
      <link rel="stylesheet" href={href} precedence="high" />
      <p>styled</p>
    </div>
  );
}

function PlainLink({ href }: { href: string }) {
  return (
    <div className="plain">
      <link rel="stylesheet" href={href} />
      <p>styled</p>
    </div>
  );
}

test("an island declaring a stylesheet precedence fails naming the component and the href", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Sheeted", props: { href: "/island.css" } }],
      registry: { Sheeted: component(Sheeted) },
      modules: { Sheeted: { useClient: true } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Sheeted": declares a stylesheet with React\'s precedence prop, and entry /en/home renders it — React hoists "/island.css" to the front of the island\'s own fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component\'s module so the build places it in a tier, or remove the precedence prop',
    ),
  );
});

test("a static component declaring a stylesheet precedence fails naming the entry", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Sheeted", props: { href: "/page.css" } }],
      registry: { Sheeted: component(Sheeted) },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Entry /en/home: declares a stylesheet with React\'s precedence prop — React hoists "/page.css" to the front of the page\'s fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component\'s module so the build places it in a tier, or remove the precedence prop',
    ),
  );
});

test("every hoisted stylesheet on a page is reported in one run", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Sheeted", props: { href: "/island.css" } },
        { component: "Static", props: { href: "/page.css" } },
      ],
      registry: {
        Sheeted: component(Sheeted),
        Static: component(Sheeted),
      },
      modules: { Sheeted: { useClient: true } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 2 stylesheets are declared with React's precedence prop — React hoists each to the front of the fragment it was rendered in, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import each stylesheet from its component's module so the build places it in a tier, or remove the precedence prop:\n" +
        '  the entry\'s own tree — "/page.css"\n' +
        '  "Sheeted" — "/island.css"',
    ),
  );
});

test("a stylesheet link with no precedence still builds, where it was written", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "PlainLink", props: { href: "/plain.css" } }],
    registry: { PlainLink: component(PlainLink) },
  });

  expect(html).toBe(
    '<div class="plain"><link rel="stylesheet" href="/plain.css"/><p>styled</p></div>',
  );
});

test("a defeated marker and a hoisted stylesheet are reported in one run", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        {
          component: "Chooser",
          children: [{ component: "Counter", props: { label: "Add" } }],
        },
        { component: "Sheeted", props: { href: "/page.css" } },
      ],
      registry: {
        Chooser: component(Chooser),
        Counter: component(Counter),
        Sheeted: component(Sheeted),
      },
      modules: COUNTER_IS_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Counter": is an island inside <select>, and entry /en/home renders it — the HTML parser discards content a <select> does not recognise, so the hydration marker would not be in the document at all; move the island out of the <select>, or drop its hydration' +
        "\n\n" +
        'Entry /en/home: declares a stylesheet with React\'s precedence prop — React hoists "/page.css" to the front of the page\'s fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component\'s module so the build places it in a tier, or remove the precedence prop',
    ),
  );
});

const SCANNED_ISLAND: RenderedIsland = {
  component: "Reveal",
  mode: "load",
  prefix: "iabc123456789",
  html: "",
};
const SCANNED_PREFIX = new Map([[SCANNED_ISLAND.prefix, SCANNED_ISLAND]]);
const SCANNED_SHEET =
  '<link rel="stylesheet" href="/after.css" data-precedence="high"/>';

test("a stylesheet inside a paired island marker is attributed to its component", () => {
  const { sheets } = faultsInEmittedHtml(
    `<div><fw-island data-fw-prefix="${SCANNED_ISLAND.prefix}">${SCANNED_SHEET}</fw-island></div>`,
    SCANNED_PREFIX,
  );

  expect(sheets).toEqual([{ component: "Reveal", href: "/after.css" }]);
});

test("a self-closing island marker does not attribute the stylesheet after it", () => {
  const { sheets } = faultsInEmittedHtml(
    `<div><fw-island data-fw-prefix="${SCANNED_ISLAND.prefix}"/>${SCANNED_SHEET}</div>`,
    SCANNED_PREFIX,
  );

  expect(sheets).toEqual([{ href: "/after.css" }]);
});

function Titled({ title }: { title: string }) {
  return (
    <div className="titled">
      <title>{title}</title>
      <meta name="description" content={`about ${title}`} />
      <p>read me</p>
    </div>
  );
}

function Annotated() {
  return (
    <div itemScope itemType="https://schema.org/Product">
      <meta itemProp="position" content="1" />
      <title itemProp="name">a product</title>
      <p>a product</p>
    </div>
  );
}

function Declaring() {
  return (
    <div>
      <meta charSet="utf-16" />
      <meta httpEquiv="content-language" content="de" />
      <p>x</p>
    </div>
  );
}

function Drawn() {
  return (
    <svg viewBox="0 0 1 1">
      <title>a red square</title>
      <rect width="1" height="1" />
    </svg>
  );
}

test("an island's title and meta are absorbed out of the page", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Titled", props: { title: "Pricing" } }],
    registry: { Titled: component(Titled) },
    modules: { Titled: { useClient: true } },
  });

  expect(absorbed).toEqual([
    {
      component: "Titled",
      claim: { singleton: "<title>", value: "Pricing" },
      tag: "<title>Pricing</title>",
    },
    {
      component: "Titled",
      claim: {
        singleton: '<meta name="description">',
        value: "about Pricing",
      },
      tag: '<meta name="description" content="about Pricing"/>',
    },
  ]);
  expect(html).not.toContain("<title");
  expect(html).not.toContain("<meta");
  expect(html).toContain('<div class="titled"><p>read me</p></div>');
});

test("a claim's value is the text, not the bytes React escaped it into", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Titled", props: { title: "Tools & Tips" } }],
    registry: { Titled: component(Titled) },
    modules: { Titled: { useClient: true } },
  });

  expect(absorbed[0]?.claim).toEqual({
    singleton: "<title>",
    value: "Tools & Tips",
  });
  expect(absorbed[0]?.tag).toBe("<title>Tools &amp; Tips</title>");
  expect(html).not.toContain("<title");
});

test("an ampersand a document wrote for itself survives one decode", async () => {
  const { absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Titled", props: { title: "&lt;" } }],
    registry: { Titled: component(Titled) },
    modules: { Titled: { useClient: true } },
  });

  expect(absorbed[0]?.claim?.value).toBe("&lt;");
});

test("a static component's title is absorbed with nothing to attribute it to", async () => {
  const { absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Titled", props: { title: "Pricing" } }],
    registry: { Titled: component(Titled) },
  });

  expect(absorbed.map((one) => one.component)).toEqual([undefined, undefined]);
});

test("microdata is not absorbed, because React does not hoist it", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Annotated" }],
    registry: { Annotated: component(Annotated) },
  });

  // The whole string, because position is the measurement: the scan skips an `itemprop`
  // tag wherever it sits.
  expect(absorbed).toEqual([]);
  expect(html).toBe(
    '<div itemScope="" itemType="https://schema.org/Product">' +
      '<meta itemProp="position" content="1"/>' +
      '<title itemProp="name">a product</title>' +
      "<p>a product</p></div>",
  );
});

test("React writes some of these attributes in the prop's own spelling", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Declaring" }],
    registry: { Declaring: component(Declaring) },
  });

  expect(absorbed.map((one) => one.claim)).toEqual([
    { singleton: "<meta charset>", value: "utf-16" },
    { singleton: '<meta http-equiv="content-language">', value: "de" },
  ]);
  expect(absorbed.map((one) => one.tag)).toEqual([
    '<meta charSet="utf-16"/>',
    '<meta http-equiv="content-language" content="de"/>',
  ]);
  expect(html).toBe("<div><p>x</p></div>");
});

test("a title inside <svg> stays with its graphic", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Drawn" }],
    registry: { Drawn: component(Drawn) },
  });

  expect(absorbed).toEqual([]);
  expect(html).toBe(
    '<svg viewBox="0 0 1 1"><title>a red square</title>' +
      '<rect width="1" height="1"></rect></svg>',
  );
});

test("absorbing a title does not absorb the stylesheet beside it", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Titled", props: { title: "Pricing" } },
        { component: "Sheeted", props: { href: "/island.css" } },
      ],
      registry: {
        Titled: component(Titled),
        Sheeted: component(Sheeted),
      },
      modules: { Sheeted: { useClient: true } },
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Sheeted": declares a stylesheet with React\'s precedence prop, and entry /en/home renders it — React hoists "/island.css" to the front of the island\'s own fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component\'s module so the build places it in a tier, or remove the precedence prop',
    ),
  );
});

function Iconed() {
  return (
    <main>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <p>deck</p>
    </main>
  );
}

test("a component's icon links are absorbed without a claim", async () => {
  const { html, absorbed } = await renderPage({
    page: PAGE,
    tree: [{ component: "Iconed" }],
    registry: { Iconed: component(Iconed) },
  });

  expect(absorbed).toEqual([
    { tag: '<link rel="icon" href="/favicon.svg" type="image/svg+xml"/>' },
    { tag: '<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>' },
  ]);
  expect(html).toBe("<main><p>deck</p></main>");
});

test("a link that is not an icon stays where it was rendered", () => {
  const html = '<div><link rel="preload" href="/a.woff2" as="font"/></div>';
  const { absorbed, body } = faultsInEmittedHtml(html, new Map());

  expect(absorbed).toEqual([]);
  expect(body).toBe(html);
});

test("an unclosed title in rich text is left where it is", () => {
  const html = "<div><title>never closed</div>";
  const { absorbed, body } = faultsInEmittedHtml(html, new Map());

  expect(absorbed).toEqual([]);
  expect(body).toBe(html);
});

test("a meta identifying nothing is absorbed without a claim", () => {
  const { absorbed } = faultsInEmittedHtml(
    '<div><meta content="x"/></div>',
    new Map(),
  );

  expect(absorbed).toEqual([{ tag: '<meta content="x"/>' }]);
});

function Article({ body }: { body: string }) {
  const { code, direction } = useLocale();
  return (
    <article lang={code} dir={direction}>
      {body}
    </article>
  );
}

const ARTICLE_REGISTRY = { Article: component(Article) } satisfies ComponentRegistry;

const ARABIC: PlacedLocale = {
  code: "ar",
  label: "العربية",
  direction: "rtl",
  prefix: "/ar",
};

test("a component reading the page's locale writes its lang and rtl into the HTML", async () => {
  const { html } = await renderPage({
    page: { locale: "ar", path: "/home" },
    tree: [{ component: "Article", props: { body: "مرحبا" } }],
    registry: ARTICLE_REGISTRY,
    locale: ARABIC,
  });

  expect(html).toBe('<article lang="ar" dir="rtl">مرحبا</article>');
});

test("the same component writes ltr for a left-to-right locale", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Article", props: { body: "Hello" } }],
    registry: ARTICLE_REGISTRY,
    locale: { code: "en", label: "English", direction: "ltr", prefix: "" },
  });

  expect(html).toBe('<article lang="en" dir="ltr">Hello</article>');
});

test("a locale that is not the page's own is refused, naming both codes", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Article", props: { body: "Hello" } }],
      registry: ARTICLE_REGISTRY,
      locale: ARABIC,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Locale "ar": is not entry /en/home\'s locale, which is "en" — pass the locale the set defineLocales() returned under "en"',
    ),
  );
});

test("the same locale is refused by buildPageTree, ahead of any render", async () => {
  await expect(
    buildPageTree({
      page: PAGE,
      content: { tree: [{ component: "Article", props: { body: "Hello" } }] },
      registry: ARTICLE_REGISTRY,
      locale: ARABIC,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Locale "ar": is not entry /en/home\'s locale, which is "en" — pass the locale the set defineLocales() returned under "en"',
    ),
  );
});

test("a page render with no locale fails naming the entry", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Article", props: { body: "Hello" } }],
      registry: ARTICLE_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Locale: not resolved for entry /en/home — pass the page's locale from the set defineLocales() returned as renderPage()'s locale",
    ),
  );
});

test("an island reading the page's locale fails rather than mismatching on the client", async () => {
  await expect(
    renderPage({
      page: { locale: "ar", path: "/home" },
      tree: [{ component: "Article", props: { body: "مرحبا" } }],
      registry: ARTICLE_REGISTRY,
      modules: { Article: { useClient: true } },
      locale: ARABIC,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Locale: read outside the page's own render pass — useLocale() is build-time only, so an island's components must be given the locale as a prop instead",
    ),
  );
});

function OwnCard() {
  const card = useSocialCard();
  if (card === undefined) return <p>no card</p>;
  return (
    <img src={card.href} width={card.width} height={card.height} alt="card" />
  );
}

const CARD_REGISTRY = { OwnCard: component(OwnCard) } satisfies ComponentRegistry;

test("a component reads its page's social card while the page renders", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "OwnCard" }],
    registry: CARD_REGISTRY,
    socialCard: {
      href: "/social/en-home.0123abcd.png",
      width: 1200,
      height: 630,
    },
  });

  expect(html).toContain(
    '<img src="/social/en-home.0123abcd.png" width="1200" height="630" alt="card"/>',
  );
});

test("a page with no card hands its components no value", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "OwnCard" }],
    registry: CARD_REGISTRY,
  });

  expect(html).toBe("<p>no card</p>");
});

test("an island reading its page's social card fails rather than mismatching on the client", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "OwnCard" }],
      registry: CARD_REGISTRY,
      modules: { OwnCard: { useClient: true } },
      socialCard: {
        href: "/social/en-home.0123abcd.png",
        width: 1200,
        height: 630,
      },
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Social card: read outside the page's own render pass — useSocialCard() is build-time only, so an island's components must be given the card as a prop instead",
    ),
  );
});

test("a chrome region's component reads its page's social card too", async () => {
  const { chrome } = await renderPage({
    page: PAGE,
    tree: [],
    registry: CARD_REGISTRY,
    chrome: { after: [{ component: "OwnCard" }] },
    socialCard: {
      href: "/social/en-home.0123abcd.png",
      width: 1200,
      height: 630,
    },
  });

  expect(chrome?.after).toContain(
    '<img src="/social/en-home.0123abcd.png" width="1200" height="630" alt="card"/>',
  );
});

function PricingPage({
  title,
  fields,
}: {
  title: string;
  fields: { intro: string };
}) {
  return (
    <main className="pricing">
      <h1>{title}</h1>
      <p>{fields.intro}</p>
    </main>
  );
}

const PRICING_REGISTRY = {
  PricingPage: component(PricingPage),
} satisfies ComponentRegistry;

const PRICING_PAGE = { locale: "en", path: "/pricing" } as const;

test("a template-driven entry renders through its template component", async () => {
  const { html } = await renderPage({
    page: PRICING_PAGE,
    template: "PricingPage",
    props: { title: "Pricing", fields: { intro: "Two plans. No seat maths." } },
    registry: PRICING_REGISTRY,
  });

  expect(html).toBe(
    '<main class="pricing"><h1>Pricing</h1><p>Two plans. No seat maths.</p></main>',
  );
});

test("a template the registry does not hold fails naming it and the entry", async () => {
  await expect(
    renderPage({
      page: PRICING_PAGE,
      template: "DocsPage",
      registry: PRICING_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RegistryError(
      'Component "DocsPage": not registered, and entry /en/pricing references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
    ),
  );
});

function deepEntryTree(levels: number): EntryNode[] {
  let node: EntryNode = { component: "Leaf" };
  for (let at = 1; at < levels; at += 1) {
    node = { component: "Link", children: [node] };
  }
  return [node];
}

function Link({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}

function Leaf() {
  return <span />;
}

const CHAIN_REGISTRY = {
  Link: component(Link),
  Leaf: component(Leaf),
} satisfies ComponentRegistry;

test("an entry tree deep enough to overflow the stack fails the build instead", async () => {
  // Without the check this render overflowed between 2,000 and 6,400 levels, run to run,
  // so 20,000 is past every depth it survived.
  await expect(
    renderPage({
      page: PAGE,
      tree: deepEntryTree(20_000),
      registry: CHAIN_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Entry /en/home: the component tree nests more than 64 levels deep at "Link" — flatten the entry\'s tree',
    ),
  );
});

test("a tree at the depth limit still renders", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: deepEntryTree(64),
    registry: CHAIN_REGISTRY,
  });

  expect(html.split("<div>").length - 1).toBe(63);
  expect(html).toContain("<span></span>");
});

test("a tree one level past the depth limit does not", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: deepEntryTree(65),
      registry: CHAIN_REGISTRY,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Entry /en/home: the component tree nests more than 64 levels deep at "Leaf" — flatten the entry\'s tree',
    ),
  );
});

test("a provider delivering a store the framework did not mint refuses the render", async () => {
  const shared = { get: () => 0, set: () => undefined, sub: () => () => {} };
  const foreign = { get: () => 1, set: () => undefined, sub: () => () => {} };
  const Delivering = ({ children }: { children?: ReactNode }) => children;
  const Own = ({ children }: { children?: ReactNode }) => children;
  const key = Symbol.for("fw.shared-store");
  const before = (globalThis as Record<symbol, unknown>)[key];
  (globalThis as Record<symbol, unknown>)[key] = {
    store: shared,
    provider: Delivering,
    hydrated: new Set(),
    mounted: false,
  };
  const stack = (component: unknown, store: unknown): RootProvider[] =>
    [{ component, props: { store } }] as unknown as RootProvider[];
  try {
    await expect(
      renderPage({
        page: PAGE,
        tree: fixtureTree("en", "home"),
        registry: SITE_REGISTRY,
        providers: stack(Delivering, shared),
      }),
    ).resolves.toBeDefined();

    await expect(
      renderPage({
        page: PAGE,
        tree: fixtureTree("en", "home"),
        registry: SITE_REGISTRY,
        providers: stack(Own, foreign),
      }),
    ).resolves.toBeDefined();

    const failure = await renderPage({
      page: PAGE,
      tree: fixtureTree("en", "home"),
      registry: SITE_REGISTRY,
      providers: stack(Delivering, foreign),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreError);
    expect((failure as Error).message).toBe(
      [
        `Shared store: 1 provider delivers a store this framework did not mint, so two island roots resolve the same atoms on two stores and neither sees the other's writes — pass the one instance "@pagedeck/islands/store" exports, and call createStore() nowhere in site code; islands are separate React roots, so one store object reached through one module is the only thing that carries state between them, and a build, a dev server and a preview app refuse this where a shipped page only reports it, because the build's chunk-graph assertion is the gate and a canary must not take a visitor's page away:`,
        `  stack[0].props.store`,
      ].join("\n"),
    );
  } finally {
    if (before === undefined) delete (globalThis as Record<symbol, unknown>)[key];
    else (globalThis as Record<symbol, unknown>)[key] = before;
  }
});

function Labelled({ text }: { text: string }) {
  const id = useId();
  return <span id={id}>{text}</span>;
}

const CHROME_REGISTRY = {
  Icon: component(Icon),
  Counter: component(Counter),
  Labelled: component(Labelled),
} satisfies ComponentRegistry;

const FRAMED_TREE: readonly EntryNode[] = [
  { component: "Labelled", props: { text: "page" } },
  { component: "Counter", props: { label: "Page" } },
];

test("chrome renders in regions of its own and leaves the page's bytes as they were", async () => {
  const alone = await renderPage({
    page: PAGE,
    tree: FRAMED_TREE,
    registry: CHROME_REGISTRY,
    modules: COUNTER_IS_CLIENT,
  });
  const framed = await renderPage({
    page: PAGE,
    tree: FRAMED_TREE,
    registry: CHROME_REGISTRY,
    modules: COUNTER_IS_CLIENT,
    chrome: {
      before: [
        { component: "Labelled", props: { text: "chrome" } },
        { component: "Counter", props: { label: "Chrome" } },
      ],
      after: [{ component: "Icon", props: { name: "foot" } }],
    },
  });

  expect(framed.html).toBe(alone.html);
  expect(alone.chrome).toBeUndefined();
  expect(framed.chrome?.after).toBe('<i class="icon icon--foot"></i>');

  expect(framed.islands.map((island) => island.component)).toEqual([
    "Counter",
    "Counter",
  ]);
  expect(framed.islands[0]).toEqual(alone.islands[0]);
  expect(framed.chrome?.before).toContain(
    `data-fw-prefix="${(framed.islands[1] as RenderedIsland).prefix}"`,
  );

  const ids = [
    ...`${framed.chrome?.before ?? ""}${framed.html}`.matchAll(/id="([^"]+)"/g),
  ].map((match) => match[1]);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
});

test("a chrome that declares no nodes renders as no chrome", async () => {
  const framed = await renderPage({
    page: PAGE,
    tree: FRAMED_TREE,
    registry: CHROME_REGISTRY,
    modules: COUNTER_IS_CLIENT,
    chrome: { before: [], after: [] },
  });

  expect(framed.chrome).toBeUndefined();
});

test("a chrome's hoisted <title> is absorbed like a page's", async () => {
  function Titled() {
    return <title>Chrome title</title>;
  }
  const { absorbed, chrome } = await renderPage({
    page: PAGE,
    tree: [{ component: "Icon", props: { name: "x" } }],
    registry: {
      Icon: component(Icon),
      Titled: component(Titled),
    },
    chrome: { before: [{ component: "Titled" }] },
  });

  expect(absorbed.map((one) => one.tag)).toEqual(["<title>Chrome title</title>"]);
  expect(chrome?.before).toBe("");
});

test("a refused prop on a chrome node names build.chrome, not the entry", async () => {
  const rendered = renderPage({
    page: PAGE,
    tree: FRAMED_TREE,
    registry: CHROME_REGISTRY,
    modules: COUNTER_IS_CLIENT,
    chrome: {
      before: [
        { component: "Icon", props: { name: "x", dangerouslySetInnerHTML: { __html: "" } } },
      ],
    },
  });

  await expect(rendered).rejects.toThrow(
    /^Component "Icon": prop "dangerouslySetInnerHTML" is .*, and build\.chrome \(before <main>\) on entry \/en\/home renders it — /,
  );
});

test("an island in the chrome whose props do not serialize names build.chrome", async () => {
  const rendered = renderPage({
    page: PAGE,
    tree: FRAMED_TREE,
    registry: CHROME_REGISTRY,
    modules: COUNTER_IS_CLIENT,
    chrome: { after: [{ component: "Counter", props: { label: 1n } }] },
  });

  await expect(rendered).rejects.toThrow(
    'Component "Counter": its props do not serialize to JSON, and build.chrome (after <main>) on entry /en/home renders it as an island',
  );
});
