---
section: how-to
title: Add an island and hold it to a budget
description: Write a "use client" component, place it on one page, choose when it hydrates, and fail the build when a page ships more JavaScript than you allow.
---

# Add an island and hold it to a budget

This page adds an island to the site `npm create pagedeck` writes, and then
makes the build check how much JavaScript each page ships. If you have no site
yet, [Your first site](../tutorials/your-first-site.md) makes one. Every file below
is relative to the site's directory.

The island is a greeting, a text box and a line that answers with what you
type. It needs JavaScript, because it changes after the page has loaded.

## 1. Write the component

Save this as `components/greeting.tsx`:

```tsx
"use client";

import { useState } from "react";

export default function Greeting() {
  const [name, setName] = useState("");
  return (
    <p>
      <label>
        Your name <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <output>Hello, {name === "" ? "whoever you are" : name}.</output>
    </p>
  );
}
```

The first line, `"use client"`, is the whole opt-in. It goes once, in the
component's own module. A page that uses the component writes nothing extra,
and a component without the line renders to HTML and ships no JavaScript.
[Why this site ships no JavaScript](../explanation/why-this-site-ships-no-javascript.md)
explains where the build gets the script tag from.

Register the component under a name, in `build.components` in `pagedeck.config.ts`:

```ts
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
  greeting: "./components/greeting.tsx",
},
```

## 2. Put it on one page

A page names its components in its frontmatter. Save this as `content/greet.md`:

```
---
components: [greeting]
---

# Greet

Type your name, and the box below answers.
```

