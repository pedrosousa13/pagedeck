---
section: reference
title: Site search
description: The @pagedeck/search package indexes a site's pages at build time, and its island loads the index files only when a reader uses the search box.
---

# Site search

`@pagedeck/search` indexes the text of every page a build renders and writes the
index as static JSON files beside the pages. A search island reads those files
in the reader's browser. Nothing runs on a server, and a page that does not
render the island ships none of its JavaScript.

The package has two halves:

- `@pagedeck/search` gives `defineSearch()`, the adapter a site declares as
  `build.search`. It runs in `pagedeck build`.
- `@pagedeck/search/island` is the search box, and `@pagedeck/search/query` is the query
  code the island calls. They run in the browser.

## Declaring the index

```ts
import { defineSearch } from "@pagedeck/search";

// In the site's config, inside `build`:
search: defineSearch(),
```

`defineSearch()` takes no options. The tokenizer runs twice, at build time over
the pages and in the browser over what the reader types, and the shard size is
written into the files the browser reads. An option could make the two halves
disagree, and a query that finds nothing looks the same as a page that does not
contain the word. So there is nothing to configure.

A site that does not declare `build.search` gets no index, and its build output
is the same as before the field existed.

## What the index contains

For each page, three fields:

- **The title**: the `title` the site's `head` callback returns for the page.
  A page with no title is indexed without one. See
  [Page head](./page-head.md).
- **The headings**: the text of each `<h1>` to `<h6>` in the page.
- **The body**: the rest of the page's text.

