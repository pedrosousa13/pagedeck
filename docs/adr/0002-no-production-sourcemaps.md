---
title: 2. No sourcemaps in production output
description: No sourcemap ships in production; the React Compiler's map only keeps the transform chain intact, and build.sourcemap alone decides what reaches disk.
---

# 2. No sourcemaps in production output

Date: 2026-08-25

## Status

Accepted. Forward-looking: nothing in the repo sets `build.sourcemap`, so no
sourcemap is emitted today and there is no code change attached to this. Raised
by #83.

## Context

The question came up from `compileIslands`
(`packages/core/src/react-compiler.ts`), whose plugin passes `sourceMaps: true`
to Babel and returns `compiled.map` alongside the code. Measuring what that map
actually contains answered a different question than the one asked, so both
answers are recorded here.

**The plugin's map is not the risk, and `sourceMaps: true` is not the setting
that matters.** A production build of a fixture island through the real Vite +
Rolldown pipeline emits a byte-identical map whether `compileIslands` is in the
plugin list or not. The plugin has to pass `sourceMaps: true` regardless: a
Vite plugin that transforms code and returns no map breaks every map
downstream of it. What that returned map does is keep the chain intact through
the transform, and whether anything reaches disk is decided elsewhere, by
`build.sourcemap`. Setting it is the whole decision.

**What an emitted map discloses is the original source, in full.** Babel
includes `sourcesContent` by default when `sourceMaps` is on, Rolldown carries
it through, and the emitted `.map` holds the complete original text of every
authored module — comments, dead branches, anything the bundler would otherwise
have dropped. This was confirmed by building a fixture whose source carried a
marker comment and finding that comment in the emitted map. For a site built on
a private design system, publishing that map publishes the design system.

**It does not disclose build-machine paths.** An earlier draft of this ADR
claimed the map's `filename` would carry the absolute path of the module on the
machine that ran the build, on the grounds that the plugin passes the resolved
module id as Babel's `filename`. That is wrong and was corrected by
measurement. Babel defaults the map's `sources` to a basename rather than to
the `filename` it was given, and Vite rewrites `sources` again relative to the
output file. The emitted map records `../../src/Hero.tsx`, and no absolute path
appears anywhere in it. What it does disclose is the shape of the source tree
above the output directory, which is a much smaller thing.

Vite also writes a `//# sourceMappingURL=` comment into each chunk, so an
emitted map is not merely present on the CDN, it is advertised to every browser
that loads the page.

The decision has to be made before someone sets `build.sourcemap` to debug a
production issue, because at that moment it looks like a one-line change with
an obvious payoff, and nothing in the diff shows what rides along with it.

## Decision

**A production build emits no sourcemap.** Do not set `build.sourcemap` for the
production build.

**Leave `sourceMaps: true` in the React Compiler plugin.** It is what keeps the
map chain intact through the transform, it is not what puts anything on a CDN,
and removing it would degrade every downstream map while protecting nothing.

This says nothing about development builds or the dev server (#50). The machine
that builds those is the machine reading them.

## Consequences

A production stack trace is against compiled output, so a crash reported from
the field names a minified frame rather than a component and a line. That is
the cost, and it is paid against publishing every authored component's source
to anyone who fetches the site.

A production build config landed with `buildClient`
(`packages/core/src/client-build.ts`, issue #164), which sets no
`build.sourcemap`, and the check this section asked for is on it:
`client-build.test.ts` asserts that no emitted file's path ends `.map` and that
no chunk carries a `sourceMappingURL` comment. The output *directory* is still
#37's to write — `buildClient` hands its files back rather than placing them —
so the check reads the emitted set instead of a tree on disk, which is the same
claim about the same bytes.

If the trade is ever reopened, reopen it on the disclosure, not on the paths —
the paths were the weaker of the two reasons and measurement removed them.

## Alternatives considered

**Emit sourcemaps and upload them to an error reporter.** The strongest
alternative, and the one to take if production stack traces become necessary.
`build.sourcemap: "hidden"` produces the map without the `sourceMappingURL`
comment, the upload step sends it to the reporter, and the file is deleted from
the output directory before publish. Not adopted now because it requires a
release pipeline and an error reporter, neither of which exists yet, and
because a half-built version of it — maps emitted, upload not wired — publishes
exactly what this ADR refuses. It is a decision for whoever builds the release
pipeline, made with the pipeline in front of them.

**Emit sourcemaps and delete them from the output directory after the build.**
Rejected as a standalone measure. It has the same failure mode as the
alternative above with none of the payoff: the window between emit and delete
is a build step someone can reorder, and a `sourceMappingURL` comment left in
the chunks points browsers at files that are meant to be gone. If the maps are
not going anywhere useful, not producing them is strictly simpler than
producing and removing them.

**Strip `sourceMaps: true` from the compiler plugin.** Rejected, and it was the
original suspicion. Measurement showed the plugin is not the source of the
risk, and dropping the option would break the map chain for the dev server and
for any future tooling that consumes it, in exchange for nothing.
