// Example: a markdown collection whose schema reads data out of the fenced blocks in `body`,
// the Markdown as written, rather than out of the rendered `html`.
import { join } from "node:path";
import { z } from "zod";
import { defineCollection, listEntries, openStore, syncCollection } from "@pagedeck/content";
import type { ContentStore } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const JSON_FENCE = /^```json\n([\s\S]*?)^```$/gm;

const stepSchema = z.object({ keys: z.string(), expect: z.string() });

function parseFences(body: string, ctx: z.RefinementCtx): unknown[] {
  const steps: unknown[] = [];
  for (const [index, fence] of [...body.matchAll(JSON_FENCE)].entries()) {
    try {
      steps.push(JSON.parse(fence[1] as string));
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `json fence ${String(index + 1)} is not JSON — quote every key and string`,
      });
    }
  }
  return steps;
}

const lessonSchema = z
  .object({
    title: z.string(),
    body: z.string().transform(parseFences).pipe(z.array(stepSchema).min(1)),
  })
  .transform(({ title, body }) => ({ title, steps: body }));

function lessons(root: string) {
  return defineCollection({
    name: "lessons",
    loader: defineMarkdownLoader({ root, locale: "en", languages: ["json"] }),
    schema: lessonSchema,
  });
}

export interface LessonSteps {
  /** Open — the caller closes it. */
  store: ContentStore;
  lessons: z.infer<typeof lessonSchema>[];
}

export async function readLessonSteps(storePath: string): Promise<LessonSteps> {
  const collection = lessons(join(FIXTURES, "lessons"));
  const store = openStore(storePath);
  await syncCollection(store, collection);

  return {
    store,
    lessons: listEntries(store, collection).map((entry) => entry.data),
  };
}

// Meant to fail: the lesson's one fence is not JSON.
export async function syncBrokenLesson(storePath: string): Promise<void> {
  const store = openStore(storePath);
  try {
    await syncCollection(store, lessons(join(FIXTURES, "broken-lesson")));
  } finally {
    store.close();
  }
}
