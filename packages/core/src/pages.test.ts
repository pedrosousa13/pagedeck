import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  PRICING_PAGE_USAGE,
  SITE_FIXTURES,
  loadFixtureStore,
} from "@pagedeck/fixtures";
import type { FixturePage } from "@pagedeck/fixtures";
import { defineCollection, listEntries, openStore } from "@pagedeck/content";
import type {
  Collection,
  ContentStore,
  ContentStoreReader,
  Entry,
} from "@pagedeck/content";
import {
  canonicalizePath,
  collectPages,
  definePages,
  fromCollection,
  fromTemplate,
  normalizeOutputPath,
  normalizeOutputPrefix,
  paginate,
  segments,
} from "./pages.js";
import type {
  Page,
  PagedRoute,
  PageSet,
  PageSource,
  ParamsOf,
  Route,
} from "./pages.js";
import { localeAlternates } from "./alternates.js";
import { defineLocales } from "./locales.js";
import { ConfigError } from "./exit.js";

const TWO_FOLDER_LOCALES = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr" },
});

const openStores: { close(): void }[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const inertLoader = {
  syncAll: () => ({ changed: [], deleted: [], cursor: 0 }),
  syncSince: () => ({ changed: [], deleted: [], cursor: 0 }),
};

function emptySite(): ContentStore {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-pages-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "content.db"));
  openStores.push(store);
  return store;
}

function collectionIn(
  store: ContentStore,
  collectionName: string,
  entries: readonly { locale: string; path: string }[],
): Collection<{ title: string }> {
  for (const entry of entries) {
    store.upsertEntry({
      collection: collectionName,
      locale: entry.locale,
      path: entry.path,
      data: { title: entry.path },
    });
  }
  return defineCollection<{ title: string }>({
    name: collectionName,
    loader: inertLoader,
    schema: false,
  });
}

function siteWith(
  collectionName: string,
  entries: readonly { locale: string; path: string }[],
): { store: ContentStore; collection: Collection<{ title: string }> } {
  const store = emptySite();
  return { store, collection: collectionIn(store, collectionName, entries) };
}

function failureOf(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to fail, but it returned");
}

async function fixtureSite(): Promise<{
  store: ContentStore;
  collection: Collection<FixturePage>;
}> {
  const fixture = await loadFixtureStore<FixturePage>({
    directory: SITE_FIXTURES,
  });
  openStores.push(fixture);
  return { store: fixture.store, collection: fixture.collection };
}

test("the fixture site yields one route per entry, across both locales", async () => {
  const { store, collection } = await fixtureSite();

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)).toEqual([
    {
      locale: "de",
      path: "/home",
      output: "/de/home",
      collection: "pages",
      entry: { locale: "de", path: "home" },
      dependencies: [{ collection: "pages", locale: "de", path: "home" }],
    },
    {
      locale: "de",
      path: "/pricing",
      output: "/de/pricing",
      collection: "pages",
      entry: { locale: "de", path: "pricing" },
      dependencies: [{ collection: "pages", locale: "de", path: "pricing" }],
    },
    {
      locale: "en",
      path: "/home",
      output: "/en/home",
      collection: "pages",
      entry: { locale: "en", path: "home" },
      dependencies: [{ collection: "pages", locale: "en", path: "home" }],
    },
    {
      locale: "en",
      path: "/pricing",
      output: "/en/pricing",
      collection: "pages",
      entry: { locale: "en", path: "pricing" },
      dependencies: [{ collection: "pages", locale: "en", path: "pricing" }],
    },
  ]);
});

function templateDriven(
  collection: Collection<FixturePage>,
): Collection<FixturePage> {
  return defineCollection<FixturePage>({
    name: collection.name,
    loader: collection.loader,
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { PricingPage: PRICING_PAGE_USAGE },
    },
    schema: false,
  });
}

test("both page modes route side by side, and only one carries a template", async () => {
  const { store, collection } = await fixtureSite();

  const pages = definePages({
    sources: [
      fromCollection(templateDriven(collection), {
        route: (entry) => `/${entry.path}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(
    collectPages(store, pages).map((page) => [page.path, page.template]),
  ).toEqual([
    ["/home", undefined],
    ["/pricing", "PricingPage"],
    ["/home", undefined],
    ["/pricing", "PricingPage"],
  ]);
});

test("a nested entry path routes at its segments when no route is written", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "legal/terms" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/legal/terms",
  ]);
});

test("an entry at path index routes at the root when no route is written", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "index" },
    { locale: "en", path: "about" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/",
    "/about",
  ]);
});

test("a nested index routes at its directory when no route is written", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "docs/index" },
    { locale: "en", path: "docs/install" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/docs",
    "/docs/install",
  ]);
});

test("an entry and the nested index of the directory it names collide", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "docs" },
    { locale: "en", path: "docs/index" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/docs" in locale "en" — sources[0] "pages" /en/docs',
      '  "/docs" in locale "en" — sources[0] "pages" /en/docs/index',
    ].join("\n"),
  );
});

test("a declared route decides an index entry's route, and the index rule never runs", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "index" },
    { locale: "en", path: "docs/index" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: (entry) => `/${entry.path}` })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/docs/index",
    "/index",
  ]);
});

test("an explicit route still decides, and the default never runs beside it", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "legal/terms" },
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "home" ? "/" : segments(entry.path)),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/",
    "/legal/terms",
  ]);
});

test("the default route reaches a dependsOn written beside no route at all", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "legal/terms" },
    { locale: "en", path: "pricing" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        dependsOn: () => [{ collection: "pages", locale: "en", path: "nav" }],
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(
    collectPages(store, pages).map((page) => [page.path, page.dependencies]),
  ).toEqual([
    [
      "/legal/terms",
      [
        { collection: "pages", locale: "en", path: "legal/terms" },
        { collection: "pages", locale: "en", path: "nav" },
      ],
    ],
    [
      "/pricing",
      [
        { collection: "pages", locale: "en", path: "pricing" },
        { collection: "pages", locale: "en", path: "nav" },
      ],
    ],
  ]);
});

test("relatesTo lands on the page's relations and dependsOn on its dependencies", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: () => "/",
        dependsOn: () => [{ collection: "pages", locale: "en", path: "nav" }],
        relatesTo: () => [
          { collection: "pages", locale: "en", path: "pricing" },
        ],
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const [page] = collectPages(store, pages);
  expect(page?.dependencies).toEqual([
    { collection: "pages", locale: "en", path: "home" },
    { collection: "pages", locale: "en", path: "nav" },
  ]);
  expect(page?.relations).toEqual([
    { collection: "pages", locale: "en", path: "pricing" },
  ]);
});

test("a repeated relation is kept once, at its first occurrence", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: () => "/",
        relatesTo: () => [
          { collection: "pages", locale: "en", path: "pricing" },
          { collection: "pages", locale: "en", path: "about" },
          { collection: "pages", locale: "en", path: "pricing" },
        ],
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)[0]?.relations).toEqual([
    { collection: "pages", locale: "en", path: "pricing" },
    { collection: "pages", locale: "en", path: "about" },
  ]);
});

test("a source declaring no relatesTo puts no relations on its pages", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)[0]?.relations).toBeUndefined();
});

test("an entry path naming nothing fails the build rather than routing at /", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "" },
    { locale: "en", path: "/" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 2 routes are not usable paths — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/ — the route is empty',
      '  sources[0] "pages" /en// — the route is empty',
    ].join("\n"),
  );
});

test("a page set declaring no locales has one, en, written left to right", () => {
  const pages = definePages({ sources: [] });

  expect([...pages.locales.values()]).toEqual([
    { code: "en", label: "English", direction: "ltr", prefix: "" },
  ]);
});

test("declared locales win over the default, which adds none beside them", () => {
  const pages = definePages({ sources: [], locales: TWO_FOLDER_LOCALES });

  expect(pages.locales).toBe(TWO_FOLDER_LOCALES);
});

test('a page set declaring no trailingSlash spells its routes "never"', () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "docs/guide" },
  ]);

  const pages = definePages({ sources: [fromCollection(collection)] });

  expect(pages.trailingSlash).toBe("never");
  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/docs/guide",
  ]);
});

test("a declared trailingSlash wins over the default", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "docs/guide" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection)],
    trailingSlash: "always",
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/docs/guide/",
  ]);
});

test("segments splits on the separator alone, minting no empty segment", () => {
  expect(segments("legal/terms")).toEqual(["legal", "terms"]);
  expect(segments("/a")).toEqual(["a"]);
  expect(segments("a/")).toEqual(["a"]);
  expect(segments("a//b")).toEqual(["a", "b"]);
});

test("an empty path and a lone separator both split to no segments", () => {
  expect(segments("")).toEqual([]);
  expect(segments("/")).toEqual([]);
});

test("segments decodes nothing, so an escaped slash stays inside its segment", () => {
  expect(segments("legal/privacy%2Fcookies")).toEqual([
    "legal",
    "privacy%2Fcookies",
  ]);
});

const ROUTE_SHAPES = [
  { locale: "en", path: "root" },
  { locale: "en", path: "bare" },
  { locale: "en", path: "slashed" },
  { locale: "en", path: "doubled" },
] as const;

const ROUTE_OF: Record<string, string> = {
  root: "/",
  bare: "pricing",
  slashed: "/docs/guide/",
  doubled: "//a//b",
};

test('trailingSlash "never" strips every emitted route, and leaves the root as "/"', () => {
  const { store, collection } = siteWith("pages", ROUTE_SHAPES);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => ROUTE_OF[entry.path] }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/",
    "/a/b",
    "/docs/guide",
    "/pricing",
  ]);
});

test('trailingSlash "always" appends to every emitted route, and leaves the root as "/"', () => {
  const { store, collection } = siteWith("pages", ROUTE_SHAPES);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => ROUTE_OF[entry.path] }),
    ],
    trailingSlash: "always",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/",
    "/a/b/",
    "/docs/guide/",
    "/pricing/",
  ]);
});

test("a route of undefined emits no page, so a source can hold entries that are not pages", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "fragment" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) =>
          entry.path === "fragment" ? undefined : `/${entry.path}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/home",
  ]);
});

test("a source that reads no store emits pages with no entry behind them", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      {
        instances: () =>
          ["pricing", "about"].map((slug) => ({
            locale: "en",
            params: { slug },
            dependencies: [],
          })),
        route: (instance) => `/${instance.params.slug}`,
      },
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)).toEqual([
    { locale: "en", path: "/about", output: "/en/about", dependencies: [] },
    { locale: "en", path: "/pricing", output: "/en/pricing", dependencies: [] },
  ]);
});

