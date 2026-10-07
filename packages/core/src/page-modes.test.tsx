import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import { defineCollection, syncCollection } from "@pagedeck/content";
import type { ComponentUsage, ContentStore, Entry } from "@pagedeck/content";
import type { ComponentDefinition, ComponentRegistry } from "@pagedeck/islands";
import {
  extractTreeUsage,
  loadFixtureStore,
  PRICING_PAGE_USAGE,
  SITE_FIXTURES,
} from "@pagedeck/fixtures";
import type { FixturePage } from "@pagedeck/fixtures";
import { collectPages, definePages, fromCollection } from "./pages.js";
import type { Page } from "./pages.js";
import { defineLocales } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { renderPage } from "./render.js";
import type { PageContent } from "./render.js";

const openStores: { close(): void }[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

const LOCALES = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr" },
});

const AR_FALLS_BACK_TO_EN = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr" },
  ar: { label: "العربية", direction: "rtl", fallback: "en" },
});

function block(name: string): ComponentDefinition {
  function Block({ children }: { children?: ReactNode }) {
    return <div data-component={name}>{children}</div>;
  }
  return { import: async () => ({ default: Block }) };
}

function PricingPage({
  title,
  fields,
}: {
  title: string;
  fields: { plans: readonly { id: string; name: string }[] };
}) {
  return (
    <>
      <div data-component="PricingHeader">
        {title}
        {fields.plans.map((plan) => (
          <div data-component="PlanCard" key={plan.id}>
            {plan.name}
          </div>
        ))}
      </div>
      <div data-component="FaqList" />
    </>
  );
}

const SITE_REGISTRY = {
  Hero: block("Hero"),
  Heading: block("Heading"),
  CtaButton: block("CtaButton"),
  FeatureGrid: block("FeatureGrid"),
  FeatureCard: block("FeatureCard"),
  Icon: block("Icon"),
  NewsletterSignup: block("NewsletterSignup"),
  PricingPage: { import: async () => ({ default: PricingPage }) },
} satisfies ComponentRegistry;

async function fixtureSite(
  locales: LocaleSet = LOCALES,
): Promise<{ store: ContentStore; pages: Page[] }> {
  const fixture = await loadFixtureStore<FixturePage>({
    directory: SITE_FIXTURES,
  });
  openStores.push(fixture);

  const collection = defineCollection<FixturePage>({
    name: fixture.collection.name,
    loader: fixture.collection.loader,
    extractUsage: (entry) =>
      entry.data.mode === "tree" ? extractTreeUsage(entry.data.tree) : [],
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { PricingPage: PRICING_PAGE_USAGE },
    },
    schema: false,
  });
  await syncCollection(fixture.store, collection);

  const pages = collectPages(
    fixture.store,
    definePages({
      sources: [
        fromCollection(collection, { route: (entry) => `/${entry.path}` }),
      ],
      trailingSlash: "never",
      locales,
    }),
  );
  return { store: fixture.store, pages };
}

function contentOf(
  entry: Entry<FixturePage>,
  template: string | undefined,
): PageContent {
  if (template !== undefined) return { template, props: { ...entry.data } };
  return { tree: entry.data.mode === "tree" ? entry.data.tree : [] };
}

async function renderSite(locales: LocaleSet = LOCALES): Promise<{
  store: ContentStore;
  html: Map<string, string>;
}> {
  const { store, pages } = await fixtureSite(locales);
  const html = new Map<string, string>();
  for (const page of pages) {
    if (page.collection === undefined || page.entry === undefined) {
      throw new Error(`The page at "${page.output}" has no entry to render`);
    }
    const entry = store.getEntry<FixturePage>(
      page.collection,
      page.entry.locale,
      page.entry.path,
    );
    if (entry === undefined) {
      throw new Error(
        `No entry for /${page.entry.locale}/${page.entry.path} in collection "${page.collection}"`,
      );
    }
    const rendered = await renderPage({
      // The route, as `buildSite` passes it, not `page.entry`, which drops the leading slash
      // (#171).
      page: { locale: page.locale, path: page.path },
      ...(locales.get(page.locale) === undefined
        ? {}
        : { locale: locales.get(page.locale) }),
      ...contentOf(entry, page.template),
      registry: SITE_REGISTRY,
    });
    html.set(page.output, rendered.html);
  }
  return { store, html };
}

