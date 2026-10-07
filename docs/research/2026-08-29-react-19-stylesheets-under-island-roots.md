# React 19 stylesheets and document metadata under island roots

**Date:** 2026-08-29
**Status:** Decided. #22 took the stylesheet verdict below as written: a
`data-precedence` sheet is refused, and `CONTEXT.md`'s `<head>` decision records
why. **#239 ruled against §6's `<title>` and `<meta>` rows**: a component's
document metadata is *absorbed* into the framework's own `<head>` rather than
refused, because what the refusal protects is the tier order and metadata has
none to invert — two claims on one head singleton fail the build instead. The
measurements below are unchanged and were what decided both; only §6's verdict
column for those two rows is superseded.
**Question:** Does a `"use client"` component that uses React 19's resource
support — `<link rel="stylesheet" precedence>`, `preinit`/`preload`, `<title>`
and `<meta>` hoisting — compose with the deterministic CSS tiers of spec §9, or
must the build reject it?
**Relates to:** [flight-free RSC](2026-08-23-flight-free-rsc.md) unverified item
5 (line 525); [RSC support options](2026-08-23-rsc-support-options.md) line 203,
where this row is flagged ⚠; spec §9 "CSS"
**Method note:** everything load-bearing here was executed, not read. Seven
probes: the framework's own `renderPage` out of `packages/core/dist`, and
`react-dom/static`'s `prerender` → `hydrateRoot` per island in real Chromium
through Playwright, serving the pages and their CSS from a route handler. The
harness idiom is `packages/core/src/singleton.harness.ts`'s. **Versions:**
react 19.2.8, react-dom 19.2.8, Chromium 151.0.7922.34 (Playwright 1.62.1),
Node v24.18.1, esbuild 0.28.2 for the client bundle, `NODE_ENV=production`
(every finding re-run under `development`, which changed nothing — see §4).

---

## Verdict

**Reject at build time. It does not compose, and the failure is silent in every
direction.**

React 19's resource support is not merely *unhelped* by fragmented roots — it is
actively wrong under them, at build time and at hydration, and it produces no
warning, no error and no recoverable-error report at any point. Specifically:

1. **The build-time render puts the stylesheet in `<body>`, not `<head>`.**
   `packages/core/src/render.tsx` prerenders a *fragment*, and
   `packages/core/src/build.ts:516-519` writes a hand-built `<head>` containing
   only `<meta charset>`. React hoists resources to the front of the stream it
   is given; for a fragment that front is inside `<body>`. In the real
   `renderPage` output the link lands **inside the `<fw-island>` marker**.
2. **A `<body>` stylesheet beats a `<head>` tier stylesheet.** Measured in
   Chromium: at equal specificity the island's link wins, because it is later in
   document order. Any island using `precedence` silently outranks every tier
   the framework emits, which is the exact inversion spec §9 exists to prevent.
3. **Per-island passes are per-island resource scopes, but the client's dedupe
   is document-wide.** Two islands rendering the same href produce two `<link>`
   nodes in the HTML; at hydration a third island that needs the same href
   adopts a node living *inside another island's React root*. Resource
   ownership crosses root boundaries in a system built on the premise that roots
   are independent.
4. **A server/client disagreement about a stylesheet is not a hydration
   mismatch.** React reports nothing — not `console.error`, not
   `onRecoverableError`, not a window `error` event — in production *or*
   development. A control text mismatch in the same harness reports React error
   #418, so the instrument works. A stylesheet the server rendered and the
   client dropped stays in the DOM and keeps applying, forever, unreported.

The check is feasible and cheap: React stamps `data-precedence` on every
hoisted stylesheet, so the build can refuse on the *emitted bytes* of each pass
rather than on static analysis of source. See §6 — including the one case that
escapes it.

---

## 1. The build-time render

### What the render path actually is

`packages/core/src/render.tsx:47` imports `prerender` from `react-dom/static`,
not `renderToString`, and `prerenderToHtml` (line 1411) is the only call site.
The task framing assumed `renderToString`-family semantics; it is worth
recording that the codebase is on the *stronger* API — `prerender` implements
the full float/resource machinery. That makes the outcome worse, not better:
`renderToString` would have dropped the resource, whereas `prerender` faithfully
hoists it to a place the framework cannot use.

