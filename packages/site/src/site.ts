import { join } from "node:path";
// A site may name a CSS toolkit: CONTEXT.md's "the framework names no CSS solution"
// binds the framework's own source (#358).
import tailwindcss from "@tailwindcss/vite";
import { defineCollection, getEntry } from "@pagedeck/content";
import type {
  Collection,
  ComponentUsage,
  ContentStoreReader,
} from "@pagedeck/content";
import { components, safelist } from "@pagedeck/design-system";
import { defineComponents } from "@pagedeck/islands";
import type { ComponentDeclarations } from "@pagedeck/islands";
import { defineFontSubset } from "@pagedeck/font-subset";
import { defineSocialImage } from "@pagedeck/social-image";
import {
  defineConfig,
  defineLocales,
  definePages,
  defineScripts,
  fromCollection,
  resolveFoldStrategy,
  SECURITY_HEADERS,
  segments,
} from "@pagedeck/core";
import type {
  FontsSetting,
  LocaleSet,
  SocialImagesSetting,
  Page,
  PageChrome,
  PageContent,
  PageHead,
  Route,
  RoutingConfig,
  ScriptsSetting,
  SiteConfig,
} from "@pagedeck/core";
import { PUBLISHED_ENTRIES } from "./content.js";
import type { PageData } from "./content.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import { PUBLIC_DIR, SITE_IMAGES } from "./images.js";
import { blockUsage, defineEntriesLoader } from "./loader.js";
import { pageContentOf } from "./props.js";

const COLLECTION = "pages";

const HOME = "home";

// `definePages` below declares no `trailingSlash`, so it takes the package
// default; mirrored here because `./props` mints a `LinkField`'s href from its
// target's locale and path, outside `collectPages` (#88).
const TRAILING_SLASH = "always";

// Domain-mapping one locale also unprefixes the other, while `./props` keeps minting
// `/en/…` hrefs (#88).
const LOCALES: LocaleSet = defineLocales({
  en: { label: "English", direction: "ltr" },
  de: { label: "Deutsch", direction: "ltr" },
});

