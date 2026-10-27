import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages";
import { defineConfig, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";

const pages = defineCollection({
  name: "pages",
  loader: defineMarkdownLoader({ root: "./content", locale: "en", languages: [] }),
  schema: false,
});

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "layout" })],
    components: {
      layout: "./src/components/layout.tsx",
      signup: "./src/components/signup.tsx",
    },
    favicon: { src: "./favicon.ico" },
    passthrough: { root: "./public" },
    adapter: cloudflarePages(),
    routing: {
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
      upstreams: [{ prefix: "/api/", dev: "http://127.0.0.1:8787", source: "src/app.ts" }],
    },
    // Measured, not chosen: re-measure rather than raise a limit (README.md, "Budgets").
    budget: { "/": "0b", "/signup/": "63kb", "/signup/thanks/": "0b", "/signup/invalid/": "0b" },
  },
});
