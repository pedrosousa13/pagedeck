// Example: build a route table from a collection, a literal list and a route template, then
// link to one of the pages with `href`. `collectDefaultedPages` below is the same table built on
// the defaults.
import {
  collectPages,
  defineLocales,
  definePages,
  fromCollection,
  fromTemplate,
  segments,
} from "@pagedeck/core";
import type { Page } from "@pagedeck/core";
import { defineCollection, openStore, syncCollection } from "@pagedeck/content";
import type { ContentStore, EntryId } from "@pagedeck/content";
import { defineFixturePages } from "./defining-a-collection.js";

// Two locales share the default tree, so each gets a path prefix and `output` differs from
// `path`.
const LOCALES = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr" },
});

// `slug` holds a `/` on purpose: routed as segments, it stays one segment.
const LEGAL_ROUTES = [
  { locale: "en", slug: "terms" },
  { locale: "en", slug: "privacy/cookies" },
  { locale: "de", slug: "impressum" },
];

// `version` is one segment, and `path` a catch-all of however many.
const DOCS_PAGES = [
  { locale: "en", version: "v2", path: ["guide", "intro"] },
  { locale: "de", version: "v2", path: ["anleitung"] },
];

export interface CollectedPages {
  /** Open — the caller closes it. */
  store: ContentStore;
  pages: Page[];
  introLink: string;
}

export async function collectSitePages(
  storePath: string,
): Promise<CollectedPages> {
  const { store, collection } = await defineFixturePages(storePath);

  const pages = definePages({
    sources: [
      // Collection-backed: one route per entry, and `fromCollection` fills in the dependencies
      // and the template.
      fromCollection(collection, {
        // `segments`, not `[entry.path]`: `legal/terms` is two segments, and a one-element route
        // would encode the `/`.
        route: (entry) => (entry.path === "home" ? "/" : segments(entry.path)),
        // What each page's render reads beyond its own entry, declared so the build knows what to
        // rebuild.
        dependsOn: (entry) => [
          { collection: "pages", locale: entry.locale, path: "nav" },
        ],
        // What a reader may go to next, a different list: `build.speculation` prefetches from this one.
        // `nav` is a dependency of every page and a destination of none.
        relatesTo: (entry) =>
          entry.path === "home"
            ? [{ collection: "pages", locale: entry.locale, path: "pricing" }]
            : [],
      }),
      // Store-free: `instances` takes no store, because there is nothing to read.
      {
        instances: () =>
          LEGAL_ROUTES.map((route) => ({
            locale: route.locale,
            params: route,
            // No entry backs these pages, so nothing invalidates them.
            dependencies: [],
          })),
        route: ({ params }) => ["legal", params.slug],
      },
      // Template-backed: the template is the route, and the params are checked against its names.
      fromTemplate("/docs/[version]/[...path]", () =>
        DOCS_PAGES.map((page) => ({
          locale: page.locale,
          params: { version: page.version, path: page.path },
          dependencies: [],
        })),
      ),
    ],
    // How the site writes URLs, decided once for every source.
    trailingSlash: "never",
    locales: LOCALES,
  });

  // The locale is last, and required because the site declares two.
  const introLink = pages.href(
    "/docs/[version]/[...path]",
    { version: "v2", path: ["guide", "intro"] },
    "en",
  );

  // Two pages claiming one URL, or an undeclared locale, is refused here, before anything
  // renders.
  return { store, pages: collectPages(store, pages), introLink };
}

const SITE_PATHS = ["index", "about", "docs/index"];

export async function collectDefaultedPages(
  storePath: string,
): Promise<{ store: ContentStore; pages: Page[] }> {
  const site = defineCollection<{ title: string }>({
    name: "site",
    loader: {
      syncAll: (writer) => {
        const changed: EntryId[] = SITE_PATHS.map((path) => ({
          locale: "en",
          path,
        }));
        for (const id of changed) {
          writer.upsert({ ...id, data: { title: id.path } });
        }
        return { changed, deleted: [], cursor: 1 };
      },
      syncSince: () => ({ changed: [], deleted: [], cursor: 1 }),
    },
    schema: false,
  });
  const store = openStore(storePath);
  await syncCollection(store, site);

  // No `route`: `index` routes at `/` and `docs/index` at `/docs`. No `locales` or
  // `trailingSlash`: one locale, `en`, and a trailing slash on every route but `/`.
  const pages = definePages({ sources: [fromCollection(site)] });

  return { store, pages: collectPages(store, pages) };
}
