---
title: 7. Islands are built in one module graph, and the singleton guarantee is per invocation
description: All island code is bundled in one module graph, so a shared module stays single within a build, and a build whose graph is open is refused.
---

# 7. Islands are built in one module graph, and the singleton guarantee is per invocation

Date: 2026-08-29

## Status

Accepted. Decided on #64 and shipped in the PR that closes it: `checkClientGraph`
(`packages/core/src/client-build.ts`) refuses a build whose emitted graph has a
hole in it or whose resolution produced two copies of one package, and
`packages/core/src/singleton.build.test.ts` measures the guarantee over a real
bundler, including the incremental path. Binding on `buildClient`'s
configuration and on anything that would emit island code from more than one
bundler invocation.

## Context

Spec §8 wants a provider stack that resolves to one instance across every island
root, and spec §11 forbids a partial-graph client build. Both are the same
requirement seen from two ends: a module two islands import has to be evaluated
once, so its module-level state is one store rather than one store per island.

**Nothing outside a single bundler invocation guarantees that.** Rolldown
documents it — "Ensure every JavaScript module is singleton in the final bundle
output" — and the words that carry the weight are *final bundle output*. The
statement is about one output of one invocation. Two invocations produce two
outputs, and no bundler documents anything across them, because there is no
shared module registry for either of them to write into: the browser's own
module map keys on URL, and two invocations that each emitted a copy of one
module emitted it at two URLs.

The framework said so in prose in two places — `entryInputs`' docblock and
`client-build.ts`' header — and nothing measured any of it. `buildClient` takes
the whole `EntryPlan` and hands `entryInputs(plan)` to one `build()` call, which
is the property both docblocks assert, but a reader had only their word for it.

Three layers can break the guarantee, and they are blind to each other:

- **Placement.** One module the bundler resolved once, copied into two chunks.
- **Resolution.** Two physical copies of one package (pnpm hoisting, a linked
  workspace package, a transitive duplicate), resolving to two different ids, so
  a per-id placement check counts one chunk each and sees nothing wrong.
- **The invocation boundary.** A module the build did not emit at all — an
  externalized dependency, loaded by the browser on its own.

#64's research addendum asked for the first two to be measured and for the third
to be documented as a constraint that fails rather than degrades silently.

## Decision

**Island code is built in one full-graph bundler invocation, and the singleton
guarantee holds per invocation.** `buildClient` is the only place the framework
configures a shipping client build; it takes the whole `EntryPlan` and passes
`entryInputs(plan)` as the input map, and it sets no `external`. That is the
mechanism, and there is no second one.

**The graph must be closed, and that is now checked rather than asserted.**
Every import in every emitted chunk — static and dynamic alike — has to name a
chunk this same invocation emitted. A module reached through an import that
names anything else is loaded by the browser separately, keyed by URL in the
browser's module map, and shared with whatever else happens to resolve to that
URL. That is a module the build cannot keep singleton, so `checkClientGraph`
refuses it, names every such import and says the fix in the same sentence
(`docs/error-messages.md` rules 3 and 5). Nothing in this repo can produce that
state today; the check exists so that the day something can, the run stops
instead of shipping.

**Two copies of one package at one version are refused by the same check, at
the resolution layer.** Two ids whose path after the last `node_modules`
segment is the same package and the same file, *and* whose nearest
`package.json` declares the same version, are two installs of one package — the
linked-package and hoisting case #64's research addendum names. The report names
both paths so the reader can tell which to remove.

**Two different versions of one package are not that, and pass.** They are
ordinary npm: a graph that transitively reaches two minors of a shared utility
holds two modules, not one module in two instances, and no lockfile edit
collapses them. The path key alone cannot tell the two apart — under pnpm both
versions live at `…/.pnpm/<name>@<version>/node_modules/<name>/…`, and the cut
after the last `node_modules` drops the segment that differs — so the version is
read as well.

