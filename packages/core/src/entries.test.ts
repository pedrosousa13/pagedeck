import { expect, test } from "vitest";
import { planEntries, renderEntryModule } from "./entries.js";
import type { PageDemand, PageEntry } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { Page } from "./pages.js";

function page(locale: string, path: `/${string}`, output: string): Page {
  return { locale, path, output, dependencies: [] };
}

function only(entries: readonly PageEntry[]): PageEntry {
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (entry === undefined) throw new Error("unreachable");
  return entry;
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("planEntries did not throw");
}

const MODULES = {
  Hero: "@ds/hero",
  NewsletterSignup: "@ds/newsletter-signup",
  Quote: "@ds/quote",
};

const TWO_ISLANDS: PageDemand = {
  page: page("en", "/", "/en"),
  islands: [
    { component: "NewsletterSignup", mode: "visible" },
    { component: "Hero", mode: "load" },
  ],
};

const CONTENT_ONLY: PageDemand = {
  page: page("en", "/pricing", "/en/pricing"),
  islands: [],
};

test("a page with two islands yields an entry importing exactly those two", () => {
  const plan = planEntries([TWO_ISLANDS], { modules: MODULES });

  expect(only(plan.entries).components).toEqual([
    { name: "Hero", module: "@ds/hero", eager: true },
    { name: "NewsletterSignup", module: "@ds/newsletter-signup", eager: false },
  ]);
});

test("the generated module text is the golden shape", () => {
  const plan = planEntries([TWO_ISLANDS], { modules: MODULES });

  expect(renderEntryModule(only(plan.entries))).toBe(
    [
      `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `hydrateIslands({`,
      `  resolve: (name) => modules[name]().then((module) => module.default),`,
      `});`,
      "",
    ].join("\n"),
  );
});

test("the dev server's hot entry keeps the module map and guards the hydrate", () => {
  const plan = planEntries([TWO_ISLANDS], {
    modules: MODULES,
    providers: "@site/providers",
  });

  expect(renderEntryModule(only(plan.entries), { hot: true })).toBe(
    [
      `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
      `import { hotIslands } from "@pagedeck/islands/hmr";`,
      `import providers from "@site/providers";`,
      `import { checkSharedStore, markRootsMounting } from "@pagedeck/islands/store-stamp";`,
      `import { rootProviderProbe } from "@pagedeck/islands/root-provider-probe";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `const hot = hotIslands(import.meta.hot, modules);`,
      `if (!hot.hydrated) {`,
      `  checkSharedStore(providers, import.meta.env.PROD);`,
      `  markRootsMounting();`,
      `  hydrateIslands({`,
      `    resolve: hot.resolve,`,
      `    providers,`,
      `    probe: rootProviderProbe(),`,
      `  });`,
      `}`,
      `import.meta.hot.accept();`,
      "",
    ].join("\n"),
  );
});

test("a provider stack adds one import and one property", () => {
  const plan = planEntries([TWO_ISLANDS], {
    modules: MODULES,
    providers: "@site/providers",
  });

  expect(renderEntryModule(only(plan.entries))).toBe(
    [
      `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
      `import providers from "@site/providers";`,
      `import { checkSharedStore, markRootsMounting } from "@pagedeck/islands/store-stamp";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `checkSharedStore(providers, import.meta.env.PROD);`,
      `markRootsMounting();`,
      `hydrateIslands({`,
      `  resolve: (name) => modules[name]().then((module) => module.default),`,
      `  providers,`,
      `});`,
      "",
    ].join("\n"),
  );
});

test("a declared stack's digest is carried into the entry as a literal", () => {
  const plan = planEntries([TWO_ISLANDS], {
    modules: MODULES,
    providers: "@site/providers",
    providersDigest: "stack[0] store=object",
  });

  expect(renderEntryModule(only(plan.entries))).toBe(
    [
      `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
      `import providers from "@site/providers";`,
      `import { checkRootProviders } from "@pagedeck/islands/root-provider-check";`,
      `import { checkSharedStore, markRootsMounting } from "@pagedeck/islands/store-stamp";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `checkRootProviders(providers, "stack[0] store=object");`,
      `checkSharedStore(providers, import.meta.env.PROD);`,
      `markRootsMounting();`,
      `hydrateIslands({`,
      `  resolve: (name) => modules[name]().then((module) => module.default),`,
      `  providers,`,
      `});`,
      "",
    ].join("\n"),
  );
});

test("the criterion-4 probe is the dev server's alone", () => {
  const plan = planEntries([TWO_ISLANDS], {
    modules: MODULES,
    providers: "@site/providers",
    providersDigest: "stack[0] store=object",
  });

  expect(renderEntryModule(only(plan.entries))).not.toContain(
    "root-provider-probe",
  );
  expect(renderEntryModule(only(plan.entries), { hot: true })).toBe(
    [
      `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
      `import { hotIslands } from "@pagedeck/islands/hmr";`,
      `import providers from "@site/providers";`,
      `import { checkRootProviders } from "@pagedeck/islands/root-provider-check";`,
      `import { checkSharedStore, markRootsMounting } from "@pagedeck/islands/store-stamp";`,
      `import { rootProviderProbe } from "@pagedeck/islands/root-provider-probe";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `const hot = hotIslands(import.meta.hot, modules);`,
      `if (!hot.hydrated) {`,
      `  checkRootProviders(providers, "stack[0] store=object");`,
      `  checkSharedStore(providers, import.meta.env.PROD);`,
      `  markRootsMounting();`,
      `  hydrateIslands({`,
      `    resolve: hot.resolve,`,
      `    providers,`,
      `    probe: rootProviderProbe(),`,
      `  });`,
      `}`,
      `import.meta.hot.accept();`,
      "",
    ].join("\n"),
  );
});

const ALL_DEFERRED: PageDemand = {
  page: page("en", "/", "/en"),
  islands: [
    { component: "NewsletterSignup", mode: "visible" },
    { component: "Hero", mode: "idle" },
  ],
};

test("a page with no load island imports only the startup module, and the runtime on a trigger", () => {
  const plan = planEntries([ALL_DEFERRED], { modules: MODULES });

  expect(renderEntryModule(only(plan.entries))).toBe(
    [
      `import { hydrateOnTrigger } from "@pagedeck/islands/startup";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `hydrateOnTrigger(async (schedule) => {`,
      `  const [{ hydrateIslands }] = await Promise.all([`,
      `    import("@pagedeck/islands/runtime"),`,
      `  ]);`,
      `  hydrateIslands({`,
      `    resolve: (name) => modules[name]().then((module) => module.default),`,
      `    schedule,`,
      `  });`,
      `});`,
      "",
    ].join("\n"),
  );
});

