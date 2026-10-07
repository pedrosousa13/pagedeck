import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { defineConfig, fromCollection } from "@pagedeck/core";

const pages = defineCollection({
  name: "pages",
  loader: defineMarkdownLoader({ root: "./content", locale: "en", languages: ["ts"] }),
  schema: false,
});

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "layout" })],
    components: {
      layout: "./components/layout.tsx",
      counter: "./components/counter.tsx",
    },
  },
});
