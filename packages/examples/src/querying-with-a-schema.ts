// Example: give a collection a schema, then query it with the entry type the schema describes.
import { join } from "node:path";
import { z } from "zod";
import {
  defineCollection,
  getEntry,
  listDueEntries,
  listEntries,
  openStore,
  syncCollection,
} from "@pagedeck/content";
import type { ContentStore, Entry } from "@pagedeck/content";
import { createFixtureLoader } from "@pagedeck/fixtures";

const ARTICLE_FIXTURES = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "articles",
);

// The collection's entry type follows from this schema.
const articleSchema = z.object({
  title: z.string(),
  /** ISO-8601 UTC, because publication times are compared as text. */
  publishAt: z.string(),
});

export interface ArticleQueries {
  /** Open — the caller closes it. */
  store: ContentStore;
  welcome: Entry<z.infer<typeof articleSchema>> | undefined;
  all: Entry<z.infer<typeof articleSchema>>[];
  due: Entry<z.infer<typeof articleSchema>>[];
}

export async function queryArticles(
  storePath: string,
): Promise<ArticleQueries> {
  const articles = defineCollection({
    name: "articles",
    // No type argument: the entry type is the schema's output, inferred.
    loader:
      createFixtureLoader<z.infer<typeof articleSchema>>(ARTICLE_FIXTURES),
    schema: articleSchema,
    // `listDueEntries` selects on this field in SQL.
    publishField: "publishAt",
  });

  const store = openStore(storePath);
  await syncCollection(store, articles);

  return {
    store,
    // Typed by the collection, so a field-name typo does not compile.
    welcome: getEntry(store, articles, { locale: "en", path: "welcome" }),
    all: listEntries(store, articles),
    // The instant is a parameter, not the clock, so a build is reproducible for a fixed moment.
    due: listDueEntries(store, articles, "2026-08-23T00:00:00Z"),
  };
}