test("a page with no load island imports its provider stack and its checks on the trigger too", () => {
  const plan = planEntries([ALL_DEFERRED], {
    modules: MODULES,
    providers: "@site/providers",
    providersDigest: "stack[0] store=object",
  });

  expect(renderEntryModule(only(plan.entries))).toBe(
    [
      `import { hydrateOnTrigger } from "@pagedeck/islands/startup";`,
      `const modules = {`,
      `  "Hero": () => import("@ds/hero"),`,
      `  "NewsletterSignup": () => import("@ds/newsletter-signup"),`,
      `};`,
      `hydrateOnTrigger(async (schedule) => {`,
      `  const [{ hydrateIslands }, { default: providers }, { checkRootProviders }, { checkSharedStore, markRootsMounting }] = await Promise.all([`,
      `    import("@pagedeck/islands/runtime"),`,
      `    import("@site/providers"),`,
      `    import("@pagedeck/islands/root-provider-check"),`,
      `    import("@pagedeck/islands/store-stamp"),`,
      `  ]);`,
      `  checkRootProviders(providers, "stack[0] store=object");`,
      `  checkSharedStore(providers, import.meta.env.PROD);`,
      `  markRootsMounting();`,
      `  hydrateIslands({`,
      `    resolve: (name) => modules[name]().then((module) => module.default),`,
      `    schedule,`,
      `    providers,`,
      `  });`,
      `});`,
      "",
    ].join("\n"),
  );
});

