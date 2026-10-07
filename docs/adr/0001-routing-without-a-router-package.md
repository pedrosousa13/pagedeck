---
description: Core ships no router package: route params come apart from the content store, and route templates exist only to check links at compile time.
---

# 1. Routing without a router package

Date: 2026-08-24

## Status

Accepted. Implemented by #87 and #88.

## Context

`definePages()` and `collectPages()` build the route table (`packages/core/src/pages.ts`, spec §7). Two questions came up together: should routing lean on an established package, and should page sources declare patterns like `/blog/[slug]` rather than computing a route per entry.

Three separate jobs hide under the word "router" here, and only one of them is a candidate for a dependency.

Building the route table is the inverse of what React Router, TanStack Router and Wouter do. They answer "given a URL, which component renders". We answer "given a content store, which URLs exist". No package solves the second problem, and `collectPages` is already a map plus a collision check.

Serving the built output is a static file lookup done by the CDN. The `trailingSlash` policy and the manifest are the whole contract, so a matcher would be dead weight. The dev server (#50) resolves a request the same way, by looking the canonical path up in the table the build already produced.

Client-side navigation is the only place a router package is a real question, and React Router in particular assumes one React root owning a tree, with nested layouts and data loaders hanging off it. Islands have no shared root. Each marker hydrates independently (decision 5, decision 21) and there is nothing above them to re-render on a route change. Astro reached the same conclusion and ships full page loads plus View Transitions instead, which is also what #42 plans here.

Patterns are a separate question from packages, and they run into a harder constraint: a static site enumerates every URL at build time, so a pattern is never a route on its own. `/blog/[slug]` is a template plus a set of param values, and something has to produce those values. Next calls that `generateStaticParams`, Astro calls it `getStaticPaths`, and neither escaped the requirement.

## Decision

**No router package in core.** Not for the route table, not for serving, not for client navigation. If `@fw/edge` ever serves paths outside the static manifest, add `URLPattern` (native in Node 24 and current browsers) in that package alone. It is a matcher, not a router.

**Decouple the param source from the content store** (#87). `PageSource` today fuses naming a collection, computing a route, and declaring dependencies, which makes the store the only thing that can mint a route. Splitting the instance provider out lets routes come from a literal array, a JSON file, or a build-time fetch, with the collection-backed case as a helper. This extends §7's "collections from different sources compose freely" to sources that are not collections at all.

**Route templates exist for compile-time link checking, and for nothing else** (#88). The build gains nothing from knowing a template, because it writes out every path either way. The payoff is deriving the param type from `"/blog/[slug]"` and giving sites an `href` that fails the type check when a route is renamed or a param is misspelled. The template and the helper ship in one pass. A template with no `href` behind it is decoration that still costs maintenance, since template literal parsing types degrade error messages and this project treats those as a feature (`docs/error-messages.md`).

**Three invariants hold through both changes.** Page identity stays `(locale, path)` and nothing else (decision 11). The build keeps enumerating every path. Two pages claiming one route stay an error rather than a precedence rule.

## Consequences

Exhaustive enumeration lets us skip route precedence entirely. Routers with patterns need rules to decide whether `/blog/[slug]` or `/blog/archive` wins, and those rules are where routers get complicated and where the bugs hide. Because we write out every concrete path, an overlap surfaces as two entries claiming one route, which `findCollisions` already reports with both claimants named. An error beats silent shadowing, which is the failure people actually hit. Precedence only becomes necessary if on-demand edge routes land, and then only for the edge matcher.

Filling params into a template introduces an injection path that `unusableReason` cannot catch, because it checks the finished route rather than the inputs. A slug containing `/` would invent a path segment and one containing `?` would smuggle in a query. Param values are percent-encoded per segment before interpolation. This intersects the open question in #85 about canonicalizing percent-encoding in emitted routes.

#87 landed that as the segment form, ahead of any template: a `route` callback returns `string | readonly string[]`, core percent-encodes each element and joins them with `/`, and `canonicalizePath` — since ratified and shipped by #85 — decides the final spelling of the result. So the safe path is the default rather than a discipline, and #88's templates lower onto the same segment list instead of introducing an encoder of their own.

Catch-all params (`[...rest]`) cannot be enumerated from a template, so the provider supplies the segments and the param type is `string[]`. #88 either implements this or rules it out in the module docs.

Typed `href` overlaps #31, which validates links by scanning rendered HTML against the manifest. They are complementary rather than redundant: one catches the bug in the type checker before a build runs, the other catches links the type system never sees, including anything a CMS authored.

#87 breaks `definePages`, which shipped in #86. Landing it early is deliberate, since the cost grows with every caller added. `packages/examples` moves with it (§14b) and gains the runnable example `definePages` never had. `packages/fixtures` does not: it names no page source, so the coupling assumed here turned out not to exist.

If soft client navigation is wanted later, the scope is intercepting same-origin link clicks, fetching the HTML, swapping `<body>`, re-running hydration over the markers, and pushing history. That is small against a hydration runtime we are building anyway (#16), and owning it is what keeps island lifecycle correct, which is the part a general router would get wrong.

## Alternatives considered

**Adopt React Router or TanStack Router.** Rejected. Both assume a tree-owning root that islands architecture deliberately does not have, and neither addresses the route table, which is the actual work.

**Ship route templates alone, add link checking later.** Rejected. The template is inert without the checker, so this pays the template literal type cost up front and banks the benefit at an unscheduled date.

**Keep routes derived from collections only.** Rejected. It forces a fake collection for a handful of static pages or an API-driven catalog, and §7 already commits to composing sources freely.
