---
section: reference
title: Sitemaps
description: Publish one sitemap per locale and one index per output tree with build.sitemap, each entry carrying the hreflang alternates of its page.
---

# Sitemaps

`build.sitemap` is where a site asks the build to publish its URLs: one sitemap
per locale, one index per output tree, and every entry annotated with the same
`hreflang` links the page itself carries.

```ts
build: {
  outDir: "./site",
  origin: "https://example.com",
  xDefault: "en",
  sitemap: { pattern: "suffix" },
  // ...
}
```

**A site that declares no `sitemap` gets exactly the build it got before the
field existed.** No file is written and no manifest row appears.

## `origin` is required

Every `<loc>` in a sitemap is an absolute URL — the protocol has no relative
form — so `sitemap` without `origin` is refused when the config loads rather
than quietly writing nothing. The same rule `xDefault` follows, for the same
reason: a field the build can never read is a field you can set and watch do
nothing.

`origin` supplies the scheme and the port. A locale with its own `domain`
overrides the host for that locale's tree, so a German locale on `example.de` is
published on `example.de` while the default tree is published on the origin's
host. This is the composition
[canonicals and hreflang](./canonicals-and-hreflang.md) already uses, called
again rather than repeated.

## The two patterns

`pattern` picks the address the per-locale files take. There is no default:
which URLs your site publishes is not a choice this framework can make for you,
and the addresses are ones you then have to keep serving.

| `pattern`     | English sitemap        | German sitemap on its own domain |
| ------------- | ---------------------- | -------------------------------- |
| `"suffix"`    | `/sitemap-en.xml`      | `/sitemap-de.xml`                |
| `"directory"` | `/en/sitemap.xml`      | `/de/sitemap.xml`                |

Both write the tree's index at `/sitemap.xml`, which is the address to give a
crawler or a `robots.txt` line. `"directory"` names the locale rather than the
locale's URL prefix, which only matters on a tree with a single locale: such a
tree is unprefixed, its pages sit at `/about` rather than `/de/about`, and its
sitemap still goes to `/de/sitemap.xml` so that `/sitemap.xml` stays the index.

## One index per output tree

A locale with a `domain` emits into that domain's own tree; locales without one
share the default tree. Each tree gets its own index, and an index names only
the sitemaps in its own tree — the default tree's index never mentions a URL on
another host.

Every locale you declare gets a sitemap, including one that has no page yet.
Its file is an empty `<urlset>`, which is valid and says what is true.

## What an entry holds

```
<url>
<loc>https://example.com/en/pricing</loc>
<xhtml:link rel="alternate" hreflang="de" href="https://example.de/pricing"/>
<xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/pricing"/>
<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing"/>
</url>
```

The `<loc>` is the page's canonical and the `xhtml:link` set is the page's
`hreflang` set — the same values, from the same call, as the `<link>` tags in
that page's `<head>`. They cannot disagree, so there is nothing to keep in step:
declare `xDefault` and it appears in both, translate a page into a fourth locale
and both grow the entry.

**Fallback pages are in the sitemap**, because they are pages: a locale that
takes a page from its fallback chain serves it at its own URL, and that URL is
the one it publishes.

**Experiment variants are not.** An arm declared in `build.routing.experiments`
is the primary page's bytes at a second address, it canonicalizes to the
primary, and no sitemap names it.

**The 404 page is not either.** A page a `build.routing.notFound` rule names
carries `noindex`, so no sitemap lists it and no entry names it as an
alternate. See [Routing](/reference/routing#the-404-page).

## What an entry does not hold

No `<lastmod>`, `<changefreq>` or `<priority>`.

`<lastmod>` states when the *page* last changed, and the only instant a build
has is when the build ran — so a redeploy that changed nothing would tell every
crawler that everything had changed. `<changefreq>` and `<priority>` are values
the build would have to invent about your content, and the search engines that
once read them have said they do not.

## Incremental builds

`pagedeck build --incremental` regenerates a locale's sitemap only when a page moved:
one added, one removed, one served from a new address, or one that became the
404 page or stopped being it. That counts pages in
the locale itself, and pages in any other locale at a path this one also routes
— the sitemap names those in the path's `hreflang` set, so they move it too. An
edit to a page's content moves neither a URL nor an `hreflang` set, so the file
is left exactly as it was — the same bytes, not rewritten with the bytes it
already held.

A sitemap the run keeps is read back off the output tree and checked against the
previous build's manifest first. Delete one, or edit one by hand, and the next
incremental build writes it again rather than refusing: a sitemap is composed
from the route table, so there is nothing lost that the build cannot make again.

**Each tree's index is written on every run.** Its bytes depend on your locale
set and on nothing a page can change, and the build compares no config between
runs — so it composes the index rather than trust that you did not add a locale.

**Change `origin` or `xDefault` and run a full build.** Both go into every
`<loc>` and every `hreflang` link, and an incremental build has no way to see
that a config value moved. A locale whose pages did not move keeps the sitemap
it had, which is the one the old `origin` wrote.

## Known limit: 50,000 URLs per locale

The sitemaps protocol caps one file at 50,000 URLs and 50 MB, and the build
writes one file per locale with no sharding. A locale past either cap ships a
sitemap a crawler will refuse. If you are near it, file an issue: the tree's
index is already the indirection that makes sharding invisible to a crawler.
