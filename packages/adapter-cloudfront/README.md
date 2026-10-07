# `@pagedeck/adapter-cloudfront`

Compiles a built site's routing document into CloudFront Functions and the
configuration fragments they need: a viewer-request function, a
viewer-response function, the 404 page's custom error response, and, past the
function size limit, a KeyValueStore dataset. It is the only adapter that
compiles an experiment split. Its refusals name it `cloudfront-function`.

```sh
npm install @pagedeck/adapter-cloudfront @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of cloudfront().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.

`cloudfront()` takes `limits`, a byte ceiling per role: `function` defaults to
`CLOUDFRONT_FUNCTION_LIMIT` (10 kB) and `dataset` to `CLOUDFRONT_KVS_LIMIT`
(5 MB). Raise one only if your account's limit is higher.

## CloudFront takes two functions

A viewer-request function runs before the origin has answered, so there is no
origin response for it to hang a header on; the response it can return is one
it synthesizes itself, which short-circuits and serves no document. A
viewer-response function runs after the origin has answered and cannot stop a
request. So the redirects and the headers compile to two artifacts, told apart
by `slot`. The 404 is neither: a function cannot serve a document out of the
bucket, so it compiles to the custom-error-response fragment instead.

The header table is in both functions. A redirect the viewer-request function
answers carries the set its `from` matches, written into the response it makes,
because whether CloudFront runs the viewer-response function over that response
is not verified. The viewer-response function gives a 404 the set of the 404
page's own path, not the path requested; see "Headers on the 404 page and on
redirects" below.

## Large redirect sets

The CloudFront Function code limit is 10 kB, and it applies to the function,
which cannot be split — a function cannot import a second file. So the redirect
table is what moves: past the limit it is emitted as a `dataset` and the
function reads one key per request, which makes the function's size independent
of the redirect count. The header table stays in the function, as it does in
the viewer-response function.

This is not what issue #33 called it. The criterion says "chunking", and the
only reading of chunking this host allows is sharding the table across several
functions, one cache behaviour each — which collapses on the flat-under-`/`
table a real migration has, where every rule lands in one shard. The
substitution is therefore raised on the issue for a decision
(#33, `issuecomment-5419538785`), not settled in this file.

Three things come with it, and none of them is left to be discovered at publish
time:

- **The runtime.** The inline form is ES5 and runs on `cloudfront-js-1.0`; the
  dataset form imports `cloudfront` and awaits a store read, which only compile
  on `cloudfront-js-2.0`. Every `function` artifact carries the one it needs in
  `runtime`. Read it — a function published on the other one is either rejected
  or accepted and inert.
- **Where the growth goes.** Moving the table out of the function does not
  remove a ceiling, it moves it onto the store, so the dataset is measured
  against the store's own quota (`CLOUDFRONT_KVS_LIMIT`, overridable through
  `limits.dataset`) by the same check that measures the function.
- **The association.** The dataset form emits
  `routing.request.config.json` — the `FunctionConfig` fragment that binds the
  store to the function, carrying the runtime, the name of the payload to
  import, and one named substitution, `${PAGEDECK_ROUTING_KVS_ARN}`, for the ARN a
  compiler cannot know. Apply it with the function
  (`create-function --function-config`), not to the distribution.

Deploying a site in that state is then: create a KeyValueStore, import
`routing.kvs.json` into it, substitute its ARN into
`routing.request.config.json`, publish the function with that config, and apply
`error-responses.json` to the distribution. Every file in that sentence is an
artifact of the compilation.

## Reserved deploy keys

The viewer-request function's first stage rewrites a denied
request to `/.pagedeck/unserved`, a key the origin never holds, so the request
misses and `error-responses.json` serves the 404 page. It matches on the path
S3 will read: decoded, with runs of slashes merged and `.` and `..` resolved.
Every tree now gets a viewer-request function for this, including a tree
with no redirects.

CloudFront runs one function per event type on a cache behaviour, so a
distribution with a viewer-request function of its own has to compose the two
into one.

## Experiment splits

A site that declares `build.routing.experiments` gets a page's variants built
as parallel static outputs under `/_v/<name>/` (#34), and the routing document
carries the split — page, cookie key, variants, weights. This
adapter compiles that into two stages, one in each
of the functions it already emits:

- **viewer-request** gains a rewrite stage. If the request path carries a
  split, `request.uri` becomes an arm's path: the arm the request's own cookie
  names, if it names a live one, and otherwise the arm derived below.
- **viewer-response** gains an assignment stage. If the request path carries a
  split and the request carried no usable arm, a `Set-Cookie` is written naming
  the arm the same derivation picks.

Both stages run the same `armFor`, emitted verbatim into each function, over
the same split entries. That is not tidiness. **Nothing travels between the two
invocations**: AWS's event structure says the `request` object a function
receives "represents the actual request that CloudFront received from the
viewer", so the second invocation sees the viewer's original URI and headers,
never the rewritten URI and never a header the first one set — the quote and
the URL are in
`docs/research/2026-09-02-cloudfront-functions-cross-invocation-state.md`. The
arm therefore cannot be chosen once and handed over — it is recomputed, from a
hash of `event.context.requestId` seeded with the split's own cookie key, which
both functions see and which the docs describe as identifying "a CloudFront
request (and its associated response)".

That fact is checked and then not leaned on. The viewer-response function's
table is keyed by the page's own path **and** by every arm's `/_v/<name>/…`
path, both naming one entry, so its lookup lands on the same split whichever of
the two it is handed. Keyed by the page alone it would miss a rewritten URI, no
cookie would ever be written, and nothing would say so. The viewer-request
function keeps the page's path as its only key, because rewriting a path that
is already an arm's would be wrong.

A held cookie naming a live arm wins in both halves. That is what makes an
assignment sticky, and it is also what heals the one failure mode the request
id has: if a request and its response ever failed to share an id, that visitor
is served arm X with a cookie set to arm Y, and their next request agrees with
the cookie.

No new artifact. A tree with redirects and a split compiles to the same
`routing.request.js` and `routing.response.js` #33 emits — the stages splice
into those two functions, so there is one thing to publish per event and the
size check measures the whole of it.

### Redirect before split

In the viewer-request function the redirect table is consulted first. A
redirect is an answer and a split is a rewrite: the redirect stage returns, so
running it first means the only path ever looked up in the redirect table is
the one the viewer asked for — which is what every row of that table was
written about. Reversed, a path this build minted (`/_v/b/en/pricing`) would be
matched against rules the author wrote about their own addresses, and any row
that hit would send the visitor to a redirect aimed at the primary with the arm
silently dropped.

### A no-cookie request is assigned and rewritten at once

**This is a decision the issue left open, it was first taken the other way, and
the maintainer overruled it.** Issue #35 asks for two things that read as
pulling against each other: "assigns a sticky cookie per configured weights and
rewrites to the variant path", and "crawlers/no-cookie requests get the
primary".

The first implementation deferred the rewrite: a cookie-less request was served
the primary and only assigned, so an arm appeared from the second visit onward.
That met the criterion's words and biased every experiment. A split landing
page showed the primary to 100% of first visits, so each arm's measured
population was conditioned on the visitor coming back — selection bias, not
sample loss, and it yields a number somebody acts on computed over the wrong
population. It compounds with `routing.ts`'s "The primary is not a member of
`variants`": a control is a named arm, so `a` vs `b` compared two arms whose
first impressions were both the primary.

**A request for a split's page is now rewritten on that same request, and the
cookie for the arm it was served goes out with the response.** SEO safety comes
from #34, which already emits every arm canonicalizing to the primary — the
standard consolidation pattern, needing no user-agent list and so introducing
no cloaking. What the criterion requires is that a crawler not have an arm
indexed _as its own page_, which the canonical delivers; it does not require
that a cookie-less request be served the primary's bytes.

The primary's path is the address, not a hidden control arm. Every request for
it is served some arm.

### The cookie

`Path=/; Max-Age=7776000; Secure; SameSite=Lax`, and each part is a choice:

- **`Max-Age`, 90 days.** Without it the assignment is a session cookie and the
  visitor is re-assigned on the next browser restart, which is not the
  stickiness the criterion asks for. 90 days is longer than an experiment run
  and short enough not to be a year-long identifier. It is not configurable —
  what is configurable is the split's _key_ (`cookie` on the rule), because that
  is the field a running experiment's assigned visitors carry across a config
  edit.
- **`SameSite=Lax`, not `Strict`.** `Lax` is sent on a top-level navigation, so
  a visitor arriving from a search result keeps their arm. `Strict` would
  re-assign them and count them twice.
- **Not `HttpOnly`.** Analytics of the experiment is out of scope here and is
  the site's own tooling; tooling that cannot read which arm it is in cannot
  report one.

### Weights, and the order they are walked in

Weights are relative shares and need not total anything, so the roll is taken
over the sum this compilation wrote into the table: `(hash / 2**32) * total`,
then the arms are walked accumulating weights until the roll is passed. It is a
multiplication and not `hash % total`, because a weight need not be an integer
and a modulo by a fractional total is not uniform.

The hash is djb2 with a final avalanche, and the avalanche is load-bearing:
djb2 shifts each character left as it folds the next in, so its top bits are
decided by the start of the seed and the roll reads the top bits. Without it,
measured over this package's own emitted code, two splits differing only in
their cookie key assigned the same arm on 50 request ids out of 50, and 2000
ids sharing a prefix gave a 1:1:2 split the shares 0:90:1910.

The arms are emitted
in the order the document holds them, and **nothing here sorts them**:
`ResolvedExperiment.variants` is already sorted by name, and that sort is what
stops a config reorder from re-randomizing every visitor who already holds a
cookie. A second sort in this package would be a second opinion about an order
core settled.

The arms are an array walked by name, not an object keyed by it. A variant name
is a path segment, and `__proto__` and `constructor` are legal ones — so a
keyed lookup would answer a member of `Object.prototype` for a cookie value
somebody typed, and `"__proto__"` in an object literal sets the prototype
rather than a key in the first place. Each arm's path is composed at compile
time by `variantPath` and emitted whole, so no cookie value is ever
concatenated into a URI.

### Other adapters

Only `cloudfront-function` compiles a split — issue #35 names it as the first
target and asks that the pattern be documented for others, which is what this
section is. The shape ports, and it is three rules: look the request path up in
a table of splits; pick the arm the request's cookie names if it names a live
one, and otherwise derive one by hashing a per-request value the host gives
both halves, seeded with the split's cookie key; serve that arm's path
internally, without a redirect, and set the cookie on the way out when the
request carried none. The derivation is only needed where the rewrite and the
`Set-Cookie` happen in two separate invocations, as they do here; a host that
handles a request and its response in one place can roll however it likes.

What does not port is the subset each of the other emitters is allowed to
produce. `@pagedeck/adapter-netlify` emits a whitespace-delimited table of exact
paths and `@pagedeck/adapter-nginx` emits `location` blocks, one `error_page`
and `add_header` — those subsets are what makes each adapter's
`interpret.test-support.ts` close to a transcription and the shared
conformance suite worth anything. Neither has a cookie in it, and widening
either one is a change to #33's proof rather than an addition to it.

**Compiling a document with splits with `@pagedeck/adapter-netlify`,
`@pagedeck/adapter-nginx` or `@pagedeck/adapter-cloudflare-worker` is
therefore refused, naming every page a split was declared on.** Emitting the rest would
ship a site that serves its primary to everyone and says nothing about it — a
site that looks entirely correct and runs no experiment, whose only evidence is
a flat line in an analytics tool weeks later.

## Recipe: suggesting a market from the visitor's country

CloudFront can tell a function where a request came from, and a market
suggestion is a good use for that. An automatic redirect is not: it makes a
page's canonical URL depend on who asked for it, which splits the crawler's view
of the site from the visitor's and hides half the markets from search entirely.

The pattern is to let the edge state a fact and let the page decide what to say
about it.

1. Enable `CloudFront-Viewer-Country` on the cache policy, so the header
   reaches the viewer-request function and is part of the cache key.
2. Add a stage to the viewer-request function that copies it to a hint the page
   can read, and does nothing else — no rewrite, no `Location`, no cookie that
   changes what is served:

   ```js
   var country = request.headers["cloudfront-viewer-country"];
   if (country) {
     request.headers["x-pagedeck-suggest-market"] = { value: country.value };
   }
   ```

3. Render a dismissible banner from that header — "Looks like you're in Canada.
   Visit the Canadian store?" — with a real link to the other market. The
   visitor stays on the URL they asked for, the link is crawlable, and the
   choice is theirs.

Two things to keep true. The suggestion must never be the only route to the
other market: the market switcher stays in the page for every visitor. And the
country must not reach the rendered HTML of a cached page unless the country is
in the cache key, or the first visitor's country is served to everyone behind
that edge.

This is a documented pattern, not a feature. This adapter ships no geo stage;
adding one would put a country in the routing document, which is a decision
about content, not about hosts.

## Known gaps

- **The two functions agree only because they share a request id.** If a
  CloudFront request and its response ever carried different `requestId`s, one
  request is served arm X with its cookie set to arm Y. Nothing here can detect
  that; it self-heals on the visitor's next request, because a held cookie wins
  in both halves.
- **Nothing here checks that the arms exist in the output tree.** The rewrite
  sends a request to `variantPath(name, path)`. `pagedeck build` writes each
  arm's page there, and this package does not check that it did; a mismatch is
  a 404 for one arm.
- **The JSON fragments have no reader in this repo.** `routing.kvs.json`,
  `routing.request.config.json` and `error-responses.json` are data whose shape
  is documented here and checked by nothing; a staging deploy is what would find
  them wrong. Creating the store and substituting its ARN also stays an operator
  step — what this package can do is emit every file that step consumes, and it
  now does.
- **The store's per-key and per-value quotas are not checked**, only its total
  size. A key over 512 bytes or a value over 1 kB is a redirect with a very
  long path, and it would fail at import rather than at build.