test("dependencies lead with the page's own entry, then dependsOn's refs, deduped", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path}`,
        dependsOn: (entry) => [
          { collection: "globals", locale: entry.locale, path: "nav" },
          { collection: "pages", locale: "en", path: "home" },
          { collection: "globals", locale: entry.locale, path: "nav" },
          { collection: "globals", locale: entry.locale, path: "footer" },
        ],
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)[0]?.dependencies).toEqual([
    { collection: "pages", locale: "en", path: "home" },
    { collection: "globals", locale: "en", path: "nav" },
    { collection: "globals", locale: "en", path: "footer" },
  ]);
});

test("dependsOn is handed the store, so a page can depend on entries it does not render", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "pricing" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path}`,
        dependsOn: (_entry, dependsOnStore) =>
          listEntries(dependsOnStore, collection).map((other) => ({
            collection: other.collection,
            locale: other.locale,
            path: other.path,
          })),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.dependencies)).toEqual([
    [
      { collection: "pages", locale: "en", path: "home" },
      { collection: "pages", locale: "en", path: "pricing" },
    ],
    [
      { collection: "pages", locale: "en", path: "pricing" },
      { collection: "pages", locale: "en", path: "home" },
    ],
  ]);
});

test("sharedDependsOn is evaluated once per instances call, and lands on every page", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "pricing" },
    { locale: "en", path: "about" },
  ]);

  let calls = 0;

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path}`,
        sharedDependsOn: (sharedStore) => {
          calls += 1;
          return listEntries(sharedStore, collection).map((other) => ({
            collection: other.collection,
            locale: other.locale,
            path: other.path,
          }));
        },
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const collected = collectPages(store, pages);

  expect(calls).toBe(1);
  expect(collected.map((page) => page.dependencies)).toEqual([
    [
      { collection: "pages", locale: "en", path: "about" },
      { collection: "pages", locale: "en", path: "home" },
      { collection: "pages", locale: "en", path: "pricing" },
    ],
    [
      { collection: "pages", locale: "en", path: "home" },
      { collection: "pages", locale: "en", path: "about" },
      { collection: "pages", locale: "en", path: "pricing" },
    ],
    [
      { collection: "pages", locale: "en", path: "pricing" },
      { collection: "pages", locale: "en", path: "about" },
      { collection: "pages", locale: "en", path: "home" },
    ],
  ]);
});

test("dependencies order the own entry, then dependsOn, then sharedDependsOn", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path}`,
        dependsOn: (entry) => [
          { collection: "globals", locale: entry.locale, path: "nav" },
          { collection: "pages", locale: "en", path: "home" },
        ],
        sharedDependsOn: () => [
          { collection: "pages", locale: "en", path: "home" },
          { collection: "globals", locale: "en", path: "footer" },
        ],
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages)[0]?.dependencies).toEqual([
    { collection: "pages", locale: "en", path: "home" },
    { collection: "globals", locale: "en", path: "nav" },
    { collection: "globals", locale: "en", path: "footer" },
  ]);
});

test("two entries claiming one (locale, path) fail the build, naming both entries", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "index" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/home" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).not.toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/home" in locale "en" — sources[0] "pages" /en/home',
      '  "/home" in locale "en" — sources[0] "pages" /en/index',
    ].join("\n"),
  );
});

test("every colliding route in a run is reported, not just the first", () => {
  const bothLocales = [
    { locale: "en", path: "home" },
    { locale: "de", path: "home" },
  ];
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", bothLocales);
  const postsCollection = collectionIn(store, "posts", bothLocales);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: (entry) => `/${entry.path}` }),
      fromCollection(postsCollection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 2 routes are each claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/home" in locale "de" — sources[0] "pages" /de/home',
      '  "/home" in locale "de" — sources[1] "posts" /de/home',
      '  "/home" in locale "en" — sources[0] "pages" /en/home',
      '  "/home" in locale "en" — sources[1] "posts" /en/home',
    ].join("\n"),
  );
});

test("two sources over one collection are told apart by their source index", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: () => "/home" }),
      fromCollection(collection, { route: () => "/home" }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/home" in locale "en" — sources[0] "pages" /en/home',
      '  "/home" in locale "en" — sources[1] "pages" /en/home',
    ].join("\n"),
  );
});

test("a claimant with no entry is named by position, and never by its route", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
      {
        instances: () => [
          { locale: "en", params: { slug: "away" }, dependencies: [] },
          { locale: "en", params: { slug: "home" }, dependencies: [] },
        ],
        route: (instance) => `/${instance.params.slug}`,
      },
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/home" in locale "en" — sources[0] "pages" /en/home',
      '  "/home" in locale "en" — sources[1] instances[1]',
    ].join("\n"),
  );
});

test("a claimant with no entry carries its locale only where the line lacks one", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      {
        instances: () => [
          { locale: "en", params: { slug: "" }, dependencies: [] },
          { locale: "fr", params: { slug: "bonjour" }, dependencies: [] },
        ],
        route: ({ params }) => (params.slug === "" ? "" : `/${params.slug}`),
      },
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] instances[0] in locale "en" — the route is empty',
      "",
      "Route table: 1 page is in a locale the site does not declare — declare the locale in defineLocales, or stop emitting the entry:",
      '  sources[0] instances[1] — locale "fr"',
    ].join("\n"),
  );
});

test("an empty route is a wiring fault, saying to return a path instead", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route is empty',
    ].join("\n"),
  );
});

test("a route carrying a query is a wiring fault, quoting the route up to the query", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/search?q=1" })],
    trailingSlash: "always",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a query or fragment: "/search?…"',
    ].join("\n"),
  );
});

test("a route carrying a fragment is a wiring fault, quoting the route up to the fragment", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/docs#top" })],
    trailingSlash: "always",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a query or fragment: "/docs#…"',
    ].join("\n"),
  );
});

test("a route's query never reaches the message, so a token in one cannot reach a CI log", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: () => "/preview?token=s3cret" }),
    ],
    trailingSlash: "always",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure.message).not.toContain("s3cret");
  expect(failure.message).toContain('"/preview?…"');
});

test("every unusable route in a run is reported, whichever kind it is", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "home" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "de", path: "hallo" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: () => "" }),
      fromCollection(postsCollection, { route: () => "/search?q=1" }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 2 routes are not usable paths — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route is empty',
      '  sources[1] "posts" /de/hallo — the route holds a query or fragment: "/search?…"',
    ].join("\n"),
  );
});

test("a wiring fault stops the run before any collision is reported", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "index" },
    { locale: "en", path: "broken" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "broken" ? "" : "/home"),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/broken — the route is empty',
    ].join("\n"),
  );
});

test("dot segments are removed, so two spellings of one URL collide", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "climbed" },
    { locale: "en", path: "plain" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "climbed" ? "/a/../b" : "/b"),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/b" in locale "en" — sources[0] "pages" /en/climbed',
      '  "/b" in locale "en" — sources[0] "pages" /en/plain',
    ].join("\n"),
  );
});

