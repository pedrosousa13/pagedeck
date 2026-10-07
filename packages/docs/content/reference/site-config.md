---
section: reference
title: Site config
description: The defaults a site config relies on, how a declared value overrides each one, and how a page renders through a layout or a content callback.
---

# Site config

`pagedeck.config.ts` default-exports `defineConfig(...)`. A minimal one names
its collections and, to build, its pages and components:

```ts
export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "article" })],
    components: { article: "./components/article.tsx" },
  },
});
```

Everything else this page lists has a default. A site that declares a field
gets exactly the value it declares, and the default plays no part.

| Field | Default |
| --- | --- |
| `store` | `"./content.db"` |
| `build.outDir` | `"./site"` |
| `locales` in `definePages` | one locale, `en`, labelled `English`, `direction: "ltr"` |
| `trailingSlash` in `definePages` | `"never"` |
| `route` in `fromCollection` | the entry's path, with a last `index` segment dropped |

## The store and the output directory

`store` is the SQLite file `pagedeck sync` writes and every other verb reads.
`build.outDir` is the directory `pagedeck build` writes the site to. Both are
resolved against the directory that holds the config file, not the directory
you run `pagedeck` from.

`build.outDir` defaults only inside a build section. A config with no `build`
has no output directory, so `pagedeck build`, `pagedeck dev` and
`pagedeck rollback` refuse it and say to add one.

## The page set

`build.pages` takes a page set from `definePages`, or a bare list of page
sources:

```ts
pages: [fromCollection(pages)],
```

A bare list is the `sources` of a `definePages` call that declares nothing
else, so it gets the default locale and trailing slash. Moving between the two
is one wrap. Call `definePages` yourself to declare locales or a trailing
slash, or to keep the page set in a variable so a content callback can link
with its `href`:

```ts
const site = definePages({
  trailingSlash: "always",
  locales: defineLocales({
    en: { label: "English", direction: "ltr" },
    de: { label: "Deutsch", direction: "ltr" },
  }),
  sources: [fromCollection(pages)],
});
```

The two settings default independently. A page set that declares `locales`
and no `trailingSlash` spells its routes `"never"`, and one that declares
`trailingSlash` alone has the single `en` locale.

The markdown loader's `locale` has no default. It says which locale the
loader's entries are in, and the page set's default locale does not reach it.
An entry in a locale the page set does not declare fails the build.

## The route of an entry

`fromCollection` with no `route` routes each entry at its path, split into
segments: `legal/terms` routes at `/legal/terms`. An entry whose last segment
is `index` routes at the directory that holds it:

| Entry path | Route |
| --- | --- |
| `index` | `/` |
| `about` | `/about` |
| `docs/index` | `/docs` |
| `docs/install` | `/docs/install` |

`docs/index` routes at `/docs` because that is where a static site author
expects it. A static host answers `/docs` with `docs/index.html`, and a
markdown file at `content/docs/index.md` is the page for that directory. The
rule drops a last `index` segment only when a segment is left, and a lone
`index` routes at `/`, so it never makes an empty or dot segment for the route
table to refuse. An entry at `docs` and one at `docs/index` both route at
`/docs`, and the build fails naming both, as it does for any two entries that
claim one route.

Write a `route` when the URL is not the path. The function you write decides
every route of that source, `index` entries included.

## Rendering a page

`fromCollection(collection, { layout: "article" })` renders each entry of the
collection into the registered component `article`, and passes it the entry's
`title` and `html` as props. The markdown loader writes that shape, and any
loader whose entries carry a string `title` and a string `html` works the same
way.

A page places other components through a `components` list in its frontmatter:

```
---
components: [counter]
---

# Counter
```

The build appends each name to the layout's children, in the order listed,
with no props, and the layout renders them where it puts `children`. A
component with `"use client"` placed this way is an island like any other: its
JavaScript ships to the pages that name it and to no other page.

Each name must be a key of `build.components`. The build looks the name up
there and nowhere else, and never reads a frontmatter value as a module path.
Entry content, which may come from a CMS, can pick from the components the
config registered and cannot import anything. An unregistered name fails the
build, and so does an entry without a string `title` or `html`. The build names
every such entry in one run, lists the registered names, and exits `1`,
because the content is at fault and the config is intact.

The layout itself must be a key of `build.components` too. `pagedeck build`,
`pagedeck dev` and `pagedeck sync` check it when they load the config, and
exit `2` naming every source whose layout is unregistered.

`build.content` renders every other page. The callback gets the page and the
content store, and returns the page's component tree. Each page has one
renderer, chosen by its source: a page whose source names a layout renders
into that layout, and the build never calls the callback for it. A page whose
source names no layout, such as one from `paginate` or `fromTemplate`, goes to
the callback. So the config needs `build.content` when any source names no
layout, and leaves it out when every source names one:

```ts
build: {
  pages: [
    fromCollection(pages, { layout: "article" }),
    paginate({ pageSize: 10, lists: postLists }),
  ],
  components: { article: "./components/article.tsx", list: "./components/list.tsx" },
  content: (page) => ({ template: "list", props: { paging: page.paging } }),
},
```

Write a callback for a collection too when its pages need another tree, or
props from fields other than `title` and `html`: drop that source's `layout`,
and the callback renders its pages.
