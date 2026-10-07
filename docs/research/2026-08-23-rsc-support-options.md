# RSC support: what each option would cost

**Date:** 2026-08-23
**Status:** Decision input — no decision taken
**Relates to:** [Design spec](../specs/2026-08-23-framework-design.md) §7–§9, §14; decisions #4, #5, #6
**Companion:** [Bundler deep dive](2026-08-23-bundler-deep-dive.md) §8 (the original RSC rejection)

## Where we actually stand

The framework as specced has **no RSC support of any kind**, and this was a
considered rejection rather than an omission. The bundler research (§8) turned
RSC-static down on payload grounds: a static RSC page that hydrates anything
ships the flight payload — the serialized page tree, scaling with *page* size,
not *island* size — plus the `react-server-dom-*` client runtime. That is the
`__NEXT_DATA__`-shaped cost named in spec §1 as the framework's whole reason to
exist.

Current mechanism, for contrast:

| Concern | Current spec | RSC equivalent |
|---|---|---|
| Render | `react-dom/server` at build (§7) | rsc environment → flight → ssr environment → HTML |
| Interactivity boundary | `defineComponents({ hydrate })` registry (§8) | `"use client"` directive |
| Props transport | per-instance, inlined at the marker (§8) | flight payload, page-wide |
| Build environments | client + ssr | rsc + ssr + client |
| Server data access | loaders → SQLite store, before render (§6) | `await` inside the component |

The registry's `hydrate` field and `"use client"` are **competing solutions to
the same problem**. This is why "partial RSC support" isn't really a coherent
position — the two mechanisms have to be reconciled, not layered.

---

## Option A — tolerate `"use client"` in dependencies

**What it means.** Consumers' design-system packages are authored for RSC and
carry directives. We don't run RSC; we just need those packages to build and
render. Hydration stays entirely with the registry.

**Cost: low.** Directives are top-of-module string literals. Rollup/Rolldown
warn about them when bundling but they're otherwise inert — this is
build-config work, not architecture.

**What breaks anyway.** A component authored *for* RSC may use RSC-only
features that go beyond the directive:

- `async function Component()` — not supported outside RSC (see Option B).
- `server-only` package imports — hard build error by design.
- `"use server"` files (server actions) — need a server; there isn't one.

So the honest framing of Option A is "directives don't break us," not
"RSC-authored packages just work." Anything using RSC's actual capabilities
still fails, and the failure mode should be a clear build error naming the
component, not a confusing bundler warning.

**Spec impact:** none. No decision reversed.

**Prototype impact:** none.

---

---

## Option A+ — derive islands from `"use client"` (leading candidate)

**Driving requirement (2026-08-23):** the consumer design system is to be
authored with RSC directives, with the goal of minimizing payload from a large
CMS-driven component tree.

**First, a correction that changes the ask.** `"use server"` marks a *server
function* (server action) callable from the client over the network. Server
Components carry **no directive** — they are the default in an RSC environment,
and `"use client"` opts out into the client. Consequences:

- Design-system components that "render on the server and ship no JS" need no
  directive and **already work today**, unchanged.
- Anything genuinely marked `"use server"` needs a runtime request handler.
  Non-goal §3 rules that out; no rendering decision recovers it.

**The reframe.** `"use client"` and `hydrate:` are the same mechanism. Both mark
exactly one thing: *this subtree needs JavaScript, everything above it does
not.* The framework already derives, per page, which components appear in the
CMS tree and which of those need JS (§6 usage extraction, §8 registry). The open
question is therefore not "do we support RSC" but **which notation declares the
boundary.**

**The option.** Read `"use client"` at build time and derive the island set from
it. The directive declares the *boundary*; the registry continues to declare the
*strategy* (`load`/`visible`/`idle`) and the fold-score demotion in §8, neither
of which a directive can express. We do not run RSC — we honor its notation.

**Cost: low-to-moderate.** A build-time directive scan feeding the existing
registry/ranking machinery. No rsc environment, no flight, no `react-server`
condition, no reversed decisions.

**What it buys:** the design system ships one package that is idiomatic in
Next.js *and* here — which is most of the practical value of "RSC support" for
a component library.

**What it does not buy:** async server components (still Option B), cross-island
context (inherent to islands), server actions (needs a server).

**Note the inversion.** For the stated goal — a large CMS tree — real RSC would
make payload *worse*. The flight payload is the serialized rendered tree, so a
big tree means a big payload: component JS traded for tree JSON, which is the
§1 problem in a different hat. Options A/A+ preserve the payload goals; Option
C forfeits them.