test("a dot segment resolves away, and a .. never climbs above the root", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "dot" },
    { locale: "en", path: "climb" },
  ]);
  const ROUTES: Record<string, string> = { dot: "/x/./", climb: "/../a" };

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => ROUTES[entry.path] }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/a",
    "/x",
  ]);
});

test("a route that resolves to the root stays the root under both policies", () => {
  const toTheRoot = ["/a/..", "/..", "/.", "/.././", "/a/b/../..", "/%2e"];

  for (const route of toTheRoot) {
    for (const trailingSlash of ["never", "always"] as const) {
      const { store, collection } = siteWith("pages", [
        { locale: "en", path: "home" },
      ]);
      const pages = definePages({
        sources: [fromCollection(collection, { route: () => route })],
        trailingSlash,
        locales: TWO_FOLDER_LOCALES,
      });
      expect(collectPages(store, pages).map((page) => page.path)).toEqual([
        "/",
      ]);
    }
  }
});

const RESOLVER_CASES = [
  "/a//../b",
  "/a/%2e%2e/b",
  "/a/%2E%2E/b",
  "/%2e/a",
  "/a/.%2e/b",
  "/caf%C3%A9",
  "/café",
  "/a/../b",
  "/x/./",
  "/../a",
];

function resolvedByBrowser(route: string): string {
  const { pathname } = new URL(route, "https://example.com");
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

test("a route resolves to the same path a browser resolves it to", () => {
  for (const route of RESOLVER_CASES) {
    const { store, collection } = siteWith("pages", [
      { locale: "en", path: "home" },
    ]);
    const pages = definePages({
      sources: [fromCollection(collection, { route: () => route })],
      trailingSlash: "never",
      locales: TWO_FOLDER_LOCALES,
    });

    expect(collectPages(store, pages).map((page) => page.path)).toEqual([
      resolvedByBrowser(route),
    ]);
  }
});

test("a percent-escaped dot segment collides with the plain spelling of its path", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "escaped" },
    { locale: "en", path: "plain" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "escaped" ? "/a/%2e%2e/b" : "/b"),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/b" in locale "en" — sources[0] "pages" /en/escaped',
      '  "/b" in locale "en" — sources[0] "pages" /en/plain',
    ].join("\n"),
  );
});

test("a percent-escaped dot segment is read before canonicalization, not after", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "escaped" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/a/%2E%2E/b" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual(["/b"]);
});

test("canonicalizePath performs the three RFC 3986 normalizations", () => {
  expect(canonicalizePath("/café")).toBe("/caf%C3%A9");
  expect(canonicalizePath("/caf%c3%a9")).toBe("/caf%C3%A9");
  expect(canonicalizePath("/%7Ea-%2E_%39")).toBe("/~a-._9");
});

test("canonicalizePath leaves a reserved character escaped, so a path keeps its segments", () => {
  expect(canonicalizePath("/a%2fb")).toBe("/a%2Fb");
});

test("canonicalizePath refuses a malformed escape, since no two clients agree on it", () => {
  for (const path of ["/a%2", "/a%zz"]) {
    const failure = failureOf(() => canonicalizePath(path));
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      'Path "/a%…": holds a malformed percent-escape — complete it with two hex digits, or write "%25" for a literal percent sign',
    );
  }
});

test("canonicalizePath refuses a query or a fragment, which no part of a path is", () => {
  for (const [path, quoted] of [
    ["/a?b", "/a?…"],
    ["/a#b", "/a#…"],
  ]) {
    const failure = failureOf(() => canonicalizePath(path));
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      `Path "${quoted}": holds a query or fragment — pass the path alone, or escape the delimiter as "%3F" or "%23"`,
    );
  }
});

test("canonicalizePath cuts at the delimiter before the escape, so a query cannot reach the message", () => {
  const failure = failureOf(() =>
    canonicalizePath("/x?token=SECRETVALUE%2"),
  ).message;
  expect(failure).not.toContain("SECRETVALUE");
  expect(failure).toContain('"/x?…"');
});

test("canonicalizePath refuses a lone surrogate, which no code point is spelled from", () => {
  for (const [path, quoted] of [
    ["/a\uD800b", "/a\uD800…"],
    ["/a\uDC00b", "/a\uDC00…"],
  ]) {
    const failure = failureOf(() => canonicalizePath(path));
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      `Path "${quoted}": holds a lone surrogate — pair it with the other half of its code point, or remove it`,
    );
  }
});

test("canonicalizePath encodes a paired surrogate, so a route outside the BMP still ships", () => {
  expect(canonicalizePath("/🎉")).toBe("/%F0%9F%8E%89");
});

test("canonicalizePath is idempotent, so re-normalizing an already canonical path is a no-op", () => {
  const once = canonicalizePath("/café/%7Ea/x%2fy");
  expect(canonicalizePath(once)).toBe(once);
});

test("normalizeOutputPrefix settles the spelling and leaves the boundary alone", () => {
  expect(normalizeOutputPrefix("docs//a/../caf%c3%a9")).toBe("/docs/caf%C3%A9");
  expect(normalizeOutputPrefix("/docs/")).toBe("/docs/");
  expect(normalizeOutputPrefix("/docs")).toBe("/docs");
  expect(normalizeOutputPrefix("/")).toBe("/");
  expect(normalizeOutputPrefix("")).toBe("/");
});

test("normalizeOutputPrefix is idempotent, so a prefix survives being spelled twice", () => {
  for (const prefix of ["/docs/", "/docs", "/", "/caf%C3%A9/"]) {
    expect(normalizeOutputPrefix(normalizeOutputPrefix(prefix))).toBe(prefix);
  }
});

test("normalizeOutputPrefix refuses what is not a path, the way every other speller does", () => {
  for (const [prefix, quoted] of [
    ["/a%2", "/a%…"],
    ["/a?b", "/a?…"],
  ]) {
    const failure = failureOf(() => normalizeOutputPrefix(prefix as string));
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toContain(`Path "${quoted as string}": `);
  }
});

test("two spellings of one non-ASCII route collide, naming both claimants", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "decoded" },
    { locale: "en", path: "encoded" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "decoded" ? "/café" : "/caf%C3%A9"),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/caf%C3%A9" in locale "en" — sources[0] "pages" /en/decoded',
      '  "/caf%C3%A9" in locale "en" — sources[0] "pages" /en/encoded',
    ].join("\n"),
  );
});

test("an escaped unreserved character collides with the character it stands for", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "plain" },
    { locale: "en", path: "escaped" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "plain" ? "/~a" : "/%7Ea"),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/~a" in locale "en" — sources[0] "pages" /en/escaped',
      '  "/~a" in locale "en" — sources[0] "pages" /en/plain',
    ].join("\n"),
  );
});

test("two escapes differing only in the case of their hex digits collide", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "lower" },
    { locale: "en", path: "upper" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) =>
          entry.path === "lower" ? "/caf%c3%a9" : "/caf%C3%A9",
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(failureOf(() => collectPages(store, pages)).message).toBe(
    [
      "Route table: 1 route is claimed by more than one entry — give each entry its own route, or emit only one of them:",
      '  "/caf%C3%A9" in locale "en" — sources[0] "pages" /en/lower',
      '  "/caf%C3%A9" in locale "en" — sources[0] "pages" /en/upper',
    ].join("\n"),
  );
});

test("an escaped slash stays one segment, and never becomes two", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/a%2Fb" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/a%2Fb",
  ]);
});

function pathOfRoute(route: Route): string {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);
  const pages = definePages({
    sources: [fromCollection(collection, { route: () => route })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });
  return collectPages(store, pages)[0]?.path ?? "";
}

test("a route written as segments encodes each one, so a slug cannot invent a segment", () => {
  expect(pathOfRoute(["blog", "a/b"])).toBe("/blog/a%2Fb");
});

test("a segment holding a query delimiter ships encoded rather than being refused", () => {
  expect(pathOfRoute(["a?b"])).toBe("/a%3Fb");
});

test("a percent sign in a segment is a literal, since a param is data and not a pre-encoded path", () => {
  expect(pathOfRoute(["a%2Fb"])).toBe("/a%252Fb");
});

test("a non-ASCII segment is spelled exactly as the string form of the same route", () => {
  expect(pathOfRoute(["café"])).toBe("/caf%C3%A9");
  expect(pathOfRoute("/café")).toBe("/caf%C3%A9");
});

test("a route returned as a string is not encoded, so its slashes stay separators", () => {
  expect(pathOfRoute("/docs/guide")).toBe("/docs/guide");
  expect(pathOfRoute(["docs/guide"])).toBe("/docs%2Fguide");
});

function failureOfRoute(route: Route): Error {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
  ]);
  const pages = definePages({
    sources: [fromCollection(collection, { route: () => route })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });
  return failureOf(() => collectPages(store, pages));
}

test("a segment of .. is refused, so a slug cannot climb out of its route", () => {
  const failure = failureOfRoute(["blog", "..", "secret"]);

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] is a dot segment',
    ].join("\n"),
  );
});

