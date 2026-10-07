# `@pagedeck/edge`

Compiles a built site's redirects, 404 page, response headers and experiment
splits into what one host serves: a CloudFront Function, Netlify's
`_redirects` and `_headers`, an nginx config fragment, or a Cloudflare Worker.
You declare them once, in `build.routing`. `pagedeck build` writes them into
the site's `manifest.json` as one document that names no host, and
`compileRouting` compiles that document for the host you choose. Experiment
splits compile for `cloudfront-function` only; see
[Experiment splits](#experiment-splits).

```sh
npm install @pagedeck/edge @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { compileRouting } from "@pagedeck/edge";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
const { artifacts } = compileRouting(manifest.routing, { target: "nginx" });
for (const artifact of artifacts) console.log(artifact.role, artifact.path);
```

Each artifact carries its text in `contents`, and its `role` says where it
goes, as [What comes out](#what-comes-out) lists.
[Routing](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/routing.md) covers `build.routing`.

This package only compiles. `compileRouting` takes the routing document from
the manifest and returns each target file as text. It reads no file, opens no
socket and calls no cloud API. `pagedeck build` does not call it, and no
`pagedeck` command uploads its output. Putting the files on your host is your
site's job.

## Targets

`cloudfront-function`, `netlify`, `nginx`, `cloudflare-worker`. Naming anything
else throws an error that lists them.

## What comes out

Every artifact carries a `role`, which says what a deployer does with it — not
what kind of bytes it holds. A CloudFront Function is not an object in a
bucket, and uploading it as one would leave the redirects inert while the
deploy reported success.

| `role`                | Where it goes                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `tree-file`           | Into the output tree, uploaded with the site (`/_redirects`, `/_headers`)                             |
| `function`            | Published as a CloudFront Function on the runtime named by `runtime`, and associated with a cache behaviour on the event named by `slot` |
| `dataset`             | Imported into the CloudFront KeyValueStore the function reads                                         |
| `function-config`     | A `FunctionConfig` fragment applied to the function beside it, not to the distribution                 |
| `distribution-config` | A `DistributionConfig` fragment CI applies to the distribution                                        |
| `server-config`       | `include`d inside the nginx `server` block that serves the tree                                       |
| `edge-module`         | Published as a Cloudflare Worker, with the tree's R2 bucket bound to it under the name in `binding`    |

### CloudFront takes two functions

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

### Large redirect sets

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

### nginx

The fragment is only `location` blocks, one `error_page`, and the two
server-level lines that deny the reserved deploy keys. It sets no `root`
and no `try_files`, because how a route becomes a filename is the build's
decision; include it inside a `server` block that already has both.

Locations are written **decoded**, because nginx decodes the request URI before
it selects one: a route stored as `/caf%C3%A9` is emitted as
`location = "/café"`, and written escaped it would match nothing. A redirect's
target is not decoded — it goes into a `Location` header, which is a URI. A
path that cannot survive the round trip is refused rather than emitted: `%2F`,
which nginx cannot tell from a real separator, an escape that is not valid
UTF-8, and anything decoding to a control character or a `$`.

### Cloudflare Worker

`cloudflare-worker` compiles each tree to one `worker.js`, an ES module Worker
that serves the tree from the R2 bucket bound to it as `PAGEDECK_ORIGIN`, the
name the artifact's `binding` records. The redirect table and the header table
are in the script. There is no dataset
form: the Workers script limit (`CLOUDFLARE_WORKER_LIMIT`, 3 MB, measured over
the text) holds a redirect table CloudFront has to move out of its function.

**The live manifest decides what is served.** On each request the Worker reads
`manifest.json` from the bucket and serves a path only when a row of that
manifest names it, as the path itself or as `<path>/index.html`. A deploy puts
`manifest.json` last, so a build's pages are served once it is live, and a
rollback, which puts the restored build's manifest, is served without
publishing the Worker again. A change to the routing is not: the redirects and
the header sets are compiled into the script, so the Worker is published again
whenever `worker.js` changes.

**An R2 key is the deploy key without its leading `/`.** `/en/about/index.html`
is stored as `en/about/index.html`, and a domain tree's `//shop.example/x` as
`/shop.example/x`. The signing step in `docs/deploy-recipe.md` writes the same
keys.

**Refused before any object is read**, with the site's 404:

- a reserved deploy key, matched on the decoded path with empty segments
  dropped, whether or not the manifest names it;
- a path whose decoded form holds a `.` or `..` segment or a control
  character, a path holding `\`, `%2F` or `%5C`, and a path that does not
  decode. The Worker takes the path from `request.url` as the runtime hands it
  over and does not parse it, so a dot segment the runtime passed through is
  still seen.

A method other than `GET` and `HEAD` is answered `405` and reads nothing. The
`405`, and the bare 404 of a tree with no 404 page, carry the set of the path
requested, so a site's security headers reach every response the Worker writes.

**A page carries the object's `ETag`, and a conditional request gets a `304`.**
A `200` carries the R2 object's `httpEtag`. A `GET` or `HEAD` whose
`If-None-Match` holds that etag, compared weakly (RFC 9110 §13.1.2, so
`W/"x"` matches `"x"`), or is `*`, is answered `304` with no body and every
header the `200` would carry. Without `If-None-Match`, an `If-Modified-Since`
at or after the object's `uploaded` time is answered `304` too. The Worker
sends no `Last-Modified`. A 404, a redirect and a `405` ignore both fields.

**A redirect sends only what the table holds.** The request path is never
written into a `Location`, and a redirect target that is not a tree-relative
path is refused at compile time by core's own `offsiteReason`, which
`planRouting` applies to the config.

A served object carries the `Content-Type` and `Cache-Control` the deploy
stored it with, and the routing set is written over them: a header rule that
sets `Cache-Control` wins.

### Headers on the 404 page and on redirects

Every response the tree's config answers carries a header set (#559): a page
the set of the prefix its path matches, a redirect the set its `from` matches,
and the 404 page the set of the prefix *its own path* matches, whatever path
was asked for. The oracle the equivalence check runs against claims exactly
this on every target.

The 404 rule is nginx's constraint, taken for every target. nginx never shares
`add_header` between sibling `location` blocks, so the lines in a `^~` prefix
block reach neither a redirect's exact location nor the 404 page's, which
`error_page` sends the request to. Each of those blocks carries the lines
itself, and one location's lines cannot vary with the request. The lines are
not at `server` level, because a location with an `add_header` of its own drops
every inherited one.

A host's own bare 404, on a tree with no 404 page, is outside the claim. On
nginx a missing path then carries the set of the prefix block that answered
it, and a reserved deploy key, refused before any location, carries none.

Two host facts this rests on are not verified, and `docs/deploy-recipe.md`
lists them: whether Netlify matches `_headers` against a `404` row's target,
and whether CloudFront runs the viewer-response function over a custom error
response.

### Reserved deploy keys

A reserved deploy key is one of the few tree-relative keys the deploy writes
for itself rather than for the site; "deploy key" alone means any key a deploy
writes. A deploy publishes the build's manifest at `/manifest.json` and files a copy of
it, with its deploy instant, under `/.pagedeck/manifests/`. Nothing in a browser
reads either, and the deploy reads the origin directly, so every tree on every
target answers `/manifest.json`, `/.pagedeck` and everything under `/.pagedeck/` with the
site's 404 — the response a missing page gets — or a bare 404 where the tree
has no 404 page (#556). A site does not ask for this and cannot turn it off:
`planRouting` refuses a page or a redirect at these paths, and a header rule
that covers them sets headers on the 404 and serves no file.

- **CloudFront**: the viewer-request function's first stage rewrites a denied
  request to `/.pagedeck/unserved`, a key the origin never holds, so the request
  misses and `error-responses.json` serves the 404 page. It matches on the path
  S3 will read: decoded, with runs of slashes merged and `.` and `..` resolved.
  Every tree now gets a viewer-request function for this, including a tree
  with no redirects.
- **Netlify**: the first three rows of `_redirects`, forced with `404!` so they
  beat the files the origin holds. Whether Netlify matches a percent-escaped
  spelling such as `/%2Epagedeck/…` against these rows is the host's behavior, which
  CI cannot run.
- **nginx**: two `if ($uri …) { return 404; }` lines at server level. They run
  before any `location` is selected, which is the only place that holds: a
  header rule's `^~` prefix under `/.pagedeck/` would be longer than any deny prefix
  and win. `$uri` is already decoded, merged and resolved, and carries no query
  string.

So every tree compiles to artifacts, even a tree that declares nothing: a
viewer-request function, a `_redirects` file, or an nginx fragment, which a
host has to install like any other. CloudFront runs one function per event
type on a cache behaviour, so a distribution with a viewer-request function of
its own has to compose the two into one.

### Trailing slashes

The site's policy (`RoutingManifest.site.trailingSlash`) is not only a spelling
rule for emitted links. Spec §11 asks that it stop "S3/CloudFront resolution
quirks" creating duplicate-content URLs, and a request for the spelling the site
does not publish is exactly that quirk: S3 behind CloudFront will often resolve
`/pricing/` to the same object as `/pricing`, and the page is live at two
addresses.

So every address the document names — each redirect's source and each
redirect's target — also gets a rule on its other spelling, sending it to the
canonical one. A source's other spelling answers what the source answers, so
neither spelling costs an extra hop; a target's other spelling is a 308 to the
page. On Netlify these rows are forced (`301!`), because an unforced rule loses
to the file the origin holds — which is the file being redirected away from.

Not as a site-wide pattern, deliberately: `_redirects` cannot express "a path
ending in a slash" (a splat is only valid last), so a pattern rule would give
two of the three targets a behavior the third does not have. An exact row per
address is what all three spell identically.

The 404 page is excluded. It is not an address — nginx serves it `internal` —
so a rule pointing at it would publish the one page the targets refuse to serve
directly.

## Experiment splits

A site that declares `build.routing.experiments` gets a page's variants built
as parallel static outputs under `/_v/<name>/` (#34), and the routing document
carries the split — page, cookie key, variants, weights. On
`cloudfront-function`, this package compiles that into two stages, one in each
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

### Other targets

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

What does not port is the subset each of the other two emitters is allowed to
produce. `netlify.ts` emits a whitespace-delimited table of exact paths and
`nginx.ts` emits `location` blocks, one `error_page` and `add_header` — those
subsets are what makes `interpret.test-support.ts` close to a transcription and
`equivalence.test.ts` worth anything. Neither has a cookie in it, and widening
either one is a change to #33's proof rather than an addition to it.

**Compiling a document with splits for `netlify`, `nginx` or
`cloudflare-worker` is therefore refused, naming every page a split was
declared on.** Emitting the rest would
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

This is a documented pattern, not a feature. `@pagedeck/edge` ships no geo stage;
adding one would put a country in the routing document, which is a decision
about content, not about hosts.

## Known gaps

- **A split is compiled for one target only.** `netlify`, `nginx` and
  `cloudflare-worker` refuse to compile one, so a site that wants an
  experiment has to compile for `cloudfront-function`; the pattern for
  the others is documented above and not implemented.
- **The Worker reads and parses `manifest.json` on every request**, a `304`
  included.
- **The two functions agree only because they share a request id.** If a
  CloudFront request and its response ever carried different `requestId`s, one
  request is served arm X with its cookie set to arm Y. Nothing here can detect
  that; it self-heals on the visitor's next request, because a held cookie wins
  in both halves.
- **Nothing here checks that the arms exist in the output tree.** The rewrite
  sends a request to `variantPath(name, path)`. `pagedeck build` writes each
  arm's page there, and this package does not check that it did; a mismatch is
  a 404 for one arm.
- **No default header set.** A site that declares no `build.routing.headers`
  compiles an empty header table on every target, and `pagedeck build` warns
  about it. `SECURITY_HEADERS` from `@pagedeck/core` holds three headers to
  spread into a rule over `/`.
- **No `pagedeck` command calls `compileRouting`.** You call it yourself, as
  the example at the top does.
- **No artifact hashes.** The manifest records no hash of a compiled artifact,
  so a deploy cannot tell an unchanged function from a changed one and skip
  publishing it.
- **The JSON fragments have no reader in this repo.** `routing.kvs.json`,
  `routing.request.config.json` and `error-responses.json` are data whose shape
  is documented here and checked by nothing; a staging deploy is what would find
  them wrong. Creating the store and substituting its ARN also stays an operator
  step — what this package can do is emit every file that step consumes, and it
  now does.
- **The store's per-key and per-value quotas are not checked**, only its total
  size. A key over 512 bytes or a value over 1 kB is a redirect with a very
  long path, and it would fail at import rather than at build.
- **Trailing-slash normalization covers the addresses the document names, and
  no others.** A page that is neither a redirect source nor a redirect target
  gets no normalizing rule, because the routing document is not a page
  inventory; its other spelling is still answered by the origin.
