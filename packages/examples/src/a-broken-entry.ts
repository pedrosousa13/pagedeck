// Example: content that fails its collection's schema, and the error that comes back. Meant
// to fail: one fixture article has no `title`, so the sync writes neither article.
import { join } from "node:path";
import { z } from "zod";
import { defineCollection, openStore, syncCollection } from "@pagedeck/content";
import { createFixtureLoader } from "@pagedeck/fixtures";

const BROKEN_FIXTURES = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "broken-article",
);

const articleSchema = z.object({
  title: z.string(),
  publishAt: z.string(),
});

export async function syncBrokenArticle(storePath: string): Promise<void> {
  const articles = defineCollection({
    name: "articles",
    loader: createFixtureLoader<z.infer<typeof articleSchema>>(BROKEN_FIXTURES),
    schema: articleSchema,
  });

  const store = openStore(storePath);
  try {
    await syncCollection(store, articles);
  } finally {
    store.close();
  }
}
