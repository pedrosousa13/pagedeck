# Next.js App Router in static export: does it already do what we're building?

**Date:** 2026-08-23
**Status:** Decision input — no decision taken
**Question:** Could Next.js App Router, in fully static export mode (`output: 'export'`, no server, no ISR, no proxy/middleware), already deliver the framework's founding goals — per-page bundle control, **zero JS on non-interactive pages, no page-level data blob**, incremental partial redeploys, 50 k pages under 10 min, first-class multi-locale/multi-domain?
**Relates to:** [Design spec](../specs/2026-08-23-framework-design.md) §1–§3, §16; decisions #3, #5, #12, #20
**Companion:** [Bundler deep dive](2026-08-23-bundler-deep-dive.md) §3 (Turbopack), [Flight-free RSC](2026-08-23-flight-free-rsc.md)
**Method note:** the load-bearing numbers here were **measured, not recalled**. I built two real projects with `next@16.3.2` / `react@19.2.0` / `react-dom@19.2.0`, `output: 'export'`, default Turbopack, `NODE_ENV=production`, Node 24.18.1 on a 4-core Linux box, and read the emitted `out/` byte-for-byte. Where I quote behaviour I could not measure, it is quoted from `nextjs.org/docs` (version stamp 16.3.2) or from `node_modules/next/dist` source at that exact version. Current Next.js stable at time of writing: **16.3.2** (`npm dist-tag`, `latest`); canary `16.4.0-canary.2`.

---

## Verdict

**No — and on goals 1 and 2 it is not close, and not a matter of configuration.**

A statically exported App Router page containing **zero client components** ships, in Next 16.3.2:

- **six `<script>` tags**, five of which load real chunks — **452,538 bytes raw / 133,120 bytes gzip** of JavaScript (plus a 112,594-byte `noModule` polyfill chunk for legacy browsers);
- **11,051 bytes of inlined RSC flight payload** (`self.__next_f.push(...)`) against **6,023 bytes of actual markup** — the data blob is **1.83× the size of the document it describes**;
- **a sidecar `.txt` flight file per route** (9,480 bytes here), plus three per-route segment-prefetch `.txt` files.

The difference in JavaScript between that page and an otherwise-identical page with an interactive `useState` counter is **283 bytes**. The baseline is entirely fixed. There is **no supported configuration that emits an App Router page with no script tags** — the Pages Router's `unstable_runtimeJS: false` exists only in `next/dist/pages/_document.js` and was never carried over, and the request to carry it over ([#45009](https://github.com/vercel/next.js/issues/45009), Jan 2023) is closed unimplemented.

This is precisely the founding complaint in spec §1, restated in a newer serialisation format. `__NEXT_DATA__` became `self.__next_f`, and it got *bigger*, because the flight payload serialises the whole rendered tree rather than just the props.

On the other goals: **incremental builds do not exist** in static export (measured: a rebuild with zero changes re-rendered all 5,003 routes and rewrote all 25,020 output files); **50 k pages is borderline-feasible but every content edit costs a full build**; **i18n routing is explicitly documented as not integrating with `output: 'export'`**, and multi-domain has no mechanism at all; and **native per-page JS budgets do not exist — Next 16.0 *removed* bundle size reporting from `next build`**.

Where App Router genuinely wins is the authoring model (`"use client"` boundaries as a first-class, React-blessed contract), ecosystem, and portability. Nothing found here changes that, and it remains the honest argument for adopting it. But it does not close goals 1, 2, 4, or the §16 incremental target, and the reasons are structural rather than missing-feature.

---

## 1. Zero-JavaScript pages: impossible, by construction

### What I built

Two routes in one `output: 'export'` project:

- `app/page.tsx` — a Server Component, no `"use client"` anywhere in its subtree, ~40 paragraphs of static text.
- `app/interactive/page.tsx` — renders one `"use client"` counter with `useState`.

### What the zero-client-component page shipped

`out/index.html` is **17,074 bytes**. Stripping every `<script>…</script>` leaves **6,023 bytes** of markup. Six script tags:

| Chunk | Raw bytes | gzip -9 | Note |
|---|---:|---:|---|
| `41qfcvra0dvw4.js` | 182,520 | 48,192 | |
| `02fh7_m5mrih8.js` | 229,156 | 71,491 | contains `react-dom` |
| `turbopack-3e4yhf95h70kc.js` | 9,688 | 3,870 | Turbopack chunk runtime |
| `3fntmmi971322.js` | 14,377 | 3,678 | app-router client entry |
| `3l04zcqx63h3y.js` | 16,797 | 5,889 | loaded via `<link rel=preload as=script>` |
| **modern-browser total** | **452,538** | **133,120** | |
| `0cz1d0mv5g_q7.js` | 112,594 | 39,392 | `noModule` — legacy browsers only |