test("a segment of . is refused, since it resolves away rather than naming one", () => {
  const failure = failureOfRoute(["blog", "."]);

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] is a dot segment',
    ].join("\n"),
  );
});

test("an empty segment is refused, so two param sets cannot alias one path", () => {
  const failure = failureOfRoute(["a", ""]);

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] is empty',
    ].join("\n"),
  );
});

test("every offending segment of one route is named, not the first (rule 5)", () => {
  const failure = failureOfRoute(["a", "..", "..", "", ".", "b"]);

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] is a dot segment, segments[2] is a dot segment, segments[3] is empty, segments[4] is a dot segment',
    ].join("\n"),
  );
});

test("the refusal names the position and never the param value, so a slug stays out of the log", () => {
  expect(failureOfRoute(["a", ".."]).message).not.toContain('".."');
});

test("a dot segment in a route written as a string still resolves, untouched by the segment rule", () => {
  expect(pathOfRoute("/blog/../secret")).toBe("/secret");
  expect(pathOfRoute("/admin/..")).toBe("/");
  expect(pathOfRoute("/a/../../../b")).toBe("/b");
});

test("a param value spelled like a dot segment's escapes is data, not a dot segment", () => {
  expect(pathOfRoute(["a", "%2E%2E", "b"])).toBe("/a/%252E%252E/b");
});

test("every malformed escape in a run is reported, quoting each route up to its bad escape", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "truncated" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "de", path: "nonhex" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: () => "/a%2" }),
      fromCollection(postsCollection, { route: () => "/a%zz" }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 2 routes are not usable paths — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/truncated — the route holds a malformed percent-escape: "/a%…"',
      '  sources[1] "posts" /de/nonhex — the route holds a malformed percent-escape: "/a%…"',
    ].join("\n"),
  );
});

test("a lone surrogate is refused by the wiring pass, whichever half it is", () => {
  for (const [route, quoted] of [
    ["/a\uD800b", "/a\\ud800…"],
    ["/a\uDC00b", "/a\\udc00…"],
  ]) {
    const failure = failureOfRoute(route);

    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      [
        'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
        `  sources[0] "pages" /en/home — the route holds a lone surrogate: "${quoted}"`,
      ].join("\n"),
    );
  }
});

test("a paired surrogate is a character and not a fault, so an emoji route ships encoded", () => {
  expect(pathOfRoute("/🎉")).toBe("/%F0%9F%8E%89");
});

test("the lone-surrogate refusal quotes the route only as far as the surrogate", () => {
  const message = failureOfRoute("/a\uD800SECRETVALUE").message;
  expect(message).not.toContain("SECRETVALUE");
  expect(message).toContain('"/a\\ud800…"');
});

test("every lone surrogate in a run is reported, not the first (rule 5)", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "high" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "de", path: "low" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: () => "/a\uD800" }),
      fromCollection(postsCollection, { route: () => "/a\uDC00" }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 2 routes are not usable paths — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/high — the route holds a lone surrogate: "/a\\ud800…"',
      '  sources[1] "posts" /de/low — the route holds a lone surrogate: "/a\\udc00…"',
    ].join("\n"),
  );
});

test("a lone surrogate in a segment is refused, whichever half it is", () => {
  for (const [segment, half] of [
    ["a\uD800b", "high"],
    ["a\uDC00b", "low"],
  ]) {
    const failure = failureOfRoute(["blog", segment]);

    expect(failure, half).toBeInstanceOf(ConfigError);
    expect(failure.message, half).toBe(
      [
        'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
        '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] holds a lone surrogate',
      ].join("\n"),
    );
  }
});

test("every segment route holding a lone surrogate is reported, not the first (rule 5)", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "high" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "de", path: "low" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: () => ["a\uD800"] }),
      fromCollection(postsCollection, { route: () => ["a\uDC00"] }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 2 routes are not usable paths — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/high — the route holds a segment that is not a path segment: segments[0] holds a lone surrogate',
      '  sources[1] "posts" /de/low — the route holds a segment that is not a path segment: segments[0] holds a lone surrogate',
    ].join("\n"),
  );
});

test("every lone surrogate inside one route's segments is named, not the first (rule 5)", () => {
  const failure = failureOfRoute(["a\uD800b", "c\uDC00d"]);

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[0] holds a lone surrogate, segments[1] holds a lone surrogate',
    ].join("\n"),
  );
});

test("a paired surrogate in a segment is a character and not a fault, so an emoji slug ships", () => {
  expect(pathOfRoute(["blog", "🎉"])).toBe("/blog/%F0%9F%8E%89");
});

test("the lone-surrogate segment refusal names the position and never the value", () => {
  const message = failureOfRoute(["a\uD800SECRETVALUE"]).message;
  expect(message).not.toContain("SECRETVALUE");
  expect(message).toContain("segments[0] holds a lone surrogate");
});

test("a route holding both a surrogate and a delimiter is cut by the delimiter, tested first", () => {
  const failure = failureOfRoute("/a\uD800?token=SECRETVALUE");

  expect(failure.message).not.toContain("SECRETVALUE");
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/home — the route holds a query or fragment: "/a\\ud800?…"',
    ].join("\n"),
  );
});

test("every door into path encoding refuses a lone surrogate before it reaches the encoder", () => {
  const doors: [string, () => unknown][] = [
    ["canonicalizePath", () => canonicalizePath("/a\uD800b")],
    ["normalizeOutputPath", () => normalizeOutputPath("/a\uD800b", "never")],
    ["normalizeOutputPrefix", () => normalizeOutputPrefix("/a\uD800b")],
    ["collectPages, string route", () => pathOfRoute("/a\uD800b")],
    ["collectPages, segment route", () => pathOfRoute(["a\uD800b"])],
  ];

  for (const [door, open] of doors) {
    const failure = failureOf(open);
    expect(failure, door).toBeInstanceOf(ConfigError);
    expect(failure, door).not.toBeInstanceOf(URIError);
    expect(failure.message, door).not.toBe("URI malformed");
  }
});

test("sources of unrelated entry types compose in one definePages call", () => {
  const store = emptySite();
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "home",
    data: { title: "Home" },
  });
  store.upsertEntry({
    collection: "plans",
    locale: "en",
    path: "team",
    data: { price: 49 },
  });
  const pagesCollection = defineCollection<{ title: string }>({
    name: "pages",
    loader: inertLoader,
    schema: false,
  });
  const plansCollection = defineCollection<{ price: number }>({
    name: "plans",
    loader: inertLoader,
    schema: false,
  });

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, {
        route: (entry) => `/${entry.data.title.toLowerCase()}`,
      }),
      fromCollection(plansCollection, {
        route: (entry) => `/plans/${String(entry.data.price)}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/home",
    "/plans/49",
  ]);
});

test("a source's params reach its own route, whichever way the source is written", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "home" },
  ]);

  const backed = fromCollection(collection, {
    route: (entry) => `/${entry.path}`,
  });
  expectTypeOf<Parameters<typeof backed.route>[0]["params"]>().toEqualTypeOf<
    Entry<{ title: string }>
  >();

  const pages = definePages({
    sources: [
      backed,
      {
        // The annotation is load-bearing: without it this callback is context-sensitive and
        // `params` silently becomes `unknown`.
        instances: (reader: ContentStoreReader) =>
          listEntries(reader, collection).map((entry) => ({
            locale: entry.locale,
            params: { slug: entry.path },
            dependencies: [],
          })),
        route: (instance) => {
          expectTypeOf(instance.params).toEqualTypeOf<{ slug: string }>();
          return `/archive/${instance.params.slug}`;
        },
      },
      {
        instances: () => [
          { locale: "en", params: { slug: "pricing" }, dependencies: [] },
        ],
        route: (instance) => {
          expectTypeOf(instance.params).toEqualTypeOf<{ slug: string }>();
          return `/${instance.params.slug}`;
        },
      },
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/archive/home",
    "/home",
    "/pricing",
  ]);
});

test("a collection whose schema narrows its loader hands the route the narrow entry", () => {
  const store = emptySite();
  store.upsertEntry({
    collection: "docs",
    locale: "en",
    path: "guide",
    data: { frontmatter: { section: "how-to" } },
  });
  const docs = defineCollection({
    name: "docs",
    loader: {
      ...inertLoader,
      fetchOne: (): { frontmatter: Record<string, string> } => ({
        frontmatter: {},
      }),
    },
    schema: z.object({
      frontmatter: z.object({ section: z.enum(["how-to", "reference"]) }),
    }),
  });

  const source = fromCollection(docs, {
    route: (entry) => `/${entry.data.frontmatter.section}/${entry.path}`,
  });
  expectTypeOf<Parameters<typeof source.route>[0]["params"]>().toEqualTypeOf<
    Entry<{ frontmatter: { section: "how-to" | "reference" } }>
  >();

  const pages = definePages({
    sources: [source],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/how-to/guide",
  ]);
});

function outputs(table: readonly Page[]): string[] {
  return table.map((page) => `${page.domain ?? "(default)"} ${page.output}`);
}

test("a locale with a domain emits into it; a locale without one emits into the default tree", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "de", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr", domain: "example.de" },
    }),
  });

  expect(outputs(collectPages(store, pages))).toEqual([
    "example.de /home",
    "(default) /home",
  ]);
});

test("two locales sharing one domain share its tree, under distinct prefixes", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "fr", path: "home" },
    { locale: "nl", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: defineLocales({
      fr: { label: "Français", direction: "ltr", domain: "example.be" },
      nl: { label: "Nederlands", direction: "ltr", domain: "example.be" },
    }),
  });

  expect(outputs(collectPages(store, pages))).toEqual([
    "example.be /fr/home",
    "example.be /nl/home",
  ]);
});

test("a page's path is its route, prefix or no prefix", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "de", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/home",
    "/home",
  ]);
  expect(outputs(collectPages(store, pages))).toEqual([
    "(default) /de/home",
    "(default) /en/home",
  ]);
});

test("a prefixed route at the site root follows the trailing-slash policy", () => {
  const outputAtRoot = (trailingSlash: "always" | "never"): string => {
    const { store, collection } = siteWith("pages", [
      { locale: "de", path: "home" },
    ]);
    const pages = definePages({
      sources: [fromCollection(collection, { route: () => "/" })],
      trailingSlash,
      locales: TWO_FOLDER_LOCALES,
    });
    return collectPages(store, pages)[0]?.output ?? "";
  };

  expect(outputAtRoot("always")).toBe("/de/");
  expect(outputAtRoot("never")).toBe("/de");
});

test("an entry in an undeclared locale is a wiring fault, naming every one", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "home" },
    { locale: "fr", path: "home" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "es", path: "hola" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: (entry) => `/${entry.path}` }),
      fromCollection(postsCollection, {
        route: (entry) => `/blog/${entry.path}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      "Route table: 2 pages are in locales the site does not declare — declare the locale in defineLocales, or stop emitting the entry:",
      '  sources[0] "pages" /fr/home — locale "fr"',
      '  sources[1] "posts" /es/hola — locale "es"',
    ].join("\n"),
  );
});