The text comes from the page's own rendered tree, which is what the build puts
inside `<main>`. The document around it is not read: not the `<head>`, not the
script tags, and not the chrome a site declares with `build.chrome`, which the
build writes before and after `<main>`. A header or footer declared as chrome is
therefore never indexed. See
[Page body](./page-body.md#chrome-markup-beside-the-landmark).

Inside the page's tree, the index leaves out:

- The contents of `<script>`, `<style>` and `<template>` elements.
- An element with the `hidden` attribute, and everything inside it. Any
  value hides, `hidden="false"` included, as it does in a browser.
- An element with `aria-hidden="true"`, and everything inside it. Other values,
  such as `aria-hidden="false"`, do not hide.
- An element that carries the attribute named by `SEARCH_ATTRIBUTE` with the
  value `"ignore"`, and everything inside it. See the next section.
- Comments and the doctype.

An inline `style="display:none"` does not hide text from the index, and
neither does a class that hides an element. The index reads the page's markup
and not its stylesheets.

A heading inside a left-out element opens no section. Its text is not indexed.

## Keeping template text out of the index

Some text inside `<main>` is not the page's own words: a navigation that lists
every page's title, a previous and next pager, a label that is the same on
every page. If it is indexed, a search for one page's name finds every page
that links to it.

`SEARCH_ATTRIBUTE`, exported from `@pagedeck/core/tree`, is the name of the attribute
that keeps such an element out of the index. Give it the value `"ignore"`. The
element and everything inside it are left out of the index, and nothing else
changes: readers and assistive technology get the element as before. This site
spreads it onto its navigation, its pager and its source line:

```tsx
import { SEARCH_ATTRIBUTE } from "@pagedeck/core/tree";

export const UNINDEXED = { [SEARCH_ATTRIBUTE]: "ignore" } as const;

<nav className="fw-docnav" aria-label="Documentation" {...UNINDEXED}>
```

Only the value `"ignore"` has this effect. An empty value or any other value is
indexed as usual.

**The attribute is for a site's templates, not for content.** `unescapedHtml`
from `@pagedeck/core/tree`, the way rich text reaches a page, removes the attribute
from content whatever its value. A rich-text field therefore cannot hide its
own text, or the rest of the page, from search. The same removal applies to
text: a page rendered through `unescapedHtml`, like this one, cannot show the
attribute's name. That is why this page names it through the constant.

Content that reaches a page another way, such as a site's own
`dangerouslySetInnerHTML`, is not changed.

## How text becomes terms

- Text is lowercased and normalized to Unicode NFC.
- A term is a run of Unicode letters, combining marks and numeric characters
  (digits, and characters such as `²` and `Ⅻ`). Anything else separates terms.
- Nothing is stemmed and no stop words are dropped. `loaders` and `loader` are
  different terms. The query side covers part of this with a prefix match; see
  "How a query is answered" below.
- Chinese, Japanese and Thai text is not split into words. A run of those
  characters is one term.

## Where the index is written

The build writes the index into the output directory, one directory per locale:

- `/search/<locale>/index.json`: the format version and the range of terms each
  shard holds. It is the first file a query fetches.
- `/search/<locale>/documents.json`: one record per page, with its path, the URL
  it is served at, and its title.
- `/search/<locale>/terms-0000.json`, `terms-0001.json` and so on: the shards.
  Each holds a sorted range of terms and, for each term, the pages that contain
  it, how often, and in which fields.

A shard holds about 64 KiB of JSON: a term goes into a new shard when adding
it would take the current one past 64 KiB. A single term whose entries are
larger than that gets a shard of its own, and that shard is larger.

On a site that publishes to more than one domain, each domain's output tree
gets its own `/search/` directory with the locales of the pages in that tree.

The index files are ordinary output files. They are hashed and recorded in the
build manifest, so a deploy uploads and prunes them with the pages. If a page or
another file of the build is already at one of these paths, the build fails and
names the path. A page at `/search` itself is fine: it is written to
`/search/index.html`, which is not an index path.

On an incremental build, a locale directory is written again, whole, only when
one of its pages was rendered again or removed. The other directories are
carried over unchanged.

## The search island

Declare the island in the site's `components` by its package specifier, with
`hydrate: "idle"`. Hydrating fetches no index file, so the island can be ready
before the reader reaches it without costing a request:

```ts
// In `components`:
search: { path: "@pagedeck/search/island", hydrate: "idle" },
```

Then place it as a node of the page's entry tree, as the sites in this
repository do:

```ts
// SEARCH is the island's registry name, "search".
{
  component: SEARCH,
  props: {
    locale: "en",
    label: COPY.search.label,
    emptyLabel: COPY.search.emptyLabel,
  },
},
```

The island takes three props, and all three are required:

| Prop | What it is |
| --- | --- |
| `locale` | Which locale's index to search: the `<locale>` directory under `/search/`. |
| `label` | The text of the input's `<label>`, and the accessible name of the results list. |
| `emptyLabel` | The message shown when a query finds nothing. |

The island renders a search input with `role="combobox"` and, when a query
matches, a list with `role="listbox"` whose options are links. Each result
links to the URL the page is served at, and shows the page's title, or its path
when the page has no title.

- The arrow keys move through the results while focus stays in the input.
- Enter follows the active result.
- Escape closes the list and keeps the query in the input.
- A query that finds nothing shows `emptyLabel` in a `role="status"`
  paragraph.

If an index file cannot be fetched, the island reports the error to the
browser console and shows `emptyLabel`. The message names the file and the
status.

Fold strategy does not change an `idle` island. See
[Fold strategy](./fold-strategy.md).

## Loading on focus

The island fetches nothing when it hydrates. The requests start when the
reader uses it:

1. **Focus** fetches `index.json`, the shard ranges, and no shard. A reader
   who focuses the box and leaves has paid for that one small file.
2. **Typing** fetches only the shards whose range can hold the words typed.
   A word outside every range fetches no shard at all.
3. **The first match** fetches `documents.json`, once.

Every file is fetched at most once per page view. Two keystrokes that need the
same shard make one request.

The index files are requested from the origin the page is served from, at
`/search/<locale>/`. A site with a Content Security Policy needs `connect-src`
to allow that origin. This site's policy sets `connect-src 'self'`.

## How a query is answered

- The query is split into terms by the same rules as the index.
- Every term must be on a page for the page to match.
- The last term matches as a prefix, because the reader may still be typing it.
  The terms before it must match exactly.
- For each term, a page scores the number of times the term occurs on it,
  multiplied by the weights of the fields it occurs in, added together: 10 for
  the title, 4 for a heading and 1 for the body. The page's score is the sum
  over the query's terms. A title match weighs more than a body match, but a
  page that uses a word often in its body can still rank above a page with
  the word once in its title.
- Results with equal scores are listed in path order.

An index written in a format version the query code does not read is refused
with an error, not guessed at.
