---
section: how-to
title: Run an app beside the site
description: Serve API routes and middleware from an app on the site's own origin, and call it from an island with types and no server code.
---

# Run an app beside the site

Pagedeck builds static files and runs no code when a page is requested. When a
site needs code that runs per request, such as a form endpoint, an auth
callback or a count an island fetches, that code goes in an app the site runs
beside its pages, on the same origin. Pagedeck never imports or runs the app,
so the app can use any framework that answers HTTP. The site declares the path
prefix the app answers, and Pagedeck checks and routes it.

This page uses [Hono](https://hono.dev) on Cloudflare Workers Static Assets.
The example is `packages/app-example` in the Pagedeck repository. Every code
sample below is copied from it, and every file path is relative to it.

To run it, build the workspace once with `pnpm build` from the repository root.
Then, in `packages/app-example`, from the example's `README.md`:

```sh
node ../core/dist/bin.js sync
node ../core/dist/bin.js build      # writes site/
pnpm exec wrangler dev              # serves site/ and the app on one origin
```

## Declare the prefix

The site names the prefix in `build.routing.upstreams`, in
`pagedeck.config.ts`:

```ts
routing: {
  headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
  upstreams: [{ prefix: "/api/", dev: "http://127.0.0.1:8787", source: "src/app.ts" }],
},
```

Each field changes what Pagedeck does:

- `prefix` is the part of the site the app answers. It starts and ends with
  `/`. `pagedeck build` refuses a prefix that covers a page, a file the build
  writes or a redirect, because under the prefix the host never serves them.
  It also refuses one prefix inside another, because a path under both would
  have two apps to answer it.
- `dev` is where the app listens while you develop. `pagedeck dev` forwards
  every request under the prefix there, with its method, headers and body, so
  an island's calls work in development as they do once deployed.
- `source` is the app's file or directory. The build refuses an island that
  imports a value from it, as the island section below explains.
- `url` is the `https` origin the deployed app answers at, such as
  `"https://app.example"`, with no path, query or credential. A host that
  proxies the prefix to an app running elsewhere needs it. The example leaves
  it out, because the app runs on the same host as the pages, and
  `cloudflarePages()` refuses it for the same reason.

## The app answers one path prefix

The app is a Hono app whose routes all start with `/api`. It answers one
request, a sign-up, and checks the address itself, in `src/app.ts`:

```ts
const app = new Hono()
  .use(secureHeaders())
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  })
  .basePath("/api")
  .post(
    "/signup",
    validator("json", (value: { email?: unknown }, c) => {
      const { email } = value;
      if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(email)) {
        return c.json({ error: "Enter an email address." }, 400);
      }
      return { email };
    }),
    (c) => c.json({ message: `Thanks. We will write to ${c.req.valid("json").email}.` }, 201),
  );

export type AppType = typeof app;
```

The two middlewares are registered before `basePath`, so they run for every
request the app answers, and not only for the ones under `/api`. The next
section says why that matters.

## The host sends the prefix to the app

The site's pages and the app deploy as one Worker. `wrangler.jsonc`:

```json
{
  "name": "pagedeck-app-example",
  "main": "src/app.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./site",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "run_worker_first": ["/api/*"]
  }
}
```

`assets.directory` is the build's output. `run_worker_first` sends every
request under `/api/` to the app before Cloudflare looks for a file. Every
other request is answered from `site/`, so a built page never runs the app.
Cloudflare documents the option at
<https://developers.cloudflare.com/workers/static-assets/binding/>.

`wrangler.jsonc` is yours, and the build does not read it. So when you add,
move or remove a prefix, change `run_worker_first` with it, one pattern per
prefix, written as the prefix followed by `*`.

`cloudflarePages()` also writes `site/_routes.json`, which sends the same
prefixes to Pages Functions on Cloudflare Pages
(<https://developers.cloudflare.com/pages/functions/routing/>). It writes two
rules per prefix, `/api` and `/api/*`, because Cloudflare's `/api/*` matches
only what comes after `/api/`. Workers Static Assets reads `run_worker_first`
instead and would serve the file as a page, so the example's
`public/.assetsignore` names `/_routes.json` to keep it out of the upload.
`wrangler dev` serves it locally all the same.

One request reaches the app without matching the prefix: a path with no file.
With `not_found_handling` set to `none`, Cloudflare hands a miss to the
Worker. That is why the middlewares come before `basePath`. Registered after
it, they would skip a miss, and its `404` would go out with no headers.

## Each half sets its own headers

The build writes `site/_headers` from `build.routing.headers`, and Cloudflare
applies it to every file it serves from `site/`. It never applies it to a
response the Worker writes
(<https://developers.cloudflare.com/workers/static-assets/headers/>). So the
app sets its own: `secureHeaders()` adds Hono's security headers, and the
second middleware marks every answer `no-store`, so no cache keeps a reply
written for one visitor.

## The island calls the app by its type

The form on `/signup/` is an island. It imports the app's type, never its
code, and builds a client from it, in `src/components/signup.tsx`:

```tsx
import { hc } from "hono/client";
import { useEffect, useId, useState } from "react";
import type { AppType } from "../app.js";

const client = hc<AppType>("/");
```

`hc<AppType>` knows each route, its input and its answers, so `tsc` fails on a
wrong path, a missing field or a misread answer in the call below. The submit
handler, in
`src/components/signup.tsx`:

```tsx
event.preventDefault();
const response = await client.api.signup.$post({ json: { email } });
const body = await response.json();
setReply("message" in body ? body.message : body.error);
```

`import type` matters. TypeScript erases it, so nothing from `src/app.ts`
reaches the browser. A plain `import` of a value from the app would put server
code, and anything it holds, into the island's chunk. Because the upstream
names `src/app.ts` as its `source`, `pagedeck build` refuses that import, and
names the module that made it and the fix.

## Develop with both running

`pagedeck dev` serves the pages and forwards `/api/` to the entry's `dev` URL,
where `wrangler dev` serves the app. Run both, `wrangler dev` first, since it
serves `site/` too and needs one build. When the app is not running,
`pagedeck dev` answers a request under the prefix with a `502` that names the
entry, its URL and the fix.

## One origin, so nothing to configure

The app answers on the site's own origin, so:

- the island calls `/api/signup` with no base URL and no CORS;
- a cookie the app sets with `Path=/` is sent with every later request to the
  site, pages and app alike;
- a `Content-Security-Policy` needs only `'self'` in `connect-src` and
  `form-action` to allow the calls.

## Other hosts

Every adapter routes upstreams, each in its host's own terms, and each sends
`/api` to the app as well as everything under `/api/`. A host that runs the
app beside the pages needs no `url`. A host that proxies to an app running
elsewhere needs `url`, the `https` origin the app answers at:

| Adapter | `url` | How the prefix reaches the app |
| --- | --- | --- |
| `cloudflarePages()` | refused | `_routes.json` sends it to Pages Functions |
| `cloudflareWorker()` | optional | a service binding named in `cloudflareWorker({ upstreams })`, or a `fetch` to `url` |
| `netlify()` | required | forced proxy rows in `_redirects` |
| `vercel()` | required | a route in `vercel.json` ahead of the files |
| `cloudfront()` | required | an origin and cache behaviours with caching disabled, in `upstreams.json` |
| `nginx()` | required | `proxy_pass` locations with TLS verification and WebSocket support |

On every host the site's header rules stay off the app's answers, and the
build refuses a header rule under a prefix, since it could never apply. So the
app sets its own headers, `Cache-Control` included: a host that caches
proxied answers, as Vercel does for a project created on or after 6 April
2026, caches what the app's `Cache-Control` allows. Hono runs on each of these
hosts with a different entry file. [Deploy a site](./deploy-a-site.md) and the
deploy recipe's "An app beside the site" give each host's steps.