test("unusable routes and undeclared locales are reported in one run", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "broken" },
    { locale: "fr", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => (entry.path === "broken" ? "" : `/${entry.path}`),
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const failure = failureOf(() => collectPages(store, pages));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    [
      'Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:',
      '  sources[0] "pages" /en/broken — the route is empty',
      "",
      "Route table: 1 page is in a locale the site does not declare — declare the locale in defineLocales, or stop emitting the entry:",
      '  sources[0] "pages" /fr/home — locale "fr"',
    ].join("\n"),
  );
});

test("the route table is sorted by locale then path, so two runs are identical", () => {
  const store = emptySite();
  const pagesCollection = collectionIn(store, "pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "home" },
  ]);
  const postsCollection = collectionIn(store, "posts", [
    { locale: "en", path: "hello" },
    { locale: "de", path: "hallo" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(pagesCollection, { route: (entry) => `/${entry.path}` }),
      fromCollection(postsCollection, {
        route: (entry) => `/blog/${entry.path}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const identity = (page: { locale: string; path: string }): string =>
    `${page.locale} ${page.path}`;
  const expected = [
    "de /blog/hallo",
    "de /home",
    "en /blog/hello",
    "en /pricing",
  ];

  expect(collectPages(store, pages).map(identity)).toEqual(expected);
  expect(collectPages(store, pages).map(identity)).toEqual(expected);
});

test("a template source routes its instances from the template", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        { locale: "en", params: { slug: "hello" }, dependencies: [] },
        { locale: "de", params: { slug: "hallo" }, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  expect(collectPages(store, pages).map((page) => page.output)).toEqual([
    "/de/blog/hallo",
    "/en/blog/hello",
  ]);
});

test("href returns the output the build emitted, prefixed and unprefixed", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        { locale: "en", params: { slug: "hello" }, dependencies: [] },
      ]),
      fromTemplate("/about", () => [
        { locale: "en", params: {}, dependencies: [] },
        { locale: "solo", params: {}, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr" },
      solo: { label: "Solo", direction: "ltr", domain: "solo.example" },
    }),
  });
  const emitted = new Map(
    collectPages(store, pages).map((page) => [
      `${page.locale} ${page.path}`,
      page.output,
    ]),
  );

  expect(pages.href("/blog/[slug]", { slug: "hello" }, "en")).toBe(
    emitted.get("en /blog/hello"),
  );
  expect(pages.href("/about", "solo")).toBe(emitted.get("solo /about"));
});

const ONE_LOCALE = defineLocales({
  en: { label: "English", direction: "ltr" },
});

function aboutPage(locales: ReturnType<typeof defineLocales>) {
  return definePages({
    sources: [
      fromTemplate("/about", () => [
        { locale: "en", params: {}, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales,
  });
}

test("href takes the site's only locale when none is given", () => {
  const store = emptySite();
  const pages = aboutPage(ONE_LOCALE);

  expect(pages.href("/about")).toBe(collectPages(store, pages)[0]?.output);
});

test("href refuses an omitted locale when the site declares more than one", () => {
  const pages = aboutPage(TWO_FOLDER_LOCALES);

  const failure = failureOf(() => pages.href("/about"));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Link to "/about": no locale was given, and the site declares more than one — pass the locale as the last argument, one of: "en", "de"',
  );
});

test("href refuses a locale the site does not declare", () => {
  const pages = aboutPage(TWO_FOLDER_LOCALES);

  const failure = failureOf(() => pages.href("/about", "fr"));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Link to "/about": locale "fr" is not declared, so it has no output tree — pass a declared locale, one of: "en", "de"',
  );
});

test("href escapes the control characters of a locale it refuses", () => {
  const pages = aboutPage(TWO_FOLDER_LOCALES);

  const failure = failureOf(() => pages.href("/about", "\u001b[2K\r\n\u009b"));

  expect(failure.message).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  expect(failure.message).toContain('locale "\\u001b[2K\\r\\n\\u009b" is not declared');
});

test("a catch-all template splices its members in as segments", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      fromTemplate("/docs/[...rest]", () => [
        {
          locale: "en",
          params: { rest: ["guide", "a/b"] },
          dependencies: [],
        },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const emitted = collectPages(store, pages)[0]?.output;
  expect(emitted).toBe("/docs/guide/a%2Fb");
  expect(pages.href("/docs/[...rest]", { rest: ["guide", "a/b"] })).toBe(
    emitted,
  );
});

test("a catch-all sharing a segment with other text is refused", () => {
  const failure = failureOf(() =>
    fromTemplate("/docs/v[...rest]", () => [
      { locale: "en", params: { rest: [] }, dependencies: [] },
    ]),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Route template "/docs/v[...rest]": segments[1] holds a catch-all alongside other text, and a catch-all stands for whole segments — give it a segment of its own, like "/x/[...rest]"',
  );
});

test("a segment holding two params is filled in from both", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      fromTemplate("/plans/[tier]-[period]", () => [
        {
          locale: "en",
          params: { tier: "pro", period: "yearly" },
          dependencies: [],
        },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const emitted = collectPages(store, pages)[0]?.output;
  expect(emitted).toBe("/plans/pro-yearly");
  expect(
    pages.href("/plans/[tier]-[period]", { tier: "pro", period: "yearly" }),
  ).toBe(emitted);
});

test.each(["always", "never"] as const)(
  "href follows the site's trailingSlash policy: %s",
  (trailingSlash) => {
    const store = emptySite();

    const pages = definePages({
      sources: [
        fromTemplate("/blog/[slug]", () => [
          { locale: "en", params: { slug: "hello" }, dependencies: [] },
        ]),
      ],
      trailingSlash,
      locales: TWO_FOLDER_LOCALES,
    });

    const link = pages.href("/blog/[slug]", { slug: "hello" }, "en");
    expect(link).toBe(collectPages(store, pages)[0]?.output);
    expect(link).toBe(
      trailingSlash === "always" ? "/en/blog/hello/" : "/en/blog/hello",
    );
  },
);

test("a template's params are checked at the call, and so is the template", () => {
  expectTypeOf<ParamsOf<"/blog/[slug]">>().toEqualTypeOf<{ slug: string }>();
  expectTypeOf<ParamsOf<"/blog/[year]/[slug]">>().toEqualTypeOf<{
    year: string;
    slug: string;
  }>();
  expectTypeOf<ParamsOf<"/blog/[year]/[...rest]">>().toEqualTypeOf<{
    year: string;
    rest: readonly string[];
  }>();
  expectTypeOf<ParamsOf<"/about">>().toEqualTypeOf<Record<string, never>>();

  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        { locale: "en", params: { slug: "hello" }, dependencies: [] },
      ]),
      fromTemplate("/about", () => [
        { locale: "en", params: {}, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  // Never called: every line below is a type-level assertion, and the two that compile
  // would throw on a locale-less multi-locale site.
  const negatives = (): void => {
    // @ts-expect-error a misspelled param is not the param the template names
    pages.href("/blog/[slug]", { slugg: "hello" });
    // @ts-expect-error the template's param is missing
    pages.href("/blog/[slug]", {});
    // @ts-expect-error no source declares this template
    pages.href("/blog/[id]", { id: "hello" });
    // @ts-expect-error a paramless link to a template that names params
    pages.href("/blog/[slug]");
    // @ts-expect-error a paramless template takes no params object
    pages.href("/about", { slug: "hello" });
  };
  expect(negatives).toBeTypeOf("function");
});

test("a template at the site root routes and links to it", () => {
  const store = emptySite();

  const pages = definePages({
    sources: [
      fromTemplate("/", () => [{ locale: "en", params: {}, dependencies: [] }]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  expect(collectPages(store, pages)[0]?.output).toBe("/");
  expect(pages.href("/")).toBe("/");
});

test("a param the template names but the instance does not is refused", () => {
  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        // @ts-expect-error the type names `slug`; this is what a JS caller does
        { locale: "en", params: {}, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });
  const expected =
    'Route template "/blog/[slug]": param "slug" has no value, so the route would spell it "undefined" — pass a value for every param the template names';

  const link = failureOf(() =>
    // @ts-expect-error the params object is missing the template's own param
    pages.href("/blog/[slug]", {}),
  );
  expect(link).toBeInstanceOf(ConfigError);
  expect(link.message).toBe(expected);

  const build = failureOf(() => collectPages(emptySite(), pages));
  expect(build).toBeInstanceOf(ConfigError);
  expect(build.message).toBe(expected);
});

test("a param that is not a string is refused rather than stringified", () => {
  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        { locale: "en", params: { slug: "hello" }, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const failure = failureOf(() =>
    // @ts-expect-error a number is not the `string` the template names
    pages.href("/blog/[slug]", { slug: 2 }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Route template "/blog/[slug]": param "slug" has type "number", not "string" — pass a string for every param the template names',
  );
});

test("a catch-all param that is not a list of strings is refused", () => {
  const pages = definePages({
    sources: [
      fromTemplate("/docs/[...rest]", () => [
        { locale: "en", params: { rest: ["guide"] }, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const failure = failureOf(() =>
    // @ts-expect-error a catch-all takes the segments, not a finished path
    pages.href("/docs/[...rest]", { rest: "guide/intro" }),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Route template "/docs/[...rest]": catch-all param "rest" is not a list of strings — pass one string per segment, like ["guide", "intro"]',
  );
});

test("a catch-all handed no segments is refused rather than shortened", () => {
  const pages = definePages({
    sources: [
      fromTemplate("/docs/[...rest]", () => [
        { locale: "en", params: { rest: ["guide"] }, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const failure = failureOf(() => pages.href("/docs/[...rest]", { rest: [] }));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Route template "/docs/[...rest]": catch-all param "rest" holds no segments, so the route would collapse onto a shorter path — pass at least one segment',
  );
});

test("a param value that is not a path segment is refused at the link", () => {
  const pages = definePages({
    sources: [
      fromTemplate("/blog/[slug]", () => [
        { locale: "en", params: { slug: "hello" }, dependencies: [] },
      ]),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  const failure = failureOf(() => pages.href("/blog/[slug]", { slug: ".." }));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Link to "/blog/[slug]": the route holds a segment that is not a path segment: segments[1] is a dot segment — give the param a value that is one, or link to a different page',
  );
});

test("a page set of function-form sources declares no templates, so href takes none", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "home" },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
      { instances: () => [], route: () => undefined },
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });

  expectTypeOf(pages).toEqualTypeOf<PageSet<never>>();

  // Never called: the assertion is that the line below does not compile.
  const negatives = (): void => {
    // @ts-expect-error the set declares no templates, so href takes none
    pages.href("/home");
  };
  expect(negatives).toBeTypeOf("function");

  expect(collectPages(store, pages).map((page) => page.path)).toEqual([
    "/home",
  ]);
});

const DE_FALLS_BACK_TO_EN = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr", fallback: "en" },
});

const A_THREE_HOP_CHAIN = defineLocales({
  base: { label: "Base", direction: "ltr" },
  en: { label: "English", direction: "ltr", fallback: "base" },
  "en-US": { label: "English (US)", direction: "ltr", fallback: "en" },
});

function routedByPath(
  collection: Collection<{ title: string }>,
  locales: PageSet["locales"],
): PageSet {
  return definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales,
  });
}

function suppliers(pages: readonly Page[]): string[] {
  return pages.map((page) => {
    const supplier =
      page.fallbackFrom === undefined ? "" : ` ← ${page.fallbackFrom}`;
    return `${page.locale} ${page.path}${supplier}`;
  });
}

test("a fallback page carries the supplying page's relations", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "pricing" },
  ]);
  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path}`,
        relatesTo: () => [{ collection: "pages", locale: "en", path: "home" }],
      }),
    ],
    trailingSlash: "never",
    locales: DE_FALLS_BACK_TO_EN,
  });

  const filled = collectPages(store, pages).find(
    (page) => page.locale === "de",
  );
  expect(filled?.fallbackFrom).toBe("en");
  expect(filled?.relations).toEqual([
    { collection: "pages", locale: "en", path: "home" },
  ]);
});