**When a version cannot be read, the check says nothing.** An absent,
unreadable or version-less `package.json` is a layout this reasoning does not
understand, and the two errors it could make there are not symmetric: staying
quiet costs a warning about an install that was already shipping, while
reporting costs a correct site a refused build at exit 2 and a fix sentence
about a lockfile that has nothing wrong with it. It fails open.

**No site-facing surface declares which modules are singletons, because every
module is one.** #64's notes asked for "a way for a site to declare 'these
modules are singletons' (config or convention)", designed as part of the issue.
The design is that there is no such surface, and the reason is above: the
guarantee is universal. It covers every module in the emitted graph, every
import out of it, and every package resolution produced two copies of — so a
declared list could only *narrow* what already holds of everything, and a module
left off it would be one the site had silently given up on. Nothing is added and
nothing has to be maintained in step with a site's dependencies.

**Vite's `resolve.dedupe` is deliberately not configured, and it is not what the
error message recommends.** It is that declared surface in Vite's spelling — a
list of package names a site keeps in step — so the paragraph above is the first
reason against it. It was the obvious candidate all the same, and it was
measured against the installed toolchain (Vite 8.2.2, `tryNodeResolve`) before
being rejected — see *Alternatives considered*.

**A partial-graph build stays unspecified, and would need an externalization
mechanism before it could be allowed.** For one entry to be rebuilt against a
previous build's chunks, that invocation would have to *not* emit those chunks
and instead import them at their existing URLs — which is an `external` plus a
mapping from module id to the previous build's emitted file name, plus a rule
for what happens when the two builds disagree about a module's contents, plus a
story for how the tier plan's groups are honoured by a graph that contains none
of their modules. None of that is specified anywhere. Until it is, the closed-
graph check above is what stops it arriving by accident.

**Owner: `buildClient`.** Whoever adds an `external`, a second `build()` call
for island code, or a plugin that resolves an island's import to a bare
specifier owns this decision and has to reopen it here first.

## Consequences

**An incremental build re-emits every chunk, and that is the design rather than
a shortcoming.** Spec §11's "island-edit → one entry re-emitted" is a statement
about which *bytes change*, not about which chunks the bundler visits.
`incremental.build.test.ts` measures the criterion that way: not "no chunk was
rebuilt" — every chunk was, over the whole graph — but "every chunk came back
the same bytes at the same address". What makes that cheap enough to
be the answer is that the tier plan is pinned (`IncrementalPlan.pinned.tiers`)
and Rolldown's output is deterministic, so an unchanged module lands in an
unchanged chunk at an unchanged content hash and the deploy diff is empty.
The pinned tier plan alone did not hold that: a shared module no tier claims
was left to Rolldown's default split, and moved when an island left the graph.
#720 also pins that split from the previous build's manifest, and where a
chunk's bytes still change, renders the reused pages that name it again and
bundles again.
`singleton.build.test.ts` measures the guarantee on exactly that path: an island
edit, the pinned tiers from the previous build, one entry re-emitted at a new
address, the pinned core chunk at its old address, and `store.js` in that one
chunk and nowhere else.

**The cost is build time on a large site.** Spec §11's headline case is 50k
pages, and every incremental build over it walks the whole client graph.
Nothing here makes that cheaper; what it does is make the alternative — walking
part of it — a decision somebody has to argue for rather than one that can be
reached by handing `buildClient` a shorter plan.

**A caller handing `buildClient` a plan short of the site's pages is not
detected, and is not a singleton fault.** This is the one thing #64's
"configuration that would split them across invocations fails" does *not* cover,
and the honest statement is worth more than a check that pretends to. Such an
invocation builds a complete, closed, internally consistent graph over fewer
pages: every module in it is still singleton. What it loses is the other pages'
entry chunks, which is a missing-output fault that `buildManifest` and the
manifest diff see, not a duplicated-store fault. `buildClient` could not detect
it in any case — it holds a plan and a tier plan and no route table, and every
subset of a site's pages is a valid plan for a smaller site. `TierPlan.pageCount`
is the one number that looks like evidence and is not: pages are legitimately
removed between builds (`IncrementalPlan.remove`), so a plan with fewer entries
than the pinned tiers were planned over is an ordinary deletion, and a check on
it would refuse correct builds.

