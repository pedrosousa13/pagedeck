import { defineCollection, syncCollection } from "@pagedeck/content";
import type { ContentStore, Entry } from "@pagedeck/content";
import { afterEach, expect, test } from "vitest";
import { loadFixtureStore } from "./harness.js";
import type { FixtureStore } from "./harness.js";
import {
  extractTreeUsage,
  PRICING_PAGE_USAGE,
  SITE_FIXTURES,
} from "./site.js";
import type { ComponentNode, FixturePage } from "./site.js";

const openFixtures: FixtureStore<FixturePage>[] = [];

afterEach(() => {
  for (const fixture of openFixtures.splice(0)) {
    fixture.close();
  }
});

async function syncedSite(): Promise<ContentStore> {
  const fixture = await loadFixtureStore<FixturePage>({
    directory: SITE_FIXTURES,
  });
  openFixtures.push(fixture);

  const pages = defineCollection<FixturePage>({
    name: fixture.collection.name,
    loader: fixture.collection.loader,
    extractUsage: (entry: Entry<FixturePage>) =>
      entry.data.mode === "tree" ? extractTreeUsage(entry.data.tree) : [],
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { PricingPage: PRICING_PAGE_USAGE },
    },
    schema: false,
  });
  await syncCollection(fixture.store, pages);
  return fixture.store;
}

test("a nested tree entry records counts, fold scores and depths", async () => {
  const store = await syncedSite();

  expect(store.listUsage("Hero")).toContainEqual({
    component: "Hero",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  });
  expect(store.listUsage("FeatureCard")).toContainEqual({
    component: "FeatureCard",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 2,
    foldScore: 4,
    depth: 1,
    isRoot: false,
  });
  expect(store.listUsage("Icon")).toContainEqual({
    component: "Icon",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 2,
    foldScore: 5,
    depth: 2,
    isRoot: false,
  });
  expect(store.listUsage("NewsletterSignup")).toContainEqual({
    component: "NewsletterSignup",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 1,
    foldScore: 8,
    depth: 0,
    isRoot: true,
  });
});

test("both locales of the same tree page record their own usage", async () => {
  const store = await syncedSite();

  expect(store.listUsage("Icon").map((row) => [row.locale, row.count])).toEqual(
    [
      ["de", 2],
      ["en", 2],
    ],
  );
});

test("a template-driven entry records declared usage in both locales", async () => {
  const store = await syncedSite();

  expect(store.listUsage("PlanCard")).toEqual([
    {
      component: "PlanCard",
      collection: "pages",
      locale: "de",
      path: "pricing",
      count: 2,
      foldScore: 1,
      depth: 1,
      isRoot: false,
    },
    {
      component: "PlanCard",
      collection: "pages",
      locale: "en",
      path: "pricing",
      count: 2,
      foldScore: 1,
      depth: 1,
      isRoot: false,
    },
  ]);
});

test("the ranking spans both page modes and both locales", async () => {
  const store = await syncedSite();

  expect(store.rankUsage()).toEqual([
    {
      component: "PlanCard",
      totalUsages: 4,
      storyCount: 2,
      avgPerStory: 2,
      avgFoldScore: 1,
    },
    {
      component: "FeatureCard",
      totalUsages: 4,
      storyCount: 2,
      avgPerStory: 2,
      avgFoldScore: 4,
    },
    {
      component: "Icon",
      totalUsages: 4,
      storyCount: 2,
      avgPerStory: 2,
      avgFoldScore: 5,
    },
    {
      component: "Hero",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 0,
    },
    {
      component: "PricingHeader",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 0,
    },
    {
      component: "Heading",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 1,
    },
    {
      component: "CtaButton",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 2,
    },
    {
      component: "FaqList",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 3,
    },
    {
      component: "FeatureGrid",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 3,
    },
    {
      component: "NewsletterSignup",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 8,
    },
  ]);
});

test("excluding components drops them from the ranking, in both modes", async () => {
  const store = await syncedSite();

  const filtered = store.rankUsage(new Set(["Icon", "PlanCard"]));

  expect(filtered.map((row) => row.component)).toEqual([
    "FeatureCard",
    "Hero",
    "PricingHeader",
    "Heading",
    "CtaButton",
    "FaqList",
    "FeatureGrid",
    "NewsletterSignup",
  ]);
});

function deepTree(levels: number): ComponentNode[] {
  let node: ComponentNode = { component: "Leaf" };
  for (let at = 1; at < levels; at += 1) {
    node = { component: "Link", children: [node] };
  }
  return [node];
}

test("a tree deep enough to overflow the stack fails the walk instead", () => {
  // 20,000 is past every depth the unchecked walk survived (6,400 to 8,800).
  expect(() => extractTreeUsage(deepTree(20_000))).toThrowError(
    'Component tree: nests more than 64 levels deep at "Link" — flatten the entry\'s tree',
  );
});

test("a tree at the depth limit is walked, one level past it is not", () => {
  expect(extractTreeUsage(deepTree(64)).map((usage) => usage.depth)).toEqual([
    0, 63,
  ]);

  expect(() => extractTreeUsage(deepTree(65))).toThrowError(
    'Component tree: nests more than 64 levels deep at "Leaf" — flatten the entry\'s tree',
  );
});

test("a tree past the depth limit fails a sync naming the entry", async () => {
  const fixture = await loadFixtureStore<FixturePage>({
    directory: SITE_FIXTURES,
  });
  openFixtures.push(fixture);

  // Shallow enough for the store's own `JSON.stringify`, which overflows on this shape
  // somewhere between 1,000 and 5,000 levels.
  const deep = defineCollection<FixturePage>({
    name: "deep",
    loader: {
      syncAll: (writer) => {
        writer.upsert({
          locale: "en",
          path: "deep",
          data: { mode: "tree", title: "Deep", tree: deepTree(100) },
        });
        return {
          changed: [{ locale: "en", path: "deep" }],
          deleted: [],
          cursor: 1,
        };
      },
      syncSince: () => ({ changed: [], deleted: [], cursor: 1 }),
    },
    extractUsage: (entry: Entry<FixturePage>) =>
      entry.data.mode === "tree" ? extractTreeUsage(entry.data.tree) : [],
    schema: false,
  });

  await expect(syncCollection(fixture.store, deep)).rejects.toThrowError(
    'Collection "deep": syncAll failed writing entry "en/deep"',
  );
});
