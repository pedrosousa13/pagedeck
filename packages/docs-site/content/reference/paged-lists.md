---
section: reference
title: Paged Lists
description: Split a list of entries across numbered pages with the paginate page source, what each page knows about its neighbours, and what it refuses.
---

# Paged Lists

A **paged list** is a list of entries you declare once and the build emits as
several pages: page 1 at the list's own path, and every page after it under
`page/2` upward. `paginate` is the page source that does it, and it goes in
`definePages` beside `fromCollection` and `fromTemplate`.

```ts
definePages({
  trailingSlash: "never",
  locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
  sources: [
    paginate({
      pageSize: 10,
      lists: (store) => [
        { locale: "en", path: ["posts"], entries: store.listEntries("posts") },
      ],
    }),
  ],
});
```

That declaration emits `/posts`, `/posts/page/2`, `/posts/page/3` and so on,
for as many pages as ten-at-a-time takes.

**Page 1 is the bare path.** There is no `/posts/page/1`: two addresses for one
set of entries is a duplicate the sitemap and the canonical tag would both need
an opinion about, and you would still have to pick one of them to link to.

**A list with no entries still has its first page.** `/tags/empty` is an
address a tag cloud links and a reader can bookmark. A list that declined to
emit its own first page would 404 from your own navigation.

## What each page knows

Every row a list expands into carries a `paging` field, and that is what a
`Pagination` component renders from:

| Field    | What it holds                                     |
| -------- | ------------------------------------------------- |
| `number` | Which page this is, counting the bare path as 1   |
| `total`  | How many pages the list has — 1 on an empty list  |
| `prev`   | The address of the page before, absent on page 1  |
| `next`   | The address of the page after, absent on the last |

`prev` and `next` are **addresses, not paths to finish**. The locale's prefix
and your site's trailing-slash policy are already applied, so a component
writes one into an `href` and does nothing else to it. They are spelled by the
same function `href` is, so a paged page's address and a link to it can never
disagree.

The entries on a page are its `dependencies`, own entries first. That is one
declaration doing two jobs: an incremental build rebuilds page 2 when the
fourth post changes and leaves page 1 alone, and your render reads the same
refs back to know which entries this page lists.

```ts
content: (page, store) => {
  if (page.paging === undefined) return contentOfAnOrdinaryPage(page, store);
  return {
    template: "PostList",
    props: {
      posts: page.dependencies.map((ref) =>
        store.getEntry("posts", ref.locale, ref.path),
      ),
      paging: page.paging,
    },
  };
},
```

**`paging` is how you tell a list page apart.** No other row carries the field,
and a paged page is not _of_ an entry — it has no `entry`, no `collection` and
no template a collection could name for it.

## Two shapes, one helper

`lists` answers with as many lists as the source claims, and each of them names
its own path and its own entries. A whole collection is one list; a collection
filtered by tag is one list per tag, from the same call:

```ts
paginate({
  pageSize: 10,
  lists: (store) => {
    const posts = store.listEntries("posts");
    const tags = [...new Set(posts.flatMap((post) => post.data.tags))].sort();
    return [
      { locale: "en", path: ["posts"], entries: posts },
      ...tags.map((tag) => ({
        locale: "en",
        path: ["tags", tag],
        entries: posts.filter((post) => post.data.tags.includes(tag)),
      })),
    ];
  },
});
```

The two shapes differ only in which entries are chunked, so there is no tag
mode to switch on — and a shape nobody has asked for yet, a year archive or one
author's posts, is the same call with a different predicate.

**`lists` is a callback over the store** because the lists are content. Your
tags are not known until the store is open, so there is nothing to map over
when you write `definePages`.

**`path` is segments, not a written path.** `["tags", tag]`, never
`"/tags/" + tag`: a slug is a value, and a slug holding a `/` written into a
path would invent a level of URL structure that no page is emitted at. Use
`segments("/posts")` when what you have is the string.

**The order is yours.** `listEntries` answers in path order; sort the array
before you hand it over if your posts should be newest first. Nothing reorders
it, because which entry lands on page 2 is what a reader bookmarks.

## What you get for free

A paged page is an ordinary row of the route table, so everything that reads
the table already reads these:

- **Sitemaps** list every page of a list.
- **The canonical tag** on `/posts/page/2` is `/posts/page/2`, written by the
  same head writer as every other page's. There is no `rel="prev"` or
  `rel="next"`: Google dropped them as an indexing signal in 2019, so emitting
  them would buy nothing and put a second writer in the `<head>`.
- **Link checking** resolves a link to a paged address like any other. A link
  to `/posts/page/9` on a list with three pages fails the build, naming the
  page and the href.
- **Collision checking** reports a paged address a second source also claims.

## Refusals

`pageSize` must be a whole number of 1 or more:

```
Paged list: pageSize is 0, and a page holds at least one entry — pass a whole
number of 1 or more
```

A list `path` holding a segment that is not one — an empty string, `.`, `..` —
is reported the way any unusable route is, naming the source and the instance.

## What is not here

**No client-side paging.** These are static pages; infinite scroll and
load-more are a site's own script over addresses the build has already emitted.

**No page-number window.** How many numbered links a `Pagination` component
draws around the current page is a design decision, and `number` and `total`
are everything one needs to take it.

**No fallback-locale arrows.** A locale that gets a list page from its fallback
chain gets the supplying locale's content at its own URL, and no `paging`:
those addresses are the supplier's, and pointing an untranslated locale's list
at another locale's pages would be worse than leaving the arrows off. A locale
that wants a paged list with arrows in it declares one.
