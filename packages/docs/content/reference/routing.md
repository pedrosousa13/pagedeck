---
section: reference
title: Routing
description: Declare redirects, a 404 page per locale and per-prefix response headers with build.routing, and what the build refuses in each of them.
---

# Routing

`build.routing` is where a site declares what it serves that is not a file: its
redirects, the page that answers a 404, and the headers each part of the tree
carries.

```ts
build: {
  outDir: "./site",
  routing: {
    redirects: [{ from: "/old-pricing", to: "/pricing", status: 301 }],
    notFound: [{ locale: "en", path: "/404" }],
    headers: [
      { prefix: "/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
    ],
  },
  // ...
}
```

The build compiles all three into one host-agnostic document, writes it into
`manifest.json`, and a host's adapter turns that document into a CloudFront
Function, a Netlify `_redirects` file, an nginx config or a Cloudflare Worker
([Deploy a site](/how-to/deploy-a-site)). Nothing you write here names a host.

**A site that declares no `routing` gets exactly the build it got before the
field existed.** The document is still written, with no rules in it.

## Redirects

`from` and `to` are paths on your own site, written the way you would type
them. The build spells both the way it spells its own routes, so `/pricing/` and
`/pricing` are the same address whichever your `trailingSlash` policy is —
declaring a rule under the wrong spelling is the mistake this framework exists
to stop being silent.

**`to` is a page this build routes, or a file it emits** into the same output
tree: the sitemap, the feed, `robots.txt`, a file from `passthrough`. So a site
that moved its sitemap can keep the old address:

```ts
redirects: [{ from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301 }],
```

Anything else is refused, and so is a page's own HTML file, which would be a
second address for the page. A file answers at one address: a request for its
slashed form, `/sitemap.xml/`, is not redirected to it and stays a 404. A page
routed at that slashed form is refused: its HTML file would be
`/sitemap.xml/index.html`, which needs `/sitemap.xml` to be a directory. See
[passthrough](./passthrough.md).

The `trailingSlash` policy spells a page target and does not spell a file
target. Under `"always"`, `to: "/pricing"` becomes `/pricing/`, but
`to: "/sitemap.xml"` stays `/sitemap.xml`. In the `to` field, the build also
accepts `"/sitemap.xml/"` as the file, under either policy, and the redirect
still goes to `/sitemap.xml`.

`status` defaults to **308**. It takes 301, 302, 307 or 308 and nothing else:
these are the codes a static host can answer with, and a rewrite or a proxy is
not a redirect.

**Chains are flattened before anything compiles them.** A rule pointing at
another rule's source is followed to the page or file at the end, and the status
a visitor observes is the first hop's. That is what makes three hosts behave the
same: nginx re-enters its rewrite table after a hop and a CloudFront Function
returns once, so an unflattened chain would be a different number of round
trips per host.

**A link on your own pages that resolves through a redirect is reported**, with
the direct target on the line, so you can point it at the page instead — see
[Link checking](/reference/link-checking).

## The 404 page

A `notFound` rule names a page **by its locale and path**, not by a filename:

```ts
notFound: [{ locale: "en", path: "/404" }],
```

A filename would be a string nothing could be compared against, so a typo in it
would deploy as a 404 page that does not exist. A locale and a path are in the
route table, so a wrong one fails the build.

One per output tree. A site with locales on their own hosts declares one per
`domain`.

**The page a rule names is not indexable.** A host serves it at every missing
path, but its own address answers 200 like any page. So the build writes
`<meta name="robots" content="noindex">` into its head, whether or not you
declared an `origin`. It gets no canonical and no `hreflang` links, no other
page lists it as an alternate, and no sitemap lists it. See
[Canonicals and hreflang](/reference/canonicals-and-hreflang) and
[Sitemaps](/reference/sitemaps).

## Headers

A `prefix` and not a glob, because a prefix is the one matcher a CloudFront
Function, a `_headers` file and an nginx `location` express identically.

The trailing slash is the boundary and is left exactly as you wrote it: `/docs/`
scopes the rule to what is under `/docs`, and `/docs` also matches `/docsearch`.
Each prefix carries one header set; two rules on one prefix are refused, because
the second row of a first-match table is unreachable.

### Security headers

**The build emits no header you did not write.** Your host or CDN may already
be setting these, and a default nobody asked for would send each of them twice.
So the posture is a value you spread, not one the build applies:

```ts
import { SECURITY_HEADERS } from "@pagedeck/core";

routing: {
  headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
}
```

`SECURITY_HEADERS` is three fields and will stay three fields:

| Header | Value | Why it is safe to spread unread |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | stops a browser guessing a type you did not send; it cannot break a page that was working |
| `X-Frame-Options` | `DENY` | your pages are documents, not widgets somebody else frames |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | already what a current browser does with no policy at all |