test("a global stylesheet is imported at startup beside a load island, and on the trigger without one", () => {
  const eager = only(planEntries([TWO_ISLANDS], { modules: MODULES }).entries);
  const deferred = only(
    planEntries([ALL_DEFERRED], { modules: MODULES }).entries,
  );
  const globalCss = ["/site/global.css"];

  expect(
    renderEntryModule(eager, { globalCss }).split("\n").slice(0, 2),
  ).toEqual([
    `import "/site/global.css";`,
    `import { hydrateIslands } from "@pagedeck/islands/runtime";`,
  ]);
  const text = renderEntryModule(deferred, { globalCss });
  expect(text).not.toContain(`import "/site/global.css";`);
  expect(text).toContain(
    [
      `    import("@pagedeck/islands/runtime"),`,
      `    import("/site/global.css"),`,
      `  ]);`,
    ].join("\n"),
  );
});

test("the dev server's hot entry loads the runtime at startup whatever the modes", () => {
  const plan = planEntries([ALL_DEFERRED], { modules: MODULES });

  const text = renderEntryModule(only(plan.entries), { hot: true });

  expect(text).toContain(`import { hydrateIslands } from "@pagedeck/islands/runtime";`);
  expect(text).not.toContain("hydrateOnTrigger");
});

test("a site with no stack writes neither the check nor the probe", () => {
  const plan = planEntries([TWO_ISLANDS], { modules: MODULES });

  for (const hot of [false, true]) {
    const text = renderEntryModule(only(plan.entries), { hot });
    expect(text).not.toContain("root-provider-check");
    expect(text).not.toContain("root-provider-probe");
    expect(text).not.toContain("checkRootProviders");
  }
});

test("a content-only page yields no entry and is recorded instead", () => {
  const plan = planEntries([TWO_ISLANDS, CONTENT_ONLY], { modules: MODULES });

  expect(plan.entries.map((entry) => entry.path)).toEqual(["/"]);
  expect(plan.contentOnly).toEqual([{ locale: "en", path: "/pricing" }]);
});

test("the same demands plan byte-identical entries, in any instance order", () => {
  const reversed: PageDemand = {
    ...TWO_ISLANDS,
    islands: [...TWO_ISLANDS.islands].reverse(),
  };

  const once = planEntries([TWO_ISLANDS, CONTENT_ONLY], { modules: MODULES });
  const twice = planEntries([CONTENT_ONLY, reversed], { modules: MODULES });

  expect(twice).toEqual(once);
  expect(twice.entries.map((entry) => renderEntryModule(entry))).toEqual(
    once.entries.map((entry) => renderEntryModule(entry)),
  );
});

test("a carried demand plans the entry its rendered demand planned", () => {
  const rendered = planEntries([TWO_ISLANDS], { modules: MODULES });
  const carried = planEntries(
    [
      {
        page: TWO_ISLANDS.page,
        carried: only(rendered.entries).components.map(({ name, eager }) => ({
          name,
          eager,
        })),
      },
    ],
    { modules: MODULES },
  );

  expect(carried).toEqual(rendered);
  expect(carried.entries.map((entry) => renderEntryModule(entry))).toEqual(
    rendered.entries.map((entry) => renderEntryModule(entry)),
  );
});

test("a carried page with no component is content-only, like a render with no island", () => {
  const plan = planEntries([{ page: CONTENT_ONLY.page, carried: [] }], {
    modules: MODULES,
  });

  expect(plan.entries).toEqual([]);
  expect(plan.contentOnly).toEqual([{ locale: "en", path: "/pricing" }]);
});

test("a carried component the module map dropped is refused like a rendered one", () => {
  const failure = refusal(() =>
    planEntries(
      [{ page: page("en", "/", "/en"), carried: [{ name: "Hero", eager: true }] }],
      { modules: { Quote: "@ds/quote" } },
    ),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Entry modules: 1 component has no module to import — pass its specifier in planEntries' modules option, or drop it from the pages that use it:",
      `  "Hero" — used by /en`,
    ].join("\n"),
  );
});