Two structural facts decide everything downstream:

- A page pass renders an **element tree with no `<html>`/`<head>`**, so React has
  no head to hoist into and emits resources at the head of the output stream.
- The document shell is string concatenation, not React
  (`packages/core/src/build.ts:513-528`):

```js
contents: [
  "<!doctype html>",
  `<html lang="${page.locale}" dir="${locale?.direction ?? "ltr"}">`,
  '<head><meta charset="utf-8"></head>',
  "<body>",
  html,
  ...
```

So React's "front of the stream" is the first byte **inside `<body>`**.

### Measured: `prerender` on a fragment

Probe 1, react-dom 19.2.8, `NODE_ENV=production`:

```
---- A fragment + precedence stylesheet mid-tree ----
<link rel="stylesheet" href="/island.css" data-precedence="high"/><main><p>before</p><p>after</p></main>

---- B two precedences declared low-then-high ----
<link rel="stylesheet" href="/low.css" data-precedence="low"/><link rel="stylesheet" href="/high.css" data-precedence="high"/><main><p>x</p></main>

---- B2 duplicate href, two components ----
<link rel="stylesheet" href="/same.css" data-precedence="high"/><main><p>x</p></main>

---- C title/meta in fragment ----
<title>Hoisted title</title><meta name="description" content="hoisted meta"/><main><p>a</p><p>b</p></main>

---- D preinit/preload in fragment ----
<link rel="preload" href="/preload.woff2" as="font" crossorigin="" type="font/woff2"/><link rel="stylesheet" href="/preinit.css" data-precedence="high"/><link rel="modulepreload" href="/mod.js"/><main><p>preinit component</p></main>

---- E full document tree ----
<!DOCTYPE html><html><head><link rel="stylesheet" href="/doc.css" data-precedence="high"/><title>Doc title</title></head><body><main><p>x</p></main></body></html>
```

So: **not dropped, not left inline where written — hoisted to the front of the
fragment**, which is the wrong place. Case E is the contrast: given a document
tree React puts the same link in `<head>`, which is what every React 19
stylesheet document assumes. The framework never gives React a document tree.

Within one pass the semantics are correct: B2 shows same-href dedupe, and B
shows precedence ordering (order of *first appearance* of each precedence name,
not any ranking of the names — "low" was declared first and sorts first).
Neither property survives leaving the pass.

### Measured: the framework's own `renderPage`

Probe 2 calls `renderPage` from `packages/core/dist/render.js` with a static
`Page` component and two instances of a `"use client"` `Widget`, plus a static
`Other` rendering the *same* href as the island:

```html
<link rel="stylesheet" href="/page-tier.css" data-precedence="page"/><link rel="stylesheet" href="/widget.css" data-precedence="island"/><title>Page title from a static component</title><main><fw-island data-fw-prefix="idc36c2d10ed8" data-fw-component="Widget" data-fw-mode="visible" data-fw-props="{&quot;label&quot;:&quot;one&quot;}" role="presentation" style="display:contents"><link rel="preload" href="/widget.woff2" as="font" crossorigin=""/><link rel="stylesheet" href="/widget-preinit.css" data-precedence="island"/><link rel="stylesheet" href="/widget.css" data-precedence="island"/><meta name="island-meta" content="from island"/><div><button>one</button></div></fw-island><div><span>other</span></div><fw-island data-fw-prefix="i135debe431e0" ... ><link rel="preload" href="/widget.woff2" as="font" crossorigin=""/><link rel="stylesheet" href="/widget-preinit.css" data-precedence="island"/><link rel="stylesheet" href="/widget.css" data-precedence="island"/><meta name="island-meta" content="from island"/><div><button>two</button></div></fw-island></main>
```

Read it carefully — five facts, all of them problems:

1. `/widget.css` appears **three times**: once from the page pass (the static
   `Other` node), once inside each island marker. **Dedupe does not cross
   passes**, because each `prerender` call has its own resource state. Spec
   §7's per-island pass model is exactly what breaks it, and there is no option
   to share resource state across `prerender` calls.
