import { join } from "node:path";
// The site's own CSS toolkit, a `devDependency` of this package; nothing in the
// framework imports it.
import tailwindcss from "@tailwindcss/vite";
import { z } from "zod";
import { defineCollection, getEntry } from "@pagedeck/content";
import type { Collection, ContentStoreReader, Entry } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { defineSearch } from "@pagedeck/search";
import type { MarkdownEntry } from "@pagedeck/markdown-loader";
import {
  defineConfig,
  defineLocales,
  definePages,
  fromCollection,
  SECURITY_HEADERS,
} from "@pagedeck/core";
import type {
  EntryRef,
  Page,
  PageContent,
  PageChrome,
  PageHead,
  PageSource,
  Route,
  SiteConfig,
} from "@pagedeck/core";
import {
  components,
  COUNTER,
  ISLAND_PAGE,
  SITE_FOOTER,
  SITE_HEADER,
} from "./catalog.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import {
  FEATURES_HEAD,
  FEATURES_PATH,
  featuresContent,
  featuresPageSource,
  FONTS,
  PUBLIC_DIR,
  SCRIPTS,
  SOCIAL_IMAGES,
} from "./features.js";
import {
  SERVER_DATA_HEAD,
  SERVER_DATA_PATH,
  serverDataContent,
  serverDataPageSource,
} from "./server_data.js";

const LOCALE = "en";

const TEMPLATE = "landing_page";

const ISLAND_ROUTE = "interactive";

const ISLAND_PATH = `/${ISLAND_ROUTE}`;

const COPY = {
  title: "One island, and the bill for it",
  description:
    "Pagedeck's landing site, second page: one interactive component, bundled and loaded for this page alone, while the front page still ships no JavaScript.",
  intro:
    "This page carries a single interactive component. Everything else on it is HTML the build wrote. The other page of this site still ships no JavaScript at all — an island is planned, bundled and loaded per page, so it is charged to the page that asked for it.",
  label: "Press me",
} as const;

// A placeholder under RFC 2606's `.example` (#288): no docs host is chosen, and
// a relative link would name a page this build does not emit.
const DOCS_ORIGIN = "https://docs.pagedeck.example";

const NAV = {
  home: "/",
  docs: `${DOCS_ORIGIN}/`,
  island: ISLAND_PATH,
  features: FEATURES_PATH,
  serverData: SERVER_DATA_PATH,
} as const;

const LANGUAGES = ["tsx"] as const;

// The `-default` pair: every token of it clears 4.5:1, where `github-light` and
// `github-dark` each have one that does not.
const CODE_THEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

// `src` under Vitest and `dist` under Node, so `..` is this package either way.
const PACKAGE = join(import.meta.dirname, "..");

// Absolute, so a config re-exporting this site from another directory resolves
// the same file.
const GLOBAL_CSS = join(PACKAGE, "styles", "global.css");

// Declared because a browser asks for it unprompted, and Lighthouse scores the
// 404 as a console error.
const FAVICON = { src: join(PACKAGE, "..", "brand", "favicon.ico") };

// Measured, not chosen: re-measure rather than raise a limit (AGENTS.md, "The
// landing site").
const BUDGET = {
  "/": "0b",
  [ISLAND_PATH]: "60kb",
  [FEATURES_PATH]: "62kb",
  [SERVER_DATA_PATH]: "60kb",
} as const;

function documentSchema() {
  return z.object({
    title: z.string().min(1),
    html: z.string(),
    file: z.string(),
    frontmatter: z
      .object({
        // Fifty characters is a floor against a placeholder, not a style rule.
        description: z.string().min(50),
        cta: z.string().min(1),
        ctaHref: z.string().min(1),
        islandCta: z.string().min(1),
        rulerTitle: z.string().min(1),
      })
      .catchall(z.union([z.string(), z.array(z.string()).readonly()])),
  });
}

export type DocumentEntry = z.infer<ReturnType<typeof documentSchema>>;