test("every component with no module is reported, with every page that uses it", () => {
  const demands: PageDemand[] = [
    {
      page: page("en", "/home", "/en/home"),
      islands: [
        { component: "Hero", mode: "load" },
        { component: "Quote", mode: "idle" },
      ],
    },
    {
      page: page("en", "/pricing", "/en/pricing"),
      islands: [{ component: "Hero", mode: "visible" }],
    },
    {
      page: page("de", "/home", "/de/home"),
      islands: [{ component: "Hero", mode: "visible" }],
    },
  ];

  const thrown = refusal(() =>
    planEntries(demands, { modules: { NewsletterSignup: "@ds/newsletter" } }),
  );

  expect(thrown).toBeInstanceOf(ConfigError);
  expect(thrown.message).toBe(
    [
      "Entry modules: 2 components have no module to import — pass each one's specifier in planEntries' modules option, or drop it from the pages that use it:",
      `  "Hero" — used by /en/home, /en/pricing, /de/home`,
      `  "Quote" — used by /en/home`,
    ].join("\n"),
  );
});

test("one missing component reads as one", () => {
  const thrown = refusal(() =>
    planEntries([TWO_ISLANDS], { modules: { Hero: "@ds/hero" } }),
  );

  expect(thrown.message).toBe(
    [
      "Entry modules: 1 component has no module to import — pass its specifier in planEntries' modules option, or drop it from the pages that use it:",
      `  "NewsletterSignup" — used by /en`,
    ].join("\n"),
  );
});

test("a component named for an Object prototype key is a missing module, not an inherited one", () => {
  const thrown = refusal(() =>
    planEntries(
      [
        {
          page: page("en", "/", "/en"),
          islands: [{ component: "constructor", mode: "load" }],
        },
      ],
      { modules: MODULES },
    ),
  );

  expect(thrown).toBeInstanceOf(ConfigError);
  expect(thrown.message).toBe(
    [
      "Entry modules: 1 component has no module to import — pass its specifier in planEntries' modules option, or drop it from the pages that use it:",
      `  "constructor" — used by /en`,
    ].join("\n"),
  );
});

function islanded(
  target: Page,
  ...components: readonly string[]
): PageDemand {
  return {
    page: target,
    islands: components.map((component) => ({
      component,
      mode: "visible" as const,
    })),
  };
}

function entryOf(
  plan: { entries: readonly PageEntry[] },
  locale: string,
  path: string,
): PageEntry {
  const found = plan.entries.find(
    (entry) => entry.locale === locale && entry.path === path,
  );
  if (found === undefined) throw new Error(`no entry for ${locale} ${path}`);
  return found;
}

test("pages whose entry text is identical share one name and one id", () => {
  const onDomain: Page = {
    locale: "de",
    path: "/",
    output: "/",
    domain: "shop.example",
    dependencies: [],
  };
  const plan = planEntries(
    [
      islanded(page("en", "/", "/en"), "Hero"),
      islanded(page("en", "/pricing", "/en/pricing"), "Hero"),
      islanded(onDomain, "Hero"),
    ],
    { modules: MODULES },
  );

  expect(plan.entries.map((entry) => `${entry.locale} ${entry.path}`)).toEqual(
    ["de /", "en /", "en /pricing"],
  );
  expect(new Set(plan.entries.map((entry) => entry.name)).size).toBe(1);
  expect(new Set(plan.entries.map((entry) => entry.id)).size).toBe(1);
  const [first] = plan.entries;
  expect(first?.name).toMatch(/^entry-[0-9a-f]{16}$/);
  expect(first?.id).toBe(`\0fw:entry/${first?.name ?? ""}`);
});

