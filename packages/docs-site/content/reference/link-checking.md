---
section: reference
title: Link checking
description: Every build checks the links, scripts and assets its pages reference, and three settings decide whether a broken one fails the build or warns.
---

# Link checking

Every build checks what its own pages point at. A `<script src>` that names a
chunk the bundler emitted under a different name, an `<a href>` to a page nobody
routes — both are links that were correct in somebody's head and 404 in a
browser, and a build is the only thing holding the URL and the file it names at
the same time.

The check is **on by default and refuses the build**, so a site that says
nothing gets it. `build.links` is how a site says something else:

```ts
build: {
  outDir: "./site",
  links: { broken: "warn" },
  // ...
}
```

## What is checked, and how each kind resolves

Two kinds of reference, and they resolve differently because they name
different things.

**Asset references name a file.** `<script src>`, `<link href>`, `<img src>`,
`<img srcset>`, `<source src>`, `<source srcset>`, `<video src>`,
`<video poster>` and `<audio src>` resolve when the build emitted a file at
exactly that path, in the same output tree as the page referencing it. This is
the check that catches a spelling drift between the URL a document was written
with and the name the file was emitted under.

`<iframe src>`, `<object data>` and `<embed src>` are **not** read. Each embeds
a whole document rather than an asset of this page, most often another origin's,
and checking them is past what this feature is.

**Content references name a route — or a file.** An `<a href>` resolves if the
build emitted a page at that route, and `/about` and `/about/` are the same
route: the build writes one file for either spelling, so a link written the
other way round to your `trailingSlash` policy still resolves, and `/` is the
site's home page.

It also resolves if the build emitted a **file** at exactly that path, because
linking a PDF, a zip or an image off a page is ordinary and none of those has a
route. The two lookups cannot collide — a page's document is written at
`<path>/index.html` and never at `<path>` — so whichever answers, answers.

A `srcset` is a list, and every candidate in it is resolved: `2x` and `640w`
descriptors are read past, not checked, because which candidate a browser picks
is not a question about what the build emitted. The attribute name is matched
in any case, so the `srcSet` React writes is read the same as `srcset`.

**Only root-relative URLs are resolved.** A URL starting `//` names another
host, and one with a scheme names another origin; no build can answer for
either, so neither is compared against the emitted set. Absolute `http:` and
`https:` URLs have their own opt-in check, under "External links" below.

**An asset URL carrying a `?query` is left alone for the same reason**, even
though it looks local. A route ignores its query — `/about?ref=nav` is the page
`/about`, which has a file — but a *file* cannot have one: no path this build
emits holds a `?`. So `/_image?src=/hero.jpg&w=640` is not naming a file in this
tree at all; it is being served by something else, an image endpoint or a CDN
function, and this build can no more answer for it than for another origin.

That exemption costs nothing the check used to catch, because every asset URL
the build itself writes is a hashed filename with no query.

A `#fragment` is cut from both kinds and is never an exemption: a fragment is
never sent to a server, so it cannot be what serves a URL. `/sprite.svg#icon`
names the file `/sprite.svg`, and the build either emitted it or did not.

## The three settings

`links.broken` takes three values.

**`"error"`** — the default, and what a site that declares nothing gets. A
broken reference fails the build with exit code 2, before anything is written to
`outDir`: the whole site is staged in memory first, so a refused build leaves no
half-written tree for a deploy to find. Every broken reference on the site is in
one report, each line naming the page by locale and path and the href it holds:

```
Site build: 2 references name nothing this build emitted — check each against the page or the file it should name: an asset URL and its file name are minted at two stages (see chunkPath in client-build.ts), and a route is served only where a page renders one:
  en / — "/apple"
  en /pricing — "/assets/assets/index-abc123.js"
```

**`"warn"`** — the same report, on the run's stderr, and the build finishes and
writes the site. For a content migration, or a CMS whose editors link ahead of
the pages, where the links are wrong today and the site still has to ship.

**`false`** — the pass does not run at all. Not the refusal alone: the redirect
warning and the external check go with it, and the build does not walk the
documents looking for references it has been told not to report.

## A reference that resolves through a redirect

While the pass is running, a reference that names no emitted file or page is
checked against the site's redirects before it is called broken. One that a
redirect answers is not a fault — the visitor reaches the page — so it is
reported separately, at **either** setting, and never fails a build:

```
Site build: 1 reference resolves through a redirect — point it at the target on the line below, so a visitor's first request is the page rather than a hop. This is a warning and not a refusal because the redirect works and the page it lands on is one this build emitted:
  en / — "/old" → "/about"
```

The target on the right is where the redirect ends up, with any chain already
flattened, so it is what the href could say instead. Changing it saves the
visitor a round trip; leaving it costs one.

The redirects it looks in are the ones your site declared in `build.routing`,
and nothing else — see [Routing](/reference/routing/). Until that field existed
the table was always empty, so every unresolved reference was reported as
broken and this warning could not be produced by any build:

```ts
build: {
  outDir: "./site",
  routing: {
    redirects: [{ from: "/old", to: "/about" }],
  },
  // ...
}
```

With that rule declared, a page linking `/old` warns and ships. Without it, the
same link is a broken reference and the build is refused.

## What the check cannot see

The build reads its own emitted HTML with a set of patterns rather than a DOM
parser, and the limits of that are worth stating rather than discovering.

An attribute value is read as the document holds it, with its character
references decoded — the five named ones an HTML serializer writes (`&amp;`,
`&lt;`, `&gt;`, `&quot;`, `&apos;`) and any numeric one such as `&#x26;`. A
value holding some other named entity is resolved as written, which for a URL is
almost always the same thing.

