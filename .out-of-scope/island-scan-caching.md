# Caching the island scan

The island scan runs a bundler pass of its own on every build, and that pass is
not cached. This was proposed as an optimisation and rejected on the
measurement.

## Why this is out of scope

The scan's cost was assumed rather than known when it was raised. Measured at
this repo's largest component set — the design system's emitted module map,
four consecutive runs in one process:

| run | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| ms | 58 | 42 | 27 | 24 |

Seven modules in the map, fifteen parsed, six of them React — `ssr.noExternal`
pulls React in, and React is one package.

The important property is not the size of the number but what it does not
depend on. **The cost is a function of the module map, not of the corpus**: the
site's registered components plus their transitive imports. Doubling the
content changes it by nothing; the render corpus and the page count never enter
it. So the framing that first motivated this — a second walk over the whole
dependency graph, threatening the "a 3-page copy tweak deploys in seconds"
ambition — is true of the *component* graph only, and amounts to a fixed
~25–60ms term.

Against that, a cache has to key on every module the scan's graph reached, not
just the map's own specifiers, or an edit to a transitively imported module
goes unnoticed and the build emits stale island facts. That is an invalidation
bug that produces a wrong page rather than a slow one.

The bar was set on the issue itself, before the number existed:

> optimising an uncosted pass is how caches get added that are never worth
> their invalidation bugs

The number is now in, and it does not clear that bar.

## What would reopen it

Two things, either alone:

- **A real site's module map grows an order of magnitude.** The figure scales
  with registered components and their imports, so a site with hundreds of them
  is a different measurement, not the same one scaled.
- **`build --incremental` lands. — Met by #308, re-measured by #385, and the
  bar still stands.** Today this term sits inside a full build and is lost in
  the noise. Once a copy tweak can skip the renders, a fixed ~25–60ms bundler
  start-up becomes the floor on that deploy, and the same number reads
  differently against a second-scale target than against a minute-scale one.
  The condition is written in the present tense it was set in, because a
  condition is a claim about what would settle the question and that one still
  reads correctly; what changed is that it has now been answered, and the
  section below is the answer.

Neither is a reason to build the cache now. Both are reasons to re-measure
rather than to re-argue.

## Caveats on the measurement

Stated so a later reader can judge it rather than inherit it: one 4-core box;
the figure excludes bundler module-load time the client build already pays; and
the graph-count probe did not pin the production environment, so it parsed both
React CJS builds where the real scan pins one.

## Re-measured inside `pagedeck build --incremental` (#385)

The second reopen condition asked what the term reads as against a deploy
rather than against a full build. **It is 3–4% of one, and the condition's
premise did not survive contact with the verb.**

`pnpm bench:island-scan` (`packages/design-system/src/island-scan.harness.ts`)
is the run, and it is re-runnable. A site is written, synced and built whole;
then one entry's copy is rewritten at a higher `rev`, `pagedeck sync --incremental`
replays that entry, and `pagedeck build --incremental` merges into the tree the full
build left. Every run below reported `incremental: 1 of N pages rendered`, which
the harness records per run and now refuses to proceed without: a run that
skipped no renders is a measurement of something else, and a run that
re-rendered pages the tweak never touched is one the report's single
"N of M pages rendered" line would label as a copy tweak without being one.

The clock is inside the real process. `island-scan-probe.harness.ts` replaces
`island-facts.js` through `module.registerHooks` with a shim that re-exports it
behind a timer, so what is timed is the shipped `dist` called by the shipped
`bin.js`, and nothing in the executable knows.

**The target is this workspace's largest module map, re-derived rather than
inherited.** It is `@pagedeck/design-system`'s whole catalog: **eight rows today**,
not the seven above. No site declares more — `packages/site` declares six of
these eight, `packages/docs` and `packages/landing` three each, and
`packages/bench`'s generated site four — so a site declaring every row costs
the scan the most a site in this repository can.

| site | probed runs | scan ms, min/median/max | `pagedeck build --incremental` ms, min/median/max | deploy ms, median | scan ÷ build | scan ÷ deploy |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| 24 pages, 2 locales | 10 | 64.2 / 94.6 / 135.2 | 1876 / 2378 / 3648 | 2604 | 3.98% | 3.63% |
| 24 pages, 2 locales, again | 10 | 62.6 / 69.9 / 108.3 | 1876 / 2023 / 3769 | 2212 | 3.45% | 3.16% |
| 6 pages, 1 locale | 10 | 64.5 / 75.4 / 111.4 | 1904 / 2145 / 2885 | 2470 | 3.52% | 3.05% |
| 240 pages, 2 locales | 6 | 66.0 / 68.7 / 89.6 | 1993 / 2030 / 2432 | 2213 | 3.39% | 3.11% |