test("a locale renders a fallback page at its own URL for a path it does not translate", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: "pricing" },
    { locale: "de", path: "home" },
  ]);
  const pages = routedByPath(collection, DE_FALLS_BACK_TO_EN);

  expect(collectPages(store, pages)).toEqual([
    {
      locale: "de",
      path: "/home",
      output: "/de/home",
      collection: "pages",
      entry: { locale: "de", path: "home" },
      dependencies: [{ collection: "pages", locale: "de", path: "home" }],
    },
    {
      locale: "de",
      path: "/pricing",
      output: "/de/pricing",
      collection: "pages",
      entry: { locale: "en", path: "pricing" },
      fallbackFrom: "en",
      dependencies: [{ collection: "pages", locale: "en", path: "pricing" }],
    },
    {
      locale: "en",
      path: "/home",
      output: "/en/home",
      collection: "pages",
      entry: { locale: "en", path: "home" },
      dependencies: [{ collection: "pages", locale: "en", path: "home" }],
    },
    {
      locale: "en",
      path: "/pricing",
      output: "/en/pricing",
      collection: "pages",
      entry: { locale: "en", path: "pricing" },
      dependencies: [{ collection: "pages", locale: "en", path: "pricing" }],
    },
  ]);
});

test("a page the locale translates itself is never displaced by a fallback", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "pricing" },
  ]);
  const pages = routedByPath(collection, DE_FALLS_BACK_TO_EN);

  expect(suppliers(collectPages(store, pages))).toEqual([
    "de /pricing",
    "en /pricing",
  ]);
});

test("what a locale translates is decided by the route, not by the entry path", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "preise" },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/pricing" })],
    trailingSlash: "never",
    locales: DE_FALLS_BACK_TO_EN,
  });

  expect(suppliers(collectPages(store, pages))).toEqual([
    "de /pricing",
    "en /pricing",
  ]);
});

test("a locale whose route translates the slug gets a fallback at the untranslated path too", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "preise" },
  ]);
  const pages = routedByPath(collection, DE_FALLS_BACK_TO_EN);

  // A known limitation, pinned rather than endorsed: nothing relates `/preise` to
  // `/pricing`, so the chain fills `/pricing` in `de` too.
  expect(suppliers(collectPages(store, pages))).toEqual([
    "de /preise",
    "de /pricing ← en",
    "en /pricing",
  ]);
});

test("the alternate that limitation produces points at a page this build emitted", () => {
  const store = emptySite();
  const collection = collectionIn(store, "pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "preise" },
  ]);
  const table = collectPages(
    store,
    routedByPath(collection, DE_FALLS_BACK_TO_EN),
  );

  const emitted = new Set(table.map((page) => `${page.locale} ${page.output}`));
  const variants = localeAlternates(table).get("/pricing") ?? [];
  expect(variants).toEqual([
    { locale: "de", output: "/de/pricing" },
    { locale: "en", output: "/en/pricing" },
  ]);
  for (const variant of variants) {
    expect(emitted).toContain(`${variant.locale} ${variant.output}`);
  }
});

test("a multi-hop chain resolves to the nearest locale that has the page", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "base", path: "deep" },
    { locale: "en", path: "deep" },
  ]);
  const pages = routedByPath(collection, A_THREE_HOP_CHAIN);

  expect(suppliers(collectPages(store, pages))).toEqual([
    "base /deep",
    "en /deep",
    "en-US /deep ← en",
  ]);
});