// No `Strict-Transport-Security`: this example is copied onto domains whose HTTPS
// this repository knows nothing about (#318).
const ROUTING: RoutingConfig = {
  redirects: [
    { from: "/en/plans", to: "/en/pricing", status: 301 },
    { from: "/en/terms", to: "/en/legal/terms", status: 301 },
  ],
  headers: [
    {
      prefix: "/",
      set: [
        ...SECURITY_HEADERS,
        { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
      ],
    },
  ],
};

// Measured off a build, not targets. Re-measure rather than raise a failing limit
// (AGENTS.md, "The site port").
const BUDGET: Readonly<Record<string, string>> = {
  "en:/": "0b",
  "de:/": "0b",
  "en:/legal/terms/": "0b",
  "en:/pricing/": "60kb",
};

// Absolute, as are `FAVICON`'s and `FONTS_DIR`'s: three files build `siteConfig` from a
// scratch `pagedeck.config.ts` elsewhere, and these paths resolve against it (#240).
const GLOBAL_CSS = join(import.meta.dirname, "..", "styles", "global.css");

const FAVICON = {
  src: join(import.meta.dirname, "..", "..", "brand", "favicon.ico"),
};

const FONTS_DIR = join(import.meta.dirname, "..", "fonts");
const FONTS: FontsSetting = {
  adapter: defineFontSubset(),
  faces: [
    {
      family: "Fira Sans",
      src: join(FONTS_DIR, "FiraSans-Regular.ttf"),
      weight: 400,
      style: "normal",
      display: "swap",
      aboveFold: true,
      unicodeRanges: [
        "U+0000-00FF",
        "U+0131",
        "U+0152-0153",
        "U+2018-201E",
        "U+2026",
        "U+20AC",
      ],
      fallback: ["Helvetica", "Arial", "sans-serif"],
    },
    {
      family: "Fira Sans",
      src: join(FONTS_DIR, "FiraSans-SemiBold.ttf"),
      weight: 600,
      style: "normal",
      display: "swap",
      unicodeRanges: [
        "U+0000-00FF",
        "U+0131",
        "U+0152-0153",
        "U+2018-201E",
        "U+2026",
        "U+20AC",
      ],
      fallback: ["Helvetica", "Arial", "sans-serif"],
    },
  ],
};

const SOCIAL_IMAGES: SocialImagesSetting = {
  adapter: defineSocialImage({
    fonts: [
      {
        family: "Fira Sans",
        src: join(FONTS_DIR, "FiraSans-Regular.ttf"),
        weight: 400,
      },
      {
        family: "Fira Sans",
        src: join(FONTS_DIR, "FiraSans-SemiBold.ttf"),
        weight: 600,
      },
    ],
  }),
  inputs: (page) =>
    page.entry === undefined ? undefined : { eyebrow: "Framework" },
};

// Each strategy is written twice on purpose: a declaration with none takes the
// `worker` default, and `workerFallbackWarning` names it.
const SCRIPTS: ScriptsSetting = defineScripts({
  scripts: [
    {
      name: "cmp",
      src: "https://consent.example/cmp.js",
      strategy: "idle",
      category: "necessary",
    },
    {
      name: "analytics",
      src: "https://analytics.example/analytics.js",
      strategy: "interaction",
      category: "analytics",
    },
  ],
  pageTypes: { "/**": { cmp: "off", analytics: "off" } },
  pages: { "en:/pricing/": { cmp: "idle", analytics: "interaction" } },
});

const SITE_VIEWPORT = "site_viewport";

function siteComponents(): ComponentDeclarations {
  // Re-declared, not passed through, so this site's config load checks the registry.
  return defineComponents({
    ...components,
    [SITE_VIEWPORT]: "@pagedeck/site/components/site_viewport",
  });
}

function chromeOf(): PageChrome {
  return { before: [{ component: SITE_VIEWPORT }] };
}

function templateUsage(component: string): readonly ComponentUsage[] {
  return [{ component, count: 1, foldScore: 0, depth: 0, isRoot: true }];
}

// `byTemplate` keeps the draft-only `landing_page`: the sync refuses a template with
// no row, the day this site syncs drafts.
function siteCollection(): Collection<PageData> {
  return defineCollection<PageData>({
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
}

// Segments: `[entry.path]` would encode `legal/terms` as one segment,
// `legal%2Fterms` (#161).
function routeOf(entry: { path: string }): Route {
  return entry.path === HOME ? "/" : segments(entry.path);
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
  return pageContentOf(entry.data, {
    images: SITE_IMAGES,
    page,
    trailingSlash: TRAILING_SLASH,
    fold: resolveFoldStrategy(undefined),
  });
}

const DESCRIPTIONS: Readonly<Partial<Record<string, string>>> = {
  "en/home":
    "Ship the site with a build that is fast and small, then see what each plan costs.",
  "de/home": "Bau die Seite mit einem Build, der im Terminal fertig wird.",
  "en/pricing":
    "The two plans and their monthly prices: Starter at 0 and Team at 49, with a yearly option.",
  "en/legal/terms": "The terms that apply to this site.",
};

function headOf(
  collection: Collection<PageData>,
  page: Page,
  store: ContentStoreReader,
): PageHead | undefined {
  const id = page.entry;
  if (id === undefined) return undefined;
  const entry = getEntry(store, collection, id);
  return entry === undefined
    ? undefined
    : {
        title: entry.data.title,
        description: DESCRIPTIONS[`${id.locale}/${id.path}`],
      };
}

// A function, not a value: `defineLocales` validates when called, and an unrelated
// import of this module should not fail for a site's reasons.
export function siteConfig(): SiteConfig {
  const collection = siteCollection();

  return defineConfig({
    store: "./content.db",
    collections: [collection],
    build: {
      // Not `./dist`: `pnpm build` emits this package's JavaScript there.
      outDir: "./site",
      origin: "https://dogfood.example",
      routing: ROUTING,
      css: [GLOBAL_CSS],
      vite: { plugins: [tailwindcss()] },
      pages: definePages({
        locales: LOCALES,
        sources: [fromCollection(collection, { route: routeOf })],
      }),
      components: siteComponents(),
      safelist,
      // Rolldown drops a shared group below `minSize`, and `checkClientGraph` refuses a
      // core tier that captured nothing.
      tierPolicy: { minSize: 0 },
      budget: BUDGET,
      fonts: FONTS,
      favicon: FAVICON,
      passthrough: { root: PUBLIC_DIR },
      socialImages: SOCIAL_IMAGES,
      scripts: SCRIPTS,
      content: (page, store) => contentOf(collection, page, store),
      head: (page, store) => headOf(collection, page, store),
      chrome: () => chromeOf(),
    },
  });
}
