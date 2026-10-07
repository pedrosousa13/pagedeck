// A function of the site's directory alone, so every rung declares the same wiring.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { defineCollection, getEntry } from "@pagedeck/content";
import type { Collection, ComponentUsage, ContentStoreReader } from "@pagedeck/content";
import {
  defineConfig,
  defineLocales,
  definePages,
  fromCollection,
  SECURITY_HEADERS,
} from "@pagedeck/core";
import type { EntryNode, Page, PageContent, SiteConfig } from "@pagedeck/core";
import { createFixtureLoader, extractTreeUsage } from "@pagedeck/fixtures";
import type { ComponentNode, FixturePage } from "@pagedeck/fixtures";
import { defineComponents } from "@pagedeck/islands";
import type { ComponentDeclarations } from "@pagedeck/islands";
import { SYNTHETIC_LOCALES } from "./locales.js";

const COLLECTION = "pages";

// Each is a bare self-reference: a generated entry resolves against the site's root.
const COMPONENTS: ComponentDeclarations = defineComponents({
  card: "@pagedeck/bench/components/card",
  counter: "@pagedeck/bench/components/counter",
  doc_page: "@pagedeck/bench/components/doc_page",
  section: "@pagedeck/bench/components/section",
});

const DOC_PAGE_USAGE: readonly ComponentUsage[] = [
  { component: "doc_page", count: 1, foldScore: 0, depth: 0, isRoot: true },
];

function entryNode(node: ComponentNode): EntryNode {
  return {
    component: node.component,
    props: node.props ?? {},
    children: (node.children ?? []).map(entryNode),
  };
}

// Read from the store: that read is one of the per-page costs measured.
function contentOf(
  collection: Collection<FixturePage>,
  page: Page,
  store: ContentStoreReader,
): PageContent {
  const id = page.entry;
  if (id === undefined) {
    throw new Error(
      `Page ${page.locale} ${page.path}: has no stored entry, so there is nothing to render — every page of a generated site comes from the "${COLLECTION}" collection`,
    );
  }
  const entry = getEntry(store, collection, id);
  if (entry === undefined) {
    throw new Error(
      `Entry /${id.locale}/${id.path}: is in the route table but not in the store — run pagedeck sync before pagedeck build`,
    );
  }
  if (entry.data.mode === "tree") {
    return { tree: entry.data.tree.map(entryNode) };
  }
  // The entry's data, so `title` reaches `doc_page` beside its `fields`.
  return { template: entry.data.template, props: { ...entry.data } };
}

function localesOf(content: string): readonly { code: string; label: string }[] {
  const found = readdirSync(content, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return found.map((code) => {
    const row = SYNTHETIC_LOCALES.find((one) => one.code === code);
    if (row === undefined) {
      throw new Error(
        `Synthetic site content "${content}": holds a directory "${code}" that is not a locale packages/bench/src/locales.ts names, and defineLocales needs a label for every locale — remove the directory, or add the code and its label to SYNTHETIC_LOCALES`,
      );
    }
    return row;
  });
}

/** A function, so `defineLocales` cannot throw at module load. */
export function syntheticSiteConfig(directory: string): SiteConfig {
  const content = join(directory, "content");
  const pages = defineCollection<FixturePage>({
    name: COLLECTION,
    loader: createFixtureLoader<FixturePage>(content),
    extractUsage: (entry) =>
      entry.data.mode === "tree" ? extractTreeUsage(entry.data.tree) : [],
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { doc_page: DOC_PAGE_USAGE },
    },
    // The corpus's shape is settled by the generator that wrote it.
    schema: false,
  });

  return defineConfig({
    store: "./content.db",
    collections: [pages],
    build: {
      outDir: "./dist",
      // A header set, so the build writes nothing of its own on stderr (#318).
      routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
      pages: definePages({
        locales: defineLocales(
          Object.fromEntries(
            localesOf(content).map((one) => [
              one.code,
              { label: one.label, direction: "ltr" as const },
            ]),
          ),
        ),
        // The default route splits the nested paths into segments.
        sources: [fromCollection(pages)],
      }),
      components: COMPONENTS,
      content: (page, store) => contentOf(pages, page, store),
    },
  });
}
