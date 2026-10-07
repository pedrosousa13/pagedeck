import { readdirSync } from "node:fs";
import { join } from "node:path";
// The site's own CSS toolkit, a `devDependency` of this package; nothing in the
// framework imports it.
import tailwindcss from "@tailwindcss/vite";
import { z } from "zod";
import { defineCollection, getEntry, listEntries } from "@pagedeck/content";
import type {
  Collection,
  CollectionWriter,
  ContentStoreReader,
  Entry,
  Loader,
  SyncResult,
} from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
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
  PageChrome,
  PageContent,
  PageHead,
  PageSource,
  Route,
  SiteConfig,
} from "@pagedeck/core";
import { defineSearch } from "@pagedeck/search";
import {
  components,
  SEARCH_ISLAND,
  SEARCH_PAGE,
  SITE_FOOTER,
  SITE_HEADER,
} from "./catalog.js";
import type { SiteLinks } from "./components/site_footer.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import {
  buildNav,
  refuseUnplaced,
  sectionOf,
  SECTIONS,
} from "./sections.js";
import type { NavDocument, SectionName } from "./sections.js";

const LOCALE = "en";

const TEMPLATE = "doc_page";

const SEARCH_ROUTE = "search";

const SEARCH_PATH = `/${SEARCH_ROUTE}`;

const SEARCH_COPY = {
  title: "Search",
  description:
    "Search Pagedeck's documentation by keyword, with pages that match in their title ranked above pages that match only in their body.",
  intro:
    "Search every page of this documentation. Results are ranked by where the words appear — a title match comes before a body match.",
  label: "Search the documentation",
  emptyLabel: "No page matches those words.",
} as const;

// A placeholder under RFC 2606's `.example` (#288): no landing host is chosen,
// and a relative `/` would name this site's own front page.
const LANDING_ORIGIN = "https://pagedeck.example";

const LINKS: SiteLinks = {
  home: `${LANDING_ORIGIN}/`,
  docs: "/",
  search: SEARCH_PATH,
};

// The `-default` pair: every token of it clears 4.5:1, where `github-light` and
// `github-dark` each have one that does not.
const CODE_THEME = {
  light: "github-light-default",
  dark: "github-dark-default",
} as const;

export const LANGUAGES = ["css", "html", "js", "json", "sh", "ts", "tsx"] as const;

// `src` under Vitest and `dist` under Node, so `..` is this package either way.
const PACKAGE = join(import.meta.dirname, "..");

// Absolute, so a config re-exporting this site from another directory resolves
// the same file.
const GLOBAL_CSS = join(PACKAGE, "styles", "global.css");

// Declared because a browser asks for it unprompted, and Lighthouse scores the
// 404 as a console error.
const FAVICON = { src: join(PACKAGE, "..", "brand", "favicon.ico") };

// Keeps a meta description within the length a search result shows whole.
const DESCRIPTION_LIMIT = 150;

const MISSING_DESCRIPTION = `missing — give the page a "description" in its frontmatter: one sentence saying what the page covers, ${String(DESCRIPTION_LIMIT)} characters at most, which the page emits as its meta description`;