function instancesIn(
  html: string,
): { component: string; foldScore: number; depth: number }[] {
  const instances: { component: string; foldScore: number; depth: number }[] =
    [];
  const open: boolean[] = [];
  let depth = 0;
  for (const [, closing, attributes] of html.matchAll(/<(\/?)div\b([^>]*)>/g)) {
    if (closing === "/") {
      if (open.pop() === true) depth -= 1;
      continue;
    }
    const named = /data-component="([^"]+)"/.exec(attributes);
    open.push(named !== null);
    if (named === null) continue;
    instances.push({
      component: named[1],
      foldScore: instances.length,
      depth,
    });
    depth += 1;
  }
  return instances;
}

function componentsIn(html: string): string[] {
  return instancesIn(html).map((instance) => instance.component);
}

function usageIn(html: string): ComponentUsage[] {
  const usage = new Map<string, ComponentUsage>();
  for (const instance of instancesIn(html)) {
    const seen = usage.get(instance.component);
    if (seen === undefined) {
      usage.set(instance.component, {
        component: instance.component,
        count: 1,
        foldScore: instance.foldScore,
        depth: instance.depth,
        isRoot: instance.depth === 0,
      });
      continue;
    }
    seen.count += 1;
    seen.depth = Math.min(seen.depth, instance.depth);
    seen.isRoot = seen.isRoot || instance.depth === 0;
  }
  return [...usage.values()];
}

function pageHtml(html: Map<string, string>, output: string): string {
  const rendered = html.get(output);
  if (rendered === undefined) {
    throw new Error(`No page rendered at "${output}"`);
  }
  return rendered;
}

test("both page modes render in one build, from one route table", async () => {
  const { html } = await renderSite();

  expect([...html.keys()]).toEqual([
    "/de/home",
    "/de/pricing",
    "/en/home",
    "/en/pricing",
  ]);
  expect(componentsIn(pageHtml(html, "/en/home"))).toEqual([
    "Hero",
    "Heading",
    "CtaButton",
    "FeatureGrid",
    "FeatureCard",
    "Icon",
    "FeatureCard",
    "Icon",
    "NewsletterSignup",
  ]);
  expect(componentsIn(pageHtml(html, "/en/pricing"))).toEqual([
    "PricingHeader",
    "PlanCard",
    "PlanCard",
    "FaqList",
  ]);
});

test("a template page is ranked for what it renders, position and nesting included", async () => {
  const { store, html } = await renderSite();

  const rendered = new Map(
    usageIn(pageHtml(html, "/en/pricing")).map((row) => [row.component, row]),
  );

  const ranked = new Map(
    store
      .rankUsage()
      .flatMap(({ component }) => store.listUsage(component))
      .filter((row) => row.locale === "en" && row.path === "pricing")
      .map((row) => [
        row.component,
        {
          component: row.component,
          count: row.count,
          foldScore: row.foldScore,
          depth: row.depth,
          isRoot: row.isRoot,
        },
      ]),
  );

  expect(ranked).toEqual(rendered);
});

test("an untranslated locale renders the supplying locale's content at its own URL", async () => {
  const { html } = await renderSite(AR_FALLS_BACK_TO_EN);

  expect([...html.keys()]).toEqual([
    "/ar/home",
    "/ar/pricing",
    "/de/home",
    "/de/pricing",
    "/en/home",
    "/en/pricing",
  ]);

  // Matched with its delimiters: `data-component="PricingHeader"` holds "Pricing" on every
  // page, German included.
  expect(pageHtml(html, "/ar/pricing")).toContain(">Pricing<");
  expect(pageHtml(html, "/ar/pricing")).not.toContain(">Preise<");
  expect(pageHtml(html, "/ar/pricing")).toBe(pageHtml(html, "/en/pricing"));
  expect(pageHtml(html, "/ar/pricing")).not.toBe(pageHtml(html, "/de/pricing"));

  expect(pageHtml(html, "/ar/home")).toBe(pageHtml(html, "/en/home"));
});
