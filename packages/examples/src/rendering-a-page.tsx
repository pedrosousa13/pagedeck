// Example: render one page's entry to static HTML. Content is escaped, components never fetch,
// and each `"use client"` island renders in its own pass inside an `<fw-island>` marker.
import { renderPage } from "@pagedeck/core";
import type { EntryNode, PlacedLocale } from "@pagedeck/core";
// The components live in a module of their own, which the preview target bundles for a browser.
import {
  AddToCart,
  Hero,
  PricingPage,
  RichText,
  Stats,
  Tabs,
  Tagline,
  ThemeProvider,
} from "./site-components.js";
import { use } from "react";
import type { ComponentRegistry } from "@pagedeck/islands";

// `PageContext.path`, rooted; the store keys this page as `home`.
const PAGE = { locale: "en", path: "/home" } as const;

// The locale `defineLocales` placed; the render refuses one whose code is not the page's.
const LOCALE: PlacedLocale = {
  code: "en",
  label: "English",
  direction: "ltr",
  prefix: "",
};

// `component` is a registry key, so moving a module never rewrites content.
const TREE: readonly EntryNode[] = [
  {
    component: "Hero",
    props: { headline: "Ship faster" },
    children: [
      // Typed by an editor who pasted a payload into a plain text field.
      { component: "Tagline", props: { text: "<script>alert(1)</script>" } },
    ],
  },
  // Rich text: the field's value is HTML the CMS already sanitised.
  { component: "RichText", props: { body: "<p>Read the <em>docs</em>.</p>" } },
  { component: "Stats" },
  // Interactive, with nested children, so a container island: each child is a slot.
  {
    component: "Tabs",
    props: { open: 0 },
    children: [
      // An island in a slot. It is a root of its own, not part of the
      // container's, so it hydrates on its own schedule.
      { component: "AddToCart", props: { sku: "fw-tee" } },
      // The unopened panel, stashed as the escaped text of a `<template>`.
      { component: "Tagline", props: { text: "Ships in two days" } },
    ],
  },
];

const PRICING_FIELDS = {
  title: "Pricing",
  plans: [
    { id: "starter", name: "Starter", price: 0 },
    { id: "team", name: "Team", price: 49 },
  ],
};

export interface ExampleIsland {
  component: string;
  prefix: string;
  html: string;
  mode: string;
  /** Absent for an instance the entry tree does not name. */
  path?: readonly number[];
}

export interface RenderedExample {
  html: string;
  templateHtml: string;
  islands: readonly ExampleIsland[];
  fetchDuringRender: string;
}

export async function renderExamplePage(): Promise<RenderedExample> {
  // renderPage takes the loaded registry, which loadConfig derives from a site's
  // path declarations; a site never writes one. Only this page's components load.
  const registry = {
    Hero: { import: async () => ({ default: Hero }) },
    Tagline: { import: async () => ({ default: Tagline }) },
    RichText: { import: async () => ({ default: RichText }) },
    Stats: { import: async () => ({ default: Stats }) },
    AddToCart: { import: async () => ({ default: AddToCart }) },
    Tabs: { import: async () => ({ default: Tabs }) },
    // A template is registered like any component; a page type names it.
    PricingPage: { import: async () => ({ default: PricingPage }) },
    // Registered, referenced by no node on this page, and never imported.
    Carousel: { import: async () => ({ default: Hero }) },
  } satisfies ComponentRegistry;

  const { html, islands } = await renderPage({
    page: PAGE,
    // Only the page's own pass carries the locale; the build refuses an island that reads it.
    locale: LOCALE,
    tree: TREE,
    registry,
    // What the build's `"use client"` scan found.
    modules: { AddToCart: { useClient: true }, Tabs: { useClient: true } },
    // Outermost first: `providers[0]` wraps everything below it.
    providers: [{ component: ThemeProvider, props: { theme: "dark" } }],
    // Resolved by the collection's loader, before this call.
    data: { stats: { pages: 4 } },
  });

  // The other page mode: one template, with the entry's fields as its props.
  const { html: templateHtml } = await renderPage({
    page: { locale: "en", path: "/pricing" },
    template: "PricingPage",
    props: PRICING_FIELDS,
    registry,
    providers: [{ component: ThemeProvider, props: { theme: "dark" } }],
  });

  // A component awaiting its own IO is refused, naming it; the promise stands in for a `fetch`.
  function Weather() {
    const forecast = use<string>(
      new Promise((resolve) => {
        setTimeout(() => resolve("sunny"), 100);
      }),
    );
    return <p>{forecast}</p>;
  }
  let fetchDuringRender = "no error";
  try {
    await renderPage({
      page: PAGE,
      tree: [{ component: "Weather" }],
      registry: {
        Weather: { import: async () => ({ default: Weather }) },
      },
    });
  } catch (error) {
    fetchDuringRender = (error as Error).message;
  }
  // Each `prefix` derives from the page and the node's position, so any worker computes the same.
  return {
    html,
    templateHtml,
    islands: islands.map((island) => ({
      component: island.component,
      prefix: island.prefix,
      html: island.html,
      mode: island.mode,
      path: island.path,
    })),
    fetchDuringRender,
  };
}
