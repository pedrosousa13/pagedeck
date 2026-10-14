import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { defineConfig, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";

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
      hello: "./components/hello.tsx",
    },
    favicon: { src: "./favicon.ico" },
    routing: {
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
      upstreams: [{ prefix: "/api/", dev: "http://127.0.0.1:8787", source: "app/" }],
    },
  },
});
