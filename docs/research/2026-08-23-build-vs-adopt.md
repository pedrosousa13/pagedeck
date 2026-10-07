# Build vs adopt: does this framework still solve a real problem?

**Date:** 2026-08-23
**Status:** Decided 2026-08-23: build (option C). The maintainer dropped the sub-30s-at-50k requirement ("build times just need to be reasonable") and set the deciding criteria as maximum control and minimal exposure to React breakage. Control rules out adoption; the design's stable-API-only React surface (decision 20) satisfies the breakage criterion. Islands milestone unblocked; Astro conventions adopted as prior art per decision 23.
**Question:** Should the project keep building its own framework, or adopt an existing stack and ship only the parts that are genuinely new?
**Method note:** Every claim below traces to one of four artifacts produced today: the #68 prototype (branch `proto/use-client-scan`), the [Astro incremental-build research](2026-08-23-astro-incremental-builds.md), the [App Router static-export research](2026-08-23-app-router-static-export.md), and a three-stack payload bake-off measured in a real browser (data in `.scratch/bakeoff/`, summarized here because `.scratch/` never reaches origin). A fifth artifact, an Astro output-hash stability test, is pending; its section is marked.

---

## Verdict

The problem in spec §1 is real but two thirds of it is already solved, by Astro, not by us.

- The **payload problem** (zero JS on content pages, no serialized page blob) is closed. Astro ships 0 bytes of JS and 0 script tags on a content-only page, within 2 brotli bytes of hand-written HTML. There is no headroom for us to win there.
- The **authoring problem** (RSC-style `"use client"` boundaries) is native to Next.js App Router, but App Router welds it to a 452 kB JS floor and a flight blob 1.8x the document. Our #68 prototype proved the boundary derivation works without any of that. This part is real and ours.
- The **scale and deploy problem** (50k pages, sub-30s incremental, partial upload) is solved by nobody. Astro 7.2's new incremental build skips only the render phase, needs a hand-written `cacheKey` per path, runs single-threaded, and still writes a full `dist/`. Next has no incremental story at all.

So the honest shape of our edge: **content layer + usage ranking + budgets + manifest-diff deploy (spec §6, §9, §11)**. The islands layer (§8) is where we would re-derive Astro's answers, and the #68 prototype spent most of its browser questions doing exactly that.

## The evidence in one table

Page with zero interactivity, identical seeded content, production builds, real Chrome:

| stack | JS bytes (raw / gzip) | script tags | HTML vs baseline | data blob |
|---|---|---|---|---|
| hand-written HTML | 0 | 0 | 1.0x | 0 |
| Astro 7.2.4 | 0 | 0 | 1.0x (+5 B) | 0 |
| Next 16.3.2 export | 452,587 / 133,083 | 6 | 2.8x | 27.5 kB inline flight |

Adding two trivial islands: Next +764 B (the floor was prepaid), Astro +0 B until visible then 192.7 kB (184 kB of that is react-dom itself, which any React stack pays, including ours), baseline +529 B.

Scale, from primary sources: Astro's own benchmark extrapolates to ~20 min full builds at 50k pages against our 10 min target, with OOM reports at 10k files. Next re-rendered all 5,003 unchanged routes on a warm rebuild.

## The three options

### A. Keep building the framework (status quo)

Everything in the spec ships as designed. We own islands, bundling, deploy.

- For: one coherent system; determinism, budgets and deploy are design invariants instead of workarounds; `"use client"` portability kept; no dependency on Astro's roadmap or its contested `cacheKey` RFC.
- Against: we rebuild the solved two thirds. The #68 prototype already re-derived three Astro behaviors (children-observation for IO, opaque slots, wrapper element costs). Every future islands bug is ours alone. Astro has a team; this project has evenings.

### B. Adopt Astro, ship the delta as integrations

Content layer with usage ranking, per-page budgets, ranking-fed `codeSplitting` via Astro's Vite config, and a manifest-diff deploy CLI on top of Astro output. Delete milestones Rendering & islands and most of Bundling.