**The two new refusals are `ConfigError`, exit 2** (`docs/error-messages.md`
rule 7). Both are the site's or the framework's wiring and neither comes right
on a retry: an install that holds two copies of a package holds them again next
run, and an externalized module stays externalized.

**The package-copy check keys on paths, which makes it a heuristic about a
convention.** `node_modules` is a filesystem convention rather than a fact the
bundler reports, and a resolver that placed packages somewhere else would defeat
it. That is accepted: it is the layout every package manager this framework can
be installed by produces.

**It reads one field off disk, and no more than one.** The version comes from
the nearest `package.json` at or above the module, bounded below the
`node_modules` directory the path was cut at, and it is read only for the paths
that already collided — a graph with no collision opens no file. That is not
the general package-identity system #64 declined to build: no name, no
resolution record, no version ranges and no comparison beyond string equality.
It is the one fact without which the check refuses correct builds.

## Alternatives considered

**Configure `resolve.dedupe` instead of detecting the duplicate.** Rejected on
measurement, and it was the first thing tried. Three findings, all against it:

- It is a **declared list of package names**, and the framework has no list. The
  duplicate could be any package a site's islands share, which is the same
  argument `checkClientGraph`'s universal per-id count already makes: there is
  nothing for a site to declare, and a declared list would only narrow what has
  to be true of every module in the graph.
- Its whole effect is to force one variable. In `tryNodeResolve` it replaces the
  base directory of the `node_modules` walk with the project root and changes
  nothing else. Bare specifiers only — a relative or absolute id never reaches
  that branch — so a duplicate reached by path is untouched.
- **It can turn a shipping build into a broken one.** With the base directory
  forced to the root, a package with no copy on the root's upward walk resolves
  to nothing, and the optional-peer-dependency fallback is skipped because it is
  guarded on the base directory *not* being the root. A site that lists a
  package its root does not hold gets an unresolved import where it previously
  had a working, if duplicated, build. That is a setting to reach for
  deliberately, with a specific package in hand — which is a site's decision,
  not a default this framework should be making on its behalf.

Detection has none of those properties: it is universal, it reads the graph the
bundler actually produced rather than trying to steer it, and its failure mode
is a refused build with both paths in the message.

**Configure `resolve.dedupe` *and* detect.** Rejected as the worst of both. The
setting would silently collapse the copies the check exists to report, so the
check would be dead for exactly the sites that needed it, and the site would
never learn its lockfile holds two copies of a package.

**Recommend `resolve.dedupe` in the error message.** Rejected for the third
finding above. A fix sentence that can leave the reader with an unresolved
specifier is not a fix (`docs/error-messages.md` rule 3). The message names the
lockfile and the site's own dependencies instead, which are levers with no
failure mode of their own.

**Check that `buildClient`'s plan covers the route table.** Rejected: it would
have to be given the route table, which is a new input for a check about a fault
that is not a singleton fault (see *Consequences*). The place that already holds
both the route table and the demands is `planIncremental`, and its partition is
total by construction — every routed page is rendered or reused — so the fact is
established where it is knowable rather than re-asserted where it is not.

**Leave the constraint in the docblocks.** Rejected, and it is why this file
exists. `entryInputs` and `client-build.ts` each stated the invariant in prose,
which served a reader already looking at them. What neither can say is what
would have to be true before it could be relaxed, or why an incremental build
re-emitting every chunk is the design rather than an optimisation nobody got to
— and those are the two questions somebody arrives with when a 50k-page build is
slow. ADR-0002 is the precedent: a constraint the code obeys and no reader can
find the argument for is a decision the project cannot defend.