The layout renders `greeting` after the page's text, where it puts its
`children`. [Rendering a page](../reference/site-config.md#rendering-a-page) covers
the `components` list and the names it accepts.

Sync the new page into the store, and build:

```sh
npx pagedeck sync
npx pagedeck build
```

`site/greet/index.html` has a `<script>` tag, which loads the greeting.
`site/about/index.html` and `site/index.html` have none.
The build bundles an island's JavaScript for the pages that name it and for no
other page. Step 4 makes the build check this for you.

## 3. Choose when it hydrates

The build renders the greeting to HTML. In the browser, the island hydrates,
which means its JavaScript loads and the box starts to answer. A component's
registry row says when, with `hydrate`:

- **`"load"`** hydrates as soon as the page's script runs. Pick it for
  something a visitor uses the moment the page opens.
- **`"idle"`** hydrates when the browser has finished loading the page. Pick
  it for something a visitor needs soon but not first. The
  [site search](../reference/site-search.md) box hydrates on `idle`.
- **`"visible"`** hydrates when the island scrolls into view. This is what
  `"use client"` gives you with no `hydrate`. Pick it for anything below the
  first screen.
- **`"none"`** never hydrates. It is what a component without `"use client"`
  gets, and the build refuses it on a module that has the line. To stop an
  island shipping JavaScript, delete `"use client"` from its module.

With no `hydrate`, the build also moves the island for you.
[Fold strategy](../reference/fold-strategy.md) promotes an island near the top of
its page to `load`, which is what happens to the counter and to the greeting:
each is the second node of its page. An explicit `hydrate` is never promoted,
but an explicit `"load"` below the fold is demoted to `visible`.
[What gets moved](../reference/fold-strategy.md#what-gets-moved-and-what-never-does)
has the full table.

Pin the greeting to `idle`, so its JavaScript waits until the page has
loaded. Change its row in `pagedeck.config.ts`:

```ts
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
  greeting: { path: "./components/greeting.tsx", hydrate: "idle" },
},
```

## 4. Set a budget

A budget is a limit on the JavaScript one page transfers for first render, in
Brotli-compressed bytes. Start by holding every page to nothing. Add this to
`build` in `pagedeck.config.ts`:

```ts
budget: { "/**": "0b" },
```

Build again:

```sh
npx pagedeck build
```

The build fails with exit code 2, and prints:

```
pagedeck: JavaScript budget: 2 pages transfer more JavaScript for first render than their budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
pagedeck:   en /counter/ — "/**" allows 0 B, the page transfers 53595 B over 4 chunks, the 3 largest:
pagedeck:     /assets/fw-core-DDGHZVhO.js — 52145 B
pagedeck:     /assets/fw-startup-DtWrQx5C.js — 992 B
pagedeck:     /assets/counter-DjZBwrr6.js — 238 B
pagedeck:     fold strategy promoted "counter" at tree position 1 from "visible" to "load" — position 1 is above the fold threshold of 4
pagedeck:   en /greet/ — "/**" allows 0 B, the page transfers 53430 B over 3 chunks:
pagedeck:     /assets/fw-core-DDGHZVhO.js — 52145 B
pagedeck:     /assets/fw-startup-DtWrQx5C.js — 992 B
pagedeck:     /assets/entry-8c8b51d5ffe9bbeb-BAEKmaf-.js — 293 B
```

The message names every page over its limit, the pattern that set the limit,
what the page transfers, and its largest chunks. `/` and `/about/` are not in
it, because they ship 0 B.

Read the two pages against step 3. The counter has no `hydrate`, so fold
strategy promoted it to `load`, and its chunk counts. The greeting hydrates on
`idle`, so its own chunk is not on the list. Both pages pay for `fw-core`,
which holds React and the island runtime, and for `fw-startup`, which waits for
each island's trigger. `/counter/` loads `fw-core` at once. `/greet/` has no
`load` island, so it loads `fw-core` only when the greeting's trigger fires,
and the budget charges it all the same. Moving an island off `load` saves the
island's own chunk, not React.

Give each page with an island a limit of its own. Size it from the figure the
build printed, plus room for drift: about 15% over 53595 B, rounded to a whole
kilobyte, is `60kb`. Replace the budget in `pagedeck.config.ts`:

```ts
budget: {
  "/**": "0b",
  "/counter/": "60kb",
  "/greet/": "60kb",
},
```

```sh
npx pagedeck build
```

The build passes. `"/counter/"` beats `"/**"` for `/counter/` because it is the
more specific pattern; [which pattern wins](../reference/javascript-budgets.md#which-pattern-wins)
has the rules. Every other page is still held to 0 B, so the next page that
starts to ship JavaScript fails the build until you give it a key.
[JavaScript budgets](../reference/javascript-budgets.md) covers what a page's cost
includes and the size units.

## 5. Read the report

Every build of a site with a budget writes `.pagedeck/budget-report.json`,
beside `pagedeck.config.ts` and outside `site/`. A failing build writes it too.
It has one row per budgeted page. This is the row for the greeting's page:

```json
{
  "locale": "en",
  "path": "/greet/",
  "pattern": "/greet/",
  "limitText": "60kb",
  "limit": 61440,
  "actual": 53430,
  "jsInlined": 0,
  "css": 0,
  "cssInlined": 0,
  "html": 280,
  "breach": false,
  "chunks": [
    { "path": "/assets/fw-core-DDGHZVhO.js", "bytes": 52145 },
    { "path": "/assets/fw-startup-DtWrQx5C.js", "bytes": 992 },
    { "path": "/assets/entry-8c8b51d5ffe9bbeb-BAEKmaf-.js", "bytes": 293 }
  ],
  "causes": [],
  "largestIslandProps": 2,
  "islandPropsBreaches": []
}
```

`actual` is what the page transfers for first render, and it is the sum of
`chunks`. `breach` is `actual > limit`. `css` and `html` are reported beside
it and never count against the budget. `causes` lists what fold strategy moved
on the page, and is empty here because the greeting's `hydrate` is explicit.
Two builds of the same site write the same rows, so you can keep the report
from each build and compare a page's `actual` over time.
[The report](../reference/javascript-budgets.md#the-report) describes every field.
