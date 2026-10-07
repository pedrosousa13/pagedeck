# `@pagedeck/search`

A build-time search index over a site's rendered pages, and the browser half
that queries it. The site declares the adapter, and the build hands it every
page it rendered.

```sh
npm install @pagedeck/search
```

```ts
import { defineSearch } from "@pagedeck/search";

// In the site's config, inside build:
search: defineSearch(),
```

The index is written as files under `/search/<locale>/`: `index.json`,
`documents.json` and the term shards. `@pagedeck/search/query`'s `createSearchClient`
reads them in a reader's browser, and `@pagedeck/search/island` is the search island
that calls it.

To show a search box, declare the island by its package specifier:

```ts
// In the site's config, inside build.components:
search: { path: "@pagedeck/search/island", hydrate: "idle" },
```

Then render it from a page's tree. It takes three props, all required:

```ts
{
  component: "search",
  props: { locale: "en", label: "Search the site", emptyLabel: "No pages match" },
},
```

[Site search](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/site-search.md) covers what the island
does with each prop, and what the index holds.

## What a page contributes

Each page's title, its headings and the text under them. The text is read from
the page's rendered body, and these are left out:

- `<script>`, `<style>` and `<template>` contents.
- An element marked `hidden`, or `aria-hidden="true"`, and everything inside
  it. The attribute also hides it from a reader or from assistive technology.
- An element marked `data-fw-search="ignore"`, and everything inside it
  (issue #566). The page does not change: a reader and assistive technology
  get the element as before.

Use `data-fw-search="ignore"` on the parts of a template that are not the
page's own words: a navigation that lists every page's title, a
previous/next pager, a label that is the same on every page. Without it, a
search for one page's name finds every page that links to it.

```tsx
<nav aria-label="Documentation" data-fw-search="ignore">…</nav>
```

Only the value `ignore` has this effect. `data-fw-search=""` and other values
are indexed as usual.

### Content cannot use it

The attribute is for a site's own templates. `unescapedHtml` from
`@pagedeck/core/tree`, the sanctioned way to put rich text into a page, removes
`data-fw-search` from content, with any value. A rich-text field therefore
cannot hide its own text, or a page's content, from the search. This also
applies when the name is written in prose: rich text rendered through
`unescapedHtml` cannot show the text `data-fw-search`.

Content that reaches a page through some other door is not stripped. There
are two: a site's own `dangerouslySetInnerHTML`, and a site rendering
`SlotContent` from `@pagedeck/islands` with a string of its own.

## The index files

The indexer (`src/shards.ts`) writes these files and the query runtime
(`src/query.ts`) reads them, so a change to one is a change to both. The two
share only `src/tokens.ts` and `src/fields.ts`, which import nothing:
`src/shards.ts` imports `@pagedeck/core` and must not reach a browser bundle.

Every file is JSON under `/search/<locale>/`, one directory per locale, in the
output tree of the locale's domain. The leading slash is part of each path, so
`fileKey` keeps a domain and the path apart.

- `index.json`: `{ "format": 1, "locale", "documents": "documents.json",
  "shards": [{ "file", "first", "last" }] }`. The shard ranges are closed,
  disjoint and rising, so a query fetches only the shards that can hold a term.
  A reader refuses a `format` it does not know, with a different fix for an
  older and a newer index.
- `documents.json`: an array of `{ "path", "output", "title"? }`, ordered by
  path. A document's id is its position, so ids move when a page is added
  before it. `output` is the URL a result links to; `path` is the route.
- `terms-NNNN.json`: an array of `[term, postings]` pairs, sorted by term in
  code-unit order so a reader can binary search it. An array, because an object
  reorders integer-like keys such as `2024`. A posting is
  `{ "d": id, "f": frequency, "w": fields }`, where `w` is a bitmask: 1 title,
  2 heading, 4 body.

A shard holds at most 64 KiB of JSON (`SHARD_CAP`), except that a term whose
postings exceed that gets a shard of its own. `QUERY_CAP` is what one keystroke
may fetch: two full shards, for a prefix that straddles a boundary, plus 16 KiB
for `index.json` and `documents.json`. Nothing enforces it at build time
(#457). A site holds its own built index to it in a build test.
