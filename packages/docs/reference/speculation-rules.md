---
section: reference
title: Speculation Rules
description: Speculation Rules let browsers prefetch or prerender the pages each page declares as likely next, capped per document and kept to one output tree.
---

# Speculation Rules

`build.speculation` puts a [Speculation
Rules](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API)
document in every page's `<head>`, listing the pages that page declares a
reader may go to next. A browser that supports the API fetches — or renders —
them before the reader asks, so the next navigation is a full page load that
already happened.

```ts
build: {
  outDir: "./site",
  speculation: { action: "prefetch", max: 5 },
  // ...
}
```

**A site that declares no `speculation` gets exactly the build it got before the
field existed.** No element is written and no page's bytes move. So does a site
that declares `speculation` but no `relatesTo` on any page source — see below.

## Turning it on: `relatesTo`

`build.speculation` decides _how_ rules are emitted. What they list comes from
one place, and you have to write it: the `relatesTo` of the page source that
produced the page.

```ts
fromCollection(articles, {
  route: (entry) => segments(entry.path),
  // Pages a reader may go to next from this one.
  relatesTo: (entry) =>
    entry.data.related.map((path) => ({
      collection: "articles",
      locale: entry.locale,
      path,
    })),
});
```

**A source that writes no `relatesTo` emits no rules**, whatever
`build.speculation` says. That is the default, and no site in this repository
declares one — the feature is dormant until a site says what its links are.

### Why not `dependsOn`

`dependsOn` and `sharedDependsOn` declare what a page's **render reads**, so an
incremental build knows what to rebuild when an entry changes. That is a
different set from what a **reader** may go to next, and using one as the other
produces wrong rules rather than fewer of them.

The clearest case is a site that declares `sharedDependsOn` over a whole
collection so that any change rebuilds every page that lists it. Every one of
those refs is a page, so every page on the site would speculate the first `max`
entries in collection order — pages nobody linked to, fetched on every visit.

A page may also link somewhere its render never touches, and read something it
never links to. Neither set contains the other, so they are declared apart.

### What resolves, and what does not

A page's targets are its relations that are **another page's own entry**. That
one sentence is the whole rule, and three things follow from it that you would
otherwise have to configure:

- **A site-wide global is not a target.** A navigation entry belongs in
  `sharedDependsOn`, and even named here it is the own entry of no page, so it
  resolves to nothing. Without this, a nav would make every page speculate every
  other page.
- **An experiment variant is never listed.** An arm declared in
  `build.routing.experiments` is the primary page's bytes at a second address
  and is not a row in the route table, so it cannot be a target. A page pointing
  at a split page lists the primary URL.
- **An external URL is never listed.** A link to another site names no entry, so
  there is no reference for the join to resolve.

Nothing scans your rendered HTML for `<a href>`, and nothing reads
`manifest.json`. A page whose relations resolve to no other page carries no
element at all — not an empty one.

## `action`: fetch it, or run it

There is no default. The two are different promises:

| `action`      | What the browser does                                       |
| ------------- | ----------------------------------------------------------- |
| `"prefetch"`  | Fetches the document's bytes and stops.                     |
| `"prerender"` | Renders the page — its scripts, its islands, its analytics. |

`"prerender"` is the faster of the two and the one to think about before
choosing: a page rendered in a hidden tab has already run whatever that page
runs, so a reader who never opened it may still appear in your analytics. If
your pages are static and your measurement is server-side, that cost is zero. If
they are not, start with `"prefetch"`.

## `max`: how many pages a document may list

Also required, and also without a default: it decides how much of your site a
reader downloads without having asked for it. When a page has more relations
than the cap allows, the first `max` are kept, in the order your `relatesTo`
returned them — so the order you declare relations in is the order they are
preferred in.

## What a page emits

```json
{ "prefetch": [{ "source": "list", "urls": ["/pricing", "/about"] }] }
```

Inside a `<script type="speculationrules">` element, last in the `<head>`.

**It is not JavaScript.** `speculationrules` is not a script type, so nothing in
the element is executed: it is a data block, parsed as JSON by the Speculation
Rules API, and ignored whole by a browser without one. Your zero-JavaScript
pages stay zero-JavaScript pages.

## Same tree only

A target in another output tree is not listed. A locale with its own `domain`
is a separate origin, and the API will not prerender across one — see
[sitemaps](./sitemaps.md) for what an output tree is.
