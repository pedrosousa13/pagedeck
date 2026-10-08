# `@pagedeck/content`

Collections and the content store. A collection names a set of entries and the
loader that fills it. `pagedeck sync` runs each loader and writes the entries
into a SQLite store, and a page reads its entry back from the store at build
time. A loader is the whole interface to your content source: a directory of
markdown files with `@pagedeck/markdown-loader`, or one you write for any
source you can list.

```sh
npm install @pagedeck/content
```

This is the collection a site created with `npm create pagedeck` declares in
`pagedeck.config.ts`:

```ts
import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";

const pages = defineCollection({
  name: "pages",
  loader: defineMarkdownLoader({ root: "./content", locale: "en", languages: ["ts"] }),
  schema: false,
});
```

`schema` has no default. Give it a Standard Schema, and the sync checks every
entry before it stores it. Give it `false`, and the store keeps what the loader
hands over, unchecked.

The config lists the collection in `collections: [pages]`, and its `content`
callback reads each page's entry with `getEntry`. The whole config is in
[`@pagedeck/core`'s README](https://www.npmjs.com/package/@pagedeck/core).

## Read more

- [Write a loader](https://pagedeck-docs.pedrodsousa.workers.dev/how-to/write-a-loader/) covers the loader
  contract, incremental syncs, deletions and schemas.
- [Your first site](https://pagedeck-docs.pedrodsousa.workers.dev/tutorials/your-first-site/) declares a
  collection and builds a site from it.
