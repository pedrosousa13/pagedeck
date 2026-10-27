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
  headers: [
    {
      prefix: "/",
      set: [...SECURITY_HEADERS, { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY }],
    },
  ],
  upstreams: [
    { prefix: "/api/", dev: "http://127.0.0.1:8787", source: "src/app.ts" },
    { prefix: "/account/", dev: "http://127.0.0.1:8787", source: "src/app.ts" },
  ],
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

## The app answers its prefixes

The app is a Hono app whose routes start with `/api` or `/account`. Under
`/api` it answers a sign-up, and checks the address itself, in `src/app.ts`:

```ts
const app = new Hono()
  .use(secureHeaders())
  .use(async (c, next) => {
    await next();
    c.header("Cache-Control", "private, no-store");
  })
  .onError((error, c) =>
    wantsJson(c)
      ? c.json({ error: "Something went wrong. Try again." }, error instanceof HTTPException ? error.status : 500)
      : c.redirect("/signup/failed/", 303),
  )
  .route("/account", account)
  .basePath("/api")
  .use(csrf())
  .post(
    "/signup",
    validator("form", (value: { email?: string | File | (string | File)[] }, c) => {
      const { email } = value;
      if (typeof email !== "string" || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
        return wantsJson(c)
          ? c.json({ error: "Enter an email address." }, 422)
          : c.redirect("/signup/invalid/", 303);
      }
      return { email };
    }),
    (c) =>
      wantsJson(c)
        ? c.json({ message: `Thanks. We will write to ${c.req.valid("form").email}.` }, 201)
        : c.redirect("/signup/thanks/", 303),
  );

export type AppType = typeof app;
```

The app's check is the one that counts. The island's `type="email"` stops
some mistakes before a request, but anyone can send the app any body, and the
two checks differ: a browser takes `reader@localhost`, and the app, which
wants a dot in the domain, refuses it with a `422`.

The two middlewares are registered before `basePath`, so they run for every
request the app answers, and not only for the ones under `/api`. The next
section says why that matters. The error handler answers every error with the
same text, so a stack trace, a message from a library or a credential in an
error never reaches the visitor. A path with no file is not an error: Hono
answers it with its own `404`.

The app reads the form's own encoding, the body a browser sends for a
`<form method="post">`, and answers in two ways. A request that asks for JSON
with `Accept: application/json` is the island's, and gets JSON. Any other
request is a form posted without JavaScript, and gets a `303` redirect to a
built page, as described below.

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
    "run_worker_first": ["/api/*", "/account/*"]
  },
  "kv_namespaces": [{ "binding": "SESSIONS" }]
}
```

`assets.directory` is the build's output. `run_worker_first` sends every
request under `/api/` and `/account/` to the app before Cloudflare looks for a
file. Every other request is answered from `site/`, so a built page never runs
the app.
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
wrangler reads that file only from `site/`, so the config passes `public/`
through with `passthrough: { root: "./public" }`. Without it, a deploy serves
`/_routes.json` and `manifest.json` to anyone who asks. `wrangler dev` serves
them locally either way.

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
second middleware marks every answer `private, no-store`, so no cache, shared
or the browser's own, keeps a reply written for one visitor.

## The island calls the app by its type

The form on `/signup/` is an island. It imports the app's type, never its
code, and builds a client from it, in `src/components/signup.tsx`:

```tsx
import { hc } from "hono/client";
import { useId, useRef, useState } from "react";
import type { AppType } from "../app.js";