A value that is single-quoted, or split across lines, is not matched at all —
and so is not checked. Nothing this build emits is written that way: the
framework composes the document's own tags, and React's serializer
double-quotes every attribute it writes.

**The one case a site has to reconcile: a query-less dynamic endpoint.** If
something on your site serves assets from a path with no query —
`/_image/640/hero.jpg`, a rewrite, an edge function on a prefix — this build
cannot tell it from a misspelled filename. It knows what it emitted, and it
cannot know which root-relative prefixes your host answers dynamically. Such a
URL is reported, and at the default setting it fails the build.

The query rule above does not close that case, and neither does anything else
here. What exists for it is `broken: "warn"`: the references are still reported,
on stderr, and the build ships. Point your adapter at a URL with a query if you
can — `urlTemplate("/_image?src={srcParam}&w={width}")` resolves clean — and
warn if you cannot.

## External links

Off unless declared. `links.external` turns on a check of the absolute
`http:`/`https:` URLs your pages link — and declaring it means **this build
makes network requests**, which is why the field carries the function that makes
them:

```ts
build: {
  outDir: "./site",
  links: {
    external: {
      probe: async (url) => (await fetch(url, { method: "HEAD" })).status,
      limit: 20,
      intervalMs: 500,
    },
  },
  // ...
}
```

**The framework ships no probe, and that is deliberate.** `fetch` exists in
every Node this runs on, so a boolean flag here could have switched on outbound
requests from a CI machine with one word — read by whoever added the flag, not
by whoever runs the build. Everything about *how* to ask is a site's decision
anyway: the method, the timeout, the user agent, the proxy, whether a redirect
is followed. Writing the function is how a site makes those six choices, and it
is the line in the config that says what this build now does.

Your probe is handed one URL and answers with the HTTP status the request came
back with. It may throw; a timeout is how a network says nothing.

**Requests are sequential, paced, and capped**, and the last two are different
protections worth having separately.

`intervalMs` is the **rate**: the least time between one request starting and
the next, defaulting to **1000** — one request a second, which is what
`Crawl-delay: 1` has asked of well-behaved automated clients for decades, and a
build asking about somebody else's URLs is exactly that. Sequential requests
alone are not a rate limit: fifty of them to one host as fast as it answers is
the burst a rate limit exists to prevent. Set `0` to say you are entitled to ask
as fast as the host answers — a host you own, a staging run — and mean it.

The interval is global rather than per host, which is stricter than the fault it
prevents: a build alternating between twenty hosts waits anyway. Per-host pacing
is a crawler's job and is not what this is.

`limit` is the **ceiling**: how many requests one build makes at all,
defaulting to **50**.

Together the defaults cost a build that has fifty external URLs about **fifty
seconds**. That is a real number to put on a build and it is the honest price of
the conservative position; lower the interval for hosts you are entitled to ask
faster, and raise the limit deliberately.

URLs are deduped before anything is asked: one URL in a footer on forty pages is
one request, and all forty pages are named in the report.

### What each answer does

| The probe answers | The build does | Why |
| --- | --- | --- |
| a status under 400 | nothing | the URL answered |
| 400 or over | warns, naming the status and every page linking it | the page may be fine and the host may be down; either way it is not this build's to refuse |
| throws | warns that the URL could not be checked | a timeout, a DNS failure or a proxy is not a broken link |
| the limit is reached first | warns, listing what it did not ask about | silence about a URL and a URL that answered must not look the same |
| something that is not an HTTP status | asks about every remaining URL, then **fails the build**, exit code 2 | a declared function answers that way on every run until somebody edits it, and one build should reveal all of them |

**Nothing a host says can fail your build**, at any `broken` setting. A 503 or a
timeout comes right on the next run, and a build whose success depends on
another company's uptime fails on a Sunday for a reason nobody can act on. The
one refusal in the table is about your own function, not about a host.

```
Site build: 1 external reference answered with a status a reader will not see the page at — check the link, or the host behind it; this build asks each URL once and takes the status its probe answers with. This is a warning and never a refusal, because a host this site does not control is not this site's wiring and the same URL usually answers on the next run:
  "https://example.com/moved" — 410 — linked from en /, en /pricing
```

Every URL in these reports is cut at its `?` or `#` before it is printed — the
URL the build asked about, and any URL inside the message your probe threw,
since `fetch` puts the request it failed on into its own message. A tracking
token or a signed URL in a CMS field does not travel into a CI log.

## Incremental builds

External checking runs on **full builds only**. `pagedeck build --incremental`
makes no probe request at all, whatever `external` declares, and there is no
setting that changes this. The internal check is not narrowed: an incremental
build still checks every page's internal references against the whole site.

So link rot is caught by your full builds. A site that builds incrementally on
every change and wants its external links checked runs `pagedeck build` on a schedule
too — nightly, say — and reads the report there.

## What is refused when the config loads

A malformed `links` is refused before anything renders, with every fault of the
build section in one report:

```
Config "/site/pagedeck.config.ts": "build.links" declares a setting no reference check can take — write "error" to fail the build on a broken reference, "warn" to report it and let the build finish, or false to skip the check:
  "false" — not a reference-check setting
```

The quoting there is the point: `false` switches the check off and `"false"` is
a string, which is not a setting at all — and a `.js` config is never
typechecked, so nothing but this refusal would tell you which one you wrote.

Declaring `external` without a probe is refused for the reason the framework
ships none:

```
Config "/site/pagedeck.config.ts": "build.links.external" names no probe for this build to ask each URL with, and this framework ships none — declare the probe this build asks each URL with, as external: { probe: async (url) => (await fetch(url, { method: "HEAD" })).status }
```