test("a shared entry's name and id do not depend on which pages use it", () => {
  const alone = planEntries([islanded(page("en", "/", "/en"), "Hero")], {
    modules: MODULES,
  });
  const elsewhere = planEntries(
    [
      islanded(page("fr", "/a/b", "/fr/a/b"), "Hero"),
      islanded(page("en", "/", "/en"), "Hero", "Quote"),
    ],
    { modules: MODULES },
  );
  const crowded = planEntries(
    [
      islanded(page("en", "/", "/en"), "Hero"),
      islanded(page("en", "/blog", "/en/blog"), "Quote"),
      islanded(page("en", "/docs", "/en/docs"), "Hero", "NewsletterSignup"),
    ],
    { modules: MODULES },
  );

  const hero = only(alone.entries);
  for (const entry of [
    entryOf(elsewhere, "fr", "/a/b"),
    entryOf(crowded, "en", "/"),
  ]) {
    expect(entry.name).toBe(hero.name);
    expect(entry.id).toBe(hero.id);
  }
});

test("two pages whose island sets differ by one component get two entries", () => {
  const plan = planEntries(
    [
      islanded(page("en", "/", "/en"), "Hero"),
      islanded(page("en", "/blog", "/en/blog"), "Hero", "Quote"),
    ],
    { modules: MODULES },
  );

  const home = entryOf(plan, "en", "/");
  const blog = entryOf(plan, "en", "/blog");
  expect(home.name).not.toBe(blog.name);
  expect(home.id).not.toBe(blog.id);
  expect(home.components.map((component) => component.name)).toEqual(["Hero"]);
  expect(blog.components.map((component) => component.name)).toEqual([
    "Hero",
    "Quote",
  ]);
});

test("the name keys on the entry text, so a difference the text does not carry shares", () => {
  const plan = planEntries(
    [
      {
        page: page("en", "/", "/en"),
        islands: [
          { component: "Hero", mode: "load" },
          { component: "Quote", mode: "visible" },
        ],
      },
      {
        page: page("en", "/blog", "/en/blog"),
        islands: [
          { component: "Hero", mode: "visible" },
          { component: "Quote", mode: "load" },
        ],
      },
    ],
    { modules: MODULES },
  );

  const home = entryOf(plan, "en", "/");
  const blog = entryOf(plan, "en", "/blog");
  expect(renderEntryModule(home)).toBe(renderEntryModule(blog));
  expect(home.name).toBe(blog.name);
  expect(home.components[0]?.eager).toBe(true);
  expect(blog.components[0]?.eager).toBe(false);
});

test("a page with no load island names a different entry from one with a load island", () => {
  const plan = planEntries(
    [
      {
        page: page("en", "/", "/en"),
        islands: [{ component: "Hero", mode: "load" }],
      },
      {
        page: page("en", "/blog", "/en/blog"),
        islands: [{ component: "Hero", mode: "visible" }],
      },
    ],
    { modules: MODULES },
  );

  expect(entryOf(plan, "en", "/").name).not.toBe(
    entryOf(plan, "en", "/blog").name,
  );
});

test("a difference the text does carry names a different entry", () => {
  const demand = islanded(page("en", "/", "/en"), "Hero");
  const plain = only(planEntries([demand], { modules: MODULES }).entries);
  const moved = only(
    planEntries([demand], { modules: { ...MODULES, Hero: "@ds/hero-v2" } })
      .entries,
  );
  const digested = only(
    planEntries([demand], {
      modules: MODULES,
      providers: "@site/providers",
      providersDigest: "stack[0] store=object",
    }).entries,
  );
  const redigested = only(
    planEntries([demand], {
      modules: MODULES,
      providers: "@site/providers",
      providersDigest: "stack[0] store=string",
    }).entries,
  );

  expect(
    new Set([plain.name, moved.name, digested.name, redigested.name]).size,
  ).toBe(4);
});

test("two pages whose outputs once spelled one entry name now plan without a refusal", () => {
  const differing = planEntries(
    [
      islanded(page("en", "/", "/"), "Hero"),
      islanded(page("en", "/index", "/index"), "Quote"),
    ],
    { modules: MODULES },
  );
  expect(entryOf(differing, "en", "/").name).not.toBe(
    entryOf(differing, "en", "/index").name,
  );

  const same = planEntries(
    [
      islanded(page("en", "/", "/"), "Hero"),
      islanded(page("en", "/index", "/index"), "Hero"),
    ],
    { modules: MODULES },
  );
  expect(entryOf(same, "en", "/").name).toBe(entryOf(same, "en", "/index").name);
});