**Spec impact:** §8 gains a directive-derived boundary path alongside explicit
registration. Decision #6 extended, not reversed. Everything else intact.

**Open questions:**

1. Does the consumer design system's intended authoring use *actual* RSC features (async components, `server-only` imports, data access in components) or plain presentational components that merely carry directives? Design-system components typically take props and render — they don't await. If so, A+ is sufficient and Option B is unnecessary.
2. Does it use the `<ClientWrapper><ServerChild /></ClientWrapper>` composition pattern? That's the one pattern A+ cannot express as inline props (see Option B's crux).
3. What happens on an unregistered `"use client"` component — does §8's "build fails on unregistered" still hold, or does the directive auto-register with a default strategy?

---

## Option B — RSC as an authoring model, islands as the hydration model

**What it means.** Page and component authors write async server components and
`await` data inline. We run the real three-environment RSC build to produce
HTML — but we **discard the flight payload** and keep the existing island
markers with inline per-instance props for hydration.

**Why this is more natural than it sounds.** RSC requires that props crossing a
client boundary be serializable. That is *exactly* the constraint the islands
model already imposes. An RSC client boundary and an island boundary are the
same boundary, described twice. The mapping `"use client"` → registry entry is
close to mechanical; the open question is where `hydrate: 'visible' | 'idle'`
strategy lives, since `"use client"` carries no strategy (probably: registry
still declares strategy, directive declares boundary).

**Cost: high, and partly unknown.** Three build environments via
`@vitejs/plugin-rsc`, plus custom work to prerender the flight to HTML and then
*not* ship it — extracting client-boundary props out of the flight tree and
re-emitting them as island markers. That is re-implementing a slice of the
client-reference machinery for our own transport. **I have not verified that
`@vitejs/plugin-rsc` exposes the hooks to do this cleanly** — that's the first
thing to check before costing this seriously.

**What we'd gain:** async server components, server-only data access woven into
component code, and CSS code-splitting for server components that the plugin
handles automatically.

**What we'd gain less of than it looks:** the "server data access" win is
already largely ours — spec §6 puts all content in a local SQLite store queried
at build time, before render. Async components are ergonomics on top of a
problem we already solved, not a new capability.

**Spec impact:**

- §8 registry contract — reworked (directive-driven boundaries, registry keeps strategy).
- §9 JS bundling — per-page generated entries are no longer the chunking unit; tiers group over client references instead. Ranking/tier machinery survives conceptually; its input changes.
- §14 preview — **this is the real casualty.** Preview's "client-rendered app reusing the same pure render function, 1:1 by construction" cannot hold: server components don't run in a browser. Preview would need either its own RSC dev server (contradicts "deployed anywhere static") or a documented divergence from production (contradicts the 1:1 guarantee).
- Decisions #5 and #6 — amended. #4 survives (still Vite 8 + Rolldown).

**Prototype impact:** #1's questions still valid. Tier grouping would eventually
need re-testing against client references rather than page entries.

---

## Option C — full RSC, flight payload and client navigation

**What it means.** Emit the RSC wire format per page, ship it, navigate
client-side against it. Possibly server actions later (needs a server, which
non-goal §3 rules out).

