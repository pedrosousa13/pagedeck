# Bundler Deep Dive: Build Foundation for a CMS-Driven Static-Site Framework

**Date:** 2026-08-23
**Question:** Which bundler/build foundation is best in mid-2026 for a custom CMS/SQLite-driven static-site framework with generated per-page entries, ranking-driven chunk tiers ("core"/"tail"), zero-JS-by-default islands, React 19 + React Compiler, and incremental S3 deploys?

---

## TL;DR

**Recommendation: Vite 8 + Rolldown** (driven programmatically via the Builder/Environment API, with chunk tiers implemented through Rolldown's `output.codeSplitting` groups).
**Runner-up: Rspack 2.x** — the strongest raw chunk control and hash determinism story, plus a native Rust React Compiler, but a clunkier fit for generated-MPA + build-time React SSR.

Turbopack remains **unusable outside Next.js** as of August 2026. esbuild and Bun.build fail the hard requirement (no manual/declarative chunk grouping). Parcel's RSC support is interesting but beta and config-file-driven. The RSC-static route (Waku / `@vitejs/plugin-rsc`) is not a replacement for hand-rolled islands for this use case, but `@vitejs/plugin-rsc` is worth watching.

---

## Comparison Table

Scores 1–5 (5 = best fit for *this* project's requirements).

| Criterion | Vite 8 + Rolldown | Raw Rolldown 1.0 | Turbopack | Rspack 2.x | esbuild | Bun.build | Parcel 2.14+ | RSC-static (Waku/plugin-rsc) |
|---|---|---|---|---|---|---|---|---|
| Programmatic API for generated many-entry MPA | **5** (createBuilder/buildApp, virtual modules) | 4 (Rollup-style JS API) | 1 (no public API outside Next) | 4 (webpack-style Node API) | 4 (good API, weak chunking) | 3 (Bun.build API) | 2 (config/target-file driven) | 2 (framework-shaped) |
| Chunk-control precision (ranking tiers) | **4** (codeSplitting groups; sharp edges open) | 4 (same engine) | 1 (no user chunk config) | **5** (splitChunks cacheGroups, battle-tested) | 1 (no manual chunks) | 1 (boolean `splitting` only) | 3 (manual shared bundles) | 3 (inherits Vite/Rolldown) |
| SSG/SSR at build time (react-dom/server, module runner) | **5** (ModuleRunner, multi-env builds) | 3 (DIY: bundle server code, run in Node) | 2 (Next-only) | 3 (DIY, well-trodden webpack pattern) | 3 (DIY) | 3 (DIY, `target: "bun"`) | 4 (react-static target renders HTML at build) | 5 (that's the whole point) |
| Plugin ecosystem | **5** (Vite + most Rollup plugins) | 4 (Rollup-compatible hooks) | 1 (webpack loaders only, no plugins) | 4 (most of webpack ecosystem) | 3 | 2 | 2 | 4 (full Vite ecosystem) |
| Dev server + HMR | **5** | 1 (none; bring your own) | 5 inside Next, 0 outside | 4 (Rspack dev server / Rsbuild) | 2 (serve/watch only) | 3 | 4 | 4 |
| React Compiler path | **5** (`@vitejs/plugin-react` ≥6.1; Oxc Rust compiler landing) | 3 (wire a transform yourself) | 5 inside Next (Rust compiler) | **5** (Rust React Compiler via builtin SWC loader, 2.1) | 2 (external transform step) | 2 | 3 (Babel-based) | 5 (via plugin-react) |
| Incremental/watch rebuilds | 3 (fast full rebuilds; no persistent prod cache yet) | 3 (`watch()` API) | 5 inside Next (persistent FS cache) | **5** (persistent cache, +50% on hits) | 4 (incremental rebuild API) | 3 (`--watch`) | 4 (Parcel caching is core design) | 3 |
| Maturity / semver stability | 4 (Vite 8 stable; Env API "RC phase") | 4 (1.0 semver-locked May 2026) | 3 (stable but Next-internal) | **5** (2.x, 5M weekly downloads, staged breaking changes) | 5 (very stable, but frozen feature-wise) | 3 | 3 (RSC parts beta) | 2 (Waku 1.0-alpha) |
| Output determinism / stable hashes across deploys | 3 (unverified; see below) | 3 (unverified) | 4 (deterministic module IDs in build; Next-internal) | **5** (`deterministic` chunk/module IDs + `realContentHash` documented defaults) | 4 | 3 (hash tokens, determinism undocumented) | 3 | 3 |

---

## Per-Candidate Findings

### 1. Vite 8 + Rolldown

**Status.** Vite 8.0 went stable **March 12, 2026** with Rolldown as the single Rust bundler replacing both esbuild and Rollup; current release is v8.2.x. "Most existing Vite plugins work out of the box" via Rolldown's Rollup-compatible plugin API, and a compat layer auto-converts `esbuild`/`rollupOptions` config. ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8))

**Programmatic MPA builds.** The Environment API provides `createBuilder()` — the programmatic equivalent of `vite build --app` — plus a `buildApp` hook so plugins participate in orchestrating multi-environment builds (client + SSR/RSC environments can be built individually via `builder.build(environment)` or together). This is exactly the shape needed for "generate N entry modules from SQLite, build client + server environments, render HTML." Virtual modules (generated per-page entries) are first-class via standard `resolveId`/`load` plugin hooks. ([Environment API for Frameworks](https://vite.dev/guide/api-environment-frameworks))

**SSR at build time.** `ModuleRunner`/`RunnableDevEnvironment` lets the framework `runner.import(url)` server modules through the Vite module graph with HMR — the modern replacement for `ssrLoadModule`. This gives a clean dev-time story for rendering pages with `react-dom/server` against live component source. ([Environment API for Frameworks](https://vite.dev/guide/api-environment-frameworks))

**Chunk control.** Rolldown's manual chunking is `output.codeSplitting` (object form): global `minSize`, `maxSize`, `minShareCount`, `minModuleSize`, `maxModuleSize`, `includeDependenciesRecursively`, plus a `groups` array where each group takes `name`, `test`, `priority`, and the same size/share thresholds. The older `advancedChunks` name is deprecated in favor of `codeSplitting` ("If `advancedChunks` and `codeSplitting` are both specified, `advancedChunks` will be ignored"). Priority ordering of groups maps directly onto our ranking-driven core/tail tiers. ([codeSplitting reference](https://rolldown.rs/reference/OutputOptions.codeSplitting), [advancedChunks reference](https://rolldown.rs/reference/OutputOptions.advancedChunks), [API design discussion](https://github.com/rolldown/rolldown/discussions/2118))

**Known sharp edges (important).** [rolldown/rolldown#7473](https://github.com/rolldown/rolldown/issues/7473) (opened Dec 2025, still open, milestone "Q2 M2") reports: the default strategy can produce hundreds of tiny chunks (a real site loaded 575 chunks/page); manual grouping can produce "Cannot access X before initialization" errors when groups split modules with side effects; isolating a dependency can drag its shared deps into an everywhere-loaded chunk; and docs/recipes are thin ([docs recipe issue #7309](https://github.com/rolldown/rolldown/issues/7309)). [vitejs/vite#21271](https://github.com/vitejs/vite/issues/21271) was closed as a duplicate of that Rolldown issue. Mitigation for us: our entries are generated and we know the full import graph from our own usage ranking, so we can express exhaustive, non-overlapping groups rather than relying on heuristics — but this must be validated with a prototype.

**React 19 + React Compiler.** `@vitejs/plugin-react` v6 uses Oxc for the React Refresh transform (Babel no longer a dependency); React Compiler integration ships in `@vitejs/plugin-react` ≥6.1.0, and Oxc announced a Rust-native React Compiler port (**~10x faster** than `babel-plugin-react-compiler`) in August 2026. ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8), [plugin-react discussion #1240](https://github.com/vitejs/vite-plugin-react/discussions/1240), [Oxc React Compiler blog, 2026-08-18](https://oxc.rs/blog/2026-08-18-react-compiler-support))

**Stability.** Rolldown 1.0 (below) is semver-locked. Vite's Environment API is described as "release candidate phase" with some sub-APIs still experimental — the one soft spot in an otherwise stable stack. ([Environment API](https://vite.dev/guide/api-environment))

**Incremental rebuilds.** No persistent production build cache yet; the pitch is that full rebuilds are fast (19k-module benchmark: 40.1s Rollup → 1.61s Rolldown). Per-page incremental S3 uploads would come from our own content-diffing layer plus stable output hashes, not from the bundler cache. ([Vite 8 announcement](https://vite.dev/blog/announcing-vite8))

### 2. Raw Rolldown 1.0 (no Vite)

**Status.** Rolldown 1.0 stable **May 7, 2026**. Semver commitment: "^1.0.0 API is locked — option names, types, and plugin hook signatures stay backward-compatible," though *output behavior* (DCE, chunking, inlining) may keep changing between minors. Production users cited: Framer (67% chunk reduction using the chunk-group rules) and PLAID. ([Rolldown 1.0 announcement](https://voidzero.dev/posts/announcing-rolldown-1-0), [1.0 RC announcement](https://voidzero.dev/posts/announcing-rolldown-rc))

**API.** Rollup-compatible JS API: `rolldown()` → `generate()/write()`, an esbuild-style one-shot `build()`, and a Rollup-compatible `watch()` backed by a native watcher. Many generated entries and virtual modules work the same as in Rollup. ([Bundler API docs](https://rolldown.rs/apis/bundler-api))

**Assessment.** Everything Vite adds on top (dev server, ModuleRunner, plugin container, environments, React plugin wiring, CSS handling) would have to be rebuilt by hand. The VoidZero team explicitly frames **"Vite 8 as Rolldown's main entry point."** Going raw only makes sense if we wanted a production-build-only pipeline with a completely custom dev story — and even then we'd keep Vite for dev anyway, doubling configs. Not worth it. ([Rolldown 1.0 announcement](https://voidzero.dev/posts/announcing-rolldown-1-0))

### 3. Turbopack — the key question: standalone in 2026?

**Answer: No. Still Next.js-only.**

- The current Next.js docs (v16.3.2, last updated 2026-08-11) describe Turbopack as "an incremental bundler … **built into Next.js**". There is no standalone CLI, no published programmatic API, and configuration happens only through the `turbopack` key of `next.config.js`. The docs even phrase standalone use in the future tense: "In the future, Turbopack **standalone usage will likely require** a loader config." ([Next.js Turbopack API reference](https://nextjs.org/docs/app/api-reference/turbopack))
- A November 2025 community question — "is Turbopack still meant to be a framework-agnostic, standalone bundler?" — sits **unanswered** by the Vercel team. ([vercel/next.js discussion #86533](https://github.com/vercel/next.js/discussions/86533))
- Inside Next.js it is genuinely strong: default bundler since Next 16, dev + production builds stable, and Next 16.3 (2026) shipped a persistent filesystem cache for `next build` (up to 5.5x faster warm builds) plus the Rust React Compiler. ([Next.js 16](https://nextjs.org/blog/next-16), [Next.js 16.3 Turbopack](https://nextjs.org/blog/next-16-3-turbopack))
- **Chunk control:** there is no user-facing splitChunks equivalent; chunking is controlled only by coarse experimental flags (`turbopackClientSideNestedAsyncChunking`, `turbopackModuleIds: 'named' | 'deterministic'`, scope hoisting toggles). webpack plugins are unsupported (webpack *loaders* are). ([Next.js Turbopack API reference](https://nextjs.org/docs/app/api-reference/turbopack))

**Assessment.** Disqualified for this project: not consumable outside Next.js, and even inside Next.js it offers no declarative chunk-tier control. Adopting Next.js itself would also reintroduce the `__NEXT_DATA__`-style hydration payload the framework explicitly wants to avoid.

### 4. Rspack 2.x

**Status.** Rspack 2.0 released **April 22, 2026**: pure-ESM core packages, ~100% faster than 1.0, experimental low-level RSC build support, dev-server dependencies cut from 192 to 1, and a stated policy of staged, minimal breaking changes while "compatibility with the webpack ecosystem will remain an important goal." Rspack 2.1 (**June 26, 2026**) added the **Rust React Compiler via the built-in SWC loader (7–13x faster than the Babel plugin)**, `import.meta.glob`, and persistent-cache cleanup (`cache.maxAge`, `cache.maxVersions`). ([Rspack 2.0 announcement](https://rspack.rs/blog/announcing-2-0), [Rspack 2.1 announcement](https://rspack.rs/blog/announcing-2-1), [InfoQ coverage](https://www.infoq.com/news/2026/07/rspack-2-release/))

**Chunk control.** Full webpack-semantics `optimization.splitChunks` with `cacheGroups` — `test`, `priority`, `minChunks`, `name`, `enforce`, plus Rspack-specific additions like `enforceSizeThreshold`. This is the most proven implementation of exactly our ranking-tier pattern (a decade of webpack production use). ([Rspack optimization config](https://rspack.rs/config/optimization), [2.0 announcement](https://rspack.rs/blog/announcing-2-0))

**Determinism.** Documented production defaults: `optimization.moduleIds`/`chunkIds: 'deterministic'` for long-term caching, and `optimization.realContentHash: true` — final hashes computed from **final asset content**, explicitly "more stable … better utilized for caching." This is the best-documented answer to our CDN-cache-hit requirement. ([Rspack optimization config](https://rspack.rs/config/optimization))

**Incremental.** Persistent cache: ~50% faster builds on cache hits, >20% less memory (2.0), with cache-lifecycle management in 2.1 — directly useful for per-page incremental rebuild → incremental S3 upload. ([Rspack 2.0 announcement](https://rspack.rs/blog/announcing-2-0))

**Weak spots for us.** SSG/SSR at build time is DIY webpack-style: build a `target: 'node'` server bundle, execute it, emit HTML — workable but there is no ModuleRunner-style graph-aware evaluation, and dev-time SSR wiring is on us (or via Rsbuild/Modern.js abstractions). MPA with hundreds of HTML pages means driving the Node API with many entries + HTML generation ourselves (fine — we generate HTML anyway, so we'd skip HTML plugins entirely). Plugin ecosystem is webpack's, which is large but aging relative to Vite's.

### 5. esbuild

**Disqualified on chunk control.** The official docs still say: "Code splitting is **still a work in progress**. It currently only works with the `esm` output format," and reference a known cross-chunk import ordering bug ([#399](https://github.com/evanw/esbuild/issues/399)). There is **no manual/declarative chunk assignment** — only automatic splitting of shared and dynamically-imported code; the gap is old and acknowledged ([#2144 "Separation of code splitting purposes"](https://github.com/evanw/esbuild/issues/2144), community workaround plugins like [esbuild-plugin-entry-chunks](https://www.npmjs.com/package/esbuild-plugin-entry-chunks)). Excellent transform/minify tool, very stable, great incremental rebuild API — but the ranking-tier requirement is impossible without forking its chunker. ([esbuild splitting docs](https://esbuild.github.io/api/#splitting))

### 6. Bun.build

**Disqualified on chunk control.** `splitting: true` is a boolean: shared code between entrypoints and dynamic imports become chunks automatically; there is **no manual chunk grouping API**. Naming templates (`chunk: '[name]-[hash].[ext]'`) exist, and watch mode is native, and HTML entrypoints are supported (the fully-inlined single-file HTML mode is incompatible with splitting). Hash determinism across builds is undocumented. Docs also note CJS/IIFE output formats remain experimental. Good for app bundling inside the Bun runtime; not a fit for precision MPA chunking. ([Bun bundler docs](https://bun.com/docs/bundler))

### 7. Parcel 2.14+

**RSC pioneer, but beta.** Parcel v2.14.0 introduced React Server Components support, "currently in **beta**," requiring `react`/`react-dom` ≥19.1. The `"react-static"` target **prerenders RSC pages to fully static HTML at build time**, emitting an `.html` file plus an `.rsc` file per page; only `"use client"` components (plus a `client.js` hydration entry) ship to the browser. Deliberately "not a framework — just the raw bundling primitives" (no router/server/cache). ([Parcel RSC recipe](https://parceljs.org/recipes/rsc/), [Parcel v2.14.0 blog](https://parceljs.org/blog/v2-14-0/), [rsc-examples repo](https://github.com/parcel-bundler/rsc-examples))

**Chunk control.** Parcel's bundler is automatic-first; explicit grouping exists via [manual shared bundles](https://parceljs.org/features/code-splitting/) (`@parcel/bundler-default` → `manualSharedBundles` with asset globs) — closer to our tiers than esbuild/Bun, but glob-based rather than programmatic, and Parcel's config-file/target-driven model fits generated thousands-of-entries builds poorly compared to a JS-API-first bundler. Still on `v2` (no v3); RSC parts are beta atop a stable core.

### 8. The RSC-static angle (Waku, `@vitejs/plugin-rsc`)

**`@vitejs/plugin-rsc`.** Official Vite plugin (lives in the `vitejs/vite-plugin-react` monorepo). Framework-agnostic, built on the Environment API with three environments (rsc / ssr / client), HMR for server and client components, automatic CSS code-splitting for server components, and **SSG and partial-prerendering examples** in-repo. React Router has adopted it for its RSC support — meaningful production validation. Some APIs are still marked experimental. ([plugin-rsc README](https://github.com/vitejs/vite-plugin-react/tree/main/packages/plugin-rsc), [RSC tracking issue](https://github.com/vitejs/vite-plugin-react/issues/531))

**Waku.** Reached **v1.0-alpha on February 10, 2026** (public API declared stable, roadmap through beta/RC to 1.0); built on Vite + Hono, targeting "mostly-static sites with some dynamic routes"; migrated onto `@vitejs/plugin-rsc` + Environment API in v0.24 (Aug 2025). Still pre-1.0-final — risky as a foundation for a product framework. ([InfoQ: Waku reaches alpha](https://www.infoq.com/news/2026/02/waku-react-framework/), [Waku migration blog](https://waku.gg/blog/migration-to-vite-plugin-rsc))

**Payload analysis vs. islands.** For this project's goals, RSC-static is a worse payload deal than hand-rolled islands:
- A static RSC page that hydrates client components ships the **RSC flight payload** (serialized page tree — in Parcel's implementation a per-page `.rsc` file, also inlined for initial load) plus the `react-server-dom-*` client runtime, so client-navigable RSC sites carry a framework data blob that scales with *page* size, not *island* size. That is exactly the `__NEXT_DATA__`-shaped cost the framework wants to avoid. ([Parcel RSC recipe](https://parceljs.org/recipes/rsc/))
- Islands with per-island props embed only each island's own props — payload scales with interactivity, which on CMS marketing pages is near zero.
- RSC's real wins (server-side data access woven into components, streaming, server actions) matter less when all data already sits in a local SQLite mirror at build time.

RSC-static *can* produce zero-JS pages when a page has no client components, and `@vitejs/plugin-rsc`'s multi-environment machinery is the right long-term substrate if the framework ever wants RSC authoring — but it doesn't beat islands on payload for this workload today.

---

## Recommendation

### Winner: Vite 8 + Rolldown (programmatic Builder API + `output.codeSplitting`)

Reasoning against the criteria that actually differentiate:

1. **Only candidate with a first-class programmatic multi-environment build orchestrator.** `createBuilder()`/`buildApp` + virtual-module plugins is precisely "generate N entries from SQLite, build client + SSR environments, render HTML with `react-dom/server`, upload." Rspack can do it webpack-style; nothing else comes close. ([source](https://vite.dev/guide/api-environment-frameworks))
2. **Chunk tiers are expressible.** `codeSplitting.groups` with `name`/`test`/`priority` maps 1:1 onto ranking-driven core/tail tiers, and because we generate every entry and know component usage frequency, we can emit exhaustive groups instead of leaning on the (currently rough) heuristics. ([source](https://rolldown.rs/reference/OutputOptions.codeSplitting))
3. **Best dev experience and ecosystem** (Vite dev server, ModuleRunner SSR, Rollup-compatible plugins), and the **React Compiler path is native to the stack** (`@vitejs/plugin-react` ≥6.1, Oxc Rust compiler). ([source](https://oxc.rs/blog/2026-08-18-react-compiler-support))
4. **Stability is acceptable:** Rolldown 1.0 is semver-locked (May 2026), Vite 8 stable (March 2026); the Environment API being "RC phase" is the main residual risk. ([source](https://voidzero.dev/posts/announcing-rolldown-1-0))
5. **Strategic alignment:** VoidZero's stated direction makes Vite the primary consumer of Rolldown improvements, so chunking fixes ([#7473](https://github.com/rolldown/rolldown/issues/7473)) land where we sit.

**Conditions attached:** before committing, prototype the core/tail grouping on a realistic design-system-scale graph (~80+ components) and verify (a) no side-effect init-order breakage, (b) chunk count stays controlled, (c) output hashes are byte-identical across two clean builds of unchanged inputs. If (a)/(b) fail, fall back to the runner-up rather than fighting the chunker.

### Runner-up: Rspack 2.x

Choose it if chunk-control precision and deploy determinism outrank DX: webpack-proven `splitChunks.cacheGroups`, **documented** deterministic IDs + `realContentHash`, persistent build cache for incremental rebuilds, and the fastest React Compiler integration (Rust, built-in). Costs: DIY build-time SSR orchestration, webpack-shaped config and plugin world, and a less natural generated-MPA workflow.

---

## What We Couldn't Verify

- **Rolldown/Vite 8 hash determinism across identical builds.** No primary-source statement or issue found either confirming or denying byte-stable output hashes for unchanged inputs (Rollup historically hashes on content, and Rolldown claims Rollup compatibility, but Rolldown 1.0 explicitly reserves the right to change *output behavior* between minors — which would churn hashes on upgrades even if single-version builds are deterministic). Must be tested empirically; treat bundler upgrades as full-redeploy events for CDN purposes.
- **Whether `codeSplitting` group `name`/`test` accept functions** (for fully programmatic tier assignment) — the reference docs show string/regex forms; the function-returning-group-name form was *requested* in [rolldown#7473](https://github.com/rolldown/rolldown/issues/7473) but its current status is unclear.
- **Resolution status of [rolldown#7473](https://github.com/rolldown/rolldown/issues/7473)** (tiny-chunk explosion + side-effect breakage): open as of our check, milestoned "Q2 M2"; whether fixes have shipped in recent 1.0.x patches wasn't determinable from the issue page.
- **Rspack `moduleIds: 'deterministic'` rebuild stability** — an old bug ([rspack#7031](https://github.com/web-infra-dev/rspack/issues/7031), 2024) reported instability during rebuilds; we did not confirm its fix status in 2.x.
- **Waku's zero-JS guarantee for static pages without client components** — plausible from its architecture but not confirmed from a primary source.
- **`@vitejs/plugin-rsc` exact version/stability label** — npm page was inaccessible (403); the README marks some APIs experimental while React Router ships on it.
- **Vite dev-server behavior at hundreds/thousands of HTML entries** (dev-time scalability of huge MPAs) — no primary source found; the experimental Full Bundle Mode may change this calculus. Prototype needed.
- Secondary sources report Vercel once promised a standalone Turbopack CLI/plugin API "in the future"; we found no primary Vercel statement newer than the Next.js docs' future-tense hint, and no delivery.
