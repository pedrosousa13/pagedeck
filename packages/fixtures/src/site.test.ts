import { afterEach, expect, test } from "vitest";
import { loadFixtureStore } from "./harness.js";
import type { FixtureStore } from "./harness.js";
import { SITE_FIXTURES } from "./site.js";
import type { ComponentNode, FixturePage } from "./site.js";

const opened: FixtureStore<FixturePage>[] = [];

async function openSite(): Promise<FixtureStore<FixturePage>> {
  const fixture = await loadFixtureStore<FixturePage>({
    directory: SITE_FIXTURES,
  });
  opened.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of opened.splice(0)) {
    fixture.close();
  }
});

function componentNames(nodes: ComponentNode[]): string[] {
  return nodes.flatMap((node) => [
    node.component,
    ...componentNames(node.children ?? []),
  ]);
}

test("the checked-in site fixtures sync end to end into a store", async () => {
  const fixture = await openSite();

  const entries = fixture.store.listEntries<FixturePage>("pages");
  expect(entries.map((entry) => `${entry.locale}/${entry.path}`)).toEqual([
    "de/home",
    "de/pricing",
    "en/home",
    "en/pricing",
  ]);
});

test("the site fixtures cover both page modes in both locales", async () => {
  const fixture = await openSite();

  for (const locale of ["en", "de"]) {
    const home = fixture.store.getEntry<FixturePage>("pages", locale, "home");
    expect(home?.data.mode).toBe("tree");
    const pricing = fixture.store.getEntry<FixturePage>(
      "pages",
      locale,
      "pricing",
    );
    expect(pricing?.data.mode).toBe("template");
  }
});

test("the tree-driven fixtures nest, so usage extraction has something to walk", async () => {
  const fixture = await openSite();

  const home = fixture.store.getEntry<FixturePage>("pages", "en", "home");
  if (home?.data.mode !== "tree") throw new Error("en/home must be tree-driven");
  expect(componentNames(home.data.tree)).toEqual([
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
});

test("the template-driven fixtures name a template and carry schema-shaped fields", async () => {
  const fixture = await openSite();

  const pricing = fixture.store.getEntry<FixturePage>("pages", "de", "pricing");
  if (pricing?.data.mode !== "template") {
    throw new Error("de/pricing must be template-driven");
  }
  expect(pricing.data.template).toBe("PricingPage");
  expect(pricing.data.fields.plans).toHaveLength(2);
});