**Cost: this is a different framework.** It directly contradicts goal §2.2
("zero JS on pages with no interactive components; **no page-level data blob
ever**") and goal §2.1. Content-only pages could still hit 0 kB, but any page
with a single interactive component starts carrying a page-sized data blob plus
the `react-server-dom-*` runtime — the exact regression the dogfood success
criteria (§15.2, ">80% JS payload reduction vs the Next.js twin") are designed
to measure against. [#292 has since restated §15.2 as a ratcheted ceiling on
the framework's own bytes on an island page; the 80 % figure is no longer a
target.]

**Spec impact:** §1 problem statement, §2 goals, §8, §9, §14, §15 success
criteria. Decisions #5, #6 reversed.

**Recommendation:** don't. If this is genuinely what's needed, the honest move
is to evaluate Waku or React Router's RSC support as the foundation rather than
build it — spec §5's "named risk" discipline applies doubly here.

---

## Interlude: what "modern React" actually decomposes into

"RSC support" and "modern React support" are not the same requirement, and the
gap between them is where most of the confusion lives. Against React 19.x, the
current spec's position feature by feature:

| Feature | Status today | Note |
|---|---|---|
| All client hooks, context/state/effects *within* an island | ✅ | Islands are ordinary React roots |
| React Compiler | ✅ | Spec §5, applied to island code |
| Suspense + `use(promise)` on the client | ✅ | Inside an island |
| Transitions, `useDeferredValue`, `useOptimistic` | ✅ | Client-side |
| Error boundaries | ✅ | Per island |
| Document metadata hoisting (`<title>`/`<meta>` in components) | ✅ | Supported by SSR; useful for our SEO goals |
| `<form action={clientFn}>`, `useFormStatus`, `useActionState` | ✅ | Client actions only — see server actions below |
| Suspense resolving *data* at build time | ⚠️ | `renderToString` won't await it. Needs `react-dom/static`'s `prerender`. **Spec §7 says `react-dom/server` and should be tightened regardless of the RSC decision.** |
| Stylesheet precedence, `preinit`/`preload` | ⚠️ | Unresolved interaction with the CSS tiering in §9 — React wants to manage stylesheet insertion; we want deterministic tiers |
| **React Context spanning multiple islands** | ❌ | Each island is an isolated root. A provider in one root cannot wrap another. Independent of RSC — inherent to islands |
| **Shared state across islands** | ✅ | *Corrected 2026-08-23.* Verified working at runtime via an external store — including Jotai's `<Provider store={shared}>`, not merely the provider-less default store. Evidence and three load-bearing traps in [flight-free RSC](2026-08-23-flight-free-rsc.md) §4b |
| **Server Components / async components** | ❌ | Needs RSC — Option B or C |
| **Server Actions (`"use server"`)** | ❌ | Needs RSC **and a runtime server** |
| Streaming SSR, PPR | ❌ | Needs a runtime server |

Three findings worth separating:

1. **The RSC-shaped gap is narrower than it looks.** Server components and
   async components. That's Option B.
2. **The islands-shaped gap is separate and unfixable by RSC.** Cross-island
   context and shared state are consequences of isolated roots. RSC does not
   fix them; it *replaces* the islands model, at which point they resolve — but
   that's Option C, and it costs the payload goals.
3. **The server-shaped gap is not a rendering decision at all.** Server actions,
   streaming, and PPR need a request handler at runtime. Non-goal §3 says the
   output is static files. No amount of RSC work delivers these while that
   holds. If "fully" includes them, the decision under discussion is the
   *deployment model*, not the *rendering model* — a much larger reversal that
   also takes decision #10 (CI-runner builds, no serverless) with it.

**The tension, stated plainly.** Goal §2.2 is "zero JS on pages with no
interactive components; no page-level data blob ever." Feature-completeness
costs runtime — a framework that fully supports every modern React feature has,
by construction, a page-level data blob and a server. "Beat Next.js on payload
by knowing per-page component usage" and "match Next.js on React feature
surface" describe two different products. Picking both means picking neither
well, and the dogfood success criteria in §15 are the thing that would fail
first and most visibly.

## Decisions taken — grilling session, 2026-08-23

**Verdict: Option A+.** The consumer design system will author with `"use
client"`; the framework derives island boundaries from the directive and never
runs an RSC pipeline. Rationale: the stated objective is maximum DX *and*
maximum performance, and those pull apart at the extremes — maximum DX alone
argues for a single hydrated root, maximum performance for shipping nothing.
A+ is where they meet: authors write one familiar annotation they would write
anyway, and get islands-level payload underneath. Real RSC would regress the
payload metric it was proposed to improve, because the flight payload is the
serialized CMS tree and the tree is precisely what is large here.

| Question | Settled |
|---|---|
| Driver | DX + performance + one package portable to Next.js |
| Boundary notation | `"use client"`, read at build time |
| Hydration strategy | Inferred (default `visible`, fold score promotes to `load`), per-component override allowed |
| Server actions (`"use server"`) | Not required. Non-goal §3 and decision #10 stand |
| Async server components | **Deferred.** Ship A+; revisit only if the dogfood proves a need |
| Preview 1:1 (§14) | **Load-bearing.** Independently rules out Option B for now |
| Container children | Slots needed for the subset whose panels hold nested blocks |
| Slot constraints | Show/hide/reorder/animate as opaque DOM is sufficient. Inspecting children as React elements is **not** required — which is what keeps A+ viable |
| Cross-island state | Module-level store outside React (Jotai), not Context |

### Consequent design additions

**Root providers.** The islands runtime wraps every island root in a configured
provider stack, and the same stack wraps the build-time page render. Providers
work across islands as long as they do not *own* the state — a `<Provider
store={shared}>` pointing at one module-level store instance gives every island
the same store while each has its own provider element. Context is the delivery
mechanism; the store is the shared state. This belongs in §8 regardless of the
RSC decision.

Three conditions:

1. The store module must resolve to exactly one instance across all chunks — filed as issue #64. This is the sharp one: duplication is silent, and manifests only in production where chunking differs from dev.
2. A provider that auto-creates its own store per instance breaks. It must receive an explicit shared store.
3. Atoms whose initial value differs between build-time render and hydration will mismatch. Standard SSR hazard, but the framework should detect and report rather than let it go quiet.

**Slot mechanism.** Containers whose CMS children are nested blocks keep their
server-rendered children as inert DOM inside the island, adopted rather than
passed as props. Which components need this should be derivable from the §6.2
schema rather than declared by authors.

### Confirmed by research, 2026-08-23

[Flight-free RSC](2026-08-23-flight-free-rsc.md) tested the open questions against a
live harness (React 19.2.8 + `react-server-dom-webpack`, production builds)
rather than reasoning from docs. It **strengthens** the A+ verdict:

- **The payload argument is worse for RSC than this document claimed.** On a 20-section page the flight payload measured **16,828 bytes against 12,210 bytes of HTML** — the serialized tree is *larger than the page it describes*. Equivalent inline island props: **60 bytes**. Dev builds are ~4× larger again, so any measurement taken in dev is meaningless.
- **Flight-free island hydration does work** — proven end to end, two islands as independent roots, zero hydration errors. So Option B is technically live. But it depends on `setRequireModule`, an exported-but-**undocumented** seam, since the documented `onClientReference` hook yields boundaries without props. And **nobody ships this**: Waku, React Router and Parcel all inject flight unconditionally with no opt-out. We would be first, against APIs React excludes from semver.
- **Cross-island shared state is not a limitation** — see the corrected table row above.
- **Option A's directive-warning suppression is dead weight on our stack.** Rolldown never implemented `MODULE_LEVEL_DIRECTIVE`; it does not warn and preserves directives on entry modules.
- **The slot downgrade is riskier than assumed** — but not in the way assumed. See the correction below.

**Correction on slots.** This document assumed slotted content could not be
reordered or conditionally rendered. That is wrong; Astro's source disproves it
(`<template data-astro-template>` exists precisely so unrendered slots remain
available client-side). The real limit is narrower and harder: the slot is an
**opaque HTML string**, so `React.Children` traversal, `cloneElement`, and
**re-rendering slotted content with new data** are all impossible, and
duplicating it in two places is unreliable. Astro has carried this since 2021
with a steady bug trail, and its escape hatch (`experimentalReactChildren`) is
still experimental three years on. Treat that as a forecast for #67.

### Still open

- Jotai store scoping — single page-level store vs nested scoped stores. Being researched against Jotai's primary docs; the answer decides whether the runtime wraps every island identically or must reconstruct a per-island provider chain.
- Everything in the flight-free research brief (`2026-08-23-flight-free-rsc.md`), which matters less now that A+ is the direction but still bounds any future Option B.
- Re-triage of the Rendering & islands and Bundling milestones against this design.

## Summary

| | A: tolerate directives | B: RSC authoring + islands | C: full RSC |
|---|---|---|---|
| Cost | Low | High + unknowns | Rewrite |
| Payload goals (§2.1–2.2) | Intact | Intact | **Broken** |
| Preview 1:1 (§14) | Intact | **Broken** | Broken |
| Registry contract (§8) | Intact | Reworked | Replaced |
| Async server components | No | Yes | Yes |
| Decisions reversed | none | #5, #6 amended | #5, #6 reversed |
| Prototype #1 still valid | Yes | Yes (inputs change) | Yes (inputs change) |

## Open questions before any of this is decidable

1. **Which consumer need is driving this?** A design system that ships RSC-authored packages points at A. Authors wanting `await` in components points at B. Wanting client-side navigation points at C. These are different problems.
2. Does `@vitejs/plugin-rsc` expose hooks to prerender and discard flight while extracting client-boundary props? Option B's cost is unknowable until this is answered.
3. If B: what happens to preview? A documented production/preview divergence may be acceptable, but §14 currently calls 1:1 a construction guarantee, not a goal.