2. The page pass's own hoisted resources land at the top of the fragment — i.e.
   the first bytes of `<body>`, in front of `<main>`. **This is not
   island-specific.** A purely static component using `precedence` has the same
   defect. The bug is the fragment render, and islands only multiply it.
3. Island resources are emitted **inside `<fw-island style="display:contents">`**
   — a custom element in the body — because the island's HTML is composed into
   the marker as an opaque string.
4. The `<title>` also lands in `<body>`. `<link rel=stylesheet>` in body is
   valid HTML (`stylesheet` is a body-ok `rel`); `<title>` in body is **not** —
   `title` is metadata content, permitted in `<head>` only. That part is
   inferred from the HTML specification, not measured; what §3 measures is what
   Chromium *does* with it.
5. Nothing in the framework noticed. `faultsInEmittedHtml`
   (`packages/core/src/render.tsx`) already walks the emitted bytes of every
   pass, so the place to notice exists — see §6.

---

## 2. Hydration under fragmented roots

Probe 3: server HTML from one `prerender` per island, each wrapped in
`<fw-island style="display:contents">`, each hydrated by its own `hydrateRoot`
under its own `identifierPrefix` — the shape
`packages/islands/src/runtime.ts:697` produces. Real Chromium 151.0.7922.34.

### React does not move server-rendered resources into `<head>`

Scenario `two-islands-same-href` — two islands, same href, nothing in `<head>`:

```
-- head after hydration --
   <meta charset="utf-8">
-- every <link>, with parent --
   FW-ISLAND: <link rel="stylesheet" href="/shared.css" data-precedence="isl">
   FW-ISLAND: <link rel="stylesheet" href="/shared.css" data-precedence="isl">
-- console errors/warnings --
   (none)
```

**Two links, both left in `<body>`, no relocation, no dedupe, no complaint.**
Hydration adopts an existing node as the resource instance and never moves it;
`<head>` stays empty because React found what it needed already in the document.

### The dedupe is document-wide, so resources cross root boundaries

Probe 7 makes this decisive. Island A's *server* HTML carries
`<link href="/shared.css">`; island B's server HTML does not, but B's *client*
render asks for the same href:

```
A server HTML: <link rel="stylesheet" href="/shared.css" data-precedence="isl"/><div><p>A</p></div>
B server HTML: <div><p>B</p></div>
nodes for /shared.css after hydration: [ 'FW-ISLAND[a]' ]
head: [ '<meta charset="utf-8">' ]
errors: []
```

B created nothing. It **adopted the node living inside island A's React root**.
So island B's stylesheet is a DOM node owned by a different `hydrateRoot`, and B
gets its CSS only because A happens to be on this page and happens to have
rendered the same href. Delete A from the page — a content edit, in a
CMS-driven framework — and B silently starts inserting its own. The
independence of island roots, which the whole architecture rests on, does not
hold for resources.

### Runtime insertion lands wherever the last `data-precedence` node is

Probe 3, scenario `mismatch`: island A's server HTML has `/drops.css`; island
B renders `/adds.css` for the first time on the client.

```
-- head after hydration --
   <meta charset="utf-8">
   <link rel="preload" as="style" href="/adds.css">
-- body innerHTML --
<fw-island data-id="a" style="display:contents"><link rel="stylesheet" href="/drops.css" data-precedence="isl"><link rel="stylesheet" href="/adds.css" data-precedence="isl"><div><p>drops</p></div></fw-island><fw-island data-id="b" ...>
```

Island **B's** stylesheet was inserted into island **A's** marker, next to A's
own link. React's client-side stylesheet insertion positions a new sheet
relative to the last `[data-precedence]` node it finds in the document, and that
search is document-wide, so a body node inside a foreign root is a legitimate
anchor. Only the `preload` hint went to `<head>`.

Same effect from `preinit`, scenario `preinit`: island B calls
`ReactDOM.preinit("/effect-b.css", …)` from an effect, and the sheet is created
inside island A's marker:

