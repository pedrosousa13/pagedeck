# Spec §15's success criteria, measured

Spec §15 states five success criteria for the dogfood site against its
production Next.js twin. Issue #59 asks for them in a report, "with measured
numbers vs the Next.js twin". This is that report: one row per criterion, each
marked met, not met or not measurable here, each carrying its measurement and
where the measurement came from.

**Three of the five are met on numbers taken here. Two cannot be settled, and
they are named rather than omitted.** When #59 wrote this report, the reason was
one fact, the same every time: there was no production, no live twin and no
third-party measurement service in reach. `docs/dogfood-parity.md` is bounded by
it, `docs/deploy-recipe.md` is bounded by it, and this file was the third. The
landing page is now live at `https://pagedeck-landing.pedrodsousa.workers.dev`
(#52, #53), and the maintainer's 2026-10-08 ruling on #2 measures criteria 4
and 5 there. The dogfood site and its twin are still not in production. A
criterion this repository cannot settle is reported unsettled, with what would
settle it.

## The verdicts

| # | Spec §15 criterion | Verdict | The number it rests on |
| --- | --- | --- | --- |
| 1 | Content-only pages: **0 kB JS** | **met** | 0 B raw, gzip and Brotli on all three content pages; the twin's floor is 452,538 B raw / 133,120 B gzip |
| 2 | Island pages: the framework's own JS at or under **6,376 B raw / 3,093 B gzip**, a ratchet (#292, gzip re-based by #547) | **met** | 6,376 B raw / 3,093 B gzip on `/en/pricing`, React set apart: at the recorded ceiling, which is today's figure. From `pnpm build && npx vitest run packages/site/src/runtime.build.test.ts` |
| 3 | Core Web Vitals better on every metric, in production (CrUX/RUM) | **not measurable here** | no production, no RUM, no CrUX — the comparison plan is below. The landing page's field data is #56 |
| 4 | Publish-to-live for a content edit **< 60 s** | **met** | 15.2 s, 16.2 s and 17.3 s from `wrangler deploy` starting to the live landing page serving the edit, three runs on 2026-10-08 (#2). The build before the deploy is not in the figure |
| 5 | **PageSpeed/Lighthouse mobile ≥ 90 with the full third-party loadout** | **not measurable here** | Lighthouse mobile performance 99 or 100 on every run over the four live landing pages (#2), but the landing page loads no third-party script, so there is no loadout for the score to survive |

Issue #59's own second criterion — an axe pass with zero serious or critical
violations — is **met**, and is reported below beside criterion 5 because the
same Lighthouse run is what qualifies it.

## How the numbers were taken

```sh
pnpm build && pnpm test:lighthouse-harness    # the Lighthouse pass and the byte counts
pnpm build && pnpm test:a11y-harness          # the axe pass
pnpm build && npx vitest run packages/site/src/runtime.build.test.ts   # criterion 2
pnpm bench:landing-publish --apply   # criterion 4: deploys the live landing page four times
pnpm bench:landing-lighthouse        # criterion 5: Lighthouse over the live landing page
```

The last two reach the live landing page, so they are run by hand and never by
CI or `pnpm test`; criteria 4 and 5 say how each is taken. Everything else in
this section is about the first three.

The third needs no browser and is in `pnpm test`; criterion 2 below says what
it measures. The first two build this site into a scratch directory with the
framework's own `pagedeck sync` and `pagedeck build`, serve the output from a `node:http`
server bound to `127.0.0.1`, and drive the Chromium Playwright pins.
The origin is local on the ruling on #57 — "if we need to test, let's test
deployments locally" — and, for this issue, because PageSpeed Insights and CrUX
are third-party services. The Lighthouse
harness writes `packages/site/.pagedeck-site-audit/lighthouse-report.json`, which is
what the figures below are quoted out of and what
`.github/workflows/lighthouse.yml` keeps as a build artifact — the byte counts,
the scores, the timings **and** the payload reductions against the twin, all
produced by the run rather than restated here.

**Run conditions**, as the report records them: Linux x64, 4 cores, Node
v24.18.1, Lighthouse 13.4.1, Chromium as pinned by `playwright@1.62.1`,
Lighthouse's default configuration — which is its **mobile** one, emulated
device and simulated throttling.

**The twin's side is cited, never re-measured**, because there is no twin here
to measure. Every figure attributed to Next.js comes from
`docs/research/2026-08-23-app-router-static-export.md`, which measured
`next@16.3.2` / `react@19.2.0` / `react-dom@19.2.0`, `output: 'export'`, default
Turbopack, `NODE_ENV=production`, Node 24.18.1, on this same four-core box, and
read the emitted `out/` byte for byte. That document's own §"What remains
unverified" is part of the citation and not a footnote to it: the measurements
are from **two small synthetic projects with no CSS, no fonts, no `next/image`
and no metadata**, so what they establish is the twin's *shape and floor* —
what an App Router static export cannot go below — and not a measurement of the
real production site. A real design system would add to those figures, never
subtract. Nothing below claims otherwise.

## 1. Content-only pages ship 0 kB of JavaScript — **met**

Measured two independent ways, on the same run, over the three content pages of
the representative set:

| URL | first-render JS off the build | script bytes the browser fetched | script requests |
| --- | ---: | ---: | ---: |
| `/de` | 0 raw / 0 gzip / 0 Brotli | 0 | 0 |
| `/en` | 0 raw / 0 gzip / 0 Brotli | 0 | 0 |
| `/en/legal/terms` | 0 raw / 0 gzip / 0 Brotli | 0 | 0 |

The left column reads `budget-report.json` — `pagedeck build`'s own record of which
chunks it charged to which page — and compresses the files it names. The right
column is Lighthouse's `resource-summary`: what Chromium actually fetched. They
are independent, and `packages/site/src/lighthouse.harness.ts` asserts that they
agree about which pages ship any JavaScript at all. A build that emitted a
`<script>` pointing at a file it had not charged to the page would satisfy the
first and fail the second.

It is also enforced rather than merely observed: `packages/site/src/site.ts`
writes `0b` as those three pages' budget, so `pagedeck build` refuses the build rather
than shipping a byte. Spec §15's phrasing is "0 kB"; the measurement is 0 B.

**The twin cannot do this in any supported configuration.** The cited research
built an App Router page with no client component anywhere in its subtree and
measured six `<script>` tags, **452,538 B raw / 133,120 B gzip**, plus a
112,594 B `noModule` chunk modern browsers skip, plus 11,051 B of inlined RSC
flight payload against 6,023 B of markup. `unstable_runtimeJS: false` is Pages
Router only and was never carried over; the request to carry it over
([vercel/next.js#45009](https://github.com/vercel/next.js/issues/45009)) is
closed unimplemented. The reduction is **100 %**, raw and gzip alike — and that
figure is `payloadReductions`' too, printed by the same run that produced the
zeros above, not an arithmetic observation made here.

## 2. The framework's own JavaScript on an island page — **met**

**The criterion changed, and this is the first verdict under its new text.**
§15 used to ask for "> 80 % JS payload reduction" on high-conversion form pages
against the twin, and this report recorded it **not met** at 56.7 % raw and
53.7 % gzip. The maintainer's ruling on #292 restated it: measure the bytes the
framework ships of its own on an island page, "everything except `react` and
`react-dom`", raw and gzip, and hold today's figure as a ratchet.
**`scheduler` counts as React here**: `react-dom`'s client renderer imports it,
and no page can ship `react-dom` without it. The criterion is met at that
recorded ceiling, since the ceiling is the figure measured when the ruling
landed. The twin comparison is kept below as recorded context. It is no longer
this criterion's verdict, and 80 % is no longer a target.

| `/en/pricing`, first render, on disk | raw | gzip -9 | Brotli |
| --- | ---: | ---: | ---: |
| the framework's own | **6,376 B** | **3,093 B** | 2,754 B |
| React (`react`, `react-dom`, `scheduler`) | 189,881 B | 58,990 B | 50,789 B |
| ceiling (`RUNTIME_CEILING`) | 6,376 B | 3,093 B | — |

**2026-09-28, #547: the gzip column is measured with content hashes
normalised.** Before this date it read 3,154 B and 58,995 B. A CSS-only change
renamed the stylesheet the entry chunk names, and the framework's gzip figure
rose by a byte with no script byte changed. The gzip figures now come from each
chunk with every hash the build emitted rewritten to a same-length placeholder,
which reads 61 B lower on the same build; the ceiling was lowered to match. The
runtime did not shrink. Raw is unchanged, and Brotli is still the file as it
is (2,754 B here against 2,773 B before is the renamed files, not the method).

```sh
pnpm build && npx vitest run packages/site/src/runtime.build.test.ts
```

That test builds this site into a scratch directory, prints the three rows
above, and fails when either figure is over its ceiling. It needs no browser.
It is a byte count off a build, so it answers the same on a loaded runner as on
an idle one. That is the reasoning of `CONTEXT.md`'s "A site audit asserts only
what is deterministic", applied by analogy: this is not a site audit and needs
no browser, so it runs in `pnpm test`. Two runs agreed to the byte.

**The page.** §15 names a class of page, and this site has no form page. The
representative set `docs/dogfood-spot-check.md` fixes has one page with an
island, `/en/pricing`, whose island is a billing toggle. It is the only page
here on which the framework ships JavaScript at all.

**The method.** Production output puts React, `react-dom`'s client renderer and
the islands runtime in one chunk, `fw-core`, so the framework's share cannot be
read off a file. The test runs the same `pagedeck build` of the same site with one
Vite plugin added. The plugin puts one more group ahead of the tier groups in
Rolldown's `codeSplitting`, and that group moves every module under
`node_modules/react/`, `node_modules/react-dom/` and `node_modules/scheduler/`
into a chunk of its own. Of the chunks `pagedeck build`'s budget report charges to the
page, that chunk is React's and the rest are the framework's: the islands
runtime, the page's entry, the billing toggle and Rolldown's interop helpers.
Each chunk is minified by the production settings. Raw is the file as it is;
gzip is the file with every content hash the build emitted in a file name
rewritten to a same-length placeholder, so a renamed stylesheet cannot move
it (`hashInsensitiveGzip` in `packages/site/src/audit.ts`). The method, in
`buildRuntimeSite` in `packages/site/src/audit-site.ts`, was chosen over two
others: Rolldown's per-module sizes are taken before minification and cannot
give a gzip figure, and a second bundle
with React externalized would restate the client build's settings in a second
place. Sourcemaps are not used (ADR-0002). The test calls no bundler itself:
`pagedeck build` reaches Rolldown through `packages/core/src/bundler.ts`.

**The split costs a little, and the framework carries it.** The measurement
build's two halves total 196,257 B raw. The production build of the same site
ships 195,823 B in its entry and `fw-core` chunks. The 434 B between them is
the cost of two chunks where production has one: an import of React's exports,
a longer preload list in the entry, and the interop helpers in a chunk of
their own. Some of it is counted as the framework's, so 6,376 B is a little
more than the framework's share of the production chunk. That is the direction
that holds the framework to more. The measurement build is never shipped.

**A ratchet, not a target.** The two ceilings are named constants,
`RUNTIME_CEILING` in `packages/site/src/audit-site.ts`, set to the figures
above. They go down when the runtime shrinks and are never raised, and that
includes a toolchain bump: a Vite or Rolldown release that pushes either figure
up is a finding to file, not something the ceiling absorbs. A React release does
not move them. The comparison
is `runtimeVerdict` in `packages/site/src/audit.ts`, and
`packages/site/src/audit.test.ts` shows one byte over either ceiling failing.

### Recorded context: the reduction against the twin

These are the figures criterion 2 used to be judged on. They are kept because
they are still true of the build they were measured on, and because they show
why the criterion was restated.

| | framework `/en/pricing` | twin, interactive page | reduction |
| --- | ---: | ---: | ---: |
| raw | 195,825 B | 452,821 B | 56.7 % |
| gzip -9 | 61,529 B | 133,120 B | 53.7 % |
| Brotli | 53,095 B | not recorded | — |

The framework's figure is the entry chunk (330 B raw / 227 B gzip / 207 B
Brotli) plus the shared `fw-core` chunk it statically imports (195,495 B /
61,302 B / 52,888 B), as a Lighthouse harness run recorded them before #264
renamed entry chunks by their content. The lazily-loaded `assets/slot-<hash>.js`
is charged to no page and is excluded, which is `packages/core/src/budgets.ts`'
definition of first-render traffic rather than a choice made here.

**Files on disk, which is why it is 365 B under the page's own budget row.**
`budget-report.json` charges this page 53,460 B, the two chunks plus the inline
consent loader in its document (#346). That loader is not a file, and the twin's
recorded numbers are file sizes, so a comparison against them has to leave it
out.

The twin's figure is the cited research's 452,538 B raw baseline plus the 283 B
chunk it measured as the entire marginal cost of one `useState` counter. **Its
gzip figure is the baseline's**, because that document records no gzip size for
the 283 B chunk — so the twin's real gzip total is 133,120 B *or a little more*,
and the 53.7 % above is therefore a **lower bound** on the reduction.

**Both percentages are computed by the run that measured the bytes**, not
entered here. `payloadReductions` in `packages/site/src/audit.ts` divides this
build's figures by `TWIN_PAYLOAD` in `packages/site/src/audit-site.ts` — where
the twin's recorded numbers are named once, with their provenance — and the
Lighthouse harness prints the result on the line under each page's byte counts:

```
  /en/pricing         195825 raw   61529 gzip   53095 brotli   −56.7% raw  −53.7% gzip
```

They are also in the report JSON as `reductions`, and
`packages/site/src/lighthouse.harness.ts` asserts that one exists for every page
of the set, so this document cannot quote a percentage the harness did not
produce. Raw is compared with raw and gzip -9 with gzip -9. Comparing the
framework's 53,095 B Brotli against the twin's 133,120 B gzip would print
60.1 %, and 6.4 points of that would be the compressor rather than the
framework. `reductionPercent` rounds **down**, so no figure here is one a
rounding rule produced.

**Why the reduction stopped at 56.7 %, and why the criterion moved rather than
the runtime.** 99.8 % of the 195,825 B this page shipped was the shared
`fw-core` chunk, and the table at the top of this section shows what that chunk
is: 189,881 B of React against 6,376 B of framework. The twin's baseline is
452 kB for the same reason in a different arrangement: React, `react-dom`, the
app-router client entry and the Turbopack runtime. Two frameworks that both ship
React to a page that hydrates differ by roughly what their runtimes differ by,
so a reduction against the twin mostly measures React's size, which this
framework does not control. The framework's own bytes are the part it does
control, and they are what criterion 2 now holds.

**Why the Lighthouse table below says 196,168 B for this same page.** That is
the *transfer* figure — the two chunks plus 343 B of response headers, over the
two of the page's three script requests that carried a body — and it is what the
script budget is asserted against, because a budget is a claim about what a
reader downloads. The third request is #212's placeholder consent manager, whose
host resolves nowhere: Lighthouse counts the request and there are no bytes to
count, as measured. Every
comparison against the twin uses the 195,825 B on-disk figure instead, because
the twin's recorded numbers are file sizes and a comparison has to be disk
against disk. Both measurements are defined in `packages/site/src/audit.ts`,
and both are in the report.

## 3. Core Web Vitals better on every metric — **not measurable here**

CrUX is Google's field dataset and RUM is real traffic. This repository has
neither and must call neither: the criterion says "measured in production", and
there is no production. **No number is offered.** What follows is the comparison
plan §15's own parenthesis asks for. The landing page is live (#53), but it
has no field data yet: its beacon and endpoint are #56,
blocked by the domain (#54).

**Metrics.** LCP, INP and CLS, which are the three Core Web Vitals as they stand
at the time of writing, plus TTFB and FCP as diagnostics — a TTFB difference is
the host's and not the framework's, and a comparison that cannot separate the
two would credit or blame the framework for a CDN.

**Sources, in this order of preference.**

1. **CrUX, per-origin and per-page**, over the 28-day rolling window, for both
   origins. It is the field data Google itself ranks on, it needs no code on the
   page, and it is the only source that can describe the twin *before* cutover —
   the twin's own history is the baseline, and after a cutover there is no twin
   left to measure. Per-page where the URL has enough traffic to be in the
   dataset and per-origin otherwise, stated per row rather than silently mixed.
2. **First-party RUM**, from the `web-vitals` beacon spec §12 describes and
   framework #48 owned; #56 now takes it for the landing page. It is what makes the comparison per page on pages CrUX cannot see, and
   it is the only source that can attribute a regression to a page rather than
   to an origin. It is not a substitute for CrUX: it measures this site's
   visitors with this site's sampling, and the twin's beacon — if it ever had
   one — measured a different population.

**When.** Not at cutover. A CrUX window is 28 days, so the first honest
comparison is **28 days after the framework build is serving 100 % of traffic**,
against the twin's last full window before cutover. Reading CrUX during a
partial rollout compares a blend to a blend. #286 owns the cutover; this is a
step after it, not part of it.

**What would falsify the claim.** Any one of LCP, INP or CLS worse at p75 on the
framework build than on the twin, on the same page or origin, over comparable
windows, with TTFB accounted for. "Better on every metric" is an `and`, and a
report that showed two of three improved and one regressed would be reporting a
**not met** — not a partial win.

**What this repository can say today, and it is not the criterion.** The local
Lighthouse pass records lab metrics under simulated mobile throttling, on a
four-core box, against a local origin. They are in the table under criterion 5.
They are lab numbers about one machine's idea of a slow phone, they say nothing
about field performance, and **nothing asserts on them** — see below.

## 4. Publish-to-live for a content edit under 60 s — **met**

**Measured on #2, on the landing page, not the dogfood site.** The
maintainer's 2026-10-08 ruling on #2 moved the measurement to the one site that
is live: `packages/landing`, served as Workers Static Assets at
`https://pagedeck-landing.pedrodsousa.workers.dev` (`docs/deploy-recipe.md`,
"The landing page on Cloudflare"). The dogfood site is still not deployed and
has no figure of its own.

**The method.** `pnpm bench:landing-publish --apply` runs
`packages/landing/src/publish-to-live.harness.ts`. Each of its three runs:

1. adds a dated probe sentence after one sentence of
   `packages/landing/content/index.md`, in place, and puts the file back in a
   `finally`;
2. runs `pagedeck sync` and `pagedeck build`, and checks that
   `site/index.html` holds the sentence;
3. starts the clock and runs `pnpm exec wrangler deploy` with
   `WRANGLER_SEND_METRICS=false`;
4. from the same instant, requests `/` no more than once a second, with no
   cache-busting query, until a response holds the sentence.

"Deploy" is the clock when wrangler exits. "First served" is the clock when
the first response holding the sentence arrives. After the three runs, the
harness builds the unedited content, deploys it, and polls until `/` is that
local build byte for byte.

**The figures**, 2026-10-08, the content of commit `ee75c45` (`main`), from
this machine (Linux x64, 4 cores, Node v24.18.1, wrangler 4.148.0):

| Run | deploy start → deploy end | deploy start → first served | requests to `/` |
| --- | ---: | ---: | ---: |
| 1 | 15,017 ms | 15,215 ms | 16 |
| 2 | 15,088 ms | 16,244 ms | 17 |
| 3 | 15,315 ms | 17,273 ms | 18 |

The deploy that put the unedited build back took 12,460 ms. `/` then served
that build byte for byte, with the ETag `"4468ecea333a7ea4779c3512ccc27afe"`,
the same one it carried before the first run.

**What the figure covers.** The edit was served 0.2 s to 2.0 s after wrangler
exited, and the poll interval is 1 s, so most of the figure is wrangler's
upload and publish. No run saw a stale copy after that, so the poll needed no
cache-busting query. The `pagedeck sync` and `pagedeck build` before the deploy
are not in the figure. Timed by hand on the same machine, they took 5.6 s for
the unedited content, twice, so an edit through build, deploy and first serve
was about 23 s. The polls came from one machine, through the Cloudflare
location that serves it. The figure says nothing about how long another
location serves the old version. Nothing asserts on these figures (#57,
#183): the harness prints them.

**What the runs exercised.** Not Pagedeck's own incremental deploy. The
landing page does not go through `deploy.bin.js` (`docs/deploy-recipe.md`), so
`pagedeck diff`, the deploy history and the one-file publish #57 measured
below play no part. Each run ran `pagedeck sync` and a full `pagedeck build`,
not `--incremental`, and then `wrangler deploy`, which hashes every asset and
uploads only those Cloudflare does not already hold. So the only thing that
skipped unchanged files was Cloudflare's hash dedupe. The verdict holds on
that path: the whole of it, from sync to the edit being served, took about
23 s, under the 60 s the criterion allows. Pagedeck's incremental path was not
measured here, so this says nothing about its speed.

### Before #2: a publish into a directory (#57)

Until #2 the verdict here was **not met**, for the reasons below.

**Carried from #57 rather than re-litigated.** `docs/deploy-recipe.md` records
the finding and the reason: "Spec §11's 'publish in under 60 s' is a figure
about a staging distribution. The build test measures the local publish and
**prints** it rather than asserting on it." There is no CDN, no bucket, no DNS
record and no credential in this repository, and no test in it makes a request
to a host the test did not start itself. A figure taken against a directory on
the same disk is not a publish-to-live time; it is a copy.

**What was measured, and why it does not settle the criterion.**
`packages/site/src/deploy.build.test.ts` builds a fixture site twice with one
page's content edited between the builds and deploys into a directory standing
in for the origin, printing what each publish cost. Run on this machine while
this report was written (`npx vitest run packages/site/src/deploy.build.test.ts`,
Linux x64 / 4 cores / Node v24.18.1):

```
[#57] first deploy published 5 files (3 of them JS/CSS) to the local origin in 36 ms
[#57] incremental deploy published 1 file to the local origin in 9 ms
```

Two reasons that is not the criterion, and the first is the one that matters.
**It is a copy between two directories on one disk.** §15's figure covers a
content edit reaching a CDN edge — an origin write, an invalidation, and
propagation — and none of those three exist here to be timed. A 9 ms local copy
says the framework's planner is not the bottleneck; it says nothing at all about
the number the criterion names. Second, the figures move run to run and no
wall-clock assertion belongs on this runner anyway, which is the same ruling
that keeps every timing figure in this report unasserted (#57, #183) — the test
prints them and asserts nothing.

The pipeline that would produce the real figure is prepared and unrun:
`.github/workflows/deploy.yml` has never deployed anything and cannot until a
maintainer supplies `PAGEDECK_SNAPSHOT_URL` and passes `apply: true`.

## 5. PageSpeed mobile ≥ 90 with the full third-party loadout — **not measurable here**

**The score half is met. The loadout half cannot be measured, because the page
has no loadout.** Measured on #2, against the live landing page, on the
maintainer's 2026-10-08 ruling.

**The method.** `pnpm bench:landing-lighthouse` runs
`packages/landing/src/lighthouse-live.harness.ts`: Lighthouse 13.4.1 in the
Chromium that `playwright@1.62.1` pins, launched as
`packages/site/src/lighthouse.harness.ts` launches it, over `/`, `/features/`,
`/interactive/` and `/server-data/` at
`https://pagedeck-landing.pedrodsousa.workers.dev`. Each page ran twice in
Lighthouse's default configuration, which is mobile, and twice in its desktop
configuration: 16 page loads, all to the Worker.

**The conditions, plainly.** It is a `workers.dev` address, not the domain
(#54). The edge cache was close to cold: the run started minutes after the
deploy that put `main`'s build back, and only the publish harness's polls of
`/` had requested that version. It ran
from this machine (Linux x64, 4 cores, Node v24.18.1) over its own network,
with Lighthouse's simulated throttling. **It is not PageSpeed Insights**: the
PageSpeed API was not called, and its servers, its network path and its CrUX
field half are not in these figures.

**The figures**, 2026-10-08, `main`'s build at commit `ee75c45`. Timings in
milliseconds; CLS is unitless.

| Page | Form | Run | Perf | A11y | BP | SEO | LCP | TBT | CLS | FCP | SI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | mobile | 1 | 100 | 100 | 100 | 100 | 1227 | 0 | 0.000 | 1227 | 1227 |
| `/` | mobile | 2 | 100 | 100 | 100 | 100 | 1235 | 0 | 0.000 | 935 | 935 |
| `/` | desktop | 1 | 100 | 100 | 100 | 100 | 353 | 0 | 0.000 | 276 | 276 |
| `/` | desktop | 2 | 100 | 100 | 100 | 100 | 357 | 0 | 0.000 | 279 | 284 |
| `/features/` | mobile | 1 | 99 | 100 | 100 | 100 | 1868 | 39 | 0.000 | 1675 | 1675 |
| `/features/` | mobile | 2 | 100 | 100 | 100 | 100 | 1541 | 0 | 0.000 | 1342 | 1342 |
| `/features/` | desktop | 1 | 100 | 100 | 100 | 100 | 432 | 0 | 0.000 | 410 | 410 |
| `/features/` | desktop | 2 | 100 | 100 | 100 | 100 | 595 | 0 | 0.000 | 462 | 462 |
| `/interactive/` | mobile | 1 | 100 | 100 | 100 | 100 | 972 | 20 | 0.000 | 972 | 972 |
| `/interactive/` | mobile | 2 | 99 | 100 | 100 | 100 | 1779 | 33 | 0.000 | 1542 | 1542 |
| `/interactive/` | desktop | 1 | 100 | 100 | 100 | 100 | 544 | 0 | 0.000 | 472 | 472 |
| `/interactive/` | desktop | 2 | 100 | 100 | 100 | 100 | 532 | 0 | 0.000 | 462 | 462 |
| `/server-data/` | mobile | 1 | 100 | 100 | 100 | 100 | 949 | 34 | 0.000 | 949 | 949 |
| `/server-data/` | mobile | 2 | 99 | 100 | 100 | 100 | 1881 | 0 | 0.000 | 1646 | 1646 |
| `/server-data/` | desktop | 1 | 100 | 100 | 100 | 100 | 527 | 0 | 0.000 | 455 | 455 |
| `/server-data/` | desktop | 2 | 100 | 100 | 100 | 100 | 410 | 0 | 0.000 | 410 | 410 |

The timings move between two runs of the same bytes: `/interactive/` on
mobile had an LCP of 972 ms, then 1,779 ms. That is why nothing asserts on
them, as below.

**The loadout.** Every request in all 16 loads went to the Worker's own
origin: the harness collects each URL in Lighthouse's `network-requests` audit
and found none on another origin. The landing page has no analytics, no tag
manager, no pixel and no consent manager, and `/features/`' embed script and
images are same-origin stand-ins by design (AGENTS.md, "The landing site").
Cloudflare adds a `NEL` header that names `a.nel.cloudflare.com` as a report
endpoint, with a `success_fraction` of 0. No load in the run sent it a report.
So a mobile performance score of 99 or 100 is what the page scores with no
third-party script at all. That is the criterion's starting condition, the
same thing the section below says of #212's placeholder sources. It does not
show that the score survives the loadout §15 names. That needs a page that
loads a real third-party set, and no site here names a vendor (`CONTEXT.md`).

### Before #2: the dogfood site on a loopback origin (#59)

Until #2 the verdict here was **not met**, for the reasons below.

**Not met twice over, and both halves have to be said.**

**PageSpeed Insights is a third-party service this work must not call.** The
issue's constraint is that nothing here reaches a live account or an external
API, and the PageSpeed and CrUX APIs are both. What ran instead is Lighthouse
locally, in its default mobile configuration, against a loopback origin. That is
**a proxy for PageSpeed and not PageSpeed**: PageSpeed Insights runs Lighthouse
on Google's infrastructure against a public URL and pairs it with CrUX field
data, and this run has neither the network path, the machine, nor the field
half.

**The loadout the criterion names does not exist.** §15 is explicit that the
score is to be taken "with the full production third-party loadout active —
analytics, tag manager, pixels, CMP banner — on default script-layer settings".
#212 has landed a script layer on `packages/site`, and the measurement below was
taken with it, but it does not close this: what it declares is **two placeholder
sources under RFC 2606's reserved `.example`**, on the one interactive page,
because a dogfood site names no vendor (`CONTEXT.md`). Neither host resolves, so
no third-party bytes are executed — and it is two scripts rather than the four
§15 lists, on overrides rather than on default script-layer settings. A ≥ 90
measured against sources that resolve nowhere is not evidence about a criterion
whose whole point is that the score survives real ones. **The number below is
not the criterion being met on a technicality; it is the criterion's starting
condition.**

With both of those said, here is what the local run measured — the scores, from
the last of the four runs whose timings are below, re-measured on #628:

| URL | performance | accessibility | best practices | SEO |
| --- | ---: | ---: | ---: | ---: |
| `/de` | 100 § | 100 ‖ | 100 † | 100 ‡ |
| `/en` | 100 § | 100 ‖ | 100 † | 100 ‡ |
| `/en/legal/terms` | 100 | 100 | 100 | 100 ‡ |
| `/en/pricing` | 96 § | 100 | 96 † | 100 ‡ |

† `best-practices` fails `errors-in-console` on `/en/pricing`, the one page
that requests a placeholder host: `consent.example` for the consent manager. It
resolves nowhere by standing decision (`CONTEXT.md`, "An example site's
third-party script sources are placeholders"), so `ERR_NAME_NOT_RESOLVED` is
that decision working rather than a defect, and the category cannot reach 100
on that page while it stands. The two front pages used to fail the same audit
over the hero's `images.example` and sat at 96 with it; since #628 the hero is
the site's own file under `packages/site/public/`, so they request no
placeholder host, and they score 100 with `/en/legal/terms`.

This column used to read 96/100/100/100 and to be asserted against nothing,
because a further console error — a 404 for `/favicon.ico`, a file the build
emitted for no site — landed on whichever page the browser loaded first in a
session, moving the score by load order rather than by anything about the page.
#297 gave `pagedeck build` a `build.favicon` field and this site an icon, and the
column above is what the harness measures with that icon in place. There is no
before column to set beside it: what a pre-#297 run reported for a given page
depended on the order that run visited them, so it is a fact about the run and
not about the page. One such run answered 96/96/100/96, which is that run's
observation and is recorded nowhere but its own report under gitignored
`.pagedeck-site-audit/`. What showed the old 96/100/100/100 column to have been stale
was the first run after #297: the placeholder hosts failed that audit on three
pages, and the icon did not touch them. What #297 changed is that the score
stopped depending on load order, which is what let
`packages/site/src/audit-site.ts` assert a floor of 96 on the category. A floor
stops a known gap getting worse while it is open and is raised when the gap
closes, so `/en/legal/terms`, which measures 100, is held only to 96.

‡ The SEO column rose by one point on every page when #288 declared
`build.origin`, putting a `<link rel="canonical">` on all four pages and the
`hreflang` set on the two front pages: 91/91/90/90 before, 92/92/91/91 after,
measured either side of that one change. #405 gave every page a hand-written
`<meta name="description">`, which closed `meta-description`, the one SEO audit
still failing on all four, and the harness then measured 100/100/100/100 on
Lighthouse 13.4.1.

‖ The accessibility column reached 100 on #296, which closed the five axe findings
that held the two tree-driven pages down. It got there in two steps that are
worth not conflating. Before #296 those pages measured **94 and 91**, not the 93
and 90 this table used to record — and #288 did not move them either, answering
94/91/100/100 both with its origin declared and without, while all five axe
findings still reproduced exactly. So a point arrived on each page from something
that was not one of these findings closing, and nothing records what. #406 is
that question. #296 does not answer it; it makes it moot for the floor, which is
a different thing — at 100 there is no slack left for an unexplained point to
hide in.

§ The performance column is the part of this table that moves between runs, and
it is asserted against nothing for exactly that reason — the standing decision
below. Two runs of the same build, minutes apart on this four-core box while
#296 was being verified, disagreed: `/en` scored **95 then 99**, its speed index
5,928 ms then 752 ms, and `/en/pricing` 99 then 98. Nothing about the site
changed between them; the machine was busier for the first. The swing is
recorded rather than tidied away — it is the concrete case the ruling below
argues from, and a timing number only ever written down on a quiet machine is
not a record of anything. The figures above are the last of the four #628 runs
below, and the performance column moved in those too: `/de` scored 99 in the
second.

**What is asserted and what is only recorded.** The Lighthouse harness asserts
the raw script-byte budgets, the script request counts, and floors of 100 on
accessibility, 96 on best practices and 100 on SEO. It asserts **nothing
timing-derived** — not the performance score, not LCP, TBT, FCP, speed index or
CLS — and
`packages/site/src/audit.ts` has no code path that can. The ruling is #57's
closing comment, on a wall-clock assertion: "a wall-clock assertion on a shared
4-core runner would manufacture exactly the flake class #183 is about". #183 is
the class where several `.build.test.ts` suites time out at 5 s under full
parallelism on this box. A red build that means "the runner was busy" trains a
reader to re-run rather than to read, and it is the audit that loses.

The lab metrics, recorded as data, in milliseconds — **four** consecutive runs
of the harness over the same unchanged build, printed together so the variance
is visible rather than described:

Re-measured on #628, the first build on which the front pages' hero loads: the
four runs before it were taken while the hero requested `images.example`, so
they measured a page whose image never arrived.

| URL | FCP | LCP | TBT | Speed Index |
| --- | ---: | ---: | ---: | ---: |
| `/de` | 912, 915, 910, 907 | 1287, 1290, 1285, 1282 | **24**, **94**, 0, 0 | 912, 915, 910, 907 |
| `/en` | 1059, 1057, 1055, 1058 | 1509, 1507, 1505, 1508 | 0, 0, 0, 0 | 1059, 1057, 1055, 1058 |
| `/en/legal/terms` | 913, 911, 904, 913 | 1213, 1211, 1204, 1213 | 0, 0, 0, 0 | 913, 911, 904, 913 |
| `/en/pricing` | 1845, 1845, 1855, **1879** | 2477, 2482, 2499, **2404** | 0, 0, 0, 0 | 1845, 1845, 1855, **1879** |

The **performance score** moved with them: `/de` scored 100, **99**, 100 and
100, on a build whose bytes did not change by one byte across all four runs.
That is the whole argument, taken here rather than borrowed. This is a quiet
machine running one thing at a time; Total Blocking Time still went 0 → 94 on
`/de`, and LCP moved 95 ms on `/en/pricing`. A shared runner under a full
`pnpm test` is where that becomes a red build meaning nothing.

**What did not move, across the same four runs**: every byte figure (0 / 0 / 0 /
195,823 on disk, 196,166 transferred, each two bytes under the figures criterion
2 quotes from an earlier build), every script request count, every
best-practices score, every accessibility score and every SEO score. That is the
line between what this audit asserts and what it records, drawn by measurement
rather than by preference.

### The axe pass — issue #59's own second criterion, **met**

`pnpm test:a11y-harness` injects axe-core into real Chromium and runs it over
every page of the representative set, after hydration. **Zero serious and zero
critical violations on all four pages**, and since #296, **nothing below serious
either**. Since #550 that is asserted rather than printed: every page is run in
the light and dark schemes, at 390 px (as a phone, with Playwright's
`isMobile`, since #568) and 1280 px, with no consent banner, with it
open and with it settled, and a violation of any impact fails the run. Since
#569 it also audits the landing template, which only a draft page renders, with
its signup form open, in both schemes at both widths, with no consent banner
only: the banner's open and settled states are not run over it. What it
used to find, recorded here because a table that once held five rows and now
holds none is the more useful record:

| URL | rule | impact | nodes | closed by |
| --- | --- | --- | ---: | --- |
| `/de` | `landmark-one-main` | moderate | 1 | #296 |
| `/de` | `region` | moderate | 1 | #296 |
| `/en` | `heading-order` | moderate | 1 | #296 |
| `/en` | `landmark-one-main` | moderate | 1 | #296 |
| `/en` | `region` | moderate | 2 | #296 |

All five were on the tree-driven pages — the hero and feature-grid composition,
which rendered no `<main>` landmark and, on `/en`, an `<h1>` followed by `<h3>`s.
The two template-driven pages were already clean. #296 gave the landmark to core,
so it is written once per document and no component writes its own, and gave
`feature_card` an `<h2>`. All four pages then measured 100, and **the
accessibility floor is 100**: the floor is a ratchet against regression, not a
claim of excellence, and this is the run that earned it.

**Two of those five were what the score was made of; the other three were never
in it.** `landmark-one-main` and `heading-order` appear in Lighthouse 13.4.1's
default config and `region` does not appear in it at all — which is the
arithmetic of the figures this table used to carry: `/de` at 94 with one scored
finding against it, `/en` at 91 with two, and the three `region` rows moving
nothing either way. It follows that the 100 floor promises less than it looks
like: it catches a regression Lighthouse scores, and `region`,
`landmark-no-duplicate-main` and `landmark-unique` are outside it — printed by
the axe harness and asserted by nobody. The landmark's singleton is held
separately, by `packages/core/src/landmark.build.test.ts` over what core emits,
and since #455 by a refusal in the build over what a site's components emit:
`documentHtml` (`packages/core/src/build.ts`) counts the landmarks in each
document it composes, `carryDocuments` beside it counts each one an incremental
run reuses, and a second `<main>` fails the build either way.

## What is filed

Every criterion above that is not met, and every gap named in passing, is filed
as a `needs-triage` issue with its measurement attached — #59's fourth
acceptance criterion. They are, in the order they appear here:

- the missing production CWV comparison, blocked on a deploy and on
  framework #48's beacon (criterion 3), and for the landing page on #56;
- publish-to-live, already carried on #57 (criterion 4), with the 36 ms / 9 ms
  local publish attached and the reason it is not the figure. #2 measured it
  on the live landing page and it is met there;
- PageSpeed with the third-party loadout, which #212's placeholder sources do
  not supply and no run here can call (criterion 5). #2 ran Lighthouse against
  the live landing page, which has no third-party loadout either.

`meta-description` on every page was on this list too, holding the SEO floor
at 91. It was filed as #405 and is **closed** by it: each page now carries a
description the site writes by hand, and the floor rose to the 100 the harness
measured. The canonical and `hreflang` absences listed beside it were closed
earlier, by #288.

The placeholder host that holds `best-practices` at 96 on `/en/pricing` is
deliberately **not** on that list, and this paragraph is where that is said
rather than a bullet that would put an unfiled item under a heading promising an
issue for each. `CONTEXT.md` rules that an example site's third-party script
sources are placeholders, so the console error is the decision working and there
is nothing to file. The hero's `images.example`, which held the two front pages
there too, is gone since #628: the image is the site's own file. What was a gap
here — the missing `/favicon.ico`, which made the category an ordering artifact
— is **closed** by #297, and closing it is what let the floor be asserted at
all.

The 56.7 % / 53.7 % payload reduction against §15's old 80 % figure was on this
list too, as criterion 2. It was filed as #292 and is **closed** by the ruling
on it, which restated the criterion as the ceiling above rather than asking the
runtime to reach 80 %.

The `landmark-one-main`, `region` and `heading-order` findings on the tree-driven
pages were on this list too. They were filed as #296 and are **closed** by it:
they held the accessibility floor at 90, and closing them took it to 100. Kept as
a sentence rather than deleted, because a list of what is filed is also the
record of what was.

## What this report is not

- **A comparison with the production site.** It is a comparison with a
  *measurement of what an App Router static export cannot go below*, taken on
  two synthetic projects. `docs/dogfood-parity.md` is bounded the same way and
  says so in the same words.
- **A performance verdict.** Nothing here measures field performance, and
  criterion 3 is the row that says so.
- **A gate.** Three of the four filed items wait on something this repository
  does not have: two on a deploy, one of those also on framework #48's RUM beacon, now #56, and
  PageSpeed with the full loadout on a service this work must not call and a
  vendor loadout it must not name. That last one is no longer waiting on a
  script layer — #212 landed one, and `packages/site` declares it against
  placeholder sources. Since #2, publish-to-live has its deploy and is met on
  the landing page, and the PageSpeed item waits only on a real loadout. The
  harnesses' assertions and
  `packages/site/src/runtime.build.test.ts` are the gate; this file is the
  record.
