# App example

A Pagedeck site with an app beside it (#141, ADR-0010). The site's pages are
static files. Requests under `/api/` and `/account/` go to a
[Hono](https://hono.dev) app that runs as the Worker on Cloudflare Workers
Static Assets. Pagedeck never imports
or runs the app: `build.routing.upstreams` declares the prefix, which the build
checks against every path it writes, `wrangler.jsonc` routes it, which the build
checks against the prefix (#145), and the island on
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

The account signs in one stub account, whose credential `wrangler dev` reads
from `.dev.vars` beside `wrangler.jsonc`. Write it there, and never in a file
the build or git can reach (`.dev.vars` is gitignored):

```sh
printf 'ACCOUNT_EMAIL=editor@example.com\nACCOUNT_PASSWORD=%s\n' "$(openssl rand -hex 16)" > .dev.vars
```

`src/site.build.test.ts` does the same and sends requests to both halves.
`pnpm test:app-form-harness`, from the repository root after `pnpm build`,
drives the form in Chromium against `wrangler dev`.

To develop, keep `wrangler dev` running and start `node ../core/dist/bin.js dev`
beside it. The config's upstream entry forwards `/api/` from the dev server to
`wrangler dev` on `http://127.0.0.1:8787`.

## Releases

`node src/release.ts prepare`, after a build, writes `releases/<build id>/`:
the built `site/`, `wrangler.jsonc`, the app bundled with its build id, and
`release.json`. `wrangler deploy worker/app.js --no-bundle` in that directory
deploys it, and deploys it again to restore it. `GET /api/release` answers the
id the app was bundled with, or `null` under `wrangler dev`.
`node src/release.ts check <build id> --live <origin>` refuses a release that
was not built on the one live. The deploy recipe's "A site and its app:
releases and recovery" is the runbook, and `src/release.build.test.ts` runs it
against `wrangler dev`.

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
  answers with a `303` to `/signup/thanks/`, `/signup/invalid/` or
  `/signup/failed/`, and no URL ever holds the address.

[Run an app beside the site](../docs/how-to/run-an-app-beside-the-site.md)
explains each choice, and the difference between same-origin `fetch`, CSRF
protection, authentication and abuse controls.

## The account

The app owns `/account/`, and no built page is under it (ADR-0010):

- `POST /account/sign-in` checks a stub credential, the Worker secrets
  `ACCOUNT_EMAIL` and `ACCOUNT_PASSWORD`, and answers `401` for any other. On a
  match it stores a session in the `SESSIONS` KV namespace and sets a
  `__Host-session` cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
- `GET /account/me` reads the session on every request and answers `401`
  without one, for a revoked or expired one, or for a cookie it never issued.
- `POST /account/sign-out` deletes the session from KV and clears the cookie.
- A new sign-in deletes the session the visitor's cookie already held, so it
  revokes the previous session.
- A revocation takes effect at once in the location where it was made, where
  a kept copy of the cookie is then refused. KV is eventually consistent, so
  another location can still accept that copy for about 60 seconds. A site
  that needs revocation to hold everywhere at once keeps its sessions in a
  strongly consistent store, such as Durable Objects or D1.
- A session lasts `SESSION_SECONDS`, an hour unless that variable is set. The
  app checks the time itself, since KV keeps an entry for 60 seconds at least.
- `hono/csrf` refuses a sign-in or sign-out posted from another site, as it
  does for the form.
- Every answer is `Cache-Control: private, no-store`, with the app's security
  headers.

To deploy it, set the secrets with `wrangler secret put ACCOUNT_EMAIL` and
`wrangler secret put ACCOUNT_PASSWORD`. The binding names no KV namespace id,
so wrangler creates one on the first deploy and writes its id into
`wrangler.jsonc`. A real site replaces the stub with its identity provider, as
[Run an app beside the site](../docs/how-to/run-an-app-beside-the-site.md)
describes.

`POST /account/sign-in` checks the credential on every request and counts no
attempts. The stub's password is random, but a site that signs in a password a
person chose needs an attempt limit on that endpoint, at the host or in the
app. Abuse controls belong to the host, and the example sets none. On
Cloudflare, a rate limiting rule sets one
(<https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/>):

- **If incoming requests match:**
  `http.request.method eq "POST" and http.request.uri.path eq "/account/sign-in"`.
  The Free plan offers only the path field, and
  `http.request.uri.path eq "/account/sign-in"` alone does the same job, since
  the app takes only a `POST` there.
- **With the same characteristics:** IP.
- **Requests and period:** 5 requests per minute. The Free plan fixes the
  period at 10 seconds.
- **Action:** Block, which answers `429` by default, for a duration of
  10 minutes.

After you deploy the rule, send more attempts than it allows, with a wrong
password, from an address you can afford to block for 10 minutes:

```sh
for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    -H 'Origin: https://app-example.example' \
    -d 'email=editor@example.com' -d 'password=wrong' \
    https://app-example.example/account/sign-in
done
```

The first attempts print `401` and, once the count passes the limit, `429`.
Put your own host in both places. `hono/csrf` accepts a post whose `Origin`
is the app's own, so a wrong password answers `401` and not `403`.

## The protected preview

`wrangler.preview.jsonc` is a second Worker with no code for the preview
build: one custom domain, no `workers.dev` route and no preview URLs. Cloudflare
Access in front of that domain is what protects it. The file points at
`./site` so that `wrangler deploy --dry-run --config wrangler.preview.jsonc`
has a tree to check; a real preview build is its own build, in its own
directory. `src/site.build.test.ts` runs that dry run and holds the file to
the fields below.

Nothing local can show that Access is on, so after each change to the preview
deployment, run these against the live hosts:

```sh
curl -sI https://preview.app-example.example/ | head -n 1
curl -sI https://preview.app-example.example/favicon.ico | head -n 1
curl -sI "https://pagedeck-app-example-preview.$SUBDOMAIN.workers.dev/" | head -n 1
```

[Run an app beside the site](../docs/how-to/run-an-app-beside-the-site.md),
"The live checklist", says what each must answer and what to check in the
dashboard.

## What answers what

| Request | Answered by | Headers from |
| --- | --- | --- |
| a built page, such as `/` or `/signup/` | Workers Static Assets, from `site/` | `site/_headers`, written by the build |
| `/signup/thanks/`, `/signup/invalid/`, `/signup/failed/` | Workers Static Assets, from `site/` | `site/_headers`, written by the build |
| `/api` and `/api/*` | the app, because `run_worker_first` names them | the app's own middleware |
| `/account` and `/account/*` | the app, because `run_worker_first` names them | the app's own middleware |
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
| `/signup/` | `63kb` (64512 B) | 55519 B (#89) | `pagedeck-core` 54416 B, `pagedeck-startup` 888 B, entry 215 B |
| `/signup/thanks/`, `/signup/invalid/`, `/signup/failed/` | `0b` | 0 B (#159) | no chunks |

The island and Hono's client are in `pagedeck-core`, since the site has one island.
The whole build's JavaScript is held to 64 kB Brotli (65536 B), against 56451 B
measured (#89), counting the 932 B `slot` chunk. #159's pending, failure and retry
states added 318 B to `/signup/` (55237 B on #141), and no limit changed.
