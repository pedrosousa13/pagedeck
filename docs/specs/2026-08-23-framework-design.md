# Static Marketing-Site Framework — Design Spec

**Date:** 2026-08-23
**Status:** Draft for review
**Name:** Pagedeck, chosen 2026-10-02 (#651): the `pagedeck` CLI and the
`@pagedeck/*` packages. This spec was written under the working name
"framework", with an `fw` CLI and an `@fw/*` scope.
**Companion research:** [Bundler deep dive](../research/2026-08-23-bundler-deep-dive.md)

## 1. Problem

CMS-driven React marketing sites currently pay for their flexibility in payload:

- **Next.js (pages router):** a single component-list file statically imports the
  entire design system (~80+ components in the current boilerplate) and feeds a
  catch-all route. Every page ships the whole map plus a `__NEXT_DATA__` blob of
  serialized page props.
- **Astro:** selective hydration exists but must be hand-annotated
  (`client:load`) per usage, every React component needs a `.astro` wrapper or
  template entry, and the framework cannot know which React components a CMS
  page will need. (Measured 2026-08-23: Astro matches this spec's payload
  goals outright — zero JS on content pages, within 2 brotli bytes of
  hand-written HTML. The gap this framework fills is the authoring model and
  the content-aware build, not payload; see
  [build vs adopt](../research/2026-08-23-build-vs-adopt.md), decision 24.)

The root cause is shared: **the framework doesn't know, per page, which
components the CMS content uses and which of those need JavaScript.** This spec
describes a framework that derives both facts from content at build time.

## 2. Goals

1. Per-page bundle control: each page loads exactly the components it uses.
2. Zero JS on pages with no interactive components; no page-level data blob ever.
3. High-conversion (ad-landing) pages get measurable, CI-enforced payload budgets.
4. Static output deployable to any static host (S3+CloudFront first) with
   incremental, partial redeploys of only changed pages.
5. Best-in-class SEO and Core Web Vitals; first-class i18n/multi-market.
6. Fully agnostic core: no CMS-, design-system-, CI-, or experimentation-vendor
   code in the framework.
7. Pure-React authoring (added 2026-08-23, decision 24): components are plain
   React modules, interactivity is declared once per component via
   `"use client"`, never per usage and never through wrapper files. HTML output
   stays plain semantic markup — parseable by crawlers with no serialized
   tree, no framework scaffolding beyond inert island markers.

## 3. Non-goals (v1)

- Request-time rendering (SSR/ISR/serverless). Output is static files.
  (The SQLite store is a deployable artifact, so serverless rendering remains
  architecturally possible later.)
- GraphQL data layer of any kind.
- Built-in site search (plugin: build-time index, Pagefind-style). Deferred
  from v1 core but **planned immediately with the docs-site dogfood** — search
  is near-mandatory for docs/help-center use cases.
- Motion/animation primitives (islands + CSS scroll-driven animations suffice).
- Form backends (an island POSTs to the site's endpoint; documented pattern only).
- Build-time image processing (sharp) — future plugin; v1 is image-CDN-based.

## 4. Consumption model

Package-first structure, **dogfood-first adoption**: the only v1 consumer is one
real high-value site migrated from the current Next.js boilerplate, chosen to
include a high-conversion form page so results are measurable against
production. The starter template and public API commitment come after the API
survives that contact.

## 5. Architecture

Packages (working names):

| Package    | Responsibility |
|------------|----------------|
| `core`     | Build orchestration, CLI (`sync`, `build`, `diff`, `store pull/push`), manifests |
| `content`  | SQLite store, collection/loader contracts, usage extraction, ranking |
| `islands`  | Client hydration runtime (~2 kB budget), hydration strategies |
| `edge`     | Optional compilers: redirect/experiment manifests → CloudFront Function / `_redirects` / nginx |

Foundation: **Vite 8 (Rolldown-powered)** builder API; React 19 with React
Compiler applied to island code. Rationale and runner-up analysis in the
companion research doc.

**Named risk — resolved (2026-08-23):** validated by prototype (issue #1,
branch `proto/rolldown-tiers`) on Vite 8.2.2 / Rolldown 1.2.5. Ranking-driven
`output.codeSplitting` groups produce the exact §9 tier shape with no
tiny-chunk explosion; two clean builds are byte-identical (hashed filenames
included); editing one tail component renames only its chunk plus its
importer pages, so core-tier chunks are cacheable site-wide and pinnable in
the incremental manifest. Rspack fallback not needed. Config surface note:
Vite 8 uses `build.rolldownOptions`, and `advancedChunks` is a deprecated
alias of `codeSplitting`.

## 6. Content layer

### Collections and loaders

```ts
defineCollection({
  name: 'pages',
  loader,             // bulk sync — never per-entry fetch during builds
  extractUsage?,      // (entry) => ComponentUsageRecord[] — powers ranking
})
```

Loader contract (the whole CMS surface area of the framework):

- `syncAll(store)` — full sync.
- `syncSince(store, cursor)` — incremental sync; returns changed/deleted entry ids.
- `fetchOne(id)?` — optional store-first-API-fallback freshness (cached mode).

The framework owns a **local SQLite store**. Snapshot in/out (`store pull/push
<url>`) makes any CI workable: pull snapshot → `syncSince` delta → build → push
snapshot. No CMS-specific and no CI-specific code in core; the CMS loader and
CI recipes live outside core (docs/adapter packages).

Queries at build time are typed and direct (no GraphQL). Data is a frozen
snapshot per build (Astro content-layer semantics, but SQLite-backed —
queryable without loading everything into memory).

### Schema validation

Collections accept an optional schema (standard-schema compatible — zod,
valibot, etc.). Entries are validated **at sync time**: a missing required
field fails the build with the page and field named (`/de/pricing:
hero.title missing`) instead of shipping a blank section. The schema is also
what makes the build-time query API **typed** rather than `any`. Validation is
opt-in per collection; unvalidated collections still work, untyped.

### Usage extraction and ranking

`extractUsage` walks an entry's component tree recording per component:
occurrence count, minimum tree position (**fold score** — lower = higher on
page), depth, root status. Sync populates a usage table; ranking aggregates
`totalUsages`, `storyCount`, `avgFoldScore` across all entries. This data
drives chunk tiers, CSS tiers, hydration demotion, and image priority — it is
the framework's core innovation over existing content layers.

## 7. Pages, rendering, i18n

### Rendering — two page modes

`definePages()` maps route instances → routes, with collection entries as the
common source of those instances (`fromCollection`) and a store-free source
— a literal list, a JSON file, a build-time fetch — as an equal one (#87). Rendering is a **pure
function**: `(entry JSON, component registry) → React tree`, rendered via
`react-dom/static`'s `prerender` at build — not `renderToString`, which does
not await Suspense boundaries and would bake fallbacks into the static HTML
silently.

Two rules attached (design-review findings, 2026-08-24):

- **Island subtrees render in per-island passes.** Each island instance's HTML
  comes from its own `prerender` call with that instance's `identifierPrefix`,
  composed into the page HTML. Hydration replays the same prefix per root, so
  `useId` matches by construction — a single-pass page render with per-root
  hydration prefixes cannot (server ids would be generated from full-page tree
  positions under one prefix, then hydrated as sub-roots under others). The
  page render stays a pure, worker-parallelizable function; island passes are
  nested pure calls.
- **Suspension during a build render is an error, not a data seam.**
  Components do not fetch for themselves: data enters through the loader (§6)
  or a registry-declared build-time resolver, resolved before render.
  `prerender` exists so Suspense-*using* client components stay renderable —
  not to enable ad-hoc build-time IO, which would silently break build-twice
  determinism (§15) and preview (§14). An unresolved suspension fails the
  build naming the component.

Pages come in two modes, identical downstream:

- **Tree-driven** (CMS page builders): the entry *is* a component tree;
  `extractUsage` walks it to determine the page's component set and fold
  positions.
- **Template-driven** (docs, blogs, product/course catalogs — any
  schema-shaped source): the page type declares a fixed template component
  whose component set and fold positions are **known statically** — no
  extraction. Ranking, tiers, CSS slicing, and island detection consume the
  same usage data either way.

Both modes coexist in one site, and collections from different sources compose
freely (CMS marketing pages + markdown legal pages + API-driven catalog pages
in one build/manifest/deploy). The framework is a **content-addressed build
system**: anything that can enumerate entries and diff them gets optimal
static pages. A CMS is just the most demanding loader, not the premise. The same function is what the preview build
renders client-side (§14) — 1:1 by construction. Page rendering is
parallelizable across workers by design (scaling target §16).

### i18n and markets

- `defineLocales()`: locale → `{ label, direction, fallback, domain? }`
  (deliberately shaped like the current `LanguageMapInterface` for mechanical
  migration). Multiple locales may share a domain.
- **Page identity is `(locale, path)`** in the store, manifest, and budgets.
- Domain-mapped locales emit per-domain output trees (own bucket/origin or
  host-routed single bucket); folder locales share one tree under prefixes.
- **Fallback chains resolve at build time**: untranslated pages render fallback
  content with correct `hreflang` and canonical. RTL direction flows from
  locale config into HTML.
- Automatic **cross-domain `hreflang` alternates** from the locale map;
  per-locale sitemaps in both `sitemap-en.xml` and `/en/sitemap.xml` patterns.
- Folder-level vs field-level translation strategy is a loader concern; the
  store normalizes to `(locale, path, content)`.

### Build-time documents

Beside the pages, a build emits **build-time documents**: files at fixed
addresses, derived from the whole build rather than authored as pages, that
something other than a reader goes looking for. The per-locale sitemaps above
are the first; `robots.txt` (#325), an RSS feed over a collection (#324) and a
favicon (#297) are the same shape of thing. None of them is a route — no
`definePages()` declares one, none carries a `(locale, path)` identity, and the
route table does not refer to them.

Four properties make it a class:

- **Derived from the build, not from a page.** A sitemap is every URL a locale
  publishes, a feed is a collection projected onto items, a `robots.txt` points
  at the sitemap this build wrote. The only place every page exists at once is
  inside a build, so each one's setting is a `build` field.
- **Declared or absent.** A site that declares none gets none, and its output
  tree stays byte for byte what it was before the field existed. No build
  guesses a crawl policy, invents a feed or ships an icon on a site's behalf.
- **Deterministic.** Two builds of one store write each build-time document
  byte for byte (§11), the invariant the emitted pages are already held to.
- **Absolute where it addresses a page.** A build-time document holding URLs is
  refused without `origin` — `sitemap`'s own refusal, because a field the
  pipeline can never read is a field a site can set and watch do nothing.

**Each gets its own `build` field rather than a shared registry**: `sitemap`'s
own arrangement, one field per build-time document. That is the configured
shape rather than the class, and it is decided and argued in `CONTEXT.md`'s
**A build-time document is configured by a field of its own**.

## 8. Component registry and islands

```ts
defineComponents({
  hero:      { import: () => import('./Hero')     },  // no directive → static
  lead_form: { import: () => import('./LeadForm') },  // "use client" → island
  carousel:  { import: () => import('./Carousel'), hydrate: 'visible' },
})
```

**Boundaries come from `"use client"`.** Design systems are authored the RSC
way — server components by default, `"use client"` on interactive leaves — and
the framework reads that directive at build time to decide what becomes an
island. A directive and a hydration boundary are the same declaration, so the
framework adopts the ecosystem's notation rather than inventing a parallel one.
The framework does **not** run an RSC pipeline, emit a flight payload, or
require a server; see [RSC support options](../research/2026-08-23-rsc-support-options.md)
and [flight-free RSC](../research/2026-08-23-flight-free-rsc.md).

Verified end to end through a real Vite 8 + Rolldown build (prototype
`proto/use-client-scan`, issue #68): the scan resolves boundaries over the real
module graph, the boundary set is byte-identical across builds, and mid-tree
boundaries, opaque slots and per-island hydration all work in built output.
The findings below marked **(#68)** are that prototype's, not inference.

- The **name → import mapping stays required** — a directive cannot say which
  entry component name resolves to which module. **Build fails on an
  unregistered component**; the registry cannot rot silently.
- **Boundaries are recorded during the build, never read back out of it (#68).**
  Rolldown preserves a top-level directive only in an entry chunk whose *entry
  module* carries it; a directive module landing in a shared chunk, or reached
  as an entry's dependency, loses the directive in the output. The scan
  therefore runs as a build-time plugin over the module graph
  (`moduleParsed`/`importedIds`, AST-checked rather than regex-matched) and
  emits a boundary manifest.
- `hydrate: 'none' | 'load' | 'visible' | 'idle' | 'interaction'` is an
  **optional override**.
  Absent it, a module carrying `"use client"` defaults to `visible`; a module
  without the directive is `none`. `"use client"` plus an explicit
  `hydrate: 'none'` is always an authoring error and fails the build. An
  explicit `hydrate` on a directive-**less** module **forces islandhood** —
  the documented escape hatch for third-party components whose source cannot
  carry the directive.
- **`visible` observes the marker's element children, never the marker (#68).**
  A `display: contents` wrapper generates no box: an `IntersectionObserver` on
  it fires once with an all-zero rect and `isIntersecting: false`, then never
  fires again — the island **never hydrates**, silently, which is the worst
  available failure. Observing each element child behaves normally. Two cases
  have no observable target at all — a marker whose children are **text nodes
  only**, and an **empty** marker — and the runtime must fall back to `idle`
  for them rather than register an observer that can never fire.
- **`interaction` hydrates on the first `focusin` or `pointerdown` inside the
  marker (#75).** It is explicit-only: no directive defaults to it, and fold
  score never moves it. The event that fires it is **not replayed** after
  hydration: focus survives hydration and a field keeps its value, while a
  replayed click could run an action twice. A marker with no element children
  falls back to `idle`, as `visible` does.
- `"use server"` marks a *server function*, not a server component. It requires
  a runtime request handler, which non-goal §3 rules out, and fails the build
  naming the file.
- Static components render to HTML and ship no JS.
- Interactive components render to HTML plus a hydration marker containing
  **that instance's props only, inline**. No page-level data blob exists.
  Island markers are **elements, not comments** — React 19's container
  validation rejects comment nodes — and each root gets a distinct
  `identifierPrefix` so `useId` cannot collide across islands.
- **Mid-tree directives are islanded, not rejected (#68).** A `"use client"`
  module rendered by a *static registered* component (a static `Hero` whose JSX
  renders a client `Tooltip` — the portable Next.js idiom) is a real boundary.
  The build wraps directive modules in the **server build** so each instance
  records its own props and emits its own marker; the directive module becomes
  the island. The rejected alternative was hoisting the boundary to the
  registered ancestor, which ships server-authored code to the browser
  (measured +31 kB on the fixture) and converts a `node:fs` import into a
  *runtime* crash — Rolldown stubs the module to `{}` and only warns, so the
  build passes and the island throws in the browser.
  **Non-serializable props crossing a mid-tree boundary fail the build**,
  naming component and prop. Function props are the common case: without the
  error the handler is silently dropped from the marker and the control
  renders but is inert.
- **Marker element constraints (#68).** The marker uses `display: contents`
  and must carry **`role="presentation"`** — verified in Chrome 149/150, the
  wrapper otherwise leaks a `generic` node between a `<ul>`/`<ol>` and its
  `<li>`s, breaking list semantics. `display: contents` itself is not the
  cause; the extra element is. With the role set, flex, grid and list contexts
  are indistinguishable from unwrapped baseline (children remain flex items,
  land in grid tracks, keep `::marker` numbering) and focusable children keep
  their roles and tab order. **Tables cannot carry a marker**: the HTML parser
  foster-parents the wrapper out of `<table>` before CSS applies, deleting the
  island entirely; even DOM-constructed, the wrapped row disappears from
  `HTMLTableElement.rows`. An island boundary inside table markup must fail
  the build.
- Fold score tunes strategy per instance, **both directions**, applied only to
  **directive-defaulted** strategies — an explicit registry `hydrate` always
  wins and is never overridden. Promotes defaulted `visible` → `load` above
  the fold, demotes below it; never alters `none`. **On by default**
  (effortless-performance stance, §12), disableable per site.
- A content-only page ships **0 bytes of JavaScript**.
- **Directive placement is a payload decision, and the risk runs upward (#68).**
  The *downward* closure React defines — the directive module plus everything it
  imports — is well behaved and barely moved when a widely-imported shared hook
  took the directive (14 → 14 modules, +14 bytes). What moves is the *upward*
  blast radius: the set of components that now contain an island boundary
  somewhere in their tree, and whose pages therefore stop being zero-JS. One
  directive on one shared hook took that set from 10 to 22 of 30 components and
  from 44% to 77% of app source bytes. This does not invalidate deriving
  boundaries from the directive — it means the build must **report** the upward
  reach per directive, so a directive on a shared module is a visible cost
  rather than a silent one. Budgets (§9) are the enforcement; this is the
  attribution.
- **Root providers.** The framework wraps a configured provider stack around
  both the build-time page render and every island root. Islands are
  independent React roots, so Context cannot flow between them — but a provider
  that receives an explicit module-level store (rather than owning its state)
  is replicable at every root while all copies address the same store. Context
  is the delivery mechanism; the store is the shared state. This requires the
  store module to resolve to exactly one instance across all chunks.
- **Slots.** Containers whose children are entry-driven nested blocks keep
  their server-rendered children as inert DOM inside the island, adopted rather
  than passed as props. Slotted content can be positioned, wrapped, toggled and
  reordered, but is an opaque string: no `React.Children` traversal, no
  `cloneElement`, and it never re-renders. Slots are **tree-mode machinery**:
  in template-driven pages (§7) a container's children are code, so they
  compile into the island's own bundle and hydrate as ordinary React children —
  `React.Children` and re-render work there, and the JS cost lands in that
  page's budget. Verified through a real build (#68): a container hydrated
  against `dangerouslySetInnerHTML` slot content with **zero** hydration errors
  and zero console errors, including switching to a panel never rendered
  server-side and recovered from a stashed `<template>`.
- **Runtime split.** The islands runtime ships as a **core runtime** (markers,
  strategies, root providers, id prefixes) holding the ~2 kB Brotli budget,
  plus a separate **slot module** loaded only on pages that contain slotted
  containers — pages without them never pay for slot machinery.
- The registry is the agnostic replacement for a design-system dependency:
  a design-system team ships a package fulfilling this contract; any design
  system can.

## 9. Bundling

### JS

- Per-page entry modules are **generated** from store queries (page → exact
  island set). No global component map exists anywhere.
- Ranking compiles into Rolldown `output.codeSplitting` groups (the successor
  to `advancedChunks`, which is deprecated):
  - **core tier** — components above a usage threshold; stable chunk name,
    cached site-wide (shared across locales/markets).
  - **grouped mid-tier** — co-occurring mid-frequency components.
  - **tail** — rare/heavy components stay per-page.
- **Per-page budgets**: `budget: { '/pricing': '15kb' }` (glob-able,
  locale-aware). Build fails on breach. A budget counts **compressed (Brotli)
  JavaScript** transferred for first render — page entry + its share of tier
  chunks, **plus the executable JavaScript the build writes into the document**:
  the script layer's consent loader, the RUM beacon and the site's own
  pre-paint scripts (§12), none of which is a chunk (#346). Not what a chunk
  is, but what the page runs — a `<script>` carrying JSON-LD or speculation
  rules is data and is not counted. CSS and HTML are reported alongside but not
  counted against it; that parenthetical is about stylesheets and markup rather
  than about inlining, and a page's whole document is `html` whatever is inside
  it.
  Fold-**promoted** islands count (promotion makes their load eager), and
  budgets re-evaluate on **every** build, incremental included — a content
  edit that shifts a component above the fold can legitimately breach. The
  breach report must name the cause ("promoted by fold score after content
  edit"), so a CI failure from a copy tweak is explainable, never mysterious.

### CSS

- Components import their CSS; per-page entries yield per-page stylesheets;
  the same ranking tiers apply. A page gets its **whole reachable set**,
  ordered core, then mid, then everything narrower, each rank sorted by path —
  not the core tier plus its own sheet: a tier the document omits is fetched at
  hydration instead, in hydration order, and the cascade stops being the
  framework's (#22). It links that set, or inlines it under `criticalCss`
  below.
- Tailwind utilities compile into `core.css` as one shared layer (no per-page
  utility subsetting — cache stability beats marginal bytes).
- **Opt-in critical-CSS inlining** (`criticalCss: true` per page/pattern) for
  cold-cache ad-landing pages: the page's critical CSS is *computed from its
  known component set* (no headless-browser heuristics) and inlined; linked
  tiers remain the default everywhere else.

### Tailwind × incremental builds (drift protocol)

Invariant: **classes derive from code, never content.** Variants are enumerated
in component source; CMS-exposed styling options come from an enumerated
safelist declared to the registry. Content changes therefore cannot require new
CSS; code changes trigger full builds anyway.

Safety net, because invariants rot: every incremental build extracts classes
from re-rendered HTML and checks them against the **class manifest** recorded
at the last full build (set lookup). On a miss:

1. Compile a supplement containing only the missing rules (scoped Tailwind v4
   run, single-digit ms) and **inline it into the affected pages' HTML** —
   zero extra requests, `core.css` byte-identical, no cascade.
2. Report drift loudly (it is always a safelist gap or content-hygiene bug).
3. Past a drift threshold (named config, default to be set during planning —
   e.g. N drifted pages or M supplement bytes), the next full rebuild reabsorbs
   supplements.

Guarantee: incremental builds are never visually broken and never cascade; the
mechanism is byte-identical to no-mechanism when drift is absent.

## 10. Images and fonts

### Images

- Core defines the image contract: `(src, width, quality, format) → URL`, plus
  one **generic URL-template adapter** covering URL-param image CDNs
  (CMS-native image services, Cloudinary, Imgix — configured in the site, not
  core).
- Core generates `srcset`/`sizes`, format negotiation, intrinsic dimensions
  (CLS-safe), below-fold lazy-loading, and `fetchpriority=high` above the fold
  — driven by fold score.
- Placeholders: **dominant-color** (one CDN request per unique image at sync
  time, cached in the store). Full blur-up LQIP deferred with the sharp plugin.

### Fonts

- Core defines the font contract, ships no subsetter: a named `FontAdapter` a
  site supplies (`build.fonts.adapter`) is handed one face's resolved source
  and its declared Unicode ranges, and answers with subset bytes and the
  metrics it read off the font. `@pagedeck/font-subset` (fontkit + harfbuzz's
  `subset-font`) is the reference adapter, wired into the dogfood site.
- Subsetting is scoped by Unicode ranges the site declares per face, not a
  scan of rendered page text — keeps a font's own bytes independent of page
  content and out of the incremental-build refusal list.
- Self-hosted, content-hashed output; `preload` for above-fold faces only;
  fallback metric adjustment (`size-adjust`, `ascent-override`,
  `descent-override`, `line-gap-override`) to eliminate font-swap CLS.
  Declared in site config; framework emits the plumbing.
- A face is linked on every page unless it declares page patterns
  (`FontFace.pages`, the `criticalCss` grammar), in which case its stylesheet
  and its preload go only on the pages they match: one stylesheet per distinct
  scope beside the site-wide one (#573). Declared, never inferred from which
  pages set text in the family.

## 10b. Local development

`pagedeck dev` runs the Vite dev server: routes resolve against the local store
on the fly (no pre-generated entries — a dev-only catch-all renders any page
from the current snapshot), islands hydrate through the same runtime, and
component/config edits get HMR. `pagedeck sync --watch` may refresh the store in the
background; content edits appear on reload. Chunk tiers, budgets, and manifests
are build-time concerns and do not run in dev — `pagedeck build` (fast via Rolldown)
is the verification step. Dev DX beyond this is explicitly deferred until after
the dogfood milestone.

## 11. Deploy

- `pagedeck build` emits the site plus a **versioned manifest**: file hashes, per-page
  dependencies (entry ids + relations), pinned chunk assignments, class
  manifest.
- `pagedeck diff` compares manifests → changed/added/removed file lists that any CI
  can feed to any host. Reference recipes (docs only): S3+CloudFront, GitHub
  Actions, Vercel/Netlify static.
- **Incremental page updates** (headline capability): `build --incremental`
  uses the sync cursor → affected page set (reverse dependency lookup including
  references) → re-renders only those pages' HTML → uploads only those files.
  Content-only changes touch zero JS/CSS files. A 3-page copy tweak deploys 3
  HTML files, per affected market, in seconds.
- **Deletions** (validated by issue #2 prototype): removing a page emits its
  HTML removal plus a redirect per a **named redirect-target policy** (config;
  default: nearest existing ancestor path) — the old entry chunk joins the
  prune queue. Deleting an entry that pages still reference **aborts the
  incremental build** at sync validation, naming the referencing pages; the
  store rolls back and the event batch is retained for retry. Within a
  debounced batch, contradictory events on one entry collapse last-write-wins
  (edit + delete → delete).
- **Chunk stability:** tier assignments stay pinned between full builds; a page
  whose island set diverges from its pinned entry rebuilds only its own entry.
  Scheduled or drift-triggered full rebuilds re-optimize tiers.
  (Clarification from issue #2 prototype: since entry modules are generated
  from the exact island set, an island-set change always re-emits that one
  tiny entry chunk — even when the island's code already ships in a pinned
  shared chunk. "Content edits touch zero JS" holds for copy/reference edits;
  island edits touch exactly one generated entry, never shared tiers.)
  **The rest of the split is pinned too (#720).** A tier group holds only the
  modules its tier claims, and Rolldown splits every other shared module by its
  own rules. When an island leaves the graph, a module the site wrote can lose
  an importer and move into the remaining island's chunk, which renames that
  chunk and the entry of a page the build reuses. So every build records each
  chunk Rolldown split off outside the tiers, with the modules it holds, as
  `files[].chunk` in the manifest. An incremental build hands that record back
  to Rolldown as split groups, each chunk keeps its modules, a chunk whose
  content did not change keeps its bytes, and a reused page's document stays
  byte-identical.
  The pin keeps each module where it was. It cannot keep a chunk's bytes when
  its content changes. That happens when the island that left was the last
  importer of one of the chunk's exports, because Rolldown drops the export,
  and when an added island imports a module another island's chunk held, which
  then has to export it. For those cases the build falls back to #720's other
  option: each reused page that names a chunk or stylesheet this build did not
  emit leaves the reused set and is rendered again, and the build bundles
  again, until no reused page names a missing file. Each bundle runs the
  head callbacks, social cards, renders and bundler again, so an incremental
  build runs at most three; a reused page that still names a missing file
  after the third is refused, whatever `build.links` says.
  An incremental build's split can differ from what a full build of the same
  source would choose, and the next full build renames those chunks.
  **Constraint:** any incremental JS emission runs as a **full-graph bundler
  invocation** — never a partial-graph build — relying on deterministic output
  (below) to leave unchanged chunks byte-identical. The singleton-module
  guarantee that cross-island state depends on (§8, issue #64) is documented
  per invocation only; a partial-graph build would silently duplicate the
  shared store against the pinned core chunk.
- **Deterministic output hashing is a CI-checked invariant** (build-twice test)
  — required for both CDN cache hit rates and incremental correctness.
- **Ordering:** upload new hashed assets → then HTML → prune old assets after a
  grace period (named config, default set during planning). Encoded in the diff
  output ordering, not left to CI authors.
- **Queueing:** webhook storms are debounced; deploys serialize via manifest
  build-ids (last-write-wins detection).
- **Rollback:** manifests are retained; rollback re-syncs a previous manifest.
- **URL normalization policy:** one explicit config decision — trailing-slash
  style and `index.html` resolution (`/pricing` vs `/pricing/`) — encoded
  consistently in emitted links, canonicals, sitemaps, and the edge config, so
  S3/CloudFront resolution quirks can't create duplicate-content URLs.
- **Redirects/404/headers:** CMS- or config-driven redirects compile into a
  redirect manifest; `edge` adapters emit CloudFront Function / `_redirects` /
  nginx config. 404 page and security headers ride the same manifest.
- **PR deploy previews:** branch builds deploy under a manifest prefix to a
  preview bucket — falls out of the manifest design; docs recipe only.
- **Caching note (docs):** CDN cache keys must ignore marketing query params
  (`utm_*`, `gclid`) or every campaign link busts the cache.
- **Scheduled publishing:** core exposes the hook (`publish_at` visible to the
  sync query + a `--due-only` build flag); triggering at the right time is the
  site's CI/scheduler concern.

## 12. Experiments and third-party scripts

Experimentation-agnostic — all three modes supported, none required:

1. **None:** pure static pages.
2. **Build-time variants:** pages declare variants → parallel static outputs +
   a routing manifest → `edge` compiles the split (cookie assignment + rewrite)
   for CloudFront Functions or equivalents. Zero flicker, zero client JS,
   SEO-safe canonicals.
3. **Client-side tools (Optimizely et al.):** loaded through the script layer
   below; the framework stays out of the way.

**Script layer:** declarative third-party script config with loading strategies
— `idle`, `interaction`, `facade` (heavy embeds), `worker` (Partytown-style
off-main-thread) — and **consent categories built into the contract**
(`category: 'analytics'`, load-only-after-consent), CMP-agnostic. Goal: keep
PageSpeed despite analytics. The categories are a closed set of four:
`analytics` (measurement), `functional` (third-party embedded content and
functionality a visitor can decline, such as video, maps and comment widgets,
#459), `marketing` (advertising) and `necessary` (loads without waiting on
consent).

Named applications: **chat widgets** (Intercom-style — the canonical `facade`
case: static button, real widget loads on interaction) and an optional
**web-vitals RUM beacon** so real-user CWV per page feeds back into which pages
deserve budgets.

**Effortless-performance stance:** the fast path is the default path. Scripts
declared without a strategy default to `worker` (fallback `idle`) — a site
that just lists its GTM/GA4/pixel loadout gets off-main-thread loading without
tuning. Strategy resolution is layered: per-script default → per-page-type
override → per-page override — so conversion pages can force worker offloading
while a page type running a DOM-touching tool (client-side experimentation)
opts that one script down to `idle`. Worker offloading is not universally safe
for DOM-heavy vendors; the override layers are the escape hatch. **An override
layer may also say `off`**, which is not a strategy but the answer to *whether*
the script loads on those pages at all — a page every declared script is `off`
on carries no script-layer bytes, so §8's zero-JS content page survives a site
that declares a loadout, and because the per-page layer wins, the same value
opts a script back in on a narrow key under a broad one (#345).
The cookie/CMP banner pattern ships as static HTML + a tiny island
(never a render-blocking third-party script), documented against the major
CMPs. The framework cannot control what marketers later dump *into* a tag
manager — the RUM beacon and per-page budgets exist to catch that drift.

**Pre-paint slot:** the one thing in this section that is not a vendor's.
`build.prePaint` carries the *site's own* synchronous scripts, written into the
`<head>` ahead of the stylesheets and run before the browser paints (#311,
#330). It is not a fifth strategy and it is not inside the layer above: those
four answer when a **deferred** script runs, and this is code that must have run
**already**, inline, with no request in front of it. Two things need that
moment and both are stored state read before paint — a theme kept in
`localStorage`, or the page paints the other one and then corrects itself; a
returning visitor's recorded consent decision, or an opt-out market's `granted`
default loads the script that visitor already refused, because the loader sits
at the end of the body and fires its first trigger there. Nothing later in the
document can do either job: a stylesheet cannot read storage, and an island
hydrates after the body it would have to precede.

**Core carries the slot and the site carries the script.** Each entry is the
JavaScript to run and not an element to write, because the `<head>` has one
writer and it writes the `<script>` around it. So the framework guarantees
*when* the bytes run and never learns what they are for — the `ImageAdapter`
and `FontAdapter` seam (§10) applied to stored state, and the reason it is
shaped this way rather than as a consent bootstrap core emits: that one works,
and it would make core know a banner's storage key. The banner ships its own
snippet beside the key it reads, so the two cannot drift and core knows
neither. What core does check is that the text can be carried at all —
`</script` and `<!--` are refused at config load, naming the entry, because a
program is the one value a writer cannot encode its way out of: escaping a `<`
inside JSON is lossless, and escaping one inside a program writes a different
program.

Declared or absent, on §7's build-time-document terms: a site that declares
none emits what it emitted before the field existed, byte for byte. A site that
declares one puts an inline `<script>` on every page it builds — a *second* one
only where the script layer's loader above is on the page too, which on a site
declaring no `build.scripts` it is not — so those bytes are counted by the
per-page budget (§9) and what they cost a strict CSP is that site's to pay.

## 13. Navigation and SEO extras

- **Speculation Rules** emitted per page (prefetch/prerender likely next pages —
  computable from the store's link graph) and **cross-document View
  Transitions** via CSS. Browser-native, zero-JS SPA feel.
- **JSON-LD structured data hook** per page type in the page contract.
- OG/social image generation at build: named **plugin**, not core.
- **A11y CI hook:** axe against built HTML on representative pages.
- **Build-time link validation:** every internal link and asset reference in
  rendered HTML is checked against the manifest at build; broken ones fail (or
  warn, config-gated) with page + href named. External links optionally checked
  on full builds only.
- **Geo market suggestion:** a "visiting from Germany — switch to the German
  site?" banner,
  as an `edge` capability (CloudFront viewer-country header) or a tiny `idle`
  island — never a blocking script. Named here so it isn't reinvented badly.

## 14. Preview

A separate build target for CMS visual editors:

- Client-rendered app reusing the **same pure render function and registry**
  with the full component set loaded. **The 1:1 claim is bounded to
  rendering** (2026-08-24 review): hydration semantics differ — preview is one
  client tree where Context flows page-wide and slotted children are live
  React elements; production is fragmented roots with opaque slots. Preview
  therefore **enforces production's constraints artificially**: operations
  production forbids (`React.Children`/`cloneElement` over slotted content,
  re-rendering it) assert loudly in preview rather than working silently —
  preview must never demonstrate a capability production lacks.
- A **bridge adapter interface** for live-edit events; the CMS bridge is the
  first adapter and lives outside core.
- Deployed anywhere static. **Zero preview bytes in production output** — the
  hard requirement. **Narrowed by #382, which wired the target into `pagedeck build`.**
  A site declares `build.preview: { path }` or gets no preview app at all, and a
  site that declares none is byte for byte the site it was before the field
  existed — so the requirement holds absolutely wherever nobody asked. A site
  that *does* declare it publishes the app into its own output tree, under that
  one path, because "deployed anywhere static" is a deploy the site already has.
  What the requirement was aimed at is unchanged and is what still holds there:
  the two targets are two bundler invocations sharing no graph and no input map,
  so no chunk a *page* loads holds a preview module. That is a claim about the
  graph, and `preview-build.test.ts` is what asks it of one: no chunk of a
  production client build holds the preview entry's id or a module under
  `packages/preview/`. `preview.build.test.ts` asks what a real `dist/` can
  answer — nothing the build wrote outside the declared path carries the preview
  app's mark — because emitted bytes and a manifest record no chunk's modules.
  `CONTEXT.md`'s **Preview is declared or
  absent, and every byte of it lives under one path** carries the deployment
  posture and the reasoning, which is not repeated here.

## 14b. Documentation

Documentation is a first-class deliverable, not an afterthought:

- **Diátaxis structure** from day one: tutorials (get a site live), how-to
  guides (write a loader, add a locale, set a budget), reference (every
  contract — loader, registry, manifest, CLI — generated from TypeScript types
  so it cannot drift), and explanation (why islands, why tiers, the drift
  protocol's reasoning — much of it distilled from this spec).
- Every public contract ships with a **runnable example** checked in CI (the
  fixture loader makes this cheap — examples build against fixtures).
- Error messages are documentation: build failures name the page, field, or
  budget concerned and link to the relevant doc.
- **The docs site is a dogfood consumer**, built on the framework itself with a
  filesystem/markdown loader — which doubles as proof that the loader contract
  is genuinely CMS-agnostic (second loader implementation) and exercises the
  zero-JS path (docs pages are the canonical content-only page).

  **Resequenced 2026-08-27, issue #61: the docs site is now the *first* dogfood
  consumer, not the second.** As written above it was second, and explicitly
  "sequenced after the marketing-site dogfood validates the core; simple
  markdown docs in-repo until then". The maintainer reversed that order on #61,
  and the reasoning is recorded there:

  - Its content is the repository's own, so it involves neither the real site's
    collections nor its design system, and the project's standing constraints
    stay untouched.
  - It is the thesis in miniature — content-heavy static pages with genuine
    interactivity — which is the case the framework claims to be uniquely good
    at.
  - It is authored continuously rather than ported once, so the authoring model
    is tested by use.
  - This bullet's own stated purpose is worth more when it runs first. A second
    loader is the only evidence the contract is real rather than shaped around
    one consumer, and until #61 there was exactly one.

  What landed under #61: `@pagedeck/markdown-loader` and `packages/docs`. Two facts
  about it are decisions rather than defaults, both taken on that issue. It
  ships **one locale, English**, with no locale scaffolding, fallback chain or
  per-locale routing — a single-locale site being its own test that the
  framework does not force locale ceremony on a site that has none. And the
  repository's own `docs/` tree is rendered as the site's first content, which
  makes *whether those working documents should be published* a decision still
  open rather than one this section settles.

  Note that "second" was true of two different things and only one of them
  changed: the docs site is now the first dogfood **consumer**, and the markdown
  loader is still the second **loader implementation** after the CMS one.

## 15. Testing and success criteria

- **Fixture loader** (in-repo JSON) makes the entire framework testable with no
  CMS and no network in CI.
- Unit tests: ranking → chunk-group compilation; usage extraction; fallback
  chains; hreflang generation.
- Golden tests: generated per-page entries; manifests.
- **Build-twice determinism test** (hash equality) in CI.
- Budget assertions and drift-protocol tests (inject unknown class → expect
  inline supplement + loud report, `core.css` unchanged).
- Lighthouse CI on the dogfood site.

**Success criteria (dogfood site vs its production Next.js twin):**

1. Content-only pages: **0 kB JS**.
2. Island pages: the framework's own JavaScript stays at or under **6,376 B
   raw / 3,154 B gzip -9**. That is every script byte the page loads on first
   render except `react`, `react-dom` and `scheduler`, measured on the dogfood
   site's `/en/pricing`. It is the one island page in the representative set
   `docs/dogfood-spot-check.md` fixes, and the site has no form page, which is
   the class this criterion first named. This criterion is not a comparison
   with the twin. The two figures are a ratchet: they are what the build
   measured when #292 restated the criterion, they go down when the runtime
   shrinks, and they are never raised, not even for a toolchain bump; a figure
   that rises is a finding to file. They are `RUNTIME_CEILING` in
   `packages/site/src/audit-site.ts`, and
   `packages/site/src/runtime.build.test.ts` builds the site and fails when
   either is exceeded.
   *Note, 2026-09-28 (#547):* the gzip figure is now measured with the
   build's content hashes normalised to a same-length placeholder, so a
   renamed stylesheet cannot move it. The same build reads 3,093 B that way,
   and that is the ceiling now; the 61 B drop is the method, not the runtime.
3. Core Web Vitals: better on every metric, measured in production (CrUX/RUM).
4. Publish-to-live for a content edit: **< 60 s** via incremental deploy.
5. **PageSpeed/Lighthouse mobile ≥ 90 with the full production third-party
   loadout active** — analytics, tag manager, pixels, CMP banner — on default
   script-layer settings. Measured on the dogfood site, not aspirational.

## 16. Scaling targets

- Design targets, not gates (relaxed 2026-08-23, decision 24 — the maintainer's
  constraint is "reasonable build times", not a number): 50 k pages (all
  locales summed) full build on the order of 10 min on a standard CI runner;
  incremental content build on the order of 30 s end-to-end. The architecture
  keeps these cheap (pure render, manifest diff); CI does not fail on them.
- Page rendering is a pure function of one page's content, so it can fan out
  across workers. It runs sequentially today, by decision rather than by
  omission: rendering costs ~1 ms/page and stays linear from 2,000 pages to
  50,000, so it is not the bottleneck at any scale measured so far — the sync
  that precedes a build costs 5.5x the build itself at 50,000 pages. Measured in
  `docs/scaling-verification.md` (#60), and ruled on #351.
- Store targets 200 k+ entries as proven feasible in prior art (compressed
  blobs).

## 17. Decision log

| # | Decision | Choice |
|---|----------|--------|
| 1 | Content resolution | Baked at build from local SQLite store; snapshot pull/push |
| 2 | Preview | Separate build, shared pure render core, zero prod pollution |
| 3 | Chunking | Ranking-driven tiers + per-page CI budgets |
| 4 | Foundation | Vite 8 + Rolldown; Rspack named fallback; determinism prototype first |
| 5 | Hydration | Islands, per-instance inline props, no page data blob |
| 6 | Registry | `defineComponents()` name→import contract; agnostic; build fails on unregistered |
| 7 | Experiments | Agnostic: none / build-time variants + edge split / client tools |
| 8 | Consumption | Package-first, dogfood on one real site, publish later |
| 9 | Content layer | Collections + loaders (bulk sync, cursor, optional fetchOne); no GraphQL |
| 10 | Infra | CI-runner builds; no serverless; core is CI- and CMS-agnostic |
| 11 | i18n | Locale-with-optional-domain model; `(locale, path)` page identity |
| 12 | Incremental deploys | Manifest-diff partial redeploys; pinned chunk graph |
| 13 | Images | URL-template CDN adapter in core; sharp as future plugin |
| 14 | CSS | Linked tiers default; opt-in computed critical-CSS inlining |
| 15 | Tailwind drift | Code-derived classes invariant + verify/inline-supplement safety net |
| 16 | Content safety | Opt-in collection schemas → typed queries, build-time content errors |
| 17 | Link/URL hygiene | Build-time link validation; explicit URL normalization policy |
| 18 | Documentation | Diátaxis + typed reference + CI-run examples; docs site self-hosted on the framework (second dogfood, markdown loader) — resequenced 2026-08-27, issue #61: the docs site is the *first* dogfood consumer, ahead of the marketing-site port; the markdown loader is still the second loader implementation. See §14b |
| 19 | Page modes | Tree-driven (CMS builders) + template-driven (schema-shaped sources); same ranking/tier machinery — CMS is a loader, not the premise |
| 20 | RSC | Island boundaries derived from `"use client"`; no RSC pipeline, no flight payload, no server. Async server components and server actions deferred |
| 21 | Cross-island state | Module-level store outside React (Context cannot cross roots); providers replicated per root against one shared store instance |
| 22 | Review fixes | Per-island render passes (`useId`-safe); suspension in build render is an error; fold tuning only touches defaulted strategies, on by default; registry `hydrate` on a directive-less module forces islandhood; promoted islands count against budgets on every build; core runtime + separate slot module; template-mode children compile into the island (amended 2026-08-26, issue #168: a leaf client component reached from any component's JSX does compile into the island; a client component a server component hands JSX children to is refused, because a slot id is a position in the entry tree — `ISLAND_ID_PATTERN` — and a proxied instance has none. Issue #173 tracks the second id space that clause needs); preview enforces production's slot constraints |
| 23 | Directive scan (#68 prototype) | Scan validated through a real Vite 8 + Rolldown build: boundaries recorded at build time (never read back from chunks), mid-tree directives islanded via server-build wrapping with non-serializable props a build error, markers carry `role="presentation"` and are banned inside tables, `visible` observes element children with an `idle` fallback for text-only/empty islands, upward reach reported per directive |
| 24 | Build vs adopt | Build, not Astro adoption. Criteria: maximum control, minimal React-breakage exposure (stable-API-only surface per decision 20), and pure-React authoring (goal 7: `"use client"` once per component, no per-usage annotation, no `.astro`-style wrappers) — the parts Astro structurally lacks. Payload is parity with Astro, not the differentiator. Build-speed targets relaxed to design targets (§16). Astro conventions stay adopted as prior art. Evidence: [build-vs-adopt](../research/2026-08-23-build-vs-adopt.md) |
| 25 | Routing | No router package in core: the route table is the inverse of what a router does, static output is a CDN path lookup, and islands have no shared root for a tree-owning router to own. Param sources decouple from the content store; route templates exist for compile-time `href` checking only. `(locale, path)` identity, exhaustive enumeration, and collision-as-error hold throughout. `URLPattern` in `@pagedeck/edge` alone, and only if on-demand paths land. Rationale: [ADR-0001](../adr/0001-routing-without-a-router-package.md) |
| 26 | Path spelling | One canonical spelling per URL, minted by `canonicalizePath` in `packages/core/src/pages.ts` and nowhere else: every emitter — output tree, sitemap, manifest key, rendered `href` — calls it or consumes a `Page` that already did, and none re-spells a path locally. The form is RFC 3986 §6.2.2 normalized: non-ASCII to UTF-8 escapes, escape hex uppercased, escapes of unreserved characters decoded back; reserved stays escaped, so no segment is invented or destroyed. Spelling only, not structure — dot segments are resolved before it. A query, a fragment or a malformed escape is a `ConfigError`. Rationale: [ADR-0003](../adr/0003-one-canonical-path-spelling.md) |
