# Scaling verification

Spec §16's design targets, measured. Issue #60.

Decision 24 relaxed these numbers from gates to design targets — the
maintainer's constraint is "reasonable build times", not a figure — so nothing
here fails a build. A large miss files a finding issue with its profiling data,
and three did: #263, #264, #265.

Reproduce with `pnpm bench:scaling`, which builds first and then climbs. The
harness is `packages/bench`, which generates a synthetic site of a requested size
and spawns `pagedeck sync` and `pagedeck build` as real processes.

## The targets

| Target | §16 |
| --- | --- |
| Full build | 50,000 pages, all locales summed, on the order of 10 min on a standard CI runner |
| Incremental | Content build on the order of 30 s end-to-end |
| Store | 200 k+ entries, proven feasible in prior art (compressed blobs) |

## What was measured

Four-core box, 15.4 GiB, Node v24.18.1, Linux. Two locales, a third of pages
carrying an island. Every rung's manifest row count was asserted equal to what
the generator wrote, so a number here is never a count of pages the build
silently dropped.

| pages | islanded | sync s | build s | ms/page | peak RSS MiB | store MiB | gzip MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 32 | 0.20 | 2.02 | 20.2 | 399.2 | 0.3 | 0.0 |
| 500 | 166 | 0.62 | 2.57 | 5.1 | 429.4 | 1.2 | 0.2 |
| 2,000 | 666 | 0.97 | 4.06 | 2.0 | 489.5 | 4.8 | 0.8 |
| 8,000 | 2,666 | 8.08 | 10.57 | 1.3 | 989.2 | 19.3 | 3.0 |
| 32,000 | 10,666 | 109.52 | 33.69 | 1.1 | 2,329.4 | 77.1 | 12.1 |
| **50,000** | 16,666 | **269.85** | **49.36** | **1.0** | **2,744.7** | **120.5** | **19.0** |

The 50,000-page row is a measurement, not an extrapolation. It is outside the
default ladder because it exceeds the harness's 180 s per-rung guard; run it with
`pnpm bench:scaling --pages 50000`.

The corpus these figures are of matters for the two byte columns and for nothing
else. Each page carries about 2.5 kB of prose drawn from a thousand-word
vocabulary, and each locale gets its own text rather than a copy of the first
one's (`packages/bench/src/generate.ts`). An earlier corpus drew from ten words
and wrote every locale identical bytes; it reported an 18x gzip ratio, which was
a fact about that generator. The clocks are unchanged by the swap — nothing in
the render path caches on content.

## Full build: the target is met with room to spare

**A cold 50,000-page build is 319 s end to end — `pagedeck sync` at 269.85 s plus
`pagedeck build` at 49.36 s — against a target of 10 minutes.** Rendering alone is the
49 s; the sync in front of it is 85% of the wall clock, and the section below is
about that.

Per-page render cost is flat. The falling `ms/page` column is a fixed ~2.7 s of
start-up amortising over more pages, not a build that gets cheaper per unit of
work. Marginal cost is 1.085 ms/page across 2,000 → 8,000, 0.963 across
8,000 → 32,000 and 0.871 across 32,000 → 50,000; a least-squares line through the
four rungs from 2,000 up is 0.943 ms/page plus 2.73 s fixed. Linear, over a
500-fold range of scales.

For context, `docs/research/2026-08-23-astro-incremental-builds.md:182-193`
records Astro 7 building aspire.dev's 13,275 pages in 326.11 s — 24.6 ms/page,
which that document extrapolates to roughly 20 minutes at 50,000 pages. Against
this build's 1.0 ms/page that is about **25× cheaper per page**.

**That comparison is not like-for-like, and the issue asked for it anyway.**
aspire.dev is real MDX documentation: Markdown parsed, code highlighted, a
component library and a content layer per page, on hardware and a Node version
nobody here can see. A rung of this ladder is a generated page of four
registered components rendered from a JSON entry, on the four-core box named
above. So 25× is the order of magnitude between a synthetic page here and a real
page there, and it is quotable as that and as nothing narrower. The honest use
of it is the one this document makes: at the same order of scale, rendering is
not where this framework's build time goes.