export function documentSchema() {
  const names: readonly SectionName[] = SECTIONS.map(({ name }) => name);
  return z.object({
    title: z.string().min(1),
    html: z.string(),
    file: z.string(),
    // Declared unnarrowed, because a field the schema omits is one no template can
    // read.
    toc: z
      .array(
        z
          .object({
            depth: z.number(),
            text: z.string(),
            slug: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    frontmatter: z
      .object({
        section: z
          .enum(names, {
            error: `not a section of this site — use one of: ${names.join(", ")}`,
          })
          .optional(),
        description: z
          .string({
            // A present value of the wrong type is a list, and calling it missing would send
            // the author looking for a field that is there.
            error: (issue) =>
              issue.input === undefined
                ? MISSING_DESCRIPTION
                : Array.isArray(issue.input)
                  ? "is a list, not one line of text — write the description as a single sentence after the colon, with no brackets"
                  : `is a ${typeof issue.input}, not a string — write the description as a single sentence after the colon`,
          })
          .trim()
          .min(1, { error: MISSING_DESCRIPTION })
          .max(DESCRIPTION_LIMIT, {
            error: (issue) =>
              `${String((issue.input as string).length)} characters, over the ${String(DESCRIPTION_LIMIT)} a meta description is kept to — shorten it to ${String(DESCRIPTION_LIMIT)} or fewer`,
          }),
      })
      .catchall(z.union([z.string(), z.array(z.string()).readonly()])),
  });
}

export type DocumentEntry = z.infer<ReturnType<typeof documentSchema>>;

const TEMPLATE_USAGE = [
  { component: TEMPLATE, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

function markdownLoader(root: string): Loader<MarkdownEntry> {
  return defineMarkdownLoader({
    root,
    locale: LOCALE,
    languages: [...LANGUAGES],
    theme: CODE_THEME,
  });
}

export const REPOSITORY_DOCS = {
  published: ["adr", "deploy-recipe.md", "error-messages.md"],
  excluded: [
    "agents",
    "dogfood-*.md",
    "research",
    "scaling-verification.md",
    "specs",
    "success-criteria.md",
  ],
} as const;

function listed(name: string, list: readonly string[]): boolean {
  return list.some((pattern) => {
    const star = pattern.indexOf("*");
    if (star === -1) return name === pattern;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    return (
      name.length >= head.length + tail.length &&
      name.startsWith(head) &&
      name.endsWith(tail)
    );
  });
}

function refuseUnclassified(root: string): void {
  const unclassified = readdirSync(root)
    .filter(
      (name) =>
        !listed(name, REPOSITORY_DOCS.published) &&
        !listed(name, REPOSITORY_DOCS.excluded),
    )
    .sort();
  if (unclassified.length === 0) return;
  const subject =
    unclassified.length === 1
      ? `1 entry directly under "${root}" is`
      : `${String(unclassified.length)} entries directly under "${root}" are`;
  throw new Error(
    `Docs site: ${subject} on neither of the docs site's lists, so the site cannot tell whether to show ${unclassified.length === 1 ? "it" : "them"} — add each entry to REPOSITORY_DOCS.published to put it on the site, or to REPOSITORY_DOCS.excluded to keep it off the site:\n${unclassified
      .map((name) => `  ${name}`)
      .join("\n")}`,
  );
}

// Filtered at the writer, so an excluded document never reaches the store that
// `pagedeck push` uploads, while every fence under `docs/` is still checked.
export function repositoryLoader(root: string): Loader<MarkdownEntry> {
  const loader = markdownLoader(root);
  const published = (file: string): boolean =>
    listed(file.split("/")[0] ?? file, REPOSITORY_DOCS.published);
  const sync = async (
    run: (
      filtered: CollectionWriter<MarkdownEntry>,
    ) => SyncResult | Promise<SyncResult>,
    writer: CollectionWriter<MarkdownEntry>,
  ): Promise<SyncResult> => {
    const written = new Set<string>();
    const result = await run({
      upsert(entry) {
        if (!published(entry.data.file)) return;
        written.add(entry.path);
        writer.upsert(entry);
      },
      delete: (id) => writer.delete(id),
    });
    refuseUnclassified(root);
    return {
      ...result,
      changed: result.changed.filter((id) => written.has(id.path)),
    };
  };
  return {
    syncAll: (writer) => sync((filtered) => loader.syncAll(filtered), writer),
    syncSince: (writer, cursor) =>
      sync((filtered) => loader.syncSince(filtered, cursor), writer),
  };
}

function documents(
  name: string,
  loader: Loader<MarkdownEntry>,
): Collection<DocumentEntry, MarkdownEntry> {
  return defineCollection({
    name,
    loader,
    templates: {
      templateOf: () => TEMPLATE,
      byTemplate: { [TEMPLATE]: TEMPLATE_USAGE },
    },
    schema: documentSchema(),
  });
}

function collections(): {
  guides: Collection<DocumentEntry, MarkdownEntry>;
  repository: Collection<DocumentEntry, MarkdownEntry>;
} {
  return {
    guides: documents("guides", markdownLoader(join(PACKAGE, "content"))),
    repository: documents(
      "repository",
      repositoryLoader(join(PACKAGE, "..", "..", "docs")),
    ),
  };
}

// `"/"`, not `[]`, which assembles to an empty route that `collectPages` refuses.
function guideRoute(entry: Entry<DocumentEntry>): Route {
  return entry.path === "index" ? "/" : entry.path.split("/");
}

// No prefix, so a link between two documents means the same on the site as in
// the checkout.
function repositoryRoute(entry: Entry<DocumentEntry>): Route {
  return entry.path.split("/");
}

function navDocuments(
  store: ContentStoreReader,
  built: ReturnType<typeof collections>,
): NavDocument[] {
  const documents: NavDocument[] = [];
  for (const [collection, route] of [
    [built.guides, guideRoute],
    [built.repository, repositoryRoute],
  ] as const) {
    for (const entry of listEntries(store, collection)) {
      const segments = route(entry);
      documents.push({
        href: segments === "/" ? "/" : `/${[...segments].join("/")}`,
        entry,
      });
    }
  }
  return documents;
}

function refOf(entry: Entry<DocumentEntry>): EntryRef {
  return {
    collection: entry.collection,
    locale: entry.locale,
    path: entry.path,
  };
}

function everyDocument(
  store: ContentStoreReader,
  built: ReturnType<typeof collections>,
): EntryRef[] {
  return [built.guides, built.repository].flatMap((collection) =>
    listEntries(store, collection).map(refOf),
  );
}

// Every page renders the whole navigation, so every page depends on every
// document; `sharedDependsOn` enumerates them once per build (#200).
function documentSource(
  collection: Collection<DocumentEntry, MarkdownEntry>,
  route: (entry: Entry<DocumentEntry>) => Route,
  built: ReturnType<typeof collections>,
): PageSource<Entry<DocumentEntry>> {
  return fromCollection(collection, {
    route,
    sharedDependsOn: (store) => everyDocument(store, built),
  });
}

// `instances` annotates its parameter, which would otherwise infer as `unknown`.
function searchPageSource(
  built: ReturnType<typeof collections>,
): PageSource<Record<string, never>> {
  return {
    instances: (store: ContentStoreReader) => [
      { locale: LOCALE, params: {}, dependencies: everyDocument(store, built) },
    ],
    route: () => SEARCH_ROUTE,
  };
}

// Run over the whole navigation, so the first page rendered names every
// unplaced document.
function navFor(
  page: Page,
  store: ContentStoreReader,
  built: ReturnType<typeof collections>,
): ReturnType<typeof buildNav> {
  const documents = navDocuments(store, built);
  refuseUnplaced(
    documents
      .filter(({ entry: document }) => sectionOf(document.data) === undefined)
      .map(({ entry: document }) => document.data.file),
  );
  return buildNav(documents, page.path);
}

function contentOf(
  page: Page,
  store: ContentStoreReader,
  built: ReturnType<typeof collections>,
): PageContent {
  if (page.path === SEARCH_PATH) {
    return {
      tree: [
        {
          component: SEARCH_PAGE,
          props: {
            title: SEARCH_COPY.title,
            intro: SEARCH_COPY.intro,
            nav: navFor(page, store, built),
          },
          children: [
            {
              component: SEARCH_ISLAND,
              props: {
                locale: LOCALE,
                label: SEARCH_COPY.label,
                emptyLabel: SEARCH_COPY.emptyLabel,
              },
            },
          ],
        },
      ],
    };
  }

  const id = page.entry;
  if (id === undefined) {
    throw new Error(
      `Page ${page.locale} ${page.path}: has no stored entry, so there is nothing to render — every page of this site comes from a markdown collection`,
    );
  }
  const collection =
    page.collection === built.guides.name ? built.guides : built.repository;
  const entry = getEntry(store, collection, id);
  if (entry === undefined) {
    throw new Error(
      `Entry /${id.locale}/${id.path}: is in the route table but not in the store — run pagedeck sync before pagedeck build`,
    );
  }

  return {
    template: TEMPLATE,
    props: { ...entry.data, nav: navFor(page, store, built) },
  };
}

function headOf(
  page: Page,
  store: ContentStoreReader,
  built: ReturnType<typeof collections>,
): PageHead | undefined {
  if (page.path === SEARCH_PATH) {
    return {
      title: SEARCH_COPY.title,
      description: SEARCH_COPY.description,
    };
  }
  const id = page.entry;
  if (id === undefined) return undefined;
  const collection =
    page.collection === built.guides.name ? built.guides : built.repository;
  const entry = getEntry(store, collection, id);
  return entry === undefined
    ? undefined
    : {
        title: entry.data.title,
        description: entry.data.frontmatter.description,
      };
}

function chromeOf(page: Page): PageChrome {
  return {
    before: [{ component: SITE_HEADER, props: { links: LINKS, current: page.path } }],
    after: [{ component: SITE_FOOTER, props: { links: LINKS } }],
  };
}

// A function, so `defineLocales` and the loaders run when called rather than
// when this module is imported.
export function docsSiteConfig(): SiteConfig {
  const built = collections();

  return defineConfig({
    store: "./content.db",
    collections: [built.guides, built.repository],
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
          documentSource(built.guides, guideRoute, built),
          documentSource(built.repository, repositoryRoute, built),
          searchPageSource(built),
        ],
      }),
      components,
      content: (page, store) => contentOf(page, store, built),
      head: (page, store) => headOf(page, store, built),
      chrome: (page) => chromeOf(page),
      search: defineSearch(),
    },
  });
}
