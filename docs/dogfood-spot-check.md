# Dogfood site: visual spot-check

Issue #56's fourth acceptance criterion asks for a manual visual comparison of
representative pages against the production Next.js twin. This is the procedure
and the state of it.

`docs/dogfood-parity.md` is the automated half of the same question: the same
representative set, compared as data by a harness rather than by eye, and
bounded by the same missing twin.

## State

**Not yet performed, and not performable from this repo.** The clean-room
constraint (#53) means no vendor code and no production credentials are here:
the site builds from its own entries in `packages/site/src/content.ts`, four
published pages written by hand. Those entries are not the site, so a
comparison run against them would compare the framework to hand-written pages
and report a pass that means nothing.

What the build does prove without a twin is in
`packages/site/src/site.build.test.ts`: it drives the `pagedeck` executable as a
spawned process, writes the whole site to disk, and reads the criteria back off
the emitted bytes rather than off a plan — including that every asset URL a
document references resolves to a file that exists, which is the assertion the
parked branch's doubled `/assets/assets/…` path slipped past.

## Procedure

Run against a snapshot of the real store, on a machine that holds the CMS token.

1. `pagedeck sync` the site's collections, then `pagedeck build`. Serve the output with any
   static server; every path is a directory holding `index.html`, so no rewrite
   rule is needed.
2. Pick the representative set. It is fixed rather than sampled, and it is the
   set the framework's claims differ on:
   - the home page (tree-driven, `hero` + `feature_grid`, one call to action),
   - a legal page (template-driven, content-only — the 0 kB JS claim),
   - the pricing page (template-driven, `"use client"` — the island claim),
   - one page per locale, to check the URL prefix and the `lang` attribute on
     `<html>`,
   - one page with a nested slug, to check #161 has not come back.

   Not the `dir` attribute, though `packages/core/src/build.ts` emits one on
   `<html>` from the locale's `direction`. Both of this site's locales are
   `ltr`, from `LOCALES` (`packages/site/src/site.ts`), so every page carries
   `dir="ltr"` and the comparison is the same on both — a step that cannot
   distinguish a correct build from one that ignored the locale map entirely.
   It becomes worth a step the day this site declares an RTL locale, and not
   before.

3. For each, open the framework build and the production URL side by side at
   360 px and at 1440 px. Compare: text content, heading levels, image sizes and
   crops, the computed classes on any element carrying a CMS styling option, and
   every internal `href`.
4. Record each page as pass or fail in the issue, with a screenshot pair for any
   failure. A pass with no note is not a record.

## What the comparison is not for

- **Dead links.** The build already fails on an `href` that names no page in
  the route table, and reports every one of them at once. A
  spot-check is the worst place to find one, which is why the check is in the
  build.
- **Byte differences in the markup.** The framework renders through
  `react-dom/static`; whitespace and attribute order will differ from Next.js
  output and mean nothing. Compare what a reader sees.
- **Performance.** Spec §15's Core Web Vitals and Lighthouse criteria are
  measured in production against real traffic, not by looking at two tabs.
