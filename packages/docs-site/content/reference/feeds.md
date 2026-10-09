---
section: reference
title: Feeds
description: An RSS feed at /rss.xml comes from one collection through build.feed, which maps entry fields to items and links the feed from every page head.
---

# Feeds

`build.feed` publishes one collection as an RSS feed at `/rss.xml`, and links it
from the `<head>` of every page so a reader finds it without being told.

```ts
build: {
  outDir: "./site",
  origin: "https://example.com",
  feed: {
    collection: "posts",
    title: "My Site",
    description: "Recent posts",
    item: { title: "title", description: "summary", pubDate: "date" },
  },
  // ...
}
```

**A site that declares no `feed` gets exactly the build it got before the field
existed.** No file is written, no manifest row appears, and no page carries a
link.

## What goes in it

The items are the **pages** of that collection, not the entries of it. An entry
the build routed no page for has no address to point a reader at, so it is not
an item — which is what makes three things true for free:

- An entry outside its
  [publication window](./publication-window.md) is absent, because it is not a
  page either.
- An experiment arm is absent, because an arm is not a page.
- Every item's `<link>` and `<guid>` is the page's own absolute URL, composed
  the same way its [canonical](./canonicals-and-hreflang.md) is.

A page a locale got from its `fallback` chain is skipped as well. It is a copy
of a post already in the feed at another URL, and a reader subscribing would see
the same article once per locale that fell back to it. A locale that really
translated the post has its own entry, its own page and its own item.

**Every locale's items share one feed, and the feed says nothing about
language.** There is no `<language>` element on the channel and no `xml:lang` on
an item, so a site that translates its posts publishes one file in which the
translations sit interleaved, and a reader has no way to subscribe to one
language. If that is not what you want, the answer today is to declare the feed
over a collection only one locale publishes.

Items are newest first, by the field `item.pubDate` names. A collection that
declares no date field gets a feed ordered by URL, which is deterministic and of
no use to a reader — declare the date.

## The mapping

`item` names the **fields of an entry**, not values:

| key | what it names |
| --- | --- |
| `title` | the field holding the item's title. Required. |
| `description` | the field holding its summary. Optional. |
| `pubDate` | the field holding its publication instant. Optional. |

Store the instant as ISO-8601 in UTC (`2026-06-01T09:00:00Z`) — the same format
a publication window wants. The build converts it to the RFC-822 form RSS asks
for.

**A stamp with no timezone designator is read as UTC**, not in the timezone of
whatever machine runs the build, so `2026-06-01T09:00:00` and
`2026-06-01T09:00:00Z` are the same instant here and one store writes one feed
everywhere. An offset is honoured where you write one
(`2026-06-01T11:00:00+02:00`), and items are ordered by the instant a stamp
names rather than by how it is spelled.

A field an individual entry does not carry writes no element for that entry
rather than an empty one, and a `pubDate` value that is not an ISO-8601 date or
date-time writes no `<pubDate>`. Which fields an entry holds is content; if a
field is required, say so in the collection's schema, where the failure names
the entry.

## `origin` is required

Every `<link>` and `<guid>` in a feed is an absolute URL — RSS has no relative
form, and a reader has no base to resolve one against — so `feed` without
`origin` is refused when the config loads rather than quietly writing a file
nobody can follow. The same rule `sitemap` and `xDefault` follow, for the same
reason.

## The autodiscovery link

Every page of a site that declares a feed carries one element, in the `<head>`
beside the canonical:

```
<link rel="alternate" type="application/rss+xml" title="My Site" href="https://example.com/rss.xml">
```

`title` is the channel title you declared. It is what a browser extension or a
reader shows when it offers to subscribe from a page.

## One feed, at one address

`/rss.xml` is fixed, and there is one feed per site rather than one per locale
or per output tree. The link every page carries is absolute, so a locale served
from its own domain points at the same file and a reader subscribing from either
tree gets the same feed.

The one file is written into the output tree that serves your `origin` — the
locale whose `domain` is the origin's host, or the default tree when no locale
claims it. So on a site whose locales all sit on domains of their own, the feed
is inside the origin's tree and not beside them.

That also means a page of your own cannot be published at `/rss.xml`: the build
refuses the collision rather than overwrite one file with the other, and the fix
is to move the page.

Atom and JSON Feed are not emitted, and neither are per-tag or per-category
feeds. One format and one feed is the whole of what this field does.

## Incremental builds

`pagedeck build --incremental` composes and writes the feed on every run, unlike a
[sitemap](./sitemaps.md), which a partial build can keep. The file is a pure
function of the collection's pages and their entries, so a rewritten one holds
the bytes it already held — it costs one small write and never goes stale.