```
-- every <link>, with parent --
   FW-ISLAND: <link rel="preload" href="/preload-a.woff2" as="font" crossorigin="">
   FW-ISLAND: <link rel="stylesheet" href="/preinit-a.css" data-precedence="isl">
   FW-ISLAND: <link rel="stylesheet" href="/effect-b.css" data-precedence="isl">
```

### Precedence ordering does not work across roots

Scenario `precedence-order` — `<head>` carries a tier link, island A declares
precedence `low`, island B declares `high`:

```
-- every <link>, with parent --
   HEAD: <link rel="stylesheet" href="/tier.css" data-precedence="page">
   FW-ISLAND: <link rel="stylesheet" href="/low.css" data-precedence="low">
   FW-ISLAND: <link rel="stylesheet" href="/high.css" data-precedence="high">
```

Each island's sheet stays where its own pass wrote it. The cascade order is
therefore **document order of the islands on the page**, which is CMS content,
not the precedence the author declared. Precedence ordering across islands is
not merely unsupported; it is replaced by an unrelated ordering that looks like
it works whenever the two happen to agree.

### The tier inversion, measured in the browser

Probe 5. `<head>` carries `/tier.css` = `.box{color:rgb(0,0,255)}`; one island
renders `<link href="/island.css" precedence="island">` =
`.box{color:rgb(255,0,0)}`. Equal specificity.

```
computed color of .box: rgb(255, 0, 0)
stylesheet order the browser sees: [
  'HEAD https://probe.invalid/tier.css',
  'FW-ISLAND https://probe.invalid/island.css'
]
```

**The island wins.** This is the finding that decides the ticket: one
`"use client"` component using React 19 stylesheet precedence overrides every
deterministic tier the framework emits, on every page it appears on, with no
diagnostic anywhere.

---

## 3. `preinit`/`preload` and `<title>`/`<meta>`

### `preinit`/`preload`

At build time (probe 1 case D, probe 2) all three forms — `preinit` with
`as: "style"`, `preload`, `preloadModule` — emit their tag at the front of the
pass's fragment, so they land in `<body>`, inside the marker for an island.
`preinit(href, { as: "script" })` emits `<script src async>` in `<body>`; the
browser executes it (deferred-parser-inserted script semantics), so it is not
broken, only misplaced.

At hydration (probe 3, scenario `preinit`) a `preinit` called from an effect
creates the stylesheet in the document, positioned as §2 describes — inside a
foreign island. A `preload` hint issued for a sheet React must create *does*
reach `<head>` (`mismatch` scenario above). So `<head>` receives the hints and
`<body>` receives the resources, which is the reverse of useful.

### `<title>` and `<meta>`

Scenario `metadata`, two islands each rendering `<title>` and two `<meta>`s over
a document whose `<head>` already had `<title>page title from build</title>`:

```
-- head after hydration --
   <meta charset="utf-8">
   <title>title-from-b</title>
   <title>title-from-a</title>
-- resource nodes still in body after hydration --
   <title>title-from-a</title>
   <meta name="description" content="desc-from-a">
   <meta property="og:title" content="og-from-a">
   <title>title-from-b</title>
   <meta name="description" content="desc-from-b">
   <meta property="og:title" content="og-from-b">
-- document.title: "title-from-b" | <title> count: 4
-- console errors/warnings --
   (none)
```

Four `<title>` elements in one document. `<meta>` is **never** hoisted at
hydration — every island's `<meta>` stays in `<body>`, where a crawler reading
head metadata will not find it. This is the one place the finding is genuinely
worse than "does not work": it *looks* like it works, because
`document.title` is a plausible value.

Probe 4 tracked node identity across hydration to establish what happens to the
build's own `<title>`:

```
head BEFORE hydration:
   <meta charset="utf-8">
   <title>page title from build</title>
head AFTER hydration:
   <meta charset="utf-8">
   <title>title-from-a</title>
build <title> node still connected: true | its text now: "title-from-a" | parent: HEAD
document.title: "title-from-a"
console errors: (none)
```

