import { join } from "node:path";
// A fixture site naming its own CSS toolkit: test support is excluded from the
// emit, so no shipped module imports it.
import tailwindcss from "@tailwindcss/vite";
import { defineCollection, getEntry } from "@pagedeck/content";
import type {
  Collection,
  ComponentUsage,
  ContentStoreReader,
} from "@pagedeck/content";
import { PUBLISHED_ENTRIES } from "@pagedeck/site/content";
import type { PageData } from "@pagedeck/site/content";
import { blockUsage, defineEntriesLoader } from "@pagedeck/site/loader";
import { PUBLIC_DIR, SITE_IMAGES } from "@pagedeck/site/images";
import { pageContentOf, propsOf } from "@pagedeck/site/props";
import { defineComponents } from "@pagedeck/islands";
import type { ComponentDeclarations } from "@pagedeck/islands";
import {
  defineConfig,
  defineLocales,
  definePages,
  fromCollection,
  resolveFoldStrategy,
  SECURITY_HEADERS,
  segments,
} from "@pagedeck/core";
import type { Page, PageContent, Route, SiteConfig } from "@pagedeck/core";
// By package name: Node loads this file for `pagedeck`, and a relative `.js` would
// name a file only `tsc` emits (#182).
import { components } from "@pagedeck/design-system";

// Absolute, because the three configs that re-export this site sit at different
// depths.
const GLOBAL_CSS = join(import.meta.dirname, "..", "styles", "global.css");

const COLLECTION = "pages";

function siteComponents(): ComponentDeclarations {
  const hero = components.hero;
  return defineComponents({
    ...components,
    hero:
      typeof hero === "string"
        ? { path: hero, hydrate: "visible" }
        : { ...hero, hydrate: "visible" },
  });
}

// Every template gets a row, synced or not: a name with no row is a
// `CollectionError` at sync time.
function templateUsage(name: string): readonly ComponentUsage[] {
  return [{ component: name, count: 1, foldScore: 0, depth: 0, isRoot: true }];
}

export { propsOf };

// `"/"`, not `[]`, which assembles to an empty route that `collectPages` refuses.
function routeOf(entry: { path: string }): Route {
  return entry.path === "home" ? "/" : segments(entry.path);
}

function contentOf(
  collection: Collection<PageData>,
  page: Page,
  store: ContentStoreReader,
): PageContent {
  const id = page.entry;
  if (id === undefined) {
    throw new Error(
      `Page ${page.locale} ${page.path}: has no stored entry, so there is nothing to render — every page of this site comes from the "${COLLECTION}" collection`,
    );
  }
  const entry = getEntry(store, collection, id);
  if (entry === undefined) {
    throw new Error(
      `Entry /${id.locale}/${id.path}: is in the route table but not in the store — run pagedeck sync before pagedeck build`,
    );
  }
  if (entry.data.mode === "tree") {
    return pageContentOf(entry.data, {
      images: SITE_IMAGES,
      page,
      fold: resolveFoldStrategy(undefined),
    });
  }
  return { template: entry.data.template, props: { ...entry.data } };
}

// A function, so `defineLocales` validates when called rather than when this
// module is imported.
export function testSiteConfig(): SiteConfig {
  const pages = defineCollection<PageData>({
    name: COLLECTION,
    loader: defineEntriesLoader(PUBLISHED_ENTRIES),
    extractUsage: blockUsage,
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: {
        landing_page: templateUsage("landing_page"),
        legal_page: templateUsage("legal_page"),
        pricing_page: templateUsage("pricing_page"),
      },
    },
    schema: false,
  });

  return defineConfig({
    store: "./content.db",
    collections: [pages],
    build: {
      outDir: "./dist",
      // A site that declares no headers warns on stderr (#318).
      routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
      css: [GLOBAL_CSS],
      passthrough: { root: PUBLIC_DIR },
      vite: { plugins: [tailwindcss()] },
      pages: definePages({
        trailingSlash: "never",
        locales: defineLocales({
          en: { label: "English", direction: "ltr" },
          de: { label: "Deutsch", direction: "ltr" },
        }),
        sources: [fromCollection(pages, { route: routeOf })],
      }),
      components: siteComponents(),
      // Rolldown drops a group below `minSize`, and these entries are few enough to
      // leave an empty core tier, which `checkClientGraph` refuses.
      tierPolicy: { minSize: 0 },
      content: (page, store) => contentOf(pages, page, store),
    },
  });
}
