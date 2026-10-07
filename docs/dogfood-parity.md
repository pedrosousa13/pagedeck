# Dogfood site: the parity harness

Issue #58 asks that the framework's build be compared against the site it
replaces, that the comparison cover a real set of pages rather than one fixture,
that expected differences be separated from defects, and that it all run locally
and in CI with no live account. This is what was built, what it proves, and what
it does not.

`docs/dogfood-spot-check.md` is the manual half of the same question. The two
are one procedure: that file is a person looking at two tabs, this one is a
program comparing two documents, and both are bounded by the same fact — there
is no production twin of `packages/site` reachable from this repository.

## The design

**One extractor, two sources.** `pageFacts` in `packages/site/src/parity.ts` is
the only thing in the repository that turns a document into comparable facts.
`packages/site/src/parity-read.ts` feeds it from two places: the build's own
output on disk, read off `manifest.json`, and an origin over HTTP. Neither side
has a reader of its own.

That is the load-bearing property. Two hand-written readers that agree today are
two readers free to disagree tomorrow, and the disagreement would be reported as
a difference between the *sites* — a defect the harness invented, in the one
report whose whole job is to be trusted about defects.

**Parsed, never pattern-matched.** The extractor uses jsdom. A regular
expression over the markup cannot tell an address the document has from a string
inside a script that looks like one, and `packages/site/src/site.build.test.ts`
records what that costs: the parked branch's regexes matched the broken doubled
`/assets/assets/…` form and the build shipped it.

**What is compared** is what a reader would compare: the `lang`, the `<title>`,
the description, the canonical, the `hreflang` set, the heading outline, the
internal `href`s and the visible text.