const TEMPLATE_USAGE = [
  { component: TEMPLATE, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

function documents(): Collection<DocumentEntry, MarkdownEntry> {
  return defineCollection({
    name: "pages",
    loader: defineMarkdownLoader({
      root: join(PACKAGE, "content"),
      locale: LOCALE,
      languages: [...LANGUAGES],
      theme: CODE_THEME,
    }),
    templates: {
      templateOf: () => TEMPLATE,
      byTemplate: { [TEMPLATE]: TEMPLATE_USAGE },
    },
    schema: documentSchema(),
  });
}

// `"/"`, not `[]`, which assembles to an empty route that `collectPages` refuses.
function documentRoute(entry: Entry<DocumentEntry>): Route {
  return entry.path === "index" ? "/" : entry.path.split("/");
}

// `instances` annotates its parameter, which would otherwise infer as `unknown`.
function islandPageSource(): PageSource<Record<string, never>> {
  return {
    instances: (_store: ContentStoreReader) => [
      { locale: LOCALE, params: {}, dependencies: [] as EntryRef[] },
    ],
    route: () => ISLAND_ROUTE,
  };
}

function contentOf(
  page: Page,
  store: ContentStoreReader,
  collection: Collection<DocumentEntry, MarkdownEntry>,
): PageContent {
  if (page.path === FEATURES_PATH) return featuresContent(page);
  if (page.path === SERVER_DATA_PATH) return serverDataContent();
  if (page.path === ISLAND_PATH) {
    return {
      tree: [
        {
          component: ISLAND_PAGE,
          props: { title: COPY.title, intro: COPY.intro },
          children: [{ component: COUNTER, props: { label: COPY.label } }],
        },
      ],
    };
  }

  const id = page.entry;
  if (id === undefined) {
    throw new Error(
      `Page ${page.locale} ${page.path}: has no stored entry, so there is nothing to render — every other page of this site comes from the "${collection.name}" collection`,
    );
  }
  const entry = getEntry(store, collection, id);
  if (entry === undefined) {
    throw new Error(
      `Entry /${id.locale}/${id.path}: is in the route table but not in the store — run pagedeck sync before pagedeck build`,
    );
  }
  return { template: TEMPLATE, props: { ...entry.data, island: ISLAND_PATH } };
}

function headOf(
  page: Page,
  store: ContentStoreReader,
  collection: Collection<DocumentEntry, MarkdownEntry>,
): PageHead | undefined {
  if (page.path === FEATURES_PATH) return FEATURES_HEAD;
  if (page.path === SERVER_DATA_PATH) return SERVER_DATA_HEAD;
  if (page.path === ISLAND_PATH) {
    return { title: COPY.title, description: COPY.description };
  }
  const id = page.entry;
  if (id === undefined) return undefined;
  const entry = getEntry(store, collection, id);
  return entry === undefined
    ? undefined
    : {
        title: `Pagedeck: ${entry.data.title}`,
        description: entry.data.frontmatter.description,
      };
}

function chromeOf(page: Page): PageChrome {
  return {
    before: [{ component: SITE_HEADER, props: { links: NAV, current: page.path } }],
    after: [{ component: SITE_FOOTER, props: { links: NAV } }],
  };
}

// A function, so `defineLocales` and the loader run when called rather than
// when this module is imported.
export function landingSiteConfig(): SiteConfig {
  const collection = documents();

  return defineConfig({
    store: "./content.db",
    collections: [collection],
    build: {
      // Not `./dist`, which `pnpm build` writes and would wipe.
      outDir: "./site",
      // No `Strict-Transport-Security`: it is a promise about a domain this
      // repository does not own.
      routing: {
        headers: [
          {
            prefix: "/",
            set: [
              ...SECURITY_HEADERS,
              { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
            ],
          },
        ],
      },
      css: [GLOBAL_CSS],
      favicon: FAVICON,
      vite: { plugins: [tailwindcss()] },
      pages: definePages({
        trailingSlash: "never",
        locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
        sources: [
          fromCollection(collection, { route: documentRoute }),
          islandPageSource(),
          featuresPageSource(),
          serverDataPageSource(),
        ],
      }),
      components,
      budget: BUDGET,
      passthrough: { root: PUBLIC_DIR },
      search: defineSearch(),
      fonts: FONTS,
      socialImages: SOCIAL_IMAGES,
      scripts: SCRIPTS,
      content: (page, store) => contentOf(page, store, collection),
      head: (page, store) => headOf(page, store, collection),
      chrome: (page) => chromeOf(page),
    },
  });
}
