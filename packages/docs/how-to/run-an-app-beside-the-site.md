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
so the app can use any framework that answers HTTP.

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

`pagedeck dev` does not forward requests to the app yet, so the island's calls
work under `wrangler dev`, after a build.

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

One request reaches the app without matching the prefix: a path with no file.
With `not_found_handling` set to `none`, Cloudflare hands a miss to the
Worker. That is why the middlewares come before `basePath`. Registered after
it, they would skip a miss, and its `404` would go out with no headers.

Keep the prefix clear of every page the build writes. Today nothing checks
that a page path does not start with `/api/`. Issue
[#141](https://github.com/pedrosousa13/pagedeck/issues/141) adds a field that
declares the prefix and makes the build refuse a page under it.

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
code, and anything it holds, into the island's chunk. The example's
`site.build.test.ts` checks that no file the build writes holds the app's
error message.

## One origin, so nothing to configure

The app answers on the site's own origin, so:

- the island calls `/api/signup` with no base URL and no CORS;
- a cookie the app sets with `Path=/` is sent with every later request to the
  site, pages and app alike;
- a `Content-Security-Policy` needs only `'self'` in `connect-src` and
  `form-action` to allow the calls.

## Other hosts

Each host has its own way to send a prefix to code beside static files: a
function with a `path` on Netlify, a function route on Vercel, a second origin
and cache behaviour on CloudFront, and a `location` with `proxy_pass` in
nginx. Hono runs on most of them with a different entry file. Pagedeck's
adapters do not write that routing yet; #141 tracks it.
