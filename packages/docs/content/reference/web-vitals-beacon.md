---
section: reference
title: The web-vitals beacon
description: Report LCP, CLS and INP from real visits to your own endpoint with build.beacon, sent only after analytics consent, and what it costs a page.
---

# The web-vitals beacon

Lab numbers tell you what a page does on the machine that built it. The beacon
tells you what it did for the people who visited it: the Largest Contentful
Paint, Cumulative Layout Shift and Interaction to Next Paint of one real visit,
reported with the page it happened on.

That is what closes the loop with per-page [JavaScript
budgets](./javascript-budgets.md). A budget is a guess about which pages matter
until real-user data says which pages are actually slow, for actual visitors, on
actual devices.

**There is nothing to turn on and nothing to turn off.** A site that declares no
`build.beacon` carries no beacon bytes at all — not a runtime that checks a
flag, not an empty configuration object. The element is not in the document.

## Declaring it

```ts
import { defineConfig } from "@pagedeck/core";

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    // …
    beacon: { endpoint: "https://collector.example.com/rum" },
  },
});
```

`endpoint` is the only field, and declaring the object is the on switch. It may
be an absolute `https:` URL, or a path on your own site:

```ts
beacon: { endpoint: "/rum" },
```

A path is the cheaper of the two for the visitor — same origin, no second
connection, no preflight — if you can terminate it at your CDN.

## What arrives at your endpoint

One `POST` per page visit, with a JSON body:

```json
{ "lcp": 1842, "cls": 0.03, "path": "/pricing", "locale": "de" }
```

- `lcp` — Largest Contentful Paint, whole milliseconds.
- `cls` — Cumulative Layout Shift, the worst session window, to four decimal
  places.
- `inp` — Interaction to Next Paint, whole milliseconds: the worst interaction
  of the visit.
- `locale` and `path` — the page, as the framework identifies it. This is the
  same `(locale, path)` pair your page patterns are written against, so a report
  groups by market and by section with nothing to join on.

**A metric the browser did not report is not in the payload.** The example above
has no `inp` because that visitor did not interact with the page, and a visit
with no layout shift carries no `cls`. Do not read a missing field as a zero;
read it as "not measured".

The body is sent with `navigator.sendBeacon`, and with a keep-alive `fetch`
where the browser's queue was full. Nothing is sent on `unload`: that handler
janks the page it is leaving and disqualifies it from the back/forward cache.

Everything behind the endpoint is yours. The framework sends the request and has
no opinion about what receives it, stores it or draws it.

## It waits for consent, and the category is `analytics`

The beacon is analytics, so it reports only for a visitor who has consented to
that category. It reads the same [consent source](./third-party-scripts.md)
your third-party scripts do — your own object at `window.fwConsent` — and it
reads it at the moment it would report, not earlier. A visitor who accepts halfway through a visit is reported;
one who withdraws consent is not.

The category is fixed, and there is no field to change it. A performance beacon
declared `necessary` would be this framework letting a config say, on its own
behalf, that it may measure people who declined to be measured.

**Until your consent source answers, the beacon assumes what your markets
say.** That is `build.scripts.consentDefaults`, the same map that decides what
your gated scripts assume:

```ts
scripts: defineScripts({
  scripts: [{ name: "tags", src: "https://example.com/tags.js" }],
  consentDefaults: { "en:/**": { analytics: "granted" } },
}),
beacon: { endpoint: "/rum" },
```

**Declare a beacon and no scripts and you have no such map**, so every market
assumes `denied` until your consent source speaks. That is a decision rather
than an oversight: market defaults are owned by one map, it lives on the script
layer, and there is no second one on `build.beacon` that could disagree with it
about the same market. What it costs you is a market missing from your dashboard
until your source speaks there.

Saying otherwise is the consent source's job, which is what decides this at
runtime anyway. You can install one before the page paints, with no script layer
anywhere, by declaring it in [`build.prePaint`](./page-head.md):

```ts
build: {
  outDir: "./site",
  prePaint: [
    `window.fwConsent = { granted: function (c) { return c !== "marketing" } }`,
  ],
  beacon: { endpoint: "/rum" },
  // ...
}
```

That is your code rather than a per-market default the build reads: a `prePaint`
entry is one piece of text every page carries, so a market that answers
differently is a branch you write in it.

Using the framework's [reference consent banner](./third-party-scripts.md)?
Declare its `CONSENT_PRE_PAINT_SCRIPT` in the same slot and a returning
visitor's own decision is installed before the beacon can report. A first-time
visitor still assumes `denied`, because that snippet installs nothing when there
is no answer to install.

## What it costs

About 1.3 KB of markup at the end of the body before compression (711 bytes
gzipped), and
no request: the beacon is written into the page rather than fetched. It is not
in the `<head>`, so nothing the page owns waits behind it.

Being written in rather than fetched does not make it free: every page carrying
the beacon is charged for those bytes against its
[JavaScript budget](./javascript-budgets.md), where what a budget counts is
written down.

The measuring starts when the browser goes idle. Nothing is lost by waiting —
every observer asks for the entries the browser recorded before it existed —
with one bounded exception, below.

Two things about `inp` are worth knowing before you read a report:

- **Interactions faster than 40 ms are not reported.** That is the threshold
  `web-vitals` uses, and it is set deliberately: left unset, browsers report
  nothing under 104 ms, and a page whose worst interaction was 90 ms would show
  no `inp` at all rather than a good one.
- **Between 40 ms and 104 ms, an interaction that happened before the first idle
  moment may be missed.** The browser keeps its pre-registration buffer at its
  own threshold, whatever the beacon asks for. This is the bounded cost of
  starting on idle, and it is the only one.

## What it does not do

- **It does not sample.** Every visit reports. Sampling belongs behind your
  endpoint, where you can change your mind without rebuilding every page.
- **It does not identify anyone.** No cookie, no identifier, no `Referer`
  handling, nothing about the visitor. The payload is the fields listed above and
  nothing else.
- **It does not retry.** A report that does not leave the browser is gone. A
  metric collected across a whole audience does not need the one that got away.