Memory is the constraint worth watching rather than the clock. Peak RSS grows
roughly linearly at ~0.047 MiB/page above 2,000 pages, reaching 2.7 GiB at
50,000. That is a direct consequence of a deliberate decision —
`packages/core/src/build.ts` stages the whole site in memory and writes at the
end, because #27's deploy diff needs an all-or-nothing write — so it is a known
trade rather than a defect. At 50,000 pages it is comfortable on a 16 GiB runner.
It is the number that would decide a materially larger site, and the clock is
not.

## Sync as #263 found it: the target is met, and this was the half that would not scale

**Sync costs 269.85 s at 50,000 pages — 5.5× the build it precedes.**

End to end, sync plus build is 319 s, still inside the 10-minute target. But
sync grows faster than the page count, and the rate at which it does is itself
rising:

| interval | sync s → sync s | ratio | pages ratio | implied exponent |
| --- | ---: | ---: | ---: | ---: |
| 500 → 2,000 | 0.62 → 0.97 | 1.55× | 4× | 0.32 |
| 2,000 → 8,000 | 0.97 → 8.08 | 8.33× | 4× | 1.53 |
| 8,000 → 32,000 | 8.08 → 109.52 | 13.56× | 4× | 1.88 |
| 32,000 → 50,000 | 109.52 → 269.85 | 2.46× | 1.56× | 2.02 |

These are per-interval ratios, not a fit. A single exponent over the whole set
would be a fiction of the same kind this document is correcting elsewhere: a
log-log least-squares line through the sync rungs comes out at about 1.3, which
describes none of the intervals, because the small rungs are dominated by a
fixed start-up cost that has nothing to do with the growth. What the intervals
say is the finding: the exponent climbs toward 2 as the fixed cost stops
mattering, and the top two intervals — the only ones at a scale the target cares
about — are 1.88 and 2.02. Quadratic, in other words, once the collection is
large.

This is filed as **#263**, with the cause attributed rather than guessed:
`clearUsage` deletes from `usage_records` on a predicate that omits the primary
key's leading column, so `EXPLAIN QUERY PLAN` reports `SCAN`, and it runs once
per entry over a table that grows with the collection. A scan per entry over a
table linear in the collection is exactly a quadratic.

It matters beyond this issue because §16 also targets a store of 200 k+ entries.
Carrying the measured top interval's exponent of 2.02 forward from the 50,000
rung puts a 200 k sync at roughly **75 minutes**. That is an extrapolation from
one interval and it is labelled as one; what is not an extrapolation is that the
cost per entry is still rising at the largest scale measured.

**#263 has since been fixed, and the section below is the measurement of it.**
Everything above this line is the state the finding was filed against. No figure
in it has been rewritten, because a before is only worth having if it stays a
before; the heading is in the past tense because a heading is a claim rather
than a measurement, and that one stopped being true.

## Sync after #263: one index, and the curve it bent

`clearUsage` deleted from `usage_records` on `(collection, locale, path)` while
the table's primary key led with `component`, so the key could not serve the
predicate and SQLite scanned. `writeUsage` runs that delete once per entry, over
a table that grows with the collection, which is where the quadratic came from.
`SCHEMA` now carries a `usage_by_entry` index on the three columns the predicate
actually names, and `EXPLAIN QUERY PLAN` reports `SEARCH usage_records USING
INDEX usage_by_entry` where it used to report `SCAN usage_records`.

That the plan changed is not the claim. The claim is the curve, so the
`8,000 → 32,000` interval — the cheapest rung pair at a scale the target cares
about — was re-measured on the same box, in the same session, immediately before
and immediately after the one-line schema change:

| pages | sync s before | sync s after | sync speed-up |
| ---: | ---: | ---: | ---: |
| 8,000 | 13.20 | 2.39 | 5.5× |
| 32,000 | 117.28 | 7.25 | 16.2× |

