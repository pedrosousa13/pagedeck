---
section: reference
title: Critical CSS
description: Inline the stylesheets of the pages you name into their HTML instead of linking them, with criticalCss and its page patterns.
---

# Critical CSS

By default every page **links** its stylesheets: one `<link rel="stylesheet">`
per tier it reaches, cached under one URL for the whole site. `criticalCss`
turns that around for the pages you name — their stylesheets travel **inside the
HTML**, in `<style>` elements, and the links they replaced are gone.

Declare it in the `build` section of `pagedeck.config.ts`, as a map of page patterns
to flags:

```ts
build: {
  outDir: "./site",
  criticalCss: {
    "/landing/**": true,
    "/landing/legal": false,
  },
  // ...
}
```

The field is optional, and a site that declares none behaves exactly as before:
linked tiers everywhere.

## What it is for

One thing: a **cold-cache landing page**. A visitor arriving from an ad has no
cache for your site, so every stylesheet in the `<head>` is a round trip that
blocks the first paint. Inlining removes those round trips at the cost of the
bytes travelling with the document.

Flag those pages, and leave the rest of the site alone.

## What gets inlined

Everything the page would have linked: the font stylesheets from `build.fonts`
(the site-wide one and any route-scoped one that matches the page), the core
tier, any mid tier it reaches, its own page sheet, and every global stylesheet
from `build.css`.

That set is already "the page's critical CSS computed from its known component
set" — the build knows exactly which components a page renders and which
stylesheets they import, and it never runs a headless browser to guess what is
above the fold. There is nothing narrower to inline, so the whole set goes in,
in the same order it would have been linked: widest-shared first, so a narrower
sheet can still override a wider one at equal specificity.

**This includes the core sheet, and that is the trade.** The core sheet is the
one file the entire site shares and caches under one URL, and a page that inlines
it does not get that cache entry — a visitor who continues to a second page
downloads the core sheet there for the first time. On a cold-cache landing page
there was no cache hit to lose, which is why the feature exists and why it is
opt-in per page rather than a site-wide setting.

## What it does not do

**It does not remove the stylesheet files.** Other pages still link them, and
they are still emitted and deployed. If you flag *every* page of a site, the
sheets ship in the deploy tree with nothing pointing at them — storage and
upload time, never a request, since no document names them. Pruning an emitted
file changes what the manifest promises about the tree, which is the deploy
story's question rather than this feature's, so the files stay.

**It cannot stop a hydrating island from fetching its sheet again.** A page's
entry chunk carries Vite's preload helper, which inserts a `<link>` for a
dynamically imported chunk's stylesheet when the document does not already have
one. On an inlined page that request happens *after* first paint and changes
nothing about how the page looks — the rules are already there — but it is a
request. Flag pages that are mostly content; a page that is mostly islands has
less to gain here anyway.

## The pattern language

Keys are the same page patterns `build.budget` uses — the same globs, the same
`<locale>:` scope, the same rule for which of several matching keys wins, and the
same refusal of a pair no page can choose between. They are read by the same
code, so the two fields cannot drift apart. See
[JavaScript budgets](./javascript-budgets.md) for the language in full.

The value is `true` or `false`. `false` is how a page opts back out of a broader
pattern: in the example at the top, everything under `/landing` inlines except
`/landing/legal`, because the more specific key wins.

A pattern that matches no page inlines nothing, which is not an error — the same
rule budgets follow.

## What is refused

A bad key or a bad value is refused when the config loads, before anything is
rendered, with every fault in one report:

```
Config "/site/pagedeck.config.ts": "build.criticalCss" declares 1 value that is not true or false — write true to inline a page's stylesheets into its HTML, or false to leave it linking them:
  "/landing" — "yes"
```

```
Config "/site/pagedeck.config.ts": "build.criticalCss" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same flag:
  "/a/*" and "/*/b" — equally specific, and both match "/a/b"
```

One more refusal happens during the build, and it is worth knowing about: a
stylesheet holding the byte sequence `</style` cannot be inlined, because an
HTML parser would end the element there and read the rest of the sheet as
markup. The build says so rather than emitting the page, and names where the
sequence is so you do not have to search a minified file for it:

```
Critical CSS: 1 stylesheet cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — remove the "</style" sequence from the stylesheet, or drop the page from build.criticalCss so the sheet is linked instead:
  "/assets/fw-core-DO-Blg1p.css" — inlined into en /landing, "</style" at line 1, column 4188
```

The bytes are otherwise inlined exactly as the bundler emitted them. The build
never rewrites, re-minifies or reorders a stylesheet's contents.

## In the size report

Flagging a page is enough to get `.pagedeck/budget-report.json`: the report is written
when the site declares `budget`, `criticalCss`, or both, and a flagged page has
a row whether or not a budget pattern matches it. The bytes appear in
`cssInlined`, weighed the same way `css` is — Brotli bytes of the stylesheets
themselves — so a flagged page and an unflagged one can be compared:

```json
{
  "locale": "en",
  "path": "/landing",
  "css": 0,
  "cssInlined": 4188,
  "html": 6023
}
```

A row a flag earned carries no `pattern`, no `limitText` and no `limit` — the
three fields a budgeted row has. That is the point: a flag buys the measurement
and nothing that can fail a build.

`css` counts the sheets a page **links**, so it is 0 on a flagged page. Those
bytes also travel inside the document, so `html` grows too — the three figures
are not meant to be added up.

Like `css` and `html`, `cssInlined` is reported and never enforced: no amount of
CSS, inlined or linked, can fail a budget.