Verified genuinely production: `next build` printed "Creating an optimized production build", and every chunk is single-line minified.

### The delta to an interactive page is 283 bytes

`out/interactive.html` loads the **same five chunks** plus one extra: `0zogv1dw-lcus.js`, **283 bytes**, containing the counter. That is the entire marginal cost of interactivity, and the entire fixed cost of non-interactivity is the other 452 kB.

Restating the spec's goal 1 against this: "each page loads exactly the components it uses" is *directionally* satisfied for the components themselves — Next did tree-shake the counter into its own 283-byte chunk. Goal 2 — "zero JS on pages with no interactive components" — is violated by 452 kB with no configuration surface to reduce it.

### Is there *any* supported configuration?

**No.**

- **`unstable_runtimeJS: false` is Pages Router only.** Grepping `next@16.3.2`'s shipped `dist`, the identifier appears only in `pages/_document.js`, `server/render.js`, `shared/lib/html-context.shared-runtime`, and the compiled `pages*.runtime` bundles. It is not a `next.config` option (absent from `server/config-schema.js`) and has no App Router equivalent.
- **[vercel/next.js#45009](https://github.com/vercel/next.js/issues/45009)** — *"fully static, zero JS pages (no React runtime, no rehydration) + Ability to bundle raw scripts (like Astro.js)"*, opened 2023-01-18 — is **closed**, unimplemented. The report explicitly cites Astro: *"Astro.js proved that demand for this approach is quite big."* Related, also unaddressed: [discussion #32217](https://github.com/vercel/next.js/discussions/32217) "Truly static pages without react app", [discussion #45174](https://github.com/vercel/next.js/discussions/45174).
- **The static-export guide never claims zero JS.** Its framing is *relative*: *"By breaking a strict SPA into individual HTML files, Next.js can avoid loading unnecessary JavaScript code on the client-side, reducing the bundle size"* — less JS than an SPA, not none. ([Static Exports](https://nextjs.org/docs/app/guides/static-exports), v16.3.2, lastUpdated 2026-08-09.)

### The one escape hatch — and why it isn't one

A **Route Handler** returning HTML *does* emit a script-free file. I verified this: `app/raw.html/route.ts` with `export const dynamic = 'force-static'` returning a `Response` with `content-type: text/html` produced `out/raw.html` containing exactly the 66 bytes I returned and nothing else.

This works. It is also not a framework: no layout, no React rendering, no component model, no `next/link`, no metadata, no CSS pipeline — you are hand-assembling HTML strings inside a Next.js build. It is worth recording as *possible*, and worth rejecting as an authoring model. The docs sanction the mechanism ("This can be used to generate static HTML, JSON, TXT, or other files") but obviously not as a page-authoring path.

**Classification: impossible** (for React-authored pages, in any supported configuration).

---

## 2. The flight payload: inlined *and* sidecarred, and not disableable

### Inlined into the HTML

Yes. In `next@16.3.2`, `dist/server/app-render/use-flight-response.js:185-214` and `dist/server/app-render/stream-ops.node.js:728-788` unconditionally emit:

```js
`${startScriptTag}self.__next_f.push(${htmlInlinedData})</script>`
```

There is no config flag gating either call site.

**Measured on the zero-client-component page:**

| | bytes | gzip -9 |
|---|---:|---:|
| Full `out/index.html` | 17,074 | 2,334 |
| Markup only (scripts stripped) | 6,023 | 584 |
| **Inline flight payload** | **11,051** | — |

The blob is **183 % of the markup**. This independently reproduces the spec's prior measurement (16,828 bytes flight vs 12,210 bytes HTML) at a different page size — and note this page has **zero client components**, so nothing on it needs hydrating at all.

### Sidecar files, per route

Yes, and more than one. `dist/export/index.js:763` writes app-path route data to `${route}.txt` (the `.rsc` payload renamed for static hosts); `dist/export/routes/app-page.js:102` appends it, and lines 105-118 additionally emit per-segment prefetch files into a `__next` directory. Measured output for a 2-page project:

```
out/index.html                        17,074
out/index.txt                          9,480   ← full route flight
out/__next._full.txt                   9,480   ← identical copy
out/__next.__PAGE__.txt                9,138   ← page segment
out/__next._tree.txt                     195   ← tree segment
```

**Five files per route**, and the flight payload is materialised **three times** (once inline, once as `.txt`, once as `__next._full.txt`) plus once more in segment form. At 5,003 routes I measured **25,020 files / 236 MB** in `out/`.

The source comment at `app-page.js` shows the *only* condition under which `.rsc` is skipped — and it is not a user-facing one:

> `// With PPR enabled, we normally skip writing .rsc because it may contain dynamic data. However, for fully static outputs (no postponed state and no fallback params), we can safely emit the route .rsc to support static navigations.`

In other words, fully-static output is the case that *guarantees* emission.

### Can either be disabled?

**No supported way.** The requests are old and numerous and none succeeded:

- [#56180](https://github.com/vercel/next.js/issues/56180) "NextJS Static Site Bundling A Bunch Of `self.__next_f.push` Instead Of Raw HTML"
- [discussion #56119](https://github.com/vercel/next.js/discussions/56119) "How Do I Remove `self.__next_f.push` From Static HTML Exports"
- [discussion #59394](https://github.com/vercel/next.js/discussions/59394) "What is the purpose of the .txt files generated for each route?"
- [discussion #58554](https://github.com/vercel/next.js/discussions/58554) "Dedupe RSC payload?"
- [discussion #67582](https://github.com/vercel/next.js/discussions/67582) "Avoiding excessive redundant data in RSC payloads…"

`<Link prefetch={false}>` suppresses *fetching* the sidecar; it does not stop it being written, and it does nothing about the inline copy, which is the hydration input.

### 2026 corroboration: the payload is worse than it needs to be

[vercel/next.js#95559](https://github.com/vercel/next.js/issues/95559), **opened 2026-07-07, still open** — *"Flight payload repeats the full chunk URL list for every client module reference (~29% of SSR HTML is duplicated chunk URLs)"*. Measured in the report:

> *"Every client-module reference row in the flight payload… serializes the entire chunk URL list of its chunk group. Because Turbopack merges a page's client modules into a shared chunk group, every reference row on the page carries an identical copy of the same URL list."*

Their production sample: **473,786 bytes of HTML, of which 357,251 (75.4 %) is flight payload and 135,749 (28.7 %) is duplicated chunk-URL text**, at a 43.3× duplication factor. No Vercel reply on the thread as of today.

This matters two ways. It confirms the payload dominates the document at real-world scale, not just in my synthetic page. And it shows the problem is being *reported* in 2026, not fixed.

**Classification: impossible** to disable; **structurally guaranteed** in exactly the fully-static case we care about.

---

## 3. Incremental builds: they do not exist for static export

### Measured

5,003 routes (5,000 `generateStaticParams` pages + 3), 4 cores, Next spawning 3 workers:

| | cold | warm, **zero changes** |
|---|---:|---:|
| Turbopack compile | 13.2 s | **0.29 s** |
| Generating static pages | 52 s | **63 s** |
| Wall clock | 77.3 s | 79.6 s |
| Peak RSS | 1,061,120 kB | 438,340 kB |

**Every one of the 5,003 routes was re-rendered on a build with no source and no content changes**, and all 25,020 files in `out/` had fresh mtimes. The persistent cache made compilation ~45× faster and page generation *not at all* faster.

That is exactly what the release notes promise, read carefully. From [Turbopack: What's New in Next.js 16.3](https://nextjs.org/blog/next-16-3-turbopack) (2026-06-29):

> *"With persistent disk cache, builds can take advantage of previously computed work and reduce the time it takes to **compile your static assets**."*

Compile. Not render. The [16.3 release post](https://nextjs.org/blog/next-16-3) (2026-08-03) headlines it as *"Faster builds. Repeat builds can read unchanged artifacts from cache"* with 1.4×–5.5× numbers — all of which are labelled **"Turbopack compile time for `next build`"** on the chart. Prerendering is outside the cache.

### What `.next/cache` actually holds

After the 5,003-page build: `.next/cache/turbopack` (25 MB), plus `.rscinfo`, `.tsbuildinfo`, `.previewinfo`. **No rendered-HTML cache.** (`.next` total: 326 MB.)

### Partial output?

`next build --debug-build-paths="app/page.tsx"` does restrict what gets built — I ran it — but under `output: 'export'` it produces an `out/` containing **only** those routes: 20 files, down from 25,020. It is destructive, not additive. The docs frame it as *"Build only specific routes for debugging"* and *"useful for faster debugging when working with large applications"* ([next CLI](https://nextjs.org/docs/app/api-reference/cli/next), v16.3.2, lastUpdated 2026-08-18). Merging a partial `out/` over a previous full `out/` is imaginable but unsupported, and Next randomises `BUILD_ID` per build (I confirmed it changes: `ufyIRkboFiFH-0xa5goRX` → `GEvXTaJdajiMs81yth8V1`), minting a fresh `_next/static/<BUILD_ID>/` directory each time. `generateBuildId` is configurable, so that specific hazard is fixable; the absence of a render cache is not.

One genuine positive for diff-deploys: **content-hashed chunk filenames were stable across rebuilds** with unchanged source, so a manifest-diff uploader would at least not re-upload every JS chunk. The HTML and `.txt` files, however, are all rewritten.

### The request has been open for six years

[#16573](https://github.com/vercel/next.js/issues/16573) "Incremental builds to deploy as a true static app", [discussion #30716](https://github.com/vercel/next.js/discussions/30716) "Support incremental builds", [discussion #29873](https://github.com/vercel/next.js/discussions/29873) "Using SSG there is a way to rebuild and upload again only some pages?". Vercel's answer throughout has been **ISR** — which [the static-exports docs list as explicitly unsupported](https://nextjs.org/docs/app/guides/static-exports#unsupported-features) under `output: 'export'`. Nothing in the 2026 releases (16.1, 16.2, 16.3) changes this; 16.3's "Better Incremental Static Regeneration" is a *server* feature built on Cache Components.

**Classification: impossible** as shipped. Our §16 target of a **< 30 s incremental content build** is unreachable — the floor is a full re-render of every page.

---

## 4. Scaling to 50 k pages: feasible-ish, but the wrong shape

Extrapolating my measurement linearly (5,003 routes → 52 s generation on 3 workers): **50 k routes ≈ 8–11 minutes of page generation alone** on this hardware, plus compile and finalisation. A larger CI runner with more cores would improve on that, so **the < 10 min full-build target in §16 is plausibly reachable**. Two caveats:

- **Output volume:** ~250,000 files and ~2.4 GB in `out/`, at 5 files and ~48 kB per route. That is a lot of S3 objects, and every one of them is rewritten every build.
- **The full build is the *only* build.** §16's real requirement is the 30 s incremental, and §3 finds no path to it.

Published guidance is thin and the field reports are not encouraging:

- **[discussion #86320](https://github.com/vercel/next.js/discussions/86320)** — ".next folder is bigger in Next.js 16"; reports of build artifacts growing for projects with thousands of static pages and *tripling* S3 upload duration. Matches my 326 MB `.next` / 236 MB `out`.
- **[#66150](https://github.com/vercel/next.js/issues/66150)** (open) — `outputFileTracing` increasing export build time 1.5–2× (~6 min → ~10–12 min at ~2,000 MDX pages).
- **[discussion #67471](https://github.com/vercel/next.js/discussions/67471)** — build times up 6× after adding `generateStaticParams`.
- **[discussion #58006](https://github.com/vercel/next.js/discussions/58006)** — ~1,500-item `generateStaticParams` halting partway with no error.
- **[discussion #14122](https://github.com/vercel/next.js/discussions/14122)** — 3 k SSG pages at 30–35 min; 12 k pages where deployment exceeded 15 min and failed.

I found **no official Vercel benchmark or documented ceiling** for `output: 'export'` page counts. Note the Pages Router i18n docs do publish a hard limit relevant to multiplication effects — *"`locales`: 100 total locales"* and *"`domains`: 100 total locale domain items"*, added *"to prevent potential performance issues at build time."*

**Classification: awkward, not impossible** — for full builds. Impossible for our incremental target.

---

## 5. i18n: sub-path locales work; multi-domain has no mechanism

### The built-in i18n router does not apply

The Pages Router's `i18n` config — the one with `domains: [{ domain: 'example.fr', defaultLocale: 'fr' }]` — carries an explicit carve-out. Verbatim from [How to implement internationalization in Next.js](https://nextjs.org/docs/pages/guides/internationalization) (v16.3.2, lastUpdated 2026-03-03):

> *"Note that Internationalized Routing does not integrate with `output: 'export'` as it does not leverage the Next.js routing layer. Hybrid Next.js applications that do not use `output: 'export'` are fully supported."*

So it is unavailable twice over: App Router never adopted it, and it is documented as incompatible with static export regardless.

### What App Router offers instead

[Internationalization](https://nextjs.org/docs/app/guides/internationalization) (v16.3.2, lastUpdated 2026-06-10) is a hand-rolled recipe with two halves:

1. **Routing** — locale detection and redirect, implemented in **`proxy.js`** (`middleware.ts` renamed in Next 16). The doc's only routing mechanism *is* the proxy: *"Routing can be internationalized by either the sub-path (`/fr/products`) or domain (`my-site.fr/products`). With this information, you can now redirect the user based on the locale inside Proxy."* **Proxy is on the static-export unsupported list.**
2. **Structure** — `app/[lang]/…` plus `generateStaticParams` returning `[{ lang: 'en-US' }, { lang: 'de' }]`. **This half works fine in static export**, and 16.3's `next/root-params` (`import { lang } from 'next/root-params'`) is a genuinely good ergonomic addition for reading the locale in any Server Component without prop-drilling.

**Net:** sub-path locales are workable and reasonably pleasant. Locale *detection and redirect* must move to your CDN or web server. **Multi-domain has no Next-level mechanism at all** in static export — you either run N builds with N `basePath`/`assetPrefix` configurations, or serve one `out/` from N hosts and resolve locale entirely at the edge, outside Next. Our spec's decision #11 (locale-with-optional-domain, `(locale, path)` page identity) has no counterpart here.

**Classification: sub-path — awkward but fine. Multi-domain — absent; entirely on you.**

---

## 6. Per-page JS budgets: nothing native, and it went backwards

Next 16 **removed** the reporting our spec's goal 3 would build on. From the version-history table in [next CLI](https://nextjs.org/docs/app/api-reference/cli/next):

> `v16.0.0` — *"The JS bundle size metrics have been removed from `next build`"*

I confirmed this empirically: `next build` on 16.3.2 prints only the route list and its Static/Dynamic legend — no "First Load JS" column at all.

The replacement is **`next experimental-analyze`** (added `v16.1.0`), an interactive analyzer: *"Analyzes bundle output using Turbopack. Does not produce build artifacts."* It can write to `.next/diagnostics/analyze` with `--output`, filter by route, and *"View the full import chain showing why a module is included."* That is a good debugging tool. It is **not a budget**: no threshold configuration, no non-zero exit, and it doesn't produce a build, so it cannot gate one.

There is no `next.config` bundle-budget option of any kind. Everything is third-party (`@next/bundle-analyzer`, `size-limit`, `bundlesize`, Lighthouse CI) wired into CI by hand — which is exactly what spec §9/§13's CI-enforced per-page budgets would have to be here too, except that the analyzer's per-route data is not in a documented stable format.

**Classification: absent, and regressed since our knowledge cutoff.**

---

## 7. What actually shipped January–August 2026

The full 2026 release list from [nextjs.org/blog](https://nextjs.org/blog), checked against each post:

| Date | Release / post | Relevant to us? |
|---|---|---|
| 2026-03-18 | [Next.js 16.2](https://nextjs.org/blog/next-16-2) | ~400 % faster `next dev` startup, ~50 % faster rendering. Dev-side. |
| 2026-03-18 | [Turbopack in 16.2](https://nextjs.org/blog/next-16-2-turbopack) | Server Fast Refresh, SRI support, tree shaking. |
| 2026-03-25 | [Next.js Across Platforms](https://nextjs.org/blog/nextjs-across-platforms) | Adapter API stable — for *server* deployment targets, not static export. |
| 2026-06-25 | [16.3: Instant Navigations](https://nextjs.org/blog/next-16-3-instant-navigations) | Partial Prefetching — **adds** per-segment `.txt` files. Moves against us. |
| 2026-06-29 | [Turbopack in 16.3](https://nextjs.org/blog/next-16-3-turbopack) | **FS cache for `next build`, on by default.** Compile only (§3). |
| 2026-08-03 | [Next.js 16.3](https://nextjs.org/blog/next-16-3) | `next/root-params` (mild i18n win); "immutable static assets" reuse across deploys — an **adapter** feature; prefetch inlining. |
| 2026-08-18 | [Building App-like Experiences with 16.3](https://nextjs.org/blog/building-app-like-experiences-with-nextjs-16-3) | Instant Navigations narrative. |
| 2026-07-20, 2026-08-20 | Security releases | — |

**Nothing in 2026 addresses zero-JS pages, flight-payload size or suppression, incremental static export, static-export i18n, or bundle budgets.** The two 2026 changes that touch our concerns push in opposite directions: the build FS cache genuinely helps compile time; Partial Prefetching adds *more* per-route payload files.

The direction of travel is legible from 16.3's own framing: *"dynamic by default, with no hidden or implicit caching"*, and *"a suite of tools that brings the responsiveness of client-driven SPAs to Next.js."* Next.js is optimising the server-driven-app case. Static-export-with-minimal-JS is not on the roadmap, and Instant Navigations makes the client runtime *more* central, not less.

---

## What this means for goals 1 and 2, stated plainly

**Goal 1 (per-page bundle control): partially met.** Turbopack does split per-page client code — 283 bytes for one counter. But you get no chunk-grouping control (bundler research §3: *"there is no user-facing splitChunks equivalent"*), no ranking-driven tiers, and no budget enforcement. The *component* half works; the *tiering and enforcement* half does not.

**Goal 2 (zero JS, no page data blob): not met, and unmeetable.** 452 kB of fixed baseline JS on a page with nothing to hydrate, plus a data blob 1.83× the markup, inlined *and* written out twice more as sidecars, with no flag to turn any of it off and closed/ignored requests going back to 2023. This is the spec's founding complaint, verified live at the current stable version. It is not a gap Next.js is closing.

**If the framework exists for any one reason, it is this one, and the reason survives contact with Next 16.3.2.**

The honest counterweight, which nothing here removes: App Router gives you the `"use client"` authoring contract natively, maintained by the people who define it, with a portability story we cannot match. Our decision #20 (derive islands from `"use client"`, no flight, no RSC pipeline) is an attempt to keep that authoring model without its payload. This research supports that decision's premise — the payload is real, large, and not optional — without saying anything about whether our implementation of the alternative will work.

---

## What remains unverified

1. **All measurements are from one machine (4 cores) and two small synthetic projects.** The 452 kB baseline is Next 16.3.2 + Turbopack + React 19.2.0 with no CSS, no fonts, no `next/image`, no metadata. A real design system would add to it, never subtract. The 50 k extrapolation is linear from 5,003 routes and assumes the generation phase scales linearly — [#58006](https://github.com/vercel/next.js/discussions/58006) suggests it may not.
2. **I did not test `--webpack`.** All numbers are Turbopack (the 16.x default). Whether the webpack path emits a smaller baseline or different chunking under `output: 'export'` is unmeasured, and webpack is on a deprecation trajectory anyway.
3. **I did not test `cacheComponents: true` or `partialPrefetching: true` with `output: 'export'`.** The `app-page.js` source suggests PPR-era flags change *when* `.rsc` is written; whether either flag is even permitted in export mode, and what it does to payload shape, is unverified.
4. **The `noModule` polyfill chunk's real-world cost is unmeasured.** Modern browsers skip it, and Next 16 requires Chrome/Edge/Firefox 111+ and Safari 16.4+, so it should be near-zero in practice — but I did not confirm no modern browser fetches it.
5. **I did not confirm the exact contents of the two large chunks.** `02fh7_m5mrih8.js` contains `react-dom`; I did not decompose either chunk module-by-module to attribute bytes between React, the app-router client runtime, and `react-server-dom-turbopack`.
6. **The `--debug-build-paths` merge strategy was not attempted.** I confirmed it produces a *replacement* `out/`, not that merging one over a prior full `out/` fails — only that it is undocumented, unsupported, and framed as a debugging aid.
7. **No Vercel-team statement was found** on any of the zero-JS, payload-suppression, or incremental-export threads. Their silence is evidence of priority, not of a position; I did not find a maintainer explicitly closing the door.
8. **Multi-domain in static export was not built.** The N-builds-with-N-`assetPrefix` approach is inference from the config surface, not something I ran.
9. **`next experimental-analyze`'s output format was not inspected.** Whether `.next/diagnostics/analyze` contains per-route byte totals in a machine-readable, stable shape — which would make a DIY CI budget viable — is unverified.
10. **Issue and discussion excerpts in §3 and §4 that I did not personally fetch** (`#66150`, `#86320`, `#67471`, `#58006`, `#14122`, `#16573`, `#30716`, `#29873`, `#56180`, `#56119`, `#58554`, `#67582`) came from a delegated search pass and are paraphrases, not verbatim quotes. Titles and URLs are reliable; treat the summarised numbers as leads to re-check before citing externally. The claims I quote verbatim — from `#45009`, `#95559`, the docs, the source, and the release posts — I fetched and read myself.
