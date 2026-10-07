---
section: reference
title: Fold strategy
description: The build promotes islands near the top of a page to hydrate on load and demotes pinned ones further down, and a site can tune or disable it.
---

# Fold strategy

A component that carries `"use client"` and nothing else hydrates on `visible`:
its JavaScript is fetched when it scrolls into view. That is the right default
for most of a page and the wrong one for the top of it — an interaction a
visitor can reach without scrolling should already be wired up.

**Fold strategy decides that per instance, per page.** An instance near the top
of the page's tree is promoted to `load`; an instance the site pinned to `load`
that turns out to sit far down the page is demoted to `visible`. You write the
directive once and the build does the tuning you would otherwise do by hand, on
every page, and get wrong on some of them.

It is **on for every site**. There is nothing to declare to get it.

## Turning it off, and tuning it

```ts
build: {
  outDir: "./site",
  foldStrategy: false,
  // ...
}
```

```ts
build: {
  outDir: "./site",
  foldStrategy: { threshold: 12 },
  // ...
}
```

`false` restores exactly the modes the registry and the `"use client"`
directives ask for. `true` and an absent field are the same thing: on, with the
default threshold. There are no page patterns — the field declares a policy, and
deciding page by page is what the feature already does for you.

## What gets moved, and what never does

The rule has one asymmetry and it is deliberate: **an explicit `hydrate` in the
registry is never promoted.** If you wrote `hydrate: 'visible'` on a heavy
carousel, you demoted it on purpose, and a build that promoted it back would be
overruling the one person who has measured the page.

| The component's mode | Above the fold | Below the fold |
| --- | --- | --- |
| `"use client"`, no `hydrate` (`visible`) | promoted to `load` | unchanged |
| `hydrate: 'visible'` | **unchanged** | unchanged |
| `hydrate: 'load'` | unchanged | demoted to `visible` |
| `hydrate: 'idle'` | unchanged | unchanged |
| `hydrate: 'none'`, or no directive | unchanged | unchanged |

Nothing is ever promoted past `load`, and a static component is never made into
an island.

Demotion applies to `hydrate: 'load'` because that is the only way a `load` mode
ever arises — no directive defaults to it — and because moving a below-fold
island off first render is a saving, not a reversal of a performance decision.
If you want an instance eager wherever it sits, `foldStrategy: false` or a
narrower tree is the answer today.

## What "the fold" means here

**A tree position, not a pixel.** Every node of a page's content tree gets an
index in a pre-order walk — the order a reader meets the blocks — and the
threshold is the first index that counts as below the fold. The default is `4`,
so positions 0 through 3 are above it.

The index counts **every node**, not every island and not every top-level block.
A hero with three children occupies four positions.

### Why 4

The target is a phone. The framework's success criterion is PageSpeed **mobile**
≥ 90, so the viewport the number has to be right for is roughly 360×640 CSS
pixels, not the 1280×900 you are probably reading this on.

A top-level content block is a section 300–700 pixels tall on a phone and
carries one to four nested children, so one visible section costs two to five
positions. A phone shows about one and a half such sections, which puts the
honest estimate at three to seven nodes. A desktop shows two to three sections,
so a desktop-chosen default would be roughly twice that.

The number is taken from the bottom of that range rather than the middle,
because the two errors do not cost the same:

- **Promoting something that is actually below the fold** puts its chunk into
  the page's first-render transfer. Those bytes are charged to the page's
  [JavaScript budget](./javascript-budgets.md) and paid for on a phone that
  never renders the component.
- **Not promoting something that is above the fold** costs an
  `IntersectionObserver` callback. The element is already in the viewport, so
  the observer fires on the first frame and the island mounts anyway, slightly
  later.

One ships bytes nobody uses; the other delays a mount by a frame.

Four and not three, which is the one part of the choice the asymmetry does not
make on its own: a threshold that lands inside a section promotes some of a
block's children and not its others, a split nothing on the page corresponds to.
Four covers a whole leading section of the common shape — a block with three
children — and stays at the bottom of the phone estimate.

### Where it diverges from what a visitor sees

This is the honest limitation, and it does not get better with a different
number:

- **CSS reorders.** `order`, `flex-direction: column-reverse` and absolute
  positioning can put the tree's last block at the top of the screen. The build
  never opens a stylesheet, so it cannot know.
- **Mobile and desktop disagree.** A three-column section is one screenful on a
  desktop and three on a phone. The same tree position is above the fold on one
  and well below it on the other. The default picks the phone.
- **A wide block spends the whole budget.** A feature grid with twenty cards is
  twenty-one positions and one section of the page. Lower the threshold on a
  site shaped that way, or turn the feature off.

Measuring real visual position would need a headless browser at build time,
which this framework does not run — the same reason
[critical CSS](./critical-css.md) inlines a page's whole reachable set instead
of guessing what is above the fold.

### Template-driven pages

A page rendered from a template is a **single node**, and a tree of one node is
never promoted. There is nothing on such a page for its only node to be above:
position 0 is not a fact about the page, it is the only number the only node
could have had. Promoting on it would move that page's whole JavaScript payload
into first render — on a template page the island *is* the page — for no
evidence about where anything sits.

Pin it with `hydrate: 'load'` if you want it eager; the registry always wins.

A page whose tree has a second node is tuned like any other, including a single
root with children: the count is of nodes, not of top-level blocks.

Components a template renders from its own code are invisible to fold strategy —
they have no position in a content tree — and keep whatever mode they were
declared or defaulted to.

## What the build tells you

Every decision is recorded per page in `manifest.json`, under `foldTuning`:

```json
{
  "locale": "en",
  "path": "/pricing",
  "foldTuning": [
    {
      "component": "PlanPicker",
      "position": 0,
      "from": "visible",
      "to": "load"
    }
  ]
}
```

Empty on a page nothing moved, and on every page of a site that turned the
feature off.

## Fold strategy and budgets

A promoted island's JavaScript is a first-render transfer, so it **counts
against that page's [budget](./javascript-budgets.md)** — which is the point of
promoting it. A demoted island's does not.

Budgets are re-evaluated on every build, so a content edit that pushes a block
above the threshold can legitimately breach one. When that happens the failure
says so, rather than leaving you to work out which component appeared:

```
JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /pricing — "/pricing" allows 15360 B, the page transfers 70813 B over 3 chunks:
    /assets/fw-core-DO-Blg1p.js — 52397 B
    /assets/PlanPicker-9f31.js — 18004 B
    /assets/en_pricing-1a2b.js — 412 B
    fold strategy promoted "PlanPicker" at tree position 0 from "visible" to "load" — position 0 is above the fold threshold of 4
```

The same sentences are in `budget-report.json` under each page's `causes`,
including the demotions — that field says why a page's spend is what it is, not
only why it is too high.

## What the build refuses

A `foldStrategy` that is neither a flag nor an object:

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" must be true, false, or an object with a threshold — write foldStrategy: false to turn fold-driven hydration off, or foldStrategy: { threshold: 8 } to tune it
```

A threshold that is not a count of nodes, with the reason on its own line — a
number in quotes, a fraction and a negative are three different mistakes:

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }:
  "8" — not a number
```

A key `foldStrategy` does not take, which would otherwise get you the default
with nothing said about it:

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" declares 1 field this build does not read — delete the field, or correct it to "threshold", the only field foldStrategy takes:
  "treshold"
```

All three are checked when the config loads, before a page is rendered.