**The build's `<title>` node is adopted and overwritten in place.** With two
islands, the second one's title is inserted *before* the first's, so
`document.title` — the first `<title>` in tree order — is decided by hydration
order, which under `visible`/`idle` strategies is scroll- and
viewport-dependent. A page's title becoming a function of where the reader
scrolled is not a defect the framework can ship past.

---

## 4. The hydration-mismatch question

**React reports nothing. In production and in development.**

Probe 3, scenario `mismatch`, runs both directions at once: island A's server
HTML has `/drops.css` and its client render omits it; island B's server HTML
omits `/adds.css` and its client render adds it. Console errors,
`console.warn`, `window` `error` events and an explicit `onRecoverableError`
callback were all captured:

```
-- console errors/warnings --
   (none)
```

Re-bundled with `process.env.NODE_ENV === "development"` and re-run, every
scenario in probe 3: still `(none)`.

The instrument is not blind. Probe 4's control — the same harness, the same
capture, an ordinary text mismatch — reports:

```
console errors:
   onRecoverableError Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]=
```

(React 19's default `onRecoverableError` is `reportError`, which surfaces as a
window `error` event rather than `console.error`. An earlier version of these
probes captured only `console.error` and saw nothing even for the control. Any
future harness in this repo must capture all three; the mistake is easy and
silent.)

And the DOM is **not** repaired. In the `drops` direction the server's
`/drops.css` link is still connected after hydration and still in the cascade —
React does not remove a hoistable it no longer renders, because it never claimed
that DOM position in the first place. So the failure mode named in the ticket
("a silent client re-render would repair the DOM and hide the problem") is not
what happens; what happens is worse. There is no re-render, no repair and no
report: the stale stylesheet simply stays applied for the life of the page.

---

## 5. What this changes about the CSS tier design

Two findings outside the four questions, both actionable for spec §9.

### `data-precedence` on the framework's own tier links is a policy lever

Probe 6 runs the same page twice, changing only whether the framework's tier
`<link>` in `<head>` carries `data-precedence`. The island renders its
stylesheet for the first time on the client, so React must create the node:

```
===== tier link WITH data-precedence =====
head after hydration:
   <meta charset="utf-8">
   <link rel="stylesheet" href="/tier.css" data-precedence="page">
   <link rel="stylesheet" href="/island.css" data-precedence="island">
   <link rel="preload" as="style" href="/island.css">
computed .box color: rgb(255, 0, 0)   (head tier = blue, island = red)

===== tier link WITHOUT data-precedence =====
head after hydration:
   <link rel="stylesheet" href="/island.css" data-precedence="island">
   <meta charset="utf-8">
   <link rel="stylesheet" href="/tier.css">
   <link rel="preload" as="style" href="/island.css">
computed .box color: rgb(0, 0, 255)   (head tier = blue, island = red)
```

React's insertion walks `[data-precedence]` nodes: with a match it appends
*after* the last one (island wins); with no match at all it falls back to
`head.insertBefore(node, head.firstChild)` (tier wins — and the new node lands
in front of `<meta charset>`, which is cosmetically alarming but harmless, since
this is DOM mutation after parsing, not a re-parse).

**So the tier system must not stamp `data-precedence` on its links.** That is a
one-line constraint on a design not yet written, and it is worth writing down
now, because a framework that adopted React's attribute for its own ordering —
an obvious-looking choice — would hand the cascade to whichever island loaded
last. It only governs sheets React creates at runtime; a server-emitted island
sheet sits in `<body>` and wins regardless, which is why §6's build-time refusal
is still required.

### The page's `<head>` is currently a string, and that is now load-bearing

`build.ts` emits `'<head><meta charset="utf-8"></head>'` and nothing else. That
means every future tier link, critical-CSS `<style>` and metadata tag is placed
by the framework, in an order the framework fully controls — which is precisely
what makes "deterministic tiers" achievable. The measurements above say that
control ends the moment React is allowed to place a resource. The tier design
should treat the `<head>` as a framework-owned region with a single writer,
and issue #22's rejection is the enforcement of that ownership rather than a
special case about one React feature.

---

## 6. What the build would detect, and what it would miss