- For: inherit five years of hardened islands. The queue's next three issues (#65, #16, #67) disappear. Effort concentrates on the parts nobody has.
- Against: sub-30s incremental at 50k is unreachable on Astro's architecture today (sync + full bundle run every build, render-skip is opt-in and single-threaded). Manifest-diff deploy depends on byte-stable output, unproven (test pending below). `"use client"` portability is lost; components need `.astro` wrappers or a `client:` directive at each use. Budgets and determinism become CI bolt-ons subject to upstream drift.
- Open question this option lives or dies on: the hash-stability result.

### C. Hybrid: build the framework, adopt Astro's island conventions wholesale

Keep the spec but replace §8's invented machinery with Astro's proven decisions verbatim where the prototype confirmed them (children observation, `role="presentation"` wrapper, opaque slots, template stash), and keep the parts Astro cannot do (directive-derived boundaries, mid-tree server-build wrapping, fold promotion).

- This is close to what decision 23 already recorded. It is option A with humility: treat Astro's source as prior art to copy from (patterns, not code), not a competitor to out-design.

## What would change my recommendation

- Hash test says Astro output is byte-stable and localized: option B gets much stronger, because the deploy layer works as a thin external tool.
- Hash test says unstable or cascading: option B's deploy story needs upstream Astro work, and A/C stand.
- The dogfood site's real numbers matter more than any of this: if its pages average 2 islands and 50 locales, the incremental-deploy edge dominates; if it is 500 pages, Astro full builds are fine and the whole scale argument evaporates.

## Astro output-hash stability (measured 2026-08-23)

Astro 7.2.4, 32-page fixture, 10 React islands, sharp images, 51 builds. Data in `.scratch/hash-stability/`.

- No-change rebuilds are byte-stable. 6 cold builds (cache wiped each time) and 5 warm builds all produced identical manifests, 42/42 files. The asset-hash nondeterminism fixed in Astro PR #17616 did not reproduce once.
- Blast radius is ideal. A one-word content edit changed exactly 1 of 38 files, that page's HTML. A one-string island edit changed the 5 pages using it plus the renamed chunk; the other island's pages, react chunks and CSS survived byte-identical. `<astro-island>` uids and props are stable across every build.
- The incremental cache restores byte-identical output. Deleting `dist/` and rebuilding restored all 30 cached pages identical to a fresh render.
- One blocking bug: under `experimental.incrementalBuild`, a CSS-only edit renames the stylesheet but does not invalidate cached pages. 30 of 32 pages shipped a dangling stylesheet link, and warm rebuilds never heal it. A manifest-diff deploy would faithfully upload an unstyled site. JSX and image edits invalidate correctly; the gap is CSS-specific. Workaround: fail the deploy if any emitted HTML references an `/_astro/` file absent from `dist/`. Cheap, one pass.
- One design limit: `cacheKey` is useless for content imported through the module graph. Editing one entry in an imported JSON file invalidated all 30 paths. It only helps when content arrives outside the graph, a fetch or store call at build time. Our SQLite store queries would qualify; a JSON-file content setup would not.

So: manifest-diff deploy on plain Astro works today. On incremental Astro it needs the dangling-ref gate.

## Recommendation

Sequence the work so the contested layer is decided last, with real numbers.

1. Build the content layer, usage ranking and diff-deploy CLI now (milestones Content layer and Deploy & incremental). Every option needs them. The diff-deploy tool proved viable against Astro output too, so this work is not stranded even if we later adopt.
2. Hold the islands milestone (#65, #16, #67). It is the layer Astro already owns, and the #68 prototype showed we would be re-deriving their answers.
3. Decide islands at dogfood time with two numbers we do not have yet: the dogfood site's real page count and locale fan-out, and a measured Astro build of that same content. If the site is thousands of pages across many locales and sub-30s incremental deploys matter commercially, option C, build the islands layer, copying Astro's conventions where decision 23 already recorded them. If it is hundreds of pages, option B, Astro plus our integrations, and the spec's §8 becomes a design note instead of a deliverable.

What this costs: the `"use client"` portability bet stays unresolved until the islands decision. What it buys: no more evenings spent rebuilding solved problems before we know the scale that justifies it.