**Text either side of a comment joins as written** (#331). React writes
`<!-- -->` between two adjacent text expressions, so `visibleText` adds a space
only at an element boundary: `#<!-- -->docs` reads as `#docs`, as a reader sees
it, and not as `# docs`.

**What is not compared, and why:**

- **Attribute order and whitespace.** `docs/dogfood-spot-check.md` already rules
  that byte differences from another renderer mean nothing. This is that rule
  compiled into a field list.
- **Class names.** They derive from code, not content (spec §9), so two
  implementations of one site have no reason to agree on them.
- **Script and style bytes.** `docs/research/2026-08-23-app-router-static-export.md`
  measured what a Next.js App Router static export emits: six `<script>` tags
  and 11,051 bytes of inlined RSC flight payload against 6,023 bytes of markup,
  with no supported configuration that emits a page without them. A script tag
  the twin ships and this build does not is the *point* of the framework.
  Comparing scripts would report the product's central claim as its largest
  defect, page after page.

**Coverage is enforced, not reported.** `compareParity` refuses a comparison
whose accounting does not add up: a baseline with no pages, or a URL on either
side accounted for other than exactly once. This is the assertion that stands
between the harness and "no differences because it compared almost nothing" —
the failure mode issue #58 exists to prevent, and the one a green report cannot
otherwise be told apart from.

**No expectation rule reaches a coverage failure.** A rule explains a difference
between two things that were both compared — two pages that disagree about a
title, two redirects that disagree about a target. What one side has and the
other does not goes straight to the defects: a baseline URL the build does not
serve, a URL only the build serves, a redirect the build dropped, a redirect
nobody declared. `status` and `redirect` are both fields a rule can name, so one
site-wide rule on either would otherwise have filed every missing page, or every
dropped redirect, as expected and printed a report with nothing in it — the one
way round the paragraph above. A dropped redirect is the production URL that now
404s, which is the difference these rules exist to hold.

**A rule excuses a field whole, or only the values it names inside one
(#545).** A rule is a `field`, an optional `url` (absent, it covers every
page) and a required `why`. With nothing more, it excuses every difference in
that field. With `baselineOnly` or `builtOnly`, it excuses only the values it
names, on the side it names them, and whatever else differs in the field is
still a defect, reported as what is left of each side:

| Field | A value is |
| --- | --- |
| `internalHrefs` | one href, as the page writes it |
| `headings` | one heading, written `h<level> <text>`, such as `h1 Home` |
| `text`, `title`, `metaDescription`, `canonical`, `lang` | a span of whole words, so `min read` does not match inside `5 min reading`, and a whole canonical is one span |

A value excuses one occurrence where its side carries it more often than the
other: present on one side and absent on the other, or once more on one side.
The first occurrence is the one taken out. If that is not the one that
differs, the rest of the field still differs and is reported, so a wrong guess
costs a defect and never an excuse. `status`, `alternates` and `redirect` take
no values: `compareParity` refuses a rule that names any, so no rule shape
reaches a coverage failure. Nothing normalizes a value on the way: a trailing
slash is excused by a rule that names both spellings, or it is a defect. A
rule whose `baselineOnly` and `builtOnly` name nothing is refused too: it would
excuse nothing, and with no value left unused it would never be reported stale.

**A rule that excuses nothing fails the run.** The report's `stale` lists every
rule, or the part of one, that matched no difference: a whole-field rule as
written, and a rule that names values with only the values that excused
nothing on any page. `parity.bin` prints them under `stale rules` and exits
non-zero, as it does on a defect. A rule left over from a fixed difference
would otherwise go on excusing whatever arrives in its place.

## Declared and captured: what each one proves

A parity baseline carries its origin, and the origin is a union of two kinds
because the two are not interchangeable.

| | **declared** | **captured** |
| --- | --- | --- |
| Where it comes from | written by hand in this repository | recorded from an origin that serves the site |
| What a green run proves | the build matches the site's *stated intent* | the build matches what that origin served, at that instant |
| Evidence of parity with production? | **no** | yes, for the origin named in the report |

`ParityReport.baselineOrigin` carries the kind, and the runnable prints it as
the report's **first line**, before any count and before any verdict. A report
that did not say where its baseline came from is exactly the report this issue
exists to prevent.

The declared baseline for this site is `packages/site/src/parity-baseline.ts`.
Its facts are written from the site's own entries (`packages/site/src/content.ts`)
and from what the design system's components render — never dumped out of a build. A baseline generated from
`pagedeck build`'s output would agree with that build by construction, on every field,
forever: a snapshot test wearing a parity harness's name. Its *URL set* is the
one thing derived from a real build's `manifest.json`, because a URL is a
decision `definePages` makes out of the locale map and the slug, and guessing at
one is how #161 happened.

## The pages it covers

The set is `docs/dogfood-spot-check.md`'s representative set, fixed rather than
sampled, because it is the set the framework's claims differ on:

| URL | What it is |
| --- | --- |
| `/en/` | tree-driven front page, hero and feature grid, one call to action |
| `/de/` | the second locale — the URL prefix and the `lang` attribute |
| `/en/legal/terms/` | content-only template, and the nested slug (#161's guard) |
| `/en/pricing/` | the one page with an island |

Plus the two redirects the site declares: `/en/plans/ → /en/pricing/` and
`/en/terms/ → /en/legal/terms/`, both 301. Those are read back out of the
**compiled** `@pagedeck/adapter-netlify` artifact rather than out of the site config object,
because the artifact is what a host is given — a rule that is in the config and
not in the artifact is a rule nobody serves.

## Running it

```sh
cd packages/site
node ../core/dist/bin.js sync && node ../core/dist/bin.js build

# Check the build against the declared baseline. Exits non-zero on a defect
# or on a stale rule, one that excused nothing.
node dist/parity.bin.js compare --build ./site

# Write the report as JSON, the way the CI step keeps it.
node dist/parity.bin.js compare --build ./site --report parity-report.json
```

`compare` opens a directory and nothing else, which is what makes it a CI step
that needs no account. It is one: `.github/workflows/ci.yml`'s `check` job syncs
and builds this site after the suite has run, compares it against the declared
baseline, and uploads `parity-report.json` as a build artifact whether the
comparison passed or failed — the run that fails is the one whose report is
worth opening.

`packages/site/src/parity.build.test.ts` runs the whole of it — a real
`pagedeck build`, a real capture over a real socket against a local `node:http`
origin, and a deliberately broken tree that the harness has to fail on. A harness that cannot be made to fail has not been shown to pass.

## Procedure: producing a captured baseline

**This has never been run for this site, and cannot be.** The clean-room
constraint (#53) keeps vendor code and production credentials out, so there is
no production origin to record. What follows is the procedure for a machine that
has one.

1. Check out this repository on the machine that can reach the origin. Install
   dependencies and `pnpm build`.
2. Record the origin. It is fetched over HTTPS with no credential and no
   redirect followed:

   ```sh
   cd packages/site
   node dist/parity.bin.js capture --origin https://<the-live-site> --out baseline.json
   ```

   The URL list comes from the declared baseline, not from a crawl. A crawler
   records what it could reach, and what a baseline has to record is what the
   site is supposed to have — a page missing from the origin is the finding, and
   a crawl cannot report a page it never saw. `capture` refuses rather than
   records when a URL does not answer as a baseline needs it to.
3. Build this framework's version of the site and compare against the recording:

   ```sh
   node ../core/dist/bin.js sync && node ../core/dist/bin.js build
   node dist/parity.bin.js compare --build ./site --baseline baseline.json --report report.json
   ```

4. Read the report top down. The origin line says it was captured, from where,
   and when. The coverage counts say how much of the baseline was reached. Then
   the defects.
5. For each defect, decide: it is a defect the build has to fix, or it is a
   difference somebody has established is expected. Only in the second case add
   a rule to `EXPECTATION_RULES` in `packages/site/src/parity-baseline.ts`, with
   the reason. Name the values the difference is made of rather than the whole
   field, unless every difference the field can show is expected.
   `compareParity` refuses a rule whose reason is blank — a rule with no reason
   is not a rule, it is a tolerance, and a tolerance in a parity harness is
   indistinguishable from the harness being wrong. Delete a rule once its
   difference is fixed: a rule that excuses nothing is stale, and a stale rule
   fails the run.
6. Commit `baseline.json` only if it holds no content the clean-room constraint
   keeps out of this repository. A recording of production pages is production
   content.

## What this harness does not check

- **Performance and accessibility.** Lighthouse and axe are #59's, and they run
  a browser over the built pages rather than comparing two documents:
  `docs/success-criteria.md` is the report, and it records which of spec §15's
  criteria a local origin can settle and which need real traffic.
- **Cutover, and anything after it.** That is #286's.
- **The normalizing redirect rows.** The compiled table also holds the
  trailing-slash rows core derives, and the reader drops them: a baseline full
  of rows nobody wrote is a baseline nobody reads.
  `packages/edge/src/conformance.test-support.ts` is where those are checked,
  against the emitter that mints them, for every adapter.
- **The other edge adapters.** Redirects are read back through the
  Netlify-style table because it is text rather than code.
  `packages/edge/src/conformance.test-support.ts` is where every adapter is held
  to one behaviour.
- **A production twin's own descriptions.** Every page of this site carries a
  `<meta name="description">` since #405, written by hand in
  `packages/site/src/site.ts`'s `DESCRIPTIONS` and spelled again in the
  declared baseline. That copy is this site's, not production's, so a green
  against the declared baseline says nothing about whether production describes
  its pages the same way. A captured baseline will show the difference.

  The canonical and the `hreflang` set were absent beside it until #288
  declared a `build.origin` on that site, which is what
  `packages/core/src/build.ts` composes both links from. The baseline now
  carries a real absolute URL per page, on a placeholder host under RFC 2606's
  reserved `.example`, and an `hreflang` set on the two front pages alone. `/`
  is the only path this corpus publishes in both locales, and a set of one is
  withheld. Declaring the origin did not reach the description, which is why it
  took a change of its own.
