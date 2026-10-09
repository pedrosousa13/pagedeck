---
section: reference
title: Canonicals and hreflang
description: The build writes canonical and hreflang links for every page from the site's locale map and declared origin, x-default included.
---

# Canonicals and hreflang

A multi-locale site publishes the same page several times — once per language,
sometimes on several domains — and a search engine has to be told that those
URLs are one page in different languages rather than duplicates of each other.
Two link types do it: `rel="canonical"`, which says which URL a document is at,
and `rel="alternate" hreflang="…"`, which says which other URLs are the same
page elsewhere.

**The build writes both, from the locale map you already declared.** There is no
per-page field for them and no callback to implement. What it needs from you is
one thing your config cannot know: where the site is served from.

## Declaring the origin

```ts
build: {
  outDir: "./site",
  origin: "https://example.com",
  // ...
}
```

`origin` is the scheme and host of the default output tree, and nothing else —
no path, no trailing slash, no query, no fragment. A locale with its own
`domain` still uses that domain; the origin supplies the scheme, and the port if
it has one. The same origin makes the `og:image` of a card the build draws an
absolute URL (see [Page head](./page-head.md#cards-the-build-draws)).

**Declare no `origin` and no links are written.** The documents are exactly what
they would be without this feature. An origin is a decision about the site's
public identity, and no default can make it for you.

## What a page gets

Take a site with `en` and `fr` on the default tree and `de` on `example.de`:

```html
<link rel="canonical" href="https://example.com/en/pricing">
<link rel="alternate" hreflang="de" href="https://example.de/pricing">
<link rel="alternate" hreflang="en" href="https://example.com/en/pricing">
<link rel="alternate" hreflang="fr" href="https://example.com/fr/pricing">
```

The set includes the page's own locale. That is what `hreflang` asks for — a set
that omits the page carrying it is ignored rather than reported — and it is what
makes the relation symmetric: every one of these documents lists the same four
URLs, so if one names another, the other names it back.

The URLs are the URLs of files this build emitted. Your `trailingSlash` policy
decides how they end, and the locale's own tree decides the host, so a canonical
and the address it is served at cannot disagree.

## x-default

`x-default` names the version an unmatched reader should get — someone whose
language is none of yours.

```ts
build: {
  outDir: "./site",
  origin: "https://example.com",
  xDefault: "en",
  // ...
}
```

It takes a locale code, and it has to be one your locale map declares. Leave it
out and no `x-default` link is written: pointing at the default tree instead
would be the build choosing which language a stranger reads.

The link goes last in the block, and it repeats the URL of the locale it names:

```html
<link rel="alternate" hreflang="x-default" href="https://example.com/en/pricing">
```

`xDefault` needs `origin`, because the link it names is an absolute URL. Declare
it alone and the build refuses the config rather than doing nothing quietly.

## Pages that are not translated everywhere

**A locale that has no page at a path is not listed.** No alternate ever points
at a URL this build did not write. If your German site has an `/impressum` and
nobody else does, its English alternate does not exist, so it is not named — and
neither is its `x-default`, even when `xDefault: "en"`.

**A page with no other version gets a canonical and nothing else.** An `hreflang`
set of one states no relationship, so a single-locale site — and a page a
multi-locale site translated into one language only — carries the canonical
alone.

**A page filled in by a locale's fallback chain is a version like any other.**
If `fr` has no `/pricing` and falls back to `en`, French readers get
that content at `https://example.com/fr/pricing`, and that is the URL the page
canonicalizes to — its own, not the English one. Sending a French reader to the
English page is not deduplication; it is the wrong page. The two are related as
alternates instead, which is exactly what they are.

## The 404 page

**The page a `notFound` rule names gets no canonical and no `hreflang` links.**
It carries `<meta name="robots" content="noindex">` in their place, and no other
page lists it as an alternate. A canonical names the address a page is to be
indexed at, and a 404 page is not to be indexed at any. The `noindex` is
written whether or not you declared an `origin`, because the page's own address
answers 200 on every host. See [Routing](./routing.md#the-404-page).

A page at the same path in another locale that no rule names is an ordinary
page. It keeps its canonical, and the 404 pages are not in its `hreflang` set.

## One limit worth knowing

Pages are matched **by path**. If you translate your slugs — `/pricing` in
English, `/preise` in German — the build sees two different pages and neither
lists the other. Nothing in the framework relates the two paths; the only thing
that knows they are one page is the `route` callback that wrote them both.

Keep one path across locales and let the prefix or the domain carry the
language, and the alternates come out right.

## Faults

An origin that is not a bare scheme and host:

```
Config "/site/pagedeck.config.ts": "build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":
  "https://example.com/shop" — the origin holds the path "/shop", and this build appends each page's own path to it
```

An `xDefault` naming a locale the map does not declare:

```
Config "/site/pagedeck.config.ts": "build.xDefault" names a locale that is not declared — declare the locale, or point xDefault at a declared locale:
  "fr" — the declared locales are "en", "de"
```

An `xDefault` with no origin to compose its link from:

```
Config "/site/pagedeck.config.ts": "build.xDefault" is declared without "build.origin", and the x-default link it names is an absolute URL — declare origin: "https://example.com", or remove xDefault
```
