---
section: reference
title: JavaScript budgets
description: Limit each page's JavaScript with build.budget and each island's serialized props with build.islandPropsBudget, and read the report.
---

# JavaScript budgets

A budget is a limit on how much JavaScript one page ships. Declare budgets in
the `build` section of `pagedeck.config.ts`, as a map of page patterns to sizes:

```ts
build: {
  outDir: "./site",
  budget: {
    "/**": "60kb",
    "/pricing/": "15kb",
    "en:/blog/**": "25kb",
  },
  // ...
}
```

`pagedeck build` weighs every page a pattern matches. A page over its limit fails the
build with exit code 2, naming each breaching page, its limit, what it spends
and its largest chunks. Every breaching page is reported, not the first.

The field is optional. A site that declares no `budget` is not weighed and pays
nothing for the check. The [island props](#island-props) limit is the exception:
it applies to every site, with a default.

## What a page costs

A budget counts the JavaScript a page transfers **for first render**, as
**Brotli-compressed bytes**. That is:

- the page's entry chunk, plus everything it **statically** imports, directly or
  through another chunk,
- the chunk holding each **eagerly hydrated** island's component, plus
  everything those chunks statically import,
- on a page with an island, the chunk holding the **island runtime**, plus
  everything it statically imports, React included, even where the page loads
  it later, and
- the executable JavaScript the build wrote **into the page's own document**
  rather than into a chunk.

Each chunk is counted once, however many ways the page reaches it.

Seven consequences are worth stating outright:

- **Only `hydrate: "load"` islands' own chunks count.** An island hydrating on
  `load` has its module fetched the moment the page's entry runs, so it is part
  of first render. `idle`, `visible` and `interaction` islands are not:
  `visible` waits for the island to scroll into view, which for a page nobody
  scrolls is never, `interaction` waits for a focus or press inside the island,
  and `idle` waits for the browser to finish the page's own load work, which is
  after first render by definition. Moving an island from `load` to `visible`
  is therefore a real way to get a page back under its budget.
- **A runtime loaded later still counts.** A page whose islands are all `idle`,
  `visible` or `interaction` loads React and the island runtime only when its first island's
  trigger fires. Its budget charges them all the same, because a budget counts
  what a page downloads, not when. Moving every island off `load` saves the
  islands' own chunks and the work at load, not React's bytes.
- **A shared chunk counts, once.** A chunk two of a page's islands both reach is
  one download. A tier chunk shared with the rest of the site still counts
  against every page that loads it on first render.
- **The numbers are compressed.** `"15kb"` is 15 × 1024 bytes on the wire, not
  of source. Uncompressed source is roughly four times larger and moves with
  formatting rather than with content.
- **A page with no islands costs 0 in chunks**, and that is its whole spend
  unless the build inlined a `<script>` into it — the last bullet below. It is
  reported as 0 rather than skipped, so a page that stops being free shows up as
  a change in the report.
- **This is not the page's whole payload.** A page whose below-the-fold chart is
  200 kB can pass a 20 kB budget, because that chart is not transferred until a
  visitor scrolls to it. The budget is a limit on what the page costs to render,
  not on what it can eventually load.
- **Inlined JavaScript counts, and it is not a chunk.** Two features write a
  `<script>` into the document itself: the
  [script layer](./third-party-scripts.md)'s consent loader, and the
  [web-vitals beacon](./web-vitals-beacon.md). A page carrying either runs
  those bytes on every visit, so they are in its spend and can fail a build on
  their own — a page with no islands at all can breach. They are reported
  separately as `jsInlined`, because there is no chunk path to name them by.

## What a `<script>` is not

A `<script>` element is not always code. The JSON-LD block a page emits for
search engines and the speculation-rules block it emits for prefetching both
carry data a browser reads rather than runs, and neither is counted. A budget
is a limit on what the page runs.

The line is drawn at the element: a `<script>` with no attributes on it is
inline code and is counted, and everything else is not. A `<script src>` is a
chunk, already counted by its path; a typed one — `application/ld+json`,
`speculationrules` — is data. That rule applies to strings your own site puts in
a document too, so a `ScriptRuntimeAdapter`'s snippet or a facade's placeholder
counts exactly when what it writes is an inline script.

## CSS and HTML

A page's stylesheets and its own document are **reported beside the JavaScript
figure and never counted against the budget**. No amount of CSS can fail a
build. A `budget:` key is a limit on JavaScript, and it stays one.

`cssInlined` and `jsInlined` are therefore not a matched pair, despite their
names: the first is reported and can never fail a build, the second is part of
the spend and can. The difference is not inlining but what the bytes are — one
is a stylesheet, and the other is JavaScript, which is the thing a budget
counts.

The three figures below are Brotli bytes, the same unit as the JavaScript
figure, so the numbers can be read across:

- **`css`** — every stylesheet the page's document links, each counted once.
  That is the site's global sheets from `build.css` and the page's own, exactly
  the set in its `<link>` tags. Stylesheets other pages link are not on this
  page's bill.
- **`cssInlined`** — the stylesheets the page inlined into its own HTML instead
  of linking, if [critical CSS](./critical-css.md) is on for it. It is 0 on
  every page of a site that has not declared `build.criticalCss`, and a flagged
  page's `css` is 0 instead. Those bytes are inside `html` as well, so the
  figures are not meant to be added up. The two other things a build can inline
  as CSS — the [view-transition](./view-transitions.md) rule and a drift
  supplement — are framework-emitted rules rather than sheets your site wrote,
  and are not in this column; they are inside `html` like the rest of the
  document.
- **`html`** — the page's own emitted document, and no other's.

They are reported for every budgeted page, passing ones included. A page whose
JavaScript held steady while its stylesheet tripled is invisible to a check that
can only fail, and these two figures are where that shows up.

## Island props

Every prop an island receives is serialized to JSON into the island's marker in
the page's HTML. A server component can read a 67 kB CMS entry and pass an
island only the 2.3 kB it renders, but if it passes the whole entry, the whole
entry ships in the page. A JavaScript budget does not see it, because it is
not JavaScript.

So each island's props have a limit of their own, set for the whole site with
`islandPropsBudget`:

```ts
build: {
  outDir: "./site",
  islandPropsBudget: "4kb",
  // ...
}
```

The limit applies to each island on its own, on every page. It is not a total
for the page, and it is not set per page. A size is written as for `budget`.

**The default is `3kb`**, and it applies to every site that does not declare
`islandPropsBudget`, with or without a `budget`. It is the largest island props
on the sites in this repository, 2296 B for the landing site's variant picker
on `/server-data`, plus about 16%, rounded to a whole kilobyte.

What counts is the JSON the marker carries, **before HTML escaping**, in
**UTF-8 bytes**. It is not compressed, unlike a JavaScript budget, so the figure
is the one `JSON.stringify` gives for the same props. A `"` costs 1 byte and
not the 6 of `&quot;`, and `é` costs 2.

An island over the limit fails the build with exit code 2. The message names the
page, the island's registry name and its prefix, which its marker carries in
the HTML, its size against the limit, and its three largest top-level props:

```
Island props budget: 1 island carries more props in its marker than the limit allows — pass the island only the fields it renders, or raise the limit in pagedeck.config.ts's build.islandPropsBudget:
  en /products/shirt — "variant_picker" at prefix "i3f2a0b1c2d3e" carries 69109 B of props against a limit of 3072 B, over 4 top-level props, the 3 largest:
    "entry" — 66804 B
    "variants" — 2250 B
    "price" — 9 B
```

A prop's figure is the JSON of its value. The lines do not add up to the
island's figure, because the names, quotes, colons, commas and braces make the
difference. Every island over the limit is reported, on every page.

The usual fix is in the server component: read the entry there, render on the
server what does not change on the client, and pass the island only the fields
it uses.

The limit applies to an incremental build too. A page the build carries from the
previous build is weighed from its document on the tree, so a lower limit
applies to it without a full build.

## The pattern language

A key is a path glob, optionally prefixed with a locale and a colon:

```
/pricing            every locale's /pricing
en:/pricing         English's /pricing alone
/blog/**            /blog and everything under it, in every locale
de:/blog/*          one level under /blog, in German
```

The path glob must start with `/`. That is what tells `en:/pricing` and a
locale-less key apart.

There are exactly two wildcards:

- `*` matches any run of characters **inside one path segment**, including none.
  It never crosses a `/`.
- `**`, written as a whole segment, matches **zero or more whole segments**.

Every other character is a literal. `?`, `[` and `{` match themselves; they are
not metacharacters, and adding one later would change what an existing key
means.

A budget may name a locale the site has not declared. Such a key matches no
page, which is not an error — locales are declared and checked in
`defineLocales`.

## Which pattern wins

Several keys can match one page. The most specific wins, compared in this order:

1. **A locale-scoped key beats an unscoped one.** `en:/**` beats `/pricing`.
2. **More literal characters in the path glob.** Characters that are not part of
   a `*` or `**` token are counted, so `/blog/*/hello` beats `/blog/**`.
3. **Fewer `**` tokens.** `*` covers one segment and `**` covers any number, so
   the narrower one wins: `/blog/*` beats `/blog/**`, and a page at
   `/blog/hello` takes the first while `/blog/2026/hello` takes the second.
4. **Fewer `*` tokens**, as the last tie-breaker between two globs spelling the
   same amount of literal text with the same reach.

Two keys can still tie. `"/a/*"` and `"/*/b"` have one `*` and three literal
characters each, and both match `/a/b`. **That is refused when the config
loads**, with the pair and an example page named:

```
Config "/site/pagedeck.config.ts": "build.budget" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same limit:
  "/a/*" and "/*/b" — equally specific, and both match "/a/b"
```

Fix it by making one key more specific, or by giving both the same limit — two
keys that agree on a limit have nothing to disagree about and are accepted.

The tie is decided against the patterns themselves, not against the pages a
particular build produced, so adding one page can never turn a green config into
a failing one.

## Sizes

A limit is a number and a unit: `b`, `kb` or `mb`, case-insensitive, with
`kb` = 1024 bytes and `mb` = 1024 kb. `"15kb"`, `"1.5mb"` and `"900b"` are all
valid. Anything else is refused when the config loads.

## The report

Every build with a budget writes `.pagedeck/budget-report.json` in the site directory
— the one that holds `pagedeck.config.ts`, beside the retention store `pagedeck rollback`
reads — including builds that fail on a breach, which are the ones most worth
reading.

**Outside `outDir`, and that is the point.** The report is a CI artifact rather
than site content: it names the build id, the build time, every budgeted page
with its limit and spend, and every emitted chunk's path and size. A
manifest-driven deploy would never have uploaded it — `pagedeck diff` uploads the rows
in the manifest plus `manifest.json`, and the report is in neither — but a
directory-sync host publishes the output tree and reads no manifest, so a report
inside `outDir` shipped. Putting it under `.pagedeck/` is the placement that holds
under both, and `.pagedeck/` is already the directory a site's `.gitignore` names for
the retention store.

It holds because `outDir` sits inside the site directory, which is the ordinary
layout and the one every site in this repo uses. That is a premise, not a check:
`build.outDir` is yours to set and the config only requires it to be a string,
so `outDir: "."` — the site directory itself, or any directory above it — puts
`.pagedeck/budget-report.json` back inside what a directory-sync host publishes. The
framework does not refuse that layout, and a site whose output tree is its own
source directory is publishing `pagedeck.config.ts` with it.

A build that declares [critical CSS](./critical-css.md) writes it too, budget or
no budget, and a flagged page gets a row whether or not a budget pattern matches
it. Such a row has no `pattern`, no `limitText` and no `limit`, and its `breach`
is always `false`: a page nothing budgeted has nothing to be over.

A build with an island over the [island props](#island-props) limit writes it
too, budget or no budget, and each page with such an island gets a row in the
same way. A site that declares neither `budget` nor `criticalCss`, and has no
island over the limit, gets no report.

```json
{
  "version": 2,
  "build": { "id": "7bc48ff6", "createdAt": "2026-08-29T17:53:34.114Z" },
  "islandPropsLimit": { "limitText": "3kb", "limit": 3072 },
  "pages": [
    {
      "locale": "en",
      "path": "/pricing/",
      "pattern": "/pricing/",
      "limitText": "15kb",
      "limit": 15360,
      "actual": 70813,
      "jsInlined": 0,
      "css": 4188,
      "cssInlined": 0,
      "html": 1902,
      "breach": true,
      "chunks": [
        { "path": "/assets/fw-core-DO-Blg1p.js", "bytes": 52397 },
        { "path": "/assets/Chart-9f31.js", "bytes": 18004 },
        { "path": "/assets/en_pricing-1a2b.js", "bytes": 412 }
      ],
      "causes": [
        "fold strategy promoted \"Chart\" at tree position 0 from \"visible\" to \"load\" — position 0 is above the fold threshold of 4"
      ],
      "largestIslandProps": 412,
      "islandPropsBreaches": []
    }
  ]
}
```

Every budgeted page appears, breaching or not, in route-table order, with its
chunks largest first, and every critical-CSS page beside them. `actual` is the
sum of `chunks` plus `jsInlined`, and `chunks` is the first-render set described
above — a chunk this page fetches only when an `idle`, `visible` or
`interaction` island hydrates is in neither. `css`, `cssInlined` and `html` sit beside `actual` and
are in no part of it, and `breach` is `actual > limit` and nothing else.
`largestIslandProps` is the page's largest island props in bytes, 0 on a page
with no island, and `islandPropsBreaches` lists each island over the limit,
largest first, with its `component`, `prefix`, `bytes` and every top-level prop
in `props`. The limit itself is the report's `islandPropsLimit`, because it is
one for the whole site. Neither is part of `actual` or `breach`. Two
builds of one site produce the same report, so it can be diffed across commits
to watch a page's weight over time.

**The report is `"version": 2` since inlined JavaScript started counting.**
Version 1 rows had no `jsInlined`, and their `actual` was the chunks alone, so
a job comparing a page's spend across that change is comparing two different
measurements. A site that declares neither a script layer nor a beacon reads
the same numbers it always did, with a `jsInlined` of 0 on every row.

The version changes only when a field already in the report changes what it
means. Adding a field does not change it, so `islandPropsLimit`,
`largestIslandProps` and `islandPropsBreaches` arrived in version 2.

`causes` says why the page's spend is what it is, in the cases where the build
can say. Today that is [fold strategy](./fold-strategy.md) and nothing else: it
is the one stage that moves an island onto or off a page's first render for a
reason that is not an edit somebody made, so a page's figure can move on a copy
change with nothing in the page's own declarations touched. Every other reason —
a component added, a directive added, a limit lowered — is legible from the diff
that caused it and gets no sentence here.

Demotions appear as well as promotions: the field answers why the spend is what
it is, not only why it is too high, and a page under budget because the build
moved an island off its first render is worth the same line. It is `[]` on a
page nothing moved and on every page of a site that turned fold strategy off.

The build failure quotes the JavaScript numbers, each page's three largest
chunks, its inlined bytes where it has any, and every one of the page's causes.
`css` and `html` are deliberately absent from it: every fix it offers is a
JavaScript fix, and a figure printed inside a failure reads as a figure that
caused one. The report on disk carries both, and it is written before the build
fails.

```
JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /pricing/ — "/pricing/" allows 15360 B, the page transfers 70813 B over 3 chunks:
    /assets/fw-core-DO-Blg1p.js — 52397 B
    /assets/Chart-9f31.js — 18004 B
    /assets/en_pricing-1a2b.js — 412 B
    fold strategy promoted "Chart" at tree position 0 from "visible" to "load" — position 0 is above the fold threshold of 4
```

The chunks are cut at three and the causes are not: a chunk is evidence about
the breach and three of them diagnose it as well as a hundred, while a cause is
a reason for it, and there is no such thing as the three most important reasons.

Inlined bytes get a line between the two, on the pages that have any, and the
page's own line says which figure is which so the sum adds up to the lines under
it. The inlined line names a phrase rather than a path, because there is no file
to go and open — and on a page whose whole spend is inline it is the only
contributor line there is:

```
JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /about/ — "/about/" allows 0 B, the page transfers 300 B, all of it inlined into its document:
    inlined into the document — 300 B
```
