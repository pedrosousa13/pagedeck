# App example

A Pagedeck site with an app beside it (#141, ADR-0010). The site's pages are
static files. Requests under `/api/` go to a [Hono](https://hono.dev) app that
runs as the Worker on Cloudflare Workers Static Assets. Pagedeck never imports
or runs the app: `build.routing.upstreams` declares the prefix, which the build
checks against every path it writes, `wrangler.jsonc` routes it, and the island on
`/signup/` calls the app through Hono's typed client, importing only its type.

[Run an app beside the site](../docs/how-to/run-an-app-beside-the-site.md)
walks through it. Every code sample there is copied from this package.

## Run it

Build the workspace once with `pnpm build` from the repository root. Then, in
`packages/app-example`:

```sh
node ../core/dist/bin.js sync
node ../core/dist/bin.js build      # writes site/
pnpm exec wrangler dev              # serves site/ and the app on one origin
```

`src/site.build.test.ts` does the same and sends requests to both halves.
`pnpm test:app-form-harness`, from the repository root after `pnpm build`,
drives the form in Chromium against `wrangler dev`.

To develop, keep `wrangler dev` running and start `node ../core/dist/bin.js dev`
beside it. The config's upstream entry forwards `/api/` from the dev server to
`wrangler dev` on `http://127.0.0.1:8787`.

## The form

The form on `/signup/` is a reference for a form an island submits:

- it shows a pending, a success, a refusal and a failure state in one
  `role="status"` paragraph, and keeps the address for a retry;
- it sends one request at a time from one form, which is not server-side
  idempotency: an app with a real side effect still makes a repeat harmless;
- a failure that is not the app's JSON, or a `fetch` that rejects, shows fixed
  text, and the app answers every error with fixed text;
- the app checks the address, and refuses a form posted from another site
  with `hono/csrf`;
- before hydration or without JavaScript it is a plain `POST`, which the app
  answers with a `303` to `/signup/thanks/` or `/signup/invalid/`, and no URL
  ever holds the address.

[Run an app beside the site](../docs/how-to/run-an-app-beside-the-site.md)
explains each choice, and the difference between same-origin `fetch`, CSRF
protection, authentication and abuse controls.

## What answers what

| Request | Answered by | Headers from |
| --- | --- | --- |
| a built page, such as `/` or `/signup/` | Workers Static Assets, from `site/` | `site/_headers`, written by the build |
| `/signup/thanks/`, `/signup/invalid/` | Workers Static Assets, from `site/` | `site/_headers`, written by the build |
| `/api/*` | the app, because `run_worker_first` names it | the app's own middleware |
| a path with no file | the app, because `not_found_handling` is `none` | the app's own middleware |

`_headers` never applies to a response the Worker writes
(<https://developers.cloudflare.com/workers/static-assets/headers/>), so the
app sets its own headers, and registers its middleware before `basePath` so a
miss gets them too.

## Budgets

The limits in `pagedeck.config.ts` are measured. Each one is the measurement
plus about 16%, rounded to a whole kilobyte. If a limit starts to fail, measure
again and give the reason. Do not raise it to make the failure go away.

| Page | Limit | Measured | Made of |
| --- | --- | --- | --- |
| `/` | `0b` | 0 B (#141) | no chunks |
| `/signup/` | `63kb` (64512 B) | 55539 B (#159) | `fw-core` 54453 B, `fw-startup` 881 B, entry 205 B |
| `/signup/thanks/`, `/signup/invalid/` | `0b` | 0 B (#159) | no chunks |

The island and Hono's client are in `fw-core`, since the site has one island.
The whole build's JavaScript is held to 64 kB Brotli (65536 B), against 56466 B
measured, counting the 927 B `slot` chunk. #159's pending, failure and retry
states added 302 B to `/signup/` (55237 B on #141), and no limit changed.
