---
title: 10. Request-time code lives beside the site, behind a path prefix
description: A site sends path prefixes to an app it runs beside the build, and Pagedeck routes and checks them but never runs request code.
---

# 10. Request-time code lives beside the site, behind a path prefix

Date: 2026-10-13

## Status

Accepted, and shipped on #141. The maintainer asked for it on 2026-10-13, with
two conditions: Pagedeck stays agnostic about the app's framework, and an
island can talk to the app's endpoints and middleware with little setup.
`cloudflarePages()` is the first adapter that routes upstreams. Every other
adapter refuses them, through the base, until its own issue lands.

## Context

Spec §3 rules out request-time rendering, and decision 10 rules out
serverless. A built site is static files. Every request-time feature Pagedeck
has today is code the build generates and checks: the redirects, headers, 404
pages and variant splits each edge adapter compiles from the routing manifest
(ADR-0009).

A site still needs endpoints. It might be a form POST, an auth callback, or a
cart count an island fetches. Next.js and Astro answer this with middleware
and server functions in the framework. Pagedeck would then own a request
context type, a function bundler and a per-host runtime for each of six hosts,
and two of those hosts cannot run such code at all. CloudFront Functions have
no network access and no request body
(<https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-restrictions.html>),
and nginx runs no JavaScript.

Next.js itself moved away from edge-only middleware. Next.js 16 runs
`proxy.ts` on Node.js and deprecates the edge `middleware.ts`
(<https://nextjs.org/blog/next-16>).

ADR-0001 kept Pagedeck free of route precedence by listing every path, and
said precedence would only come back "if on-demand edge routes land".

## Decision

**The app is the site's, not Pagedeck's.** A site declares path prefixes in
`routing.upstreams`, and requests under them go to an app the site writes and
deploys. Any framework that answers HTTP works. Pagedeck never imports,
bundles or runs it. The docs and the example use Hono, because one Hono app
runs on Cloudflare Workers, Vercel, Netlify, AWS Lambda and Node, but no
package depends on it.

**Pagedeck routes and checks, nothing more.** Each adapter writes the prefix
into the host's own routing, so a request for a built page never reaches the
app:

| Host | How the prefix reaches the app |
| --- | --- |
| Cloudflare Pages | a `_routes.json` include rule per prefix, the app as Pages Functions |
| Cloudflare Workers Static Assets | `assets.run_worker_first` patterns in the site's own `wrangler.jsonc`, the app as the Worker; the build cannot write that file |
| Cloudflare Worker | the generated Worker forwards the prefix to a service binding |
| Vercel | a route in the build output to a function |
| Netlify | a function's `path` |
| CloudFront | a second origin and a cache behaviour for the prefix |
| nginx | a `location` that proxies to the app |

`defineAdapter` refuses upstreams for every adapter that does not declare it
routes them, so a new adapter cannot drop a prefix without a word.

**No precedence.** A prefix may not cover a built page, a redirect, a 404 page
or a reserved deploy key, and one prefix may not contain another. The build
refuses each case, naming both sides. Pagedeck lists every path, so it can
check this, and ADR-0001 still holds: no path ever has two claimants for a
host to choose between.

**Same origin.** The app answers on the site's own origin, so an island calls
`fetch("/api/…")` with no CORS and no base URL, cookies are shared, and the
site's CSP needs only `'self'` in `connect-src` and `form-action`.
`pagedeck dev` forwards each prefix to a local app, so dev behaves the same.

**Types without shipped code.** An island may import types from the app, so
a Hono app's `hc<AppType>` client, or OpenAPI types, give typed calls. The
build refuses a value import from the app's directory into an island, because
it would ship server code, and maybe secrets, to the browser.

**Personalised parts of a page are islands.** A page stays static, and an
island fetches what depends on the visitor from the app.

## Consequences

- Pagedeck maintains a manifest field, its collision checks, one conformance
  case, a dev proxy and an import check. It maintains no middleware API, no
  request context, no function bundler and no per-host runtime.
- The app's framework, runtime limits and costs are the site's. A function's
  size and cold start are not in `build.budget`.
- Built pages are unaffected: budgets, the 0 B pages, the CSP checks and the
  build-twice check all stay as they are.
- An app cannot run in front of a built page yet, for example as an auth gate
  on `/account/`. On Cloudflare, `_headers` and `_redirects` do not apply to a
  request the Worker handles
  (<https://developers.cloudflare.com/workers/static-assets/headers/>,
  <https://developers.cloudflare.com/workers/static-assets/redirects/>), so
  the app would have to apply the site's headers, CSP included. Allowing it
  means handing the app those rules, and that is a separate decision.
- A site that deploys to CloudFront or nginx deploys its app on its own and
  names where it runs. Pagedeck only writes the routing to it.

## Alternatives considered

**A middleware and functions API in Pagedeck,** as Next.js and Astro have.
Rejected: it is the runtime this decision exists to avoid, it cannot run on
CloudFront Functions or nginx, and every host's runtime limits would become
Pagedeck's to track.

**Hono as a dependency,** with Pagedeck generating the app's entry for each
host. Rejected: Hono's releases would become Pagedeck's, and a site that wants
another framework would have none. Hono stays the documented choice.

**Request-time rendering of pages.** Still ruled out by spec §3. An island
fetching from the app gives the personalised part without giving up a static
page.

**A separate API origin,** such as `api.example.com`. Rejected: it needs CORS,
a base URL in every island, a cookie domain and a wider CSP, which is the
communication cost this decision is meant to remove.
