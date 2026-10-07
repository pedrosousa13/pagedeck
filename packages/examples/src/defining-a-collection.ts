// Example: define a collection over a directory of JSON content, sync it, and read back which
// components the site uses.
import { defineCollection, openStore, syncCollection } from "@pagedeck/content";
import type {
  Collection,
  ComponentRanking,
  ContentStore,
  SyncResult,
} from "@pagedeck/content";
import {
  SITE_FIXTURES,
  createFixtureLoader,
  extractTreeUsage,
} from "@pagedeck/fixtures";
import type { FixturePage } from "@pagedeck/fixtures";

export interface DefinedCollection {
  /** Open — the caller closes it. */
  store: ContentStore;
  collection: Collection<FixturePage>;
  sync: SyncResult;
  ranking: ComponentRanking[];
}

export async function defineFixturePages(
  storePath: string,
): Promise<DefinedCollection> {
  const pages = defineCollection<FixturePage>({
    name: "pages",
    // The loader is the whole CMS surface; a real site swaps in one that talks to its CMS.
    loader: createFixtureLoader<FixturePage>(SITE_FIXTURES),
    // Must be synchronous: it runs inside the transaction that writes the entry.
    extractUsage: (entry) =>
      entry.data.mode === "tree" ? extractTreeUsage(entry.data.tree) : [],
    templates: {
      // The template that renders this entry, or undefined to let `extractUsage` walk it.
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      // Naming a template that is missing here is an error, not an empty page.
      byTemplate: {
        PricingPage: [
          {
            component: "PricingTable",
            count: 1,
            foldScore: 0,
            depth: 0,
            isRoot: true,
          },
          {
            component: "FaqList",
            count: 1,
            foldScore: 1,
            depth: 0,
            isRoot: true,
          },
        ],
      },
    },
    // No validation: `querying-with-a-schema.ts` is the schema-bearing case.
    schema: false,
  });

  const store = openStore(storePath);
  // Entries, their usage records and the cursor commit together.
  const sync = await syncCollection(store, pages);

  return { store, collection: pages, sync, ranking: store.rankUsage() };
}
