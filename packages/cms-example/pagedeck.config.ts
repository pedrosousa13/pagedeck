import { z } from "zod";
import { defineCollection, getEntry } from "@pagedeck/content";
import type { ContentStoreReader } from "@pagedeck/content";
import { defineConfig, fromCollection } from "@pagedeck/core";
import type { Page } from "@pagedeck/core";
// By package name: Node loads this file with types stripped, and a relative `.js` would
// name a file only `tsc` emits (#182).
import { defineExampleCmsLoader } from "@pagedeck/cms-example";

const block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hero"), heading: z.string(), text: z.string() }),
  z.object({ type: z.literal("rich_text"), paragraphs: z.array(z.string()) }),
  z.object({
    type: z.literal("feature_grid"),
    features: z.array(z.object({ title: z.string(), text: z.string() })),
  }),
  z.object({
    type: z.literal("faq"),
    questions: z.array(z.object({ question: z.string(), answer: z.string() })),
  }),
  z.object({
    type: z.literal("signup_form"),
    label: z.string(),
    button: z.string(),
    confirmation: z.string(),
  }),
]);

const pages = defineCollection({
  name: "pages",
  loader: defineExampleCmsLoader({
    endpoint: process.env["PAGEDECK_CMS_EXAMPLE_URL"] ?? "http://127.0.0.1:4310/",
    locale: "en",
  }),
  schema: z.object({ title: z.string(), blocks: z.array(block) }),
});

function pageOf(page: Page, store: ContentStoreReader) {
  const entry = page.entry === undefined ? undefined : getEntry(store, pages, page.entry);
  if (entry === undefined) {
    throw new Error(
      `Page ${page.locale} ${page.path}: has no stored entry — run pagedeck sync before pagedeck build`,
    );
  }
  return entry.data;
}

export default defineConfig({
  collections: [pages],
  build: {
    pages: [
      fromCollection(pages, { route: (entry) => (entry.path === "home" ? "/" : entry.path) }),
    ],
    components: {
      hero: "./src/components/hero.tsx",
      rich_text: "./src/components/rich_text.tsx",
      feature_grid: "./src/components/feature_grid.tsx",
      faq: "./src/components/faq.tsx",
      signup_form: "./src/components/signup_form.tsx",
    },
    // Measured, not chosen: re-measure rather than raise a limit (README.md, "Budgets").
    budget: { "/": "0b", "/faq/": "60kb", "/signup/": "60kb" },
    head: (page, store) => ({ title: pageOf(page, store).title }),
    // A block's type is the name of the component that renders it, and the schema admits
    // only the five registered here.
    content: (page, store) => ({
      tree: pageOf(page, store).blocks.map(({ type, ...props }) => ({ component: type, props })),
    }),
  },
});