That last value is not a preference. It is the modern browser default, so
sending it changes nothing for most of your visitors — what it buys is the older
browser that still sends a full URL cross-origin, and a posture stated in your
own document rather than inherited from whatever browsers settle on next. A
value that tightened *past* the default would be a behaviour change you would
have to consent to, and this is a constant people spread without reading.

**A build that declares no header set at all says so on stderr**, once, and
still succeeds. Every page it emitted is correct, and a site whose CDN already
sets these has nothing to fix — but with the field absent there is no `_headers`
file, no nginx `add_header` block and no CloudFront viewer-response function,
and that absence looks exactly like a feature you are not using. Declare a set —
the spread above, or your own — and the message stops.

### Two headers this framework will not decide for you

**`Strict-Transport-Security` is not in `SECURITY_HEADERS`, deliberately.** It
is the one with a real footgun. It tells a browser to refuse plain HTTP for your
host for the whole `max-age`, and a browser that has been told once keeps
refusing whether or not you take it back. A site not yet fully on HTTPS locks
itself out; with `includeSubDomains`, a site on a shared domain locks out
siblings whose owners never saw your config. None of that is knowable from
anything the build can read, which is exactly why it cannot ride in a constant
people spread unread. If you want it, write it yourself, beside the spread, once
you know the domain is ready:

```ts
headers: [
  {
    prefix: "/",
    set: [
      ...SECURITY_HEADERS,
      {
        name: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
    ],
  },
],
```

**`Content-Security-Policy` is not in it either, and that is a decision rather
than a gap.** A CSP is a claim about what a page may load, and this framework
composes a page's script layer per page: the island entry chunk, the consent
gate, and whatever you declared in
[`build.scripts`](/reference/third-party-scripts). No single policy is correct
for all of them, and a wrong CSP is worse than none — it breaks the page in
production, silently, on the first request that violates it. The framework's own
inline script loader is the sharpest case. Its text differs from page to page,
so its hash does too, and the build records each page's hash in
`manifest.json` for your own header to use.
[Third-party scripts](/reference/third-party-scripts) has the recipe. Write
yours deliberately, against the pages your build actually emits.

## Output trees

A site whose locales have their own hosts builds one output tree per host, and
**every rule of all three lists may name the tree it belongs to** with a
`domain`:

```ts
routing: {
  redirects: [{ domain: "shop.example", from: "/old", to: "/pricing" }],
  notFound: [{ domain: "shop.example", locale: "en", path: "/404" }],
  headers: [
    {
      domain: "shop.example",
      prefix: "/",
      set: [{ name: "X-Frame-Options", value: "DENY" }],
    },
  ],
}
```

Leave it out for the default tree. The trees are the hosts your pages are routed
to and nothing else, so a rule naming a `domain` no page occupies is refused — a
tree no page occupies serves nothing, and the rule would compile into a table no
request reaches.

A rule is scoped to its own tree in every direction: paths are tree-relative, so
a redirect cannot point at a page on another host, and each tree gets its own
404 page and its own header table.

## What is refused, and when

Two doors, and which one a fault meets tells you what it is.

**When the config loads**, before a page renders, every field is checked for
being the type the build is about to read it as:

```
Config "/site/pagedeck.config.ts": "build.routing" declares 1 rule field this build cannot route with — declare each as the type its own line names:
  headers[0] — "set" — undefined — not a list of header fields — write the headers this prefix carries, as set: [{ name: "X-Frame-Options", value: "DENY" }]
```

**After every page has rendered and before a byte is written**, each rule is
checked against the route table — which is the earliest point that table exists.
Every fault of the same kind is in one report, and each line names the rule by
its position in the field you wrote:

```
Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:
  build.routing.redirects[0] — "/nowhere" in the default tree
```

The refusals in that second group are:

| The fault | Why it is refused |
| --- | --- |
| a `to` or a `from` with a scheme, a `//` host, a backslash or a control character | a target off this site compiles to an open redirect; a source spelled as a URL is a rule that can never fire |
| a `from` that is a page this build serves | a page and a redirect cannot both answer one path, and the route table has no precedence rules |
| a `to` that is neither a page of this build nor a file it emits into the rule's tree, or is a page's own HTML file | the visitor lands on a 404, or the page gets a second address |
| a `to` that is a page of another output tree | a tree-relative path cannot name a page on another host |
| two rules on one path with different targets or statuses | nothing says which the author meant |
| two header sets on one prefix | the second row of a first-match table is unreachable |
| a `notFound` naming a page nothing routes, or two of them in one tree | the same two reasons, over the 404 page |
| a chain of rules that closes on itself | the visitor loops |
| any rule naming a `domain` no page occupies | a tree no page occupies serves nothing |

Every one of them is a build failure with exit code 2, and nothing is written to
`outDir`: the site is staged in memory first, so a refused build leaves no
half-written tree for a deploy to find.