| interval | ratio | pages ratio | implied exponent |
| --- | ---: | ---: | ---: |
| 8,000 → 32,000, before | 8.88× | 4× | 1.58 |
| 8,000 → 32,000, after | 3.03× | 4× | **0.80** |

(The 5.5× in that first table is a speed-up. The 5.5× in the section above is a
ratio of sync cost to build cost. Same number, unrelated quantities.)

**The before column is a weaker baseline than the ladder's own, and that is
stated rather than smoothed.** The original ladder measured this interval at an
implied exponent of 1.88; re-measured today it came out at 1.58, because the box
was busier — the same `before` run's 8,000-page build took 26.97 s against the
ladder's 10.57 s. So the exponent fell 1.58 → 0.80 here, not 1.88 → 0.80, and
the smaller of the two deltas is the one this pair supports. What is not
sensitive to the box is the 16.2× drop at 32,000, which no amount of ambient
load explains.

**Both runs are from this session and neither matches the table above, which is
the point of pairing them.** A before taken from a document and an after taken
from a machine would have compared two boxes and called it a fix. These two rows
come from the same box, minutes apart, with one line of schema between them.

The `build s` column moved in both directions across the pair (26.97 → 14.16 at
8,000, 40.64 → 50.63 at 32,000) and is noise: the change is to a write path sync
owns, and nothing in it runs during a build.

### 0.80 is not evidence of sub-linearity, and a third rung is

Two rungs cannot distinguish a fixed cost from a growth term — a straight line
through two points fits by construction — so the 0.80 above says only that the
interval stopped rising. A third rung is what makes the shape readable, and one
was measured on the same code:

| pages | sync s after | marginal cost over the previous rung |
| ---: | ---: | ---: |
| 2,000 | 1.19 | — |
| 8,000 | 2.39 | 0.200 ms/page |
| 32,000 | 7.25 | 0.203 ms/page |

Marginal cost is flat to within 1.3% across a sixteen-fold change in scale, on
about 0.79 s of fixed cost — the same shape, and the same reading, as the build's
own "0.943 ms/page plus 2.73 s fixed" above. That is what makes the sub-linear
exponent a statement about start-up being amortised rather than about sync
getting cheaper per entry, and it is measured rather than argued.

The 2,000-page rung is from its own run rather than from the pair, so it is
evidence about the *after* curve's shape and not part of the before/after
comparison.

### What the index costs

