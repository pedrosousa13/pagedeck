// Example: a markdown collection whose schema reads data out of the fenced blocks in `body`,
// the Markdown as written, rather than out of the rendered `html`.
import { join } from "node:path";
import { z } from "zod";
import { defineCollection, listEntries, openStore, syncCollection } from "@pagedeck/content";
import type { ContentStore } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";

const LESSONS = join(import.meta.dirname, "..", "fixtures", "lessons");

const JSON_FENCE = /^```json\n([\s\S]*?)^```$/gm;

const stepSchema = z.object({ keys: z.string(), expect: z.string() });

// A step that does not parse fails the sync with the lesson's file named beside its id.
const lessonSchema = z
  .object({
    title: z.string(),
    body: z
      .string()
      .transform((body) =>
        [...body.matchAll(JSON_FENCE)].map((fence): unknown => JSON.parse(fence[1] ?? "")),
      )
      .pipe(z.array(stepSchema).min(1)),
  })
  .transform(({ title, body }) => ({ title, steps: body }));

export interface LessonSteps {
  /** Open — the caller closes it. */
  store: ContentStore;
  lessons: z.infer<typeof lessonSchema>[];
}

export async function readLessonSteps(storePath: string): Promise<LessonSteps> {
  const lessons = defineCollection({
    name: "lessons",
    loader: defineMarkdownLoader({ root: LESSONS, locale: "en", languages: ["json"] }),
    schema: lessonSchema,
  });

  const store = openStore(storePath);
  await syncCollection(store, lessons);

  return {
    store,
    lessons: listEntries(store, lessons).map((entry) => entry.data),
  };
}