test("a chain walks past a locale that does not have the page, to one that does", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "base", path: "deep" },
  ]);
  const pages = routedByPath(collection, A_THREE_HOP_CHAIN);

  expect(suppliers(collectPages(store, pages))).toEqual([
    "base /deep",
    "en /deep ← base",
    "en-US /deep ← base",
  ]);
});

test("a locale that declares no fallback gets no page it does not translate", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "pricing" },
    { locale: "de", path: "home" },
  ]);
  const pages = routedByPath(collection, DE_FALLS_BACK_TO_EN);

  expect(suppliers(collectPages(store, pages))).toEqual([
    "de /home",
    "de /pricing ← en",
    "en /pricing",
  ]);
});

test("a path no locale on the chain has produces no page", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    de: { label: "Deutsch", direction: "ltr", fallback: "en" },
    fr: { label: "Français", direction: "ltr" },
  });
  const { store, collection } = siteWith("pages", [
    { locale: "fr", path: "seul" },
  ]);
  const pages = routedByPath(collection, locales);

  expect(suppliers(collectPages(store, pages))).toEqual(["fr /seul"]);
});

test("a fallback page is emitted into its own locale's tree, not the supplying one", () => {
  const locales = defineLocales({
    en: { label: "English", direction: "ltr" },
    ar: {
      label: "العربية",
      direction: "rtl",
      domain: "example.ae",
      fallback: "en",
    },
  });
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "pricing" },
  ]);
  const pages = routedByPath(collection, locales);

  expect(collectPages(store, pages)).toEqual([
    {
      locale: "ar",
      path: "/pricing",
      domain: "example.ae",
      declaredDomain: "example.ae",
      output: "/pricing",
      collection: "pages",
      entry: { locale: "en", path: "pricing" },
      fallbackFrom: "en",
      dependencies: [{ collection: "pages", locale: "en", path: "pricing" }],
    },
    {
      locale: "en",
      path: "/pricing",
      output: "/pricing",
      collection: "pages",
      entry: { locale: "en", path: "pricing" },
      dependencies: [{ collection: "pages", locale: "en", path: "pricing" }],
    },
  ]);
});

test("a fallback page carries the supplying page's template and dependencies", async () => {
  const { store, collection } = await fixtureSite();
  const pages = definePages({
    sources: [
      fromCollection(templateDriven(collection), {
        route: (entry) => `/${entry.path}`,
        dependsOn: () => [
          { collection: "pages", locale: "en", path: "navigation" },
        ],
      }),
    ],
    trailingSlash: "never",
    locales: defineLocales({
      en: { label: "English", direction: "ltr" },
      de: { label: "Deutsch", direction: "ltr" },
      it: { label: "Italiano", direction: "ltr", fallback: "en" },
    }),
  });

  expect(
    collectPages(store, pages)
      .filter((page) => page.locale === "it")
      .map((page) => ({
        path: page.path,
        template: page.template,
        dependencies: page.dependencies,
      })),
  ).toEqual([
    {
      path: "/home",
      template: undefined,
      dependencies: [
        { collection: "pages", locale: "en", path: "home" },
        { collection: "pages", locale: "en", path: "navigation" },
      ],
    },
    {
      path: "/pricing",
      template: "PricingPage",
      dependencies: [
        { collection: "pages", locale: "en", path: "pricing" },
        { collection: "pages", locale: "en", path: "navigation" },
      ],
    },
  ]);
});

test("the route table stays sorted with fallback pages in it, and two runs agree", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "base", path: "zebra" },
    { locale: "base", path: "alpha" },
    { locale: "en", path: "alpha" },
  ]);
  const pages = routedByPath(collection, A_THREE_HOP_CHAIN);

  const first = collectPages(store, pages);

  expect(suppliers(first)).toEqual([
    "base /alpha",
    "base /zebra",
    "en /alpha",
    "en /zebra ← base",
    "en-US /alpha ← en",
    "en-US /zebra ← base",
  ]);
  expect(collectPages(store, pages)).toEqual(first);
});

function scheduledSite(
  window: { publishField?: string; unpublishField?: string },
  entries: readonly {
    path: string;
    publish_at?: string;
    unpublish_at?: string;
  }[],
): { store: ContentStore; collection: Collection<{ title: string }> } {
  const store = emptySite();
  for (const { path, ...dates } of entries) {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { title: path, ...dates },
    });
  }
  return {
    store,
    collection: defineCollection<{ title: string }>({
      name: "posts",
      loader: inertLoader,
      schema: false,
      ...window,
    }),
  };
}

function scheduledPages(collection: Collection<{ title: string }>): PageSet {
  return definePages({
    sources: [
      fromCollection(collection, { route: (entry) => `/${entry.path}` }),
    ],
    trailingSlash: "never",
    locales: ONE_LOCALE,
  });
}

test("an entry whose publish date has not arrived yields no page", () => {
  const { store, collection } = scheduledSite({ publishField: "publish_at" }, [
    { path: "out", publish_at: "2026-01-01T00:00:00Z" },
    { path: "later", publish_at: "2026-12-01T00:00:00Z" },
    { path: "evergreen" },
  ]);

  const paths = collectPages(
    store,
    scheduledPages(collection),
    "2026-06-01T00:00:00Z",
  ).map((page) => page.path);

  expect(paths).toEqual(["/evergreen", "/out"]);
});

test("an entry whose end date has passed yields no page", () => {
  const { store, collection } = scheduledSite(
    { unpublishField: "unpublish_at" },
    [
      { path: "expired", unpublish_at: "2026-01-01T00:00:00Z" },
      { path: "live", unpublish_at: "2026-12-01T00:00:00Z" },
      { path: "evergreen" },
    ],
  );

  const paths = collectPages(
    store,
    scheduledPages(collection),
    "2026-06-01T00:00:00Z",
  ).map((page) => page.path);

  expect(paths).toEqual(["/evergreen", "/live"]);
});

test("collecting a scheduled collection with no instant is refused", () => {
  const { store, collection } = scheduledSite({ publishField: "publish_at" }, [
    { path: "out", publish_at: "2026-01-01T00:00:00Z" },
  ]);

  const failure = failureOf(() =>
    collectPages(store, scheduledPages(collection)),
  );

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    'Collection "posts": is scheduled by publishField, but this page set was collected with no instant to schedule against — pass one to collectPages, as pagedeck build passes its build stamp\'s createdAt',
  );
});

test("an unscheduled collection is collected with no instant, as it always was", () => {
  const { store, collection } = scheduledSite({}, [
    { path: "a", publish_at: "2026-12-01T00:00:00Z" },
  ]);

  expect(
    collectPages(store, scheduledPages(collection)).map((page) => page.path),
  ).toEqual(["/a"]);
});

function postsSite(): {
  store: ContentStore;
  collection: Collection<{ title: string; tags: readonly string[] }>;
} {
  const store = emptySite();
  const tagged = new Set(["b", "d"]);
  for (const path of ["a", "b", "c", "d", "e"]) {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { title: path, tags: tagged.has(path) ? ["css"] : [] },
    });
  }
  return {
    store,
    collection: defineCollection<{ title: string; tags: readonly string[] }>({
      name: "posts",
      loader: inertLoader,
      schema: false,
    }),
  };
}

function everyPost(
  collection: Collection<{ title: string; tags: readonly string[] }>,
  pageSize: number,
): PageSource<PagedRoute> {
  return paginate({
    pageSize,
    lists: (store) => [
      {
        locale: "en",
        path: ["posts"],
        entries: listEntries(store, collection),
      },
    ],
  });
}

function paged(pages: readonly Page[]): string[] {
  return pages.flatMap((page) => {
    const paging = page.paging;
    if (paging === undefined) return [];
    return [
      [
        page.path,
        `${String(paging.number)}/${String(paging.total)}`,
        paging.prev ?? "—",
        paging.next ?? "—",
      ].join(" "),
    ];
  });
}

test("a paged list expands into as many pages as the collection needs", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [everyPost(collection, 2)],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(pages.map((page) => page.path)).toEqual([
    "/posts",
    "/posts/page/2",
    "/posts/page/3",
  ]);
});

test("each paged page carries its number, its total and the addresses either side", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [everyPost(collection, 2)],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(paged(pages)).toEqual([
    "/posts 1/3 — /posts/page/2",
    "/posts/page/2 2/3 /posts /posts/page/3",
    "/posts/page/3 3/3 /posts/page/2 —",
  ]);
});