It is a second structure to maintain on every usage write, and `content.db` is a
snapshot artifact that gets pushed and pulled (#76, #118), so the index travels
with it. Both halves of that cost were measured rather than waved at, off the
same pair of runs:

| pages | store MiB before | store MiB after | gzip MiB before | gzip MiB after |
| ---: | ---: | ---: | ---: | ---: |
| 8,000 | 19.3 | 19.9 | 3.0 | 3.2 |
| 32,000 | 77.1 | 79.6 | 12.1 | 12.7 |

That is 3.1% and 3.2% on disk, and 6.7% and 5.0% compressed — the compressed
figures being the noisier pair because they are the smaller numbers, rounded to
a tenth of a MiB. Call it three percent on disk and five to seven compressed.
The write cost is inside the sync figures above, which fell by an order of
magnitude while paying it.

The two `before` byte columns are identical to the ladder's own, unlike every
clock in this section. That is not a copied row: the generator writes the same
corpus for a given rung every time, and the store is a deterministic function of
it, so the bytes reproduce exactly while the seconds do not.

**An existing store file acquires the index without a migration**, and this is
tested rather than argued: `store.test.ts` builds a `usage_records` table with
no `usage_by_entry` index, confirms the delete predicate scans on that file,
then opens it writable and confirms it searches. `openStore` runs `SCHEMA` on
every writable open and every statement in it is `IF NOT EXISTS`, which is the
same retrofit mechanism the `image_colors` table relies on, and it is why this
needed no migration step.

## Incremental: the halves, measured before there was a whole

The §16 target is an end-to-end incremental content build on the order of 30 s.
**The run recorded below could not measure it.** No build path called
`planIncremental` at the time: it was a pure planner, and no incremental writer
existed.

The harness reported that in as many words rather than timing a substitute and
presenting it as the figure. What it did measure is a floor:

| pages | `pagedeck sync --incremental` s | `planIncremental` s |
| ---: | ---: | ---: |
| 32,000 | 0.80 | 0.19 |
| 50,000 | 1.13 | 0.24 |

Both are real: the sync follows a genuine edit to one entry, and the plan runs
over that rung's own manifest and dependency graph. Together they say the
planning half of an incremental build costs under 1.5 s at 50,000 pages, which
left the 30 s target almost entirely to a writer that did not exist.

**#281 built that writer**, and the harness now spawns `pagedeck build --incremental`
after the sync, against the tree the rung's full build left — one process, the
whole target, in a new `inc build s` column. **The two figures above are not
superseded by a measurement; they are superseded by a harness that can take
one.** This page still records what that run found, because every other table
here is the same run and a page mixing two runs' numbers is a page whose rows
cannot be compared. Re-running `pnpm bench:scaling` fills the column, and that
run is what should replace this section.

## Store: 200 k entries look feasible

At 50,000 entries the store is **120.5 MiB on disk and 19.0 MiB gzipped**, a
6.3× compression ratio. Both figures are read from one snapshot of `content.db`,
taken after the full sync and before the harness edits an entry.

Size is linear in entries across every rung — 2,525 bytes per page from 2,000
pages up, within 1% at every rung — and the compression ratio is flat at 6.3×
to 6.5×. So 200 k entries of this corpus extrapolate to roughly 480 MiB raw and
76 MiB compressed.

Both numbers are properties of the content as much as of the store: 2.5 kB of
prose per entry is the ladder's page, and a site of one-line entries or of long
Markdown documents would divide or multiply them. What survives the choice of
corpus is that the store costs a constant per entry and that gzip pays for
itself.

Nothing about those figures is alarming, and §16's target is explicitly about
feasibility ("proven feasible in prior art (compressed blobs)"). The constraint
at 200 k is not the store's size. It is the sync time above.

## Findings filed

- **#263** — `pagedeck sync` is quadratic in a collection's entry count. The headline
  result: at 50,000 pages sync costs 5.5× the whole build, and it is what stands
  between this framework and §16's 200 k-entry store target. **Fixed**, by the
  `usage_by_entry` index; the before/after measurement is the section above.
  The 200 k extrapolation this finding carried does not survive the fix and has
  not been replaced with a new one, because no rung above 32,000 has been
  re-measured since.
- **#264** — one entry chunk per islanded page, so output file count scales with
  content volume rather than with code. 42,668 files at 32,000 pages, 66,668 at
  50,000. Cheap now; it sets deploy-diff and upload cost once #57 exists.
  **Fixed**, by naming each generated entry after a hash of its text, so pages
  with identical entry text share one chunk. Every islanded page of the
  synthetic site islands the same set, so the 32,000-page rung is expected to
  emit 1 entry chunk rather than 10,666, and about 32,000 files rather than
  42,668. Expected, not measured: no rung has been re-run since the fix.
- **#265** — §16 said rendering "runs as a parallel pure function across workers
  from day one" and the code renders sequentially by decision. The deferral
  named "#40's worker pool", but #40 is *Per-locale sitemaps* and no worker-pool
  issue existed; it named **#351**, which ruled on 2026-09-06 that the sentence
  was the thing to fix and softened §16 to describe the decision the code makes.
  **Resolved** — the sequential decision stands unchanged, and these
  measurements are why: rendering is ~1 ms/page and linear, so it is not the
  bottleneck at any scale measured here. Rendering is most of the build's own
  clock at 50,000 pages; what makes it the cheap half is the sync before it,
  at 5.5x the build.