Thirty-six probed incremental builds across four harness runs, each paired with
an unprobed one. "Deploy" is both incremental verbs — the sync that replays the
edit and the build that merges it — because the condition weighs the term
against something a person runs rather than against one verb of it. The upload
is outside it: #27's diff decides that from file hashes a copy tweak barely
moves.

**The premise that did not hold is that the deploy would shrink.** It does not:
at six pages, at twenty-four and at two hundred and forty, the incremental
build's median lands between 2.0 s and 2.4 s and its floor never drops below
1.88 s, so the page count barely moves it.
The reason is ADR-0007's: an incremental run hands `planEntries`
every page of the route table, so the client build stays a full-graph pass and
re-emits every chunk, which spec §11 requires of "any incremental JS emission".
So there is no second-scale deploy for a fixed ~70 ms term to be the floor on.
A cache would remove 3–4% of a deploy whose shape is set by a bundler pass
nobody proposes to cache.

**The term is also not the one this page recorded, and it is bigger.** The
original 58/42/27/24 were four consecutive calls in one process, and a build
makes one call, cold: the in-build figure is 63–135 ms, so ~25–60 ms was the
warm tail of that sequence rather than what a build pays. **The warm tail is not
the whole of the difference, and nothing here says how much of it is.** The
third caveat below is the other half of the same gap: the scan is the build's
first bundler invocation and is charged whatever the bundler initialises lazily,
which a second, third and fourth call in one process had already paid for. Read
the two together rather than the sentence above alone.

**And it is barely a function of the map at these sizes.** Five incremental
builds of `packages/landing`, whose map is three rows, measured 72.7–75.8 ms —
inside the eight-row site's own spread. **That reading is not one the harness
takes.** `pnpm bench:island-scan` takes `--pages`, `--locales` and `--runs` and
always generates its own site, so it has no way to be pointed at a checked-in
one: the landing figure was taken outside it, by installing the same `--import`
probe on a `pagedeck build --incremental` of `packages/landing`, and re-deriving it
means doing that again rather than re-running the harness. What the figure is
mostly made of at this scale is the bundler invocation and React, not the site's
components, which is worth knowing before the *first* reopen condition is read:
an order of magnitude more components is still the measurement to take, and it
is a different one from this.

The bar is unchanged and this does not clear it. An invalidation bug that keyed
on the map's own specifiers and missed a transitively imported module would
ship a wrong page; what it would buy back is 3–4% of a deploy.

### Caveats on this measurement

Stated on the same terms as the ones above, and one of those is retired rather
than repeated.

- One 4-core box, Node v24.18.1, Linux. The figure above also states one
  4-core box; nothing on this page proves the two were the same machine, and
  reading the old number against the new one assumes it. **Run-to-run variance
  is wide**: inside a single run an incremental build's maximum reached twice
  its minimum, which is why every row carries its extremes and every share is
  taken off medians.
- The figure still excludes bundler module-load time. `bundler.ts` imports Vite
  statically, so the toolchain is loaded when `build.js` is imported, before
  this clock starts — and the client build downstream of the scan does not pay
  it either.
- **New, and the largest unquantified term here: the scan is the build's first
  bundler invocation**, so whatever the bundler initialises lazily on first use
  is charged to this figure. A cache would not return the whole of it; the
  client build would then be the pass that pays that part. Nothing here
  separates the two.
- **New: the generated site is leaner than a checked-in one.** It declares no
  CSS toolkit, no fonts, no social images and no favicon, so its deploy is
  smaller than `packages/site`'s would be — which makes the reported *share* an
  upper bound rather than a midpoint.
- **New: the clock is a loader hook and not the shipped verb.** Half of every
  run's incremental builds ran without it, and the probed and unprobed medians
  differ by less than the run-to-run spread (2378 against 2192 ms in the first
  row, 2023 against 2014 in the second), so the hook is not what these numbers
  are of.
- **Retired: the production environment is pinned.** The old graph-count probe
  parsed both React CJS builds because it did not pin one; this reading is of
  the real `scanIslandFacts`, which runs under `inProductionEnv`, so one is
  parsed. The parsed-module *count* was not re-taken — the probe times the call
  and does not read the graph — so "fifteen parsed" above stands as the original
  reading at seven rows and is not restated for eight.

## Prior requests

- #170: "The island scan pays a second uncached SSR bundler pass on every build"