test("a paged address is the row the build emits, prefix and policy included", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [everyPost(collection, 2)],
      trailingSlash: "always",
      locales: TWO_FOLDER_LOCALES,
    }),
  );

  const outputs = pages.map((page) => page.output);
  expect(outputs).toEqual([
    "/en/posts/",
    "/en/posts/page/2/",
    "/en/posts/page/3/",
  ]);
  expect(pages.map((page) => page.paging?.next)).toEqual([
    outputs[1],
    outputs[2],
    undefined,
  ]);
  expect(pages.map((page) => page.paging?.prev)).toEqual([
    undefined,
    outputs[0],
    outputs[1],
  ]);
});

test("one helper pages a whole collection and the same collection by tag", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [
        paginate({
          pageSize: 2,
          lists: (reader) => {
            const entries = listEntries(reader, collection);
            return [
              { locale: "en", path: ["posts"], entries },
              {
                locale: "en",
                path: ["tags", "css"],
                entries: entries.filter((entry) =>
                  entry.data.tags.includes("css"),
                ),
              },
            ];
          },
        }),
      ],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(paged(pages)).toEqual([
    "/posts 1/3 — /posts/page/2",
    "/posts/page/2 2/3 /posts /posts/page/3",
    "/posts/page/3 3/3 /posts/page/2 —",
    "/tags/css 1/1 — —",
  ]);
});

function taggedPosts(): {
  store: ContentStore;
  collection: Collection<{ title: string; tags: readonly string[] }>;
} {
  const store = emptySite();
  const tags: Record<string, readonly string[]> = {
    a: ["css"],
    b: ["css", "html"],
    c: ["css"],
    d: ["html"],
    e: [],
  };
  for (const [path, carried] of Object.entries(tags)) {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { title: path, tags: carried },
    });
  }
  return {
    store,
    collection: defineCollection<{ title: string; tags: readonly string[] }>({
      name: "posts",
      loader: inertLoader,
      schema: false,
    }),
  };
}

test("one list per tag the store turns out to hold", () => {
  const { store, collection } = taggedPosts();

  const pages = collectPages(
    store,
    definePages({
      sources: [
        paginate({
          pageSize: 2,
          lists: (reader) => {
            const entries = listEntries(reader, collection);
            const tags = new Set(entries.flatMap((entry) => entry.data.tags));
            return [...tags].map((tag) => ({
              locale: "en",
              path: ["tags", tag],
              entries: entries.filter((entry) => entry.data.tags.includes(tag)),
            }));
          },
        }),
      ],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(paged(pages)).toEqual([
    "/tags/css 1/2 — /tags/css/page/2",
    "/tags/css/page/2 2/2 /tags/css —",
    "/tags/html 1/1 — —",
  ]);
  expect(
    pages.map((page) => page.dependencies.map((ref) => ref.path).join("")),
  ).toEqual(["ab", "c", "bd"]);
});

test("a list with no entries still emits its first page", () => {
  const { store } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [
        paginate({
          pageSize: 2,
          lists: () => [{ locale: "en", path: ["tags", "empty"], entries: [] }],
        }),
      ],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(paged(pages)).toEqual(["/tags/empty 1/1 — —"]);
});

test("a paged page depends on the entries on it and on no others", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [everyPost(collection, 2)],
      trailingSlash: "never",
      locales: ONE_LOCALE,
    }),
  );

  expect(
    pages.map((page) => page.dependencies.map((ref) => ref.path).join("")),
  ).toEqual(["ab", "cd", "e"]);
});

test("a page size that is not a positive whole number is refused", () => {
  const failure = failureOf(() => paginate({ pageSize: 0, lists: () => [] }));

  expect(failure).toBeInstanceOf(ConfigError);
  expect(failure.message).toBe(
    "Paged list: pageSize is 0, and a page holds at least one entry — pass a whole number of 1 or more",
  );
});

test("a fallback page carries no paging", () => {
  const { store, collection } = postsSite();

  const pages = collectPages(
    store,
    definePages({
      sources: [everyPost(collection, 4)],
      trailingSlash: "never",
      locales: DE_FALLS_BACK_TO_EN,
    }),
  );

  expect(suppliers(pages)).toEqual([
    "de /posts ← en",
    "de /posts/page/2 ← en",
    "en /posts",
    "en /posts/page/2",
  ]);
  expect(pages.map((page) => page.paging?.number)).toEqual([
    undefined,
    undefined,
    1,
    2,
  ]);
});

test("a page from a source naming a layout carries it, and a page from one naming none carries none", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "index" },
  ]);
  const other = collectionIn(store, "notes", [{ locale: "en", path: "one" }]);

  const pages = collectPages(
    store,
    definePages({
      sources: [
        fromCollection(collection, { layout: "layout" }),
        fromCollection(other, { route: (entry) => ["notes", entry.path] }),
      ],
    }),
  );

  expect(pages.map((page) => [page.path, page.layout])).toEqual([
    ["/", "layout"],
    ["/notes/one", undefined],
  ]);
  expect(Object.hasOwn(pages[1] ?? {}, "layout")).toBe(false);
});

test("a fallback page keeps the layout of the page it falls back to", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "about" },
  ]);

  const pages = collectPages(
    store,
    definePages({
      sources: [fromCollection(collection, { layout: "layout" })],
      locales: DE_FALLS_BACK_TO_EN,
    }),
  );

  expect(suppliers(pages)).toEqual(["de /about ← en", "en /about"]);
  expect(pages.map((page) => page.layout)).toEqual(["layout", "layout"]);
});

test("a page set records the layout each of its sources names", () => {
  const { collection } = siteWith("pages", []);

  const pages = definePages({
    sources: [
      fromCollection(collection, { layout: "layout" }),
      fromCollection(collection),
    ],
  });

  expect(pages.layouts).toEqual(["layout", undefined]);
});

// Each byte can rewrite or forge a terminal line (#730).
const HOSTILE = "x\u001b[2K\rpagedeck: build complete\n\u009b2K";

test("a route collision names each entry with its id's control characters replaced", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: "home" },
    { locale: "en", path: HOSTILE },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: () => "/home" })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const message = failureOf(() => collectPages(store, pages)).message;

  expect(message).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(message.split("\n").slice(1)).toEqual([
    '  "/home" in locale "en" — sources[0] "pages" /en/home',
    '  "/home" in locale "en" — sources[0] "pages" /en/x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K',
  ]);
});

const RAW_CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

test("a collided route taken from a hostile id reaches the report percent-encoded", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: `${HOSTILE}/a` },
    { locale: "en", path: `${HOSTILE}/b` },
  ]);

  const pages = definePages({
    sources: [
      fromCollection(collection, {
        route: (entry) => `/${entry.path.split("/")[0] ?? ""}`,
      }),
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const message = failureOf(() => collectPages(store, pages)).message;

  expect(message).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(message.split("\n").slice(1)).toEqual([
    '  "/x%1B%5B2K%0Dpagedeck:%20build%20complete%0A%C2%9B2K" in locale "en" — sources[0] "pages" /en/x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K/a',
    '  "/x%1B%5B2K%0Dpagedeck:%20build%20complete%0A%C2%9B2K" in locale "en" — sources[0] "pages" /en/x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K/b',
  ]);
});

test("the part of an unusable route a hostile id supplied is quoted through quoteIdentifier", () => {
  const { store, collection } = siteWith("pages", [
    { locale: "en", path: `${HOSTILE}?q` },
  ]);

  const pages = definePages({
    sources: [fromCollection(collection, { route: (entry) => `/${entry.path}` })],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const message = failureOf(() => collectPages(store, pages)).message;

  expect(message).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(message.split("\n").slice(1)).toEqual([
    '  sources[0] "pages" /en/x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K?q — the route holds a query or fragment: "/x\\u001b[2K\\rpagedeck: build complete\\n\\u009b2K?…"',
  ]);
});

test("a hostile locale is quoted through quoteIdentifier in the route table's reports", () => {
  const { store, collection } = siteWith("pages", [
    { locale: HOSTILE, path: "home" },
  ]);
  const instancePages = definePages({
    sources: [
      {
        instances: () => [{ locale: HOSTILE, params: {}, dependencies: [] }],
        route: () => "",
      },
    ],
    trailingSlash: "never",
    locales: TWO_FOLDER_LOCALES,
  });

  const undeclared = failureOf(() =>
    collectPages(
      store,
      definePages({
        sources: [fromCollection(collection)],
        trailingSlash: "never",
        locales: TWO_FOLDER_LOCALES,
      }),
    ),
  ).message;
  const unusable = failureOf(() => collectPages(store, instancePages)).message;

  expect(undeclared).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(undeclared.split("\n").slice(1)).toEqual([
    '  sources[0] "pages" /x\ufffd[2K\ufffdpagedeck: build complete\ufffd\ufffd2K/home — locale "x\\u001b[2K\\rpagedeck: build complete\\n\\u009b2K"',
  ]);
  expect(unusable).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(unusable.split("\n")[1]).toBe(
    '  sources[0] instances[0] in locale "x\\u001b[2K\\rpagedeck: build complete\\n\\u009b2K" — the route is empty',
  );
});
