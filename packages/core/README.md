# `@pagedeck/core`

The `pagedeck` command and the site config. `defineConfig` declares where the
content store is, which collections fill it, which pages the site has, and how
each page renders. `pagedeck sync` fills the store, `pagedeck dev` serves the
site while you edit, and `pagedeck build` writes the finished site.

```sh
npm install @pagedeck/core @pagedeck/content @pagedeck/markdown-loader @pagedeck/islands react react-dom
```

`npm create pagedeck` writes this `pagedeck.config.ts` for a new site:

```ts
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
```

Each entry renders into the `layout` component, with its `title` and `html` as
props. A page that needs an interactive component names it in its frontmatter,
as the site's `content/counter.md` does with `components: [counter]`.

Then, from the site's directory:

```sh
npx pagedeck sync
npx pagedeck build
```

The `pagedeck` command loads `pagedeck.config.ts` and your `.tsx` and `.jsx`
components with no build step of their own. It needs Node 22.18 or later. On
Node 23, it needs 23.7 or later.

## Read more

- [The pagedeck command](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/cli.md) lists every verb,
  its flags and its exit codes.
- [Site config](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/site-config.md) lists the defaults
  this config relies on and how to override each one.
- [Routing](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/routing.md),
  [Page head](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/page-head.md) and the other pages in
  [reference](https://github.com/pedrosousa13/pagedeck/tree/main/packages/docs/content/reference) cover more of the `build` fields.