const client = hc<AppType>("/");
```

`hc<AppType>` knows each route, its input and its answers, so `tsc` fails on a
wrong path, a missing field or a misread answer in the call below. The island
sends the request and turns every answer into a state, in
`src/components/signup.tsx`:

```tsx
async function send(email: string): Promise<Status> {
  try {
    const response = await client.api.signup.$post(
      { form: { email } },
      { headers: { Accept: "application/json" } },
    );
    if (response.status === 201) return { phase: "sent", text: (await response.json()).message };
    if (response.status === 422) return { phase: "refused", text: (await response.json()).error };
  } catch {
    // A request that never arrived, or a body that is not the JSON its status promised.
  }
  return { phase: "failed" };
}
```

The types describe what the app sends, not what reaches the browser. A proxy,
the host or a dropped connection can answer instead, with an HTML error page
or nothing at all. So `send` reads a body only for the app's `201` and its
`422` refusal, and turns everything else into one failure: a `5xx`, a `403`,
a `400` for a body the app could not read, a body that is not JSON and a
`fetch` that rejects. Only the `422` marks the field as wrong. It never shows text it did not
expect, so nothing from an error page reaches the visitor, and no rejection
goes unhandled.

`import type` matters. TypeScript erases it, so nothing from `src/app.ts`
reaches the browser. A plain `import` of a value from the app would put server
code, and anything it holds, into the island's chunk. Because the upstream
names `src/app.ts` as its `source`, `pagedeck build` refuses that import, and
names the module that made it and the fix.

## Pending, failure and retry

The submit handler, in `src/components/signup.tsx`:

```tsx
onSubmit={async (event) => {
  event.preventDefault();
  if (sending.current) return;
  sending.current = true;
  setStatus({ phase: "pending" });
  setStatus(await send(email));
  sending.current = false;
}}
```

Each state is announced in one `role="status"` paragraph, which a screen
reader reads out when its text changes: "Signing up…" while the request is
out, the app's answer after it, and a fixed failure message that says the
address is still in the form. A refusal also sets `aria-invalid` on the field
and points its `aria-describedby` at the message. The field keeps what the
visitor typed after every answer, so a retry is one more press of the button.

While the request is out, the button is marked `aria-disabled`. It is not
`disabled`, because disabling the focused button moves focus to the page
body. The form is not marked `aria-busy`, because a screen reader may hold
back the announcements of a busy region until it is no longer busy, and the
status paragraph is inside the form.

## One submit at a time, and what that does not cover

The handler refuses a second submit while one is out. It checks a ref, not
state, because two presses can arrive before React renders the first one's
state. That stops a double click from one form sending two requests.

It does not make the request idempotent. The same sign-up can still reach the
app twice: from two tabs, from a retry after an answer that was lost on the
way back, or from a form posted twice without JavaScript. The example has no
side effect, so a repeat costs nothing. An app that sends mail, takes a
payment or writes a row must make a repeat harmless on the server: with a
unique key on what it stores, such as the address, or with an idempotency key
the client sends and the app remembers for a time.

## The form works before the island does

The island renders a real form, in `src/components/signup.tsx`:

```tsx
<form
  method="post"
  action="/api/signup"
  onSubmit={async (event) => {
```

Before the island hydrates, or with JavaScript off, a press of the button
posts the form to the app like any HTML form. The address goes in the request
body. Without `method="post"`, a form sends a `GET` to its `action`, so the
address would land in the URL of `/api/signup?email=…`, where it reaches the
history, the server's logs and the `Referer` of the next request.

The app answers that post with a `303` to a built page: `/signup/thanks/` on
success, `/signup/invalid/` on a refusal, and `/signup/failed/` on any other
error, such as a post from another site or a body it could not read. No URL
holds the address, and a reload of the page does not post the form again. The
pages are static files in `content/signup/`, with a `0b` budget each.

One limit remains. The pages are the same for every visitor, so they cannot
say which address was signed up or quote the app's message. After a refusal
or a failure, the visitor goes back to the form, which most browsers restore
with what was typed.

## Request protection

Four different things protect an endpoint, and the sign-up applies only the
first two:

- **Same-origin `fetch`.** The island calls the app on the site's own origin,
  so it needs no CORS. The app sends no CORS headers, so a script on another
  site cannot read an answer.
- **CSRF protection.** Another site can still make a visitor's browser post a
  form to the app, since a form post needs no CORS. `csrf()` from
  `hono/csrf` refuses a form post unless `Sec-Fetch-Site` is `same-origin` or
  `Origin` is the app's own. Behind `pagedeck dev`, the app's URL is not the
  page's origin, and `Sec-Fetch-Site` is the header that passes.
- **Authentication** says who is asking. The sign-up is open to anyone, so it
  has none. The account, below, checks a session on every request, and a
  session cookie is the reason CSRF protection matters.
- **Abuse controls** limit how much anyone can ask: rate limits, a challenge
  for bots, a limit on body size. They belong to the host or a layer in front
  of the app, such as a rate-limiting rule on Cloudflare, and the example
  shows none.

## An account the app owns

The example has a small account area under `/account/`. The app answers every
request under it, and the build writes no page there, so ADR-0010's rule holds:
a prefix never covers a built page, and `pagedeck build` refuses one that does.
A page that shows account data is a static page with an island that fetches
from the account, never a page the app gates.

Signing in checks a credential, stores a session and sets a cookie, in
`src/account.ts`:

```ts
async (c) => {
  const { email, password } = c.req.valid("form");
  const signedIn = await checkCredential(c.env, email, password);
  if (signedIn === undefined) return c.json({ error: "The email or password is wrong." }, 401);
  const seconds = lifetime(c.env);
  const previous = await cookieKeyOf(c);
  if (previous !== undefined) await c.env.SESSIONS.delete(previous);
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const session: Session = { email: signedIn, expiresAt: Date.now() + seconds * 1000 };
  await c.env.SESSIONS.put(await keyOf(token), JSON.stringify(session), {
    expirationTtl: Math.max(seconds, KV_MINIMUM_TTL),
  });
  setCookie(c, COOKIE, token, { ...COOKIE_OPTIONS, httpOnly: true, sameSite: "Lax", maxAge: seconds });
  return c.json({ email: signedIn }, 200);
},
```

The session lives on the server, in a Workers KV namespace bound as
`SESSIONS`. The cookie holds only a random token, and the store is keyed by the
token's SHA-256 digest, so a copy of the store signs nobody in. Each cookie
attribute does one job:

- the `__Host-` prefix, which `prefix: "host"` adds, makes the browser refuse
  the cookie unless it is `Secure`, has `Path=/` and names no `Domain`, so
  another host under the same domain cannot set or replace it;
- `HttpOnly` keeps it from scripts, an island's included;
- `Secure` sends it over HTTPS only;
- `SameSite=Lax` leaves it off a `POST` from another site.

Every request under `/account/` checks the session again, on the server, in
`src/account.ts`:

```ts
async function sessionOf(c: Context<{ Bindings: AccountEnv }>): Promise<Session | undefined> {
  const key = await cookieKeyOf(c);
  if (key === undefined) return undefined;
  const stored = await c.env.SESSIONS.get(key);
  if (stored === null) return undefined;
  const session = JSON.parse(stored) as Session;
  if (Date.now() < session.expiresAt) return session;
  await c.env.SESSIONS.delete(key);
  return undefined;
}
```

`GET /account/me` answers `401` and clears the cookie when there is no
session. That covers an anonymous request, a cookie the app never issued, a
session past its lifetime and one signed out. Signing out deletes the session
from KV, so a copy of the cookie kept after sign-out is refused too: the
session is revocable, which a cookie that carries its own signed claims is
not. A new sign-in deletes the session the visitor's cookie already held, so
signing in again revokes the previous session. The app checks the expiry time itself, because KV keeps an entry for 60
seconds at least, and a session can be shorter. `SESSION_SECONDS` sets the
lifetime, an hour by default.

The account takes the same request protection as the form: `csrf()` from
`hono/csrf` refuses a sign-in or sign-out from another site, and
`SameSite=Lax` keeps the cookie off one anyway. Every answer, a refusal
included, is `private, no-store`, so neither a shared cache nor the browser
keeps one visitor's account for the next.

The credential is a Worker secret, set with `wrangler secret put`, and
`wrangler dev` reads it from `.dev.vars` beside `wrangler.jsonc`. It is never
in the source, so it is never in the app's bundle, in `site/` or in an island's
props, and `wrangler dev` prints a secret's name but never its value. The
example's test writes a fresh credential at run time and searches `site/`, the
bundle and wrangler's output for it and for every session it was issued.

### Where an identity provider plugs in

The stub signs in one account, whose email and password are the secrets
`ACCOUNT_EMAIL` and `ACCOUNT_PASSWORD`, in `src/account.ts`:

```ts
async function checkCredential(env: AccountEnv, email: string, password: string): Promise<string | undefined> {
  if (!env.ACCOUNT_EMAIL || !env.ACCOUNT_PASSWORD) return undefined;
```

A real site replaces `checkCredential`, and keeps the rest. With an OpenID
Connect provider, sign-in becomes a redirect to the provider, and a callback
route under `/account/` checks the provider's answer and then creates the
session the same way. The session, the cookie, the expiry and sign-out do not
change. Pagedeck integrates no provider, and adds no auth to core.

## A preview only editors can load

Two different things protect a site, and they belong to different layers:

- **Page protection** decides who may load a page at all. A built page is a
  static file the host serves without running the app, so only the host can
  protect it. The preview build, with drafts the public must not see, is
  protected this way.
- **API authorization** decides what a request to the app may do. The app
  checks it on every request, as the account above does.

Nothing in a page protects it. `noindex` asks crawlers not to list a page, a
link left out of the navigation hides it from people who click, and a client
redirect runs only if the browser runs it. A request for the file still gets
the file. [The preview app](../reference/preview.md) authenticates nothing for
the same reason.

So the preview is a second Workers Static Assets deployment with no code,
served on one custom domain behind Cloudflare Access, `wrangler.preview.jsonc`:

```json
{
  "name": "pagedeck-app-example-preview",
  "compatibility_date": "2026-10-01",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "preview.app-example.example", "custom_domain": true }],
  "assets": {
    "directory": "./site",
    "html_handling": "auto-trailing-slash"
  }
}
```

Access protects a hostname, so every other way to reach the Worker must be
off. `workers_dev: false` removes the `workers.dev` route, and
`preview_urls: false` removes the version and preview URLs, which are public
when on (<https://developers.cloudflare.com/workers/configuration/previews/>).
Set both: when a field is left out, wrangler keeps whatever the Worker had
before. Deploy it with
`wrangler deploy --config wrangler.preview.jsonc`, then add a self-hosted
Access application for `preview.app-example.example` with a policy that
admits your editors. The example points `assets.directory` at its own `site/`
so a dry run has a tree to check. Point yours at the preview build's own
directory, and never deploy that build to the public Worker.

Everything on the preview host is behind Access, the build's assets included,
so the preview build holds no public renderer asset. The public site serves
its own copy of each file it needs.

### The live checklist

A local run cannot show that Access is on, so run this against the live hosts
after you set the deployment up and after each change to it, from the
example's `README.md`:

```sh
curl -sI https://preview.app-example.example/ | head -n 1
curl -sI https://preview.app-example.example/favicon.ico | head -n 1
curl -sI "https://pagedeck-app-example-preview.$SUBDOMAIN.workers.dev/" | head -n 1
```

1. **Access on the preview host.** The first two requests answer a redirect
   to your Access team domain, for a page and for a file alike, and never
   `200`.
2. **`workers.dev` off.** The third answers no preview page.
3. **Preview URLs off.** The Worker's Settings, Domains & Routes, in the
   dashboard, show Preview URLs disabled.
4. **Direct origin refused.** The same page lists the preview domain and no
   other route or domain, so no host serves the preview without Access.

The example's test checks what can run locally: the preview config's fields
and a dry run of its deploy, and for the account an anonymous request, an
anonymous request to another path under `/account/`, sign-in, sign-out, an
expired session, a sign-in or sign-out from another site and each answer's
headers, against `wrangler dev`.

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
  `form-action` to allow the calls. The example's, in `src/csp.ts`, has both.

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