**A `precedence` prop is not reliably detectable in island source, and it does
not need to be.** React stamps `data-precedence` on every stylesheet it hoists,
in every emitted pass (visible in every probe output above). The detection can
therefore be a **byte scan over each pass's HTML**, which answers for the
rendered result rather than the source, and so is immune to prop spreads,
helper modules in another file, re-exports and third-party components inside the
`"use client"` closure — every case a static scan would have to give up on.

The scan already exists in the right place. `faultsInEmittedHtml`
(`packages/core/src/render.tsx`) walks the emitted bytes of a pass tag by
tag, tracking an open-element stack. The line range this note used to give
here had rotted onto an unrelated declaration, so the function is named rather
than numbered: a line number is the fastest part of a citation to go stale.
Adding a rule is a new case in that walk, not new machinery. What it keys on, in
order of
confidence:

| tag shape in a pass's output | what it means | verdict |
|---|---|---|
| `<link … data-precedence="…">` | a component used `precedence`, or `preinit(…, { precedence })` | refuse, naming the component and the href |
| `<title>` outside the framework's own shell | React metadata hoisting | refuse |
| `<meta>` from a component | React metadata hoisting | refuse |
| `<link rel="preload">`, `<link rel="modulepreload">`, `<script … async>` | `preload`/`preloadModule`/`preinit(as:"script")` | refuse, or allow once the tier design has somewhere to put them |

Two limits, stated plainly.

**A `preinit` call made from an effect is invisible to the build.** Probe 3's
`/effect-b.css` exists only after hydration; nothing in the emitted HTML
mentions it. A byte scan cannot see it, and neither can a static scan of an
arbitrary import graph. If issue #22 wants a hard guarantee it needs a second,
weaker check — a static scan of the `"use client"` closure for imports of
`preinit`/`preinitModule` from `react-dom`, which is detectable (the import
specifier is the anchor, and the closure is already computed by
`directive-scan.ts` for the directive scan) but is defeatable by indirection.
Recommend shipping the byte scan as the enforced rule and the import scan as a
build warning, and saying so in the error message.

**A component rendering `<link rel="stylesheet">` without `precedence`** gets no
`data-precedence` attribute and is not a React resource at all — it is an
ordinary element that stays where it was written. It is not this ticket's
subject, but the scan should not accidentally refuse it, and a rule written
against `data-precedence` rather than against `<link>` does not.

---

## What I could not determine

1. **Whether React removes a body-located stylesheet when the island that owns
   it unmounts.** Not probed. It matters for the cross-root adoption in §2 —
   island A unmounting while island B depends on A's node is the obvious
   failure, and I have not measured it.
2. **Whether search engines and social scrapers read a `<meta>` in `<body>`.**
   §3 measures where the tags land; what consumers do with them is asserted from
   the HTML specification's content model, not measured.
3. **Suspense inside an island with a stylesheet resource.** React suspends
   rendering on a stylesheet load in some configurations; none of these probes
   had a Suspense boundary, so nothing here says whether an island's paint can
   be blocked by a sheet it declared.
4. **Whether `renderToPipeableStream`/`resume` would behave differently.** Only
   `prerender` was measured, because that is the only server API this codebase
   calls (`render.tsx:47`). The finding that a fragment hoists to the front of
   its stream is likely general to Fizz, but that is inference.
5. **View transitions, `<style href precedence>` (inline style resources), and
   `preinitModule`.** Not probed.
6. **Nothing was measured through a real `fw build`.** Probe 2 drives
   `renderPage` from `packages/core/dist` directly; the document shell it would
   be composed into is read from `build.ts:513-528` rather than executed. The
   composition is string concatenation, so the risk is low, but it is inference.
7. **No harness from this work was kept.** All seven probes are throwaway and
   live in the session scratchpad. If issue #22 implements the byte scan of §6,
   the scenario set in probe 3 — dedupe, two-islands-same-href, precedence
   order, metadata, preinit, mismatch, plus the probe-4 control — is worth
   rebuilding as a kept harness alongside `singleton.harness.ts`, because the
   whole finding rests on React behaviour that React does not document and does
   not promise.
