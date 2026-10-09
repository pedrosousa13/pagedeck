---
section: reference
title: Third-party scripts
description: List tag managers, analytics and other third-party scripts once, and the build picks a loading strategy per page, with facades and consent.
---

# Third-party scripts

A tag manager, an analytics pixel, an experimentation tool and a chat widget are
the four scripts almost every site ends up carrying, and none of them is the
site. Left as `<script src>` tags in the page they compete with the page's own
content for the main thread, and the site pays for a decision a marketer made.

**The script layer is where you declare them instead.** You list what the site
loads and, if you want to, say how; the build decides per page and writes the
loading code. A site that only lists its scripts gets the fastest strategy the
build can give it without being asked.

There is nothing to turn on. A site that declares no `build.scripts` carries no
script-layer bytes at all — not an empty loader, not a listener, nothing. Nor
does a page you have taken every script off, which is how a site that *does*
declare a loadout keeps its content pages at zero JavaScript.

The loader is written into the document rather than fetched as a chunk, so it
never costs a request — but a page that carries it is charged for those bytes
against its [JavaScript budget](./javascript-budgets.md), where what a budget
counts is written down.

## Declaring the loadout

```ts
import { defineConfig, defineScripts } from "@pagedeck/core";

export default defineConfig({
  build: {
    outDir: "./site",
    scripts: defineScripts({
      scripts: [
        { name: "tags", src: "https://example.com/gtm.js" },
        { name: "metrics", src: "/metrics.js", strategy: "idle" },
        {
          name: "chat",
          src: "https://example.com/chat.js",
          strategy: "facade",
          facade: { html: '<button class="chat-launcher">Chat with us</button>' },
        },
      ],
    }),
    // ...
  },
});
```

`name` is how an override addresses the script and is not the URL. That is
deliberate: a container id, a region or a version changes in a vendor's URL
without the site meaning anything by it, and an override keyed by one would stop
applying the day the tag was reissued.

`defineScripts` checks the whole section when the config loads, so a
misspelled strategy or an override naming a script that does not exist is a
build failure with the fix in it, not a page that quietly loads nothing.

## The four strategies

| Strategy | When the script loads |
| --- | --- |
| `worker` | Off the main thread, through a mechanism the site supplies. **The default.** |
| `idle` | On the main thread, once the browser is idle. |
| `interaction` | On the main thread, at the first interaction anywhere on the page. |
| `facade` | Not until a visitor uses the placeholder the script declares. |

A script that names no strategy takes `worker`. Listing your loadout and saying
nothing else is meant to be the good outcome, not the lazy one. The one thing
that moves a script off `worker` without an override is a consent `category`,
because the gate cannot be written around a mechanism you supplied — the consent
section below is where that is spelled out.

`idle` waits for idle and for nothing else: `requestIdleCallback` where the
browser has it and a `setTimeout` where it does not. A page that never goes idle
never loads them. `interaction` listens for `pointerdown`, `keydown` and
`wheel`, passively, and stops listening on the first of them. `scroll` is not on
that list — a browser restoring a scroll position fires it with nobody having
done anything, which would make `interaction` a slower `idle`.

## Which strategy a page uses

Three layers, later winning:

1. the script's own `strategy`, or `worker` where it declares none;
2. `pageTypes` — an override for a section of the site;
3. `pages` — an override for one page, over everything above.

```ts
defineScripts({
  scripts: [
    { name: "tags", src: "https://example.com/gtm.js" },
    { name: "experiment", src: "https://example.com/ab.js" },
  ],
  pageTypes: { "/blog/**": { experiment: "idle" } },
  pages: { "/pricing": { experiment: "worker" } },
});
```

Both maps are keyed by the page-pattern language
[budgets](./javascript-budgets.md) and [critical CSS](./critical-css.md) use,
and each key holds a map of *script names* — so a page type moves one script and
leaves the rest of the loadout where it was, which is the case this feature
exists for: an experimentation tool that touches the DOM has to be on the main
thread on the pages that run it, and the pixel beside it does not.

Inside one layer the most specific pattern that **names that script** wins.
A key that says nothing about `experiment` is not an opinion about
`experiment`, however narrow it is. Two keys that match the same page and both
name the same script with no way to rank them are refused when the config
loads, so two builds of one config cannot disagree.

Neither map is limited to the four strategies: both also take `"off"`, which is
the next section.

## Taking a script off a page

The four strategies are four answers to *how* a script loads. `"off"` is the
answer to *whether*, and both override maps take it:

```ts
defineScripts({
  scripts: [
    { name: "cmp", src: "/cmp.js", strategy: "idle", category: "necessary" },
    { name: "analytics", src: "https://example.com/a.js", category: "analytics" },
  ],
  pageTypes: { "/legal/**": { analytics: "off" } },
});
```

The terms page loads the CMP and nothing else. A script that resolves to `"off"`
contributes nothing to its page — no entry in the loader, no facade placeholder,
no declaration handed to your `runtime` adapter — and `resolveScriptStrategy`
answers `"off"` for it rather than a strategy. Nothing is deferred, because
`"off"` is not a strategy: there is no later moment at which the script loads.

**Take every declared script off a page and it carries no script-layer bytes at
all.** It is the same document a site with no `build.scripts` would have
emitted, down to the missing inline loader. That is what the value is for.
Declaring analytics used to mean putting its consent-gated loader on every page
of the site — the documentation, the terms, the article nobody has touched in a
year — so a content page could ship zero JavaScript only at a site that declared
no scripts. Which pages those are is your loadout's statement to make now.

### Off broadly, on narrowly

`pages` beats `pageTypes`, so the same value is also how a script is opted *in*.
A broad key takes it off; a narrow one names a strategy:

```ts
defineScripts({
  scripts: [{ name: "analytics", src: "https://example.com/a.js", category: "analytics" }],
  pageTypes: { "/**": { analytics: "off" } },
  pages: { "/pricing": { analytics: "idle" } },
});
```

Analytics runs on the pricing page, on `idle`, and on no other page of the site.
There is no second mechanism to learn for that: it is the layering above with one
more value in it.

### A declaration cannot say `"off"`

`strategy` on the script's own declaration still takes the four strategies and
nothing else. Writing `"off"` there fails the build:

```
Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "strategy" — "off" — not a loading strategy — write one of: worker, idle, interaction, facade
```

A declaration is the site saying what it loads, and a declaration that loads
nowhere has nothing behind it — if a script has no page left, delete it. The
config that would otherwise have wanted a declaration-level `"off"` is the opt-in
shape above, which is why there is no value for it here.

### When no page loads a declared script, the build says so

A key covers more pages than its author thought, or a script name in an override
is misspelled by one letter, and the result looks exactly like a script that
works: the declaration reads like a script the site loads, the override reads
like a narrowing, and what the built pages hold is an absence. `pagedeck build` names
it once:

```
Script reach: 1 script resolves to "off" on every page this site builds, so no page loads it — this site builds 12 pages, and an override takes a script off every page its key covers, so a key that covers them all leaves a declaration nothing acts on while it still reads in the config like a script that loads; this is a warning and not a refusal because every field of the declaration is well formed and a site mid-migration may have taken a script off every page on purpose — drop the declaration from build.scripts.scripts, or narrow the override that takes it off so at least one page keeps it:
  "analytics" — pageTypes "/**" sets "off"
```

Every override key that took the script off is named, not just one of them,
because a script taken off by two keys is half fixed by dropping either. Then do
one of the two things the message asks for: drop the declaration if the script is
genuinely gone, or narrow the key if it caught pages you meant to keep.

A warning and not a failure, because every field is well formed and a site that
took a script off every page for a release meant to. Only `pagedeck build` reports it.
`pagedeck dev` cannot: it renders one page per request, so the widest question it could
answer is whether *that* page loads the script, which is not this one.

## The `worker` strategy needs a mechanism, and you supply it

**Nothing in this framework moves a script off the main thread.** `worker` is a
request the build records and routes; the code that honours it is an adapter
the site configures:

```ts
defineScripts({
  scripts: [{ name: "tags", src: "https://example.com/gtm.js" }],
  runtime: ({ scripts }) => [
    '<script src="/~partytown/partytown.js"></script>',
    ...scripts.map(
      (script) => `<script type="text/partytown" src="${script.src}"></script>`,
    ),
  ],
});
```

The adapter is handed **one page's `worker` loadout** and returns the finished
HTML elements that load it, which the build writes into that page in the order
they were returned. Scripts on the other three strategies are not handed over —
they need no mechanism, and a mechanism should not get an opinion about a script
you kept on the main thread on purpose. The elements are your bytes and are
never read, rewritten or escaped.

It is a list per page rather than a URL per script because every plausible
mechanism needs something emitted once per document — Partytown its snippet, a
hand-rolled worker its bootstrap — as well as something per script.

Core ships no adapter of its own, and that is not an oversight. It ships a
generic URL-template adapter for [images](./images.md) because every image CDN
answers the same four parameters at a URL; off-main-thread runtimes have no such
common shape, and a "generic" one would be one vendor's runtime with a neutral
name in front of it.

### With no adapter, `worker` becomes `idle` — and the build says so

A site whose scripts reach `worker` with no `runtime` configured loads them on
`idle` instead, and the build prints this once:

```
Script runtime: 1 script can resolve to the worker strategy and this site configures no script runtime, so it loads on idle instead — worker moves a script off the main thread, and core ships no mechanism to do that with because a framework that picked one would carry a vendor's runtime into every site that never asked for it; this is a warning and not a refusal because idle is the fallback spec §12 states for this case, and a site that did not want off-main-thread loading is served correctly by it — supply build.scripts.runtime, or declare strategy: "idle" to say the fallback is what you meant:
  "tags" — declares no strategy, so it takes the worker default
```

A warning and not a failure: the config is well formed and the fallback is a
behaviour a site may well have wanted. What it will not do is happen silently.
Declare `strategy: "idle"` to say the fallback is what you meant, and the
warning goes away.

## Facades

A facade is for an embed that is too heavy to load for everyone and only some
visitors ever use. The chat widget is the case it is written for: the page ships
a button, and the vendor's script is fetched the first time somebody presses it.

```ts
{
  name: "chat",
  src: "https://example.com/chat.js",
  strategy: "facade",
  facade: { html: '<button class="chat-launcher">Chat with us</button>' },
}
```

The markup is yours and is written into the page as you wrote it. A script that
can reach `facade` with no `facade` to render is refused when the config loads —
including one an override pushes there — because the alternative is a page that
silently shows nothing and loads nothing.

**The trigger is the placeholder, not the page.** Pressing it, or a keypress
while focus is inside it, loads the script; a click somewhere else does not.
That is the whole difference between `facade` and `interaction` — one asks
whether this visitor wants *this embed*, the other whether the visitor is using
the page at all.

Three things to know before you choose it:

- **The placeholder is written inside `<main>`**, last in the landmark and after
  your page's own content, so it must position itself — which is what the embeds
  this strategy is for already do. A chat widget is `position: fixed`; the
  vendor's own button would have been appended to the end of the body too. It is
  inside the landmark whether or not you do anything about it: a control outside
  every region belongs to none a screen reader can name, and CSS moves where an
  element looks rather than where it is in the accessibility tree.
- **An in-flow facade is what `mount` is for.** A video embed halfway down an
  article wants its poster frame at that point in the content, and this layer
  still cannot decide that: the page's HTML reaches the document writer as one
  rendered string, and the layer that knows where the embed belongs is your
  component tree. So you mark the place in the tree that knows and name it in
  the declaration — the next section.
- **The placeholder is removed once the script has loaded**, so that a vendor
  that renders its own launcher does not leave you with two. Your markup must
  therefore stand alone rather than be the container the vendor mounts into —
  the element you name as a mount point is that container, and the placeholder
  goes *inside* it and leaves it behind. If the script never loads, the
  placeholder stays: the visitor keeps a button rather than losing one.

The gesture is not replayed into the script it loads. A visitor who presses the
placeholder has pressed the placeholder; whether the widget opens on arrival is
the vendor's decision. Write a button that says what pressing it does.

### Say where the placeholder goes with `mount`

`mount` is the `id` of an element your page renders. The placeholder is written
inside that element, immediately after its start tag, instead of at the default
place:

```ts
{
  name: "comments",
  src: "https://giscus.app/client.js",
  strategy: "facade",
  facade: {
    html: '<button type="button">Load comments</button>',
    mount: "comments",
  },
}
```

```tsx
<section id="comments" className="giscus" />
```

An `id` rather than a selector, because a document may hold one element with a
given id and no more — there is no tiebreak rule to learn, and none for this
framework to invent.

Inside that element rather than in place of it, because the placeholder goes
away when the script loads and your element is what is left for the vendor to
render into. The pair above is Giscus exactly: it mounts into the first
`.giscus` element it finds and builds a container beside its own script when it
finds none, so the section is both the place you chose for the button and the
place the thread arrives in.

**A page that renders no element with that id fails the build**, naming every
facade that named one:

```
Entry /en/post: 2 facades declare a mount point no element on this page carries — a facade's placeholder is emitted inside the element its mount point names, so this page has nowhere to put one; render the element, or take the script off this page with a pages or pageTypes override set to "off":
  "comments" — no element carries id="comments"
  "chat" — no element carries id="chat"
```

It is a refusal and not a quiet fall back to the default, because a control that
appears somewhere other than where you put it is the fault `mount` exists to
fix, one step quieter. Usually the fix is the second one the message offers: a
facade whose element is on your post pages is a script that belongs on your post
pages, which is the layering "Off broadly, on narrowly" above.

The element is found by reading the page's emitted tags, so it is *your*
rendered tree that can carry a mount point — not the head, and not anything the
build writes around your page. That is also what keeps a mounted placeholder
inside `<main>`.

### A gated facade says which consent state it is in

Every facade's markup is wrapped in an element of the framework's, and where the
script declares a `category` that element also carries `data-fw-consent`, which
reads `granted` or `denied`. The build writes this page's market default into
it, and the loader rewrites it whenever consent changes — so it is current
before your first stylesheet rule runs, and it stays current when a visitor
answers your banner without leaving the page.

```html
<div data-fw-consent="denied">
  <button class="chat-launcher">Chat with us</button>
  <span class="chat-consent-note">Chat needs marketing consent.</span>
</div>
```

The second element there is yours — everything inside the wrapper is the `html`
you declared. That is the whole of the hook, and it is what a press under a
denied category otherwise leaves you with nothing to answer. Dim the control,
explain it, or link to the surface where the visitor can change the answer — all
of it in CSS, with no JavaScript of your own:

```css
.chat-consent-note {
  display: none;
}

[data-fw-consent="denied"] .chat-launcher {
  opacity: 0.6;
}

[data-fw-consent="denied"] .chat-consent-note {
  display: block;
}
```

Three things it is not:

- **It is not a second gate.** The script is refused by consent whatever this
  attribute says, and a value forged in your own markup reaches nothing.
- **It does not promote the facade.** A grant moves the attribute and loads
  nothing; the visitor presses again, and that press is what fetches the vendor.
- **It is not on an uncategorized facade.** A script with no `category`, and a
  `necessary` one, have no consent state to report, and their placeholders carry
  exactly the markup they carried before this existed.

The name is exported as `CONSENT_ATTRIBUTE` from `@pagedeck/core`, beside
`CONSENT_GLOBAL` and `CONSENT_EVENT`, and the two words it is valued with are
exported with it as `CONSENT_GRANTED` and `CONSENT_DENIED` — for wiring that is
bundled and would rather not spell any of them twice. The selectors above write
the word out because a stylesheet has no imports; a script of yours that reads
the attribute back does not have to.

## Configuring a vendor with `data-*` attributes

Many vendors take their whole configuration as attributes on the tag and read it
back out of `document.currentScript.dataset` as the script runs. Plausible finds
the site it is reporting for in `data-domain` and nowhere else; Giscus takes its
repository, its category and six more settings the same way. Declare them in
`attributes`.

```ts
defineScripts({
  scripts: [
    {
      name: "analytics",
      src: "https://analytics.example.com/js/script.js",
      strategy: "idle",
      attributes: { "data-domain": "example.com" },
    },
  ],
});
```

The build writes each one onto the element **before** it puts the element in the
document, which is what makes this work at all: the vendor reads its
configuration while it executes, and an attribute added a moment later is one it
never sees. A script configured that way loads, runs and reports nothing.

**Only `data-*` keys are accepted, and anything else is a type error where you
wrote it.** `src`, `async`, `defer`, `type`, `nonce`, `integrity` and
`crossorigin` belong to the strategy and CSP layers, and a declaration that
could set them would be fighting the code that loads it. Integrity has a field
of its own, which the next section describes. The prefix is the rule rather
than a list of forbidden names, so nothing here goes stale as those layers
grow. A `.js`
config, which TypeScript never sees, is refused when the config loads instead,
along with a bare `"data-"` — the type cannot refuse that one, and its `dataset`
key is the empty string, so no vendor reads it.

```
Script settings: declares 2 script fields that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "attributes.src" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"
  scripts[0] — "attributes.data-" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"
```

Write the key the vendor's own page tells you to write. Anything under the
prefix is accepted as spelled: `data-Domain` reaches `dataset.domain`, because
the browser lowercases an attribute name on an HTML element, `data-foo_bar`
reaches `dataset.foo_bar`, and `data-1` and `data-x.y` reach `dataset["1"]` and
`dataset["x.y"]`.

**One more key is refused, and the browser is what refuses it.** A `data-` key
can still be a name `setAttribute` will not take. `"data-a b"` and
`"data-domain "` with a trailing space are both keys TypeScript accepts and a
browser throws `InvalidCharacterError` on, because neither matches the `Name`
production XML defines and the DOM borrows. An angle bracket, a quote, a tab or
a newline in a key does the same.

That throw happens inside the loader, which sets every declared attribute as it
runs. You do not lose one attribute. You lose **every script on every page that
carries this one**, silently, with nothing in the build output to read. A trailing
space is an ordinary typo, so this is worth catching early, and the build
catches it when it loads your config:

```
Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "attributes.data-domain " — a name setAttribute throws on — it holds 1 character outside XML's Name production, " " (U+0020), and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete it, or write the name the vendor documents, such as "data-domain"
```

The code point is printed because the mistake is usually invisible: a trailing
space inside a quoted key is not something you spot in a CI log. Every character
of the name that a browser would refuse is listed, in the order it appears, so
one edit fixes the key.

This is the only rule here that the browser sets rather than the framework. The
build refuses the names a browser refuses and accepts every name a browser will
set, `data-x:y` included. If the vendor's page tells you to write it, you can
write it.

Do not fold configuration into `src` as a query parameter. The vendors do not
read it there, and it puts your site's identity inside the one field a marketer
can reissue.

An override addresses a script by `name` and changes its `strategy`. It does not
reach into `attributes`: a strategy is a per-page answer, and a vendor's
configuration is the same wherever the script loads.

## Pinning a vendor bundle with `integrity`

A script served from a vendor's CDN runs with your page's full authority. If
that CDN is compromised, the attacker's code runs on every page of your site.
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
stops this. You give the browser the hash of the file you expect, and the
browser does not run a file that does not match it. Declare the hash in
`integrity`, as the vendor publishes it:

```ts
defineScripts({
  scripts: [
    {
      name: "carousel",
      src: "https://cdn.example.com/carousel@4.2.1/carousel.min.js",
      strategy: "idle",
      integrity:
        "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC",
    },
  ],
});
```

The build sets `integrity` on the element, and `crossorigin="anonymous"` with
it, before the element goes into the document. The browser checks integrity on
a script from another origin only when it fetches that script with CORS, so you
do not write `crossorigin` yourself. This does mean that the vendor must send an
`Access-Control-Allow-Origin` header with the file. A CDN that publishes hashes
for its files normally does this. The same applies on every path a script loads by:
`idle`, `interaction`, behind a consent category, and a facade loading on a
press.

**Only a pinned, versioned URL can take one.** The hash describes one exact
file. A URL that names its version, such as `carousel@4.2.1` above, serves that
file for as long as the URL exists. A tag-manager container, such as
`https://www.googletagmanager.com/gtm.js?id=…`, serves different bytes each time
somebody publishes the container. That is how a tag manager works, so a hash
pinned to one would block the script the next time the container changed. The
same is true for any vendor URL without a version, which the vendor updates in
place. Declare no `integrity` for these scripts.

A script with no `integrity` gets neither attribute, and a site that declares
none gets the same pages it got before the field existed.

The build refuses a value when it loads your config if the value is not a
string, is empty, or has no `sha256-`, `sha384-` or `sha512-` hash in it. A
browser ignores integrity metadata that it cannot parse and runs the script
with no check, so a mistyped value would give you no protection and no warning.
Here the digest was copied without its `sha384-` prefix:

```
Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "integrity" — "oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" — holds no sha256-, sha384- or sha512- hash, and a browser ignores integrity it cannot parse, so the script would load unchecked — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
```

The build does not compute or fetch hashes for you. Copy the value from the
vendor's release page.

A `worker` script is loaded by the elements your `runtime` adapter returns. The
adapter receives the whole declaration, `integrity` included. The build does
not apply it there, so your adapter decides whether its mechanism checks it.

## Allowing inline scripts under a strict Content-Security-Policy

The loader is an inline `<script>`, and `script-src 'self'` does not cover a
script with no `src`. A policy that strict blocks the loader, and every `idle`,
`interaction` and facade script on the page goes with it. Adding
`'unsafe-inline'` lets it run, but it also lets every other inline script run,
which throws away most of what the policy was for.

The loader is one of four inline scripts the framework can write, and a strict
policy blocks each of them on a page that carries it:

- the loader, on a page with an `idle`, `interaction` or facade script
- the [web-vitals beacon](./web-vitals-beacon.md), on a site that declares
  `build.beacon`
- your [pre-paint scripts](./page-head.md), on a site that declares
  `build.prePaint`
- the [speculation-rules](./speculation-rules.md) block, on a site that
  declares `build.speculation`

Allow them by their hashes instead. The loader carries the page's own script
list, the beacon carries the page's path, and the speculation rules carry the
pages this one links to, so their hashes differ from page to page. The build
records every hash a page needs on that page's row in `manifest.json`, each as
a CSP source expression with the single quotes included:

```json
{
  "locale": "en",
  "path": "/pricing",
  "output": "/pricing",
  "inlineScriptHashes": [
    "'sha256-mT3dQx0vE1cJ8tKpZ4nW7yUa…'",
    "'sha256-Fq9LbR2sXo6hVdN1kC5mEwTi…'",
    "'sha256-RbNDkSx56cLFPl9yZqIL15uce…'",
    "'sha256-8jW2pYzA4nQeL0rT6uHcKbVs…'"
  ]
}
```

The list is in the order the scripts appear in the document: the pre-paint
scripts, the speculation rules, the loader, then the beacon. Two pre-paint
scripts with the same text share one hash, so the list holds it once. A page
that carries none of the four has no `inlineScriptHashes` key. The build hashes
the scripts it wrote into the document, so the values always match the bytes
the page serves, including a page an incremental build reused.

The list does not include:

- a JSON-LD block (`<script type="application/ld+json">`). It is data, and CSP
  does not apply to it.
- an inline script you wrote yourself. A `worker` script's elements are the
  ones your `runtime` adapter returns, a facade's `html` is yours, and so is any
  script in your page content. Hash those yourself and add them to the policy.

The framework does not write the header. A CSP has to be read before it ships,
and [Routing](./routing.md) explains why no policy comes by default. Your
deploy step writes it. After `pagedeck build`, read the manifest and give each page
its own policy in your host's configuration:

```js
// csp.mjs, run after `pagedeck build`
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
for (const page of manifest.pages) {
  const policy = [
    "script-src 'self' https://cdn.example.com",
    ...(page.inlineScriptHashes ?? []),
  ].join(" ");
  // Write this pair in whatever form your host reads its headers from.
  console.log(page.domain ?? "", page.output, policy);
}
```

`page.output` is the URL path the page is served at, and `page.domain` names
the host on a site whose locales have their own. Match each policy to that
exact path. A header rule that matches by path prefix, such as a
[`routing.headers`](./routing.md) entry, sends one page's policy to other
pages too: a rule for `/post` also matches `/posts/first`, and that page's
scripts have different hashes. An experiment arm serves its primary page's
bytes, so it takes the primary's value. The policy also names
`https://cdn.example.com`, because the loader appends each vendor's script as a
`<script src>`, and `script-src` has to allow that script's origin too. List the
origin of every `src` you declared. The beacon sends its report with
`sendBeacon` or `fetch`, so its endpoint belongs in `connect-src`, not in
`script-src`.

**Run this on every build. Do not copy the values once.** A hash changes
whenever the script it covers changes: a page's loadout, its links, your
pre-paint code, or a new `pagedeck` version that changes the framework's own code. A
header left over from an older build blocks those scripts on the pages it no
longer matches, in production, with nothing in the build to warn you.

## Consent categories

A script can say what it is loaded **for**, and then it waits for the visitor's
consent as well as for its strategy.

```ts
defineScripts({
  scripts: [
    { name: "cmp", src: "/cmp.js", strategy: "idle", category: "necessary" },
    { name: "pixel", src: "https://example.com/px.js", strategy: "idle", category: "analytics" },
    { name: "ads", src: "https://example.com/ads.js", strategy: "interaction", category: "marketing" },
  ],
});
```

`analytics`, `functional`, `marketing` and `necessary`, and **a script that
names none of them is not gated at all**. There is no default here, unlike every
other field in this section, and that is deliberate: `necessary` would be the
framework claiming on your behalf that a script loads without permission, and
any of the other three would gate scripts you never described as gateable.
Silence means you have said nothing about consent for that script, and the page
is the page it was before you read this section.

`functional` is for third-party embedded content and functionality a visitor
can decline: a video player, a map, a comment widget. It is not measurement and
it is not advertising, and it is gated exactly as `analytics` and `marketing`
are.

`necessary` is a claim you make and the build honours: those scripts load on
their strategy alone and are never asked about. Your consent banner's own script
is the case it is for — a banner that waited for consent could never be
answered.

### Wiring it to your CMP

**This framework ships no consent manager and names none.** What it emits is a
gate, and the gate asks your code:

```ts
import { CONSENT_EVENT, CONSENT_GLOBAL } from "@pagedeck/core";
import type { ConsentSource } from "@pagedeck/core";

const source: ConsentSource = {
  granted: (category) => myCmp.hasConsentFor(category),
};

window[CONSENT_GLOBAL] = source; // "fwConsent"
window.dispatchEvent(new Event(CONSENT_EVENT)); // "fw:consent"
```

One method and one event. The method is read at the moment a script would load,
never cached; the event tells the page the answer may have moved, so dispatch it
whenever your CMP says consent changed — a grant, a revocation, or the first
answer arriving.

There is no build-time half to this, and no module specifier either. A build
cannot know whether *this* visitor consented, so there is nothing for it to
hold; and the loader is an inline script no bundler ever sees, so a specifier
written into it would have to be a URL fetched at runtime — a render-blocking
third-party request to decide whether to make third-party requests. A global and
an event are what a browser already has.

Two worked adapters follow, for OneTrust and for Cookiebot. They are here as a
**pair** on purpose: the two report state and signal a change in genuinely
different shapes, and an interface that absorbs both without either side bending
is the claim this section makes. Neither is a dependency of this framework and
no code in it names either — these are recipes you copy into your own site, and
this page is the only place in the repository the two products appear.

Both are written as plain JavaScript with `"fwConsent"` and `"fw:consent"`
spelled out, because that is what they are: lines pasted into a callback a
third-party script calls, which no bundler ever transforms. Import
`CONSENT_GLOBAL` and `CONSENT_EVENT` instead wherever your wiring *is* bundled —
your site's own entry, or a component. The strings are the same either way, and
the constants exist so you never have to check that.

Both adapters do the same three things, and every adapter does:

1. **map your CMP's categories onto `analytics`, `functional`, `marketing` and
   `necessary`**;
2. **install the source** on `window[CONSENT_GLOBAL]`;
3. **dispatch `CONSENT_EVENT`** each time the CMP says the answer moved.

#### OneTrust

OneTrust reports state as a **string of active group ids** on
`window.OnetrustActiveGroups`, and calls a global function you define,
`OptanonWrapper`, once its banner script has initialised and again after the
visitor changes their preferences.

```js
// Categories are OneTrust group ids. C0001/C0002/C0003/C0004 are the ids of
// the stock Strictly Necessary / Performance / Functional / Targeting groups —
// check yours in the OneTrust admin, because group ids are configured per
// tenant and a site can add its own.
const GROUPS = {
  necessary: "C0001",
  analytics: "C0002",
  functional: "C0003",
  marketing: "C0004",
};

// `OnetrustActiveGroups` is a comma-delimited list written with leading and
// trailing commas, e.g. ",C0001,C0002,". Matching on ",<id>," is what stops
// "C0002" from also matching a hypothetical "C00021".
function active(group) {
  return `,${window.OnetrustActiveGroups ?? ""},`.includes(`,${group},`);
}

function publishConsent() {
  window.fwConsent = { granted: (category) => active(GROUPS[category]) };
  window.dispatchEvent(new Event("fw:consent"));
}

// OneTrust calls this itself. Defining it is the whole of the wiring.
window.OptanonWrapper = publishConsent;
```

Two things about this shape are worth noticing, because they are what the
interface is absorbing:

- **The state is a string, not booleans.** `granted` parses it on every call,
  which is correct rather than wasteful: the framework asks at the moment a
  script would load, so parsing then is parsing an answer that is current.
- **The change signal is a function you define, not an event you subscribe
  to.** That is the opposite direction from a listener, and it makes no
  difference here — `publishConsent` is called and dispatches, and the
  framework listens on `window` either way. Newer OneTrust builds also expose
  `OneTrust.OnConsentChanged(callback)`; if yours has it, calling
  `OneTrust.OnConsentChanged(publishConsent)` from inside `OptanonWrapper` is a
  narrower signal than the wrapper alone.

#### Cookiebot

Cookiebot reports state as an **object of booleans** on `Cookiebot.consent`,
and signals changes by dispatching real DOM events on `window`.

```js
// Cookiebot's four categories are fixed, so this map is a rename and not a
// lookup. `preferences` has no counterpart here, which is the honest outcome:
// this framework's categories are the four spec §12 names, and a script you
// gate on preferences is one you gate yourself. `functional` has no entry
// either, so `granted("functional")` answers false and an embed stays gated.
const CATEGORIES = {
  necessary: "necessary",
  analytics: "statistics",
  marketing: "marketing",
};

function publishConsent() {
  window.fwConsent = {
    granted: (category) => window.Cookiebot?.consent[CATEGORIES[category]] === true,
  };
  window.dispatchEvent(new Event("fw:consent"));
}

// `CookiebotOnConsentReady` is the first answer, `OnAccept` and `OnDecline`
// every answer after it. All three are dispatched on `window`.
for (const event of [
  "CookiebotOnConsentReady",
  "CookiebotOnAccept",
  "CookiebotOnDecline",
]) {
  window.addEventListener(event, publishConsent);
}
```

And the differences from OneTrust, which are the point of showing both:

- **Three signals rather than one.** Cookiebot separates "the answer arrived"
  from "the visitor accepted" from "the visitor declined". All three mean the
  same thing to this framework — the answer may have moved — so all three
  dispatch the same event, and nothing downstream has to know which fired.
- **A category with no counterpart, each way.** Cookiebot has `preferences`
  and this framework does not, and this framework has `functional` and
  Cookiebot does not. The map says so rather than inventing a mapping for
  either, and a category it leaves out is denied.

#### What we have not verified for you

The two recipes above are written from each product's documented public API
shape, and this repository has no OneTrust or Cookiebot account to check them
against. Two things in particular are **yours to confirm** before you ship:

- **OneTrust group ids are per-tenant.** `C0001` to `C0004` are the stock ids
  and are what most sites see, but a site can rename, remove or add groups.
  Read yours out of the OneTrust admin; the map at the top of the recipe is the
  only part that changes.
- **Which OneTrust callback fires on a *change*.** `OptanonWrapper` is
  documented to run after the banner initialises, and is widely used as the
  change hook as well. If your build exposes `OneTrust.OnConsentChanged`,
  prefer it for the change and keep `OptanonWrapper` for the first answer —
  that pair is unambiguous, and dispatching `fw:consent` more often than
  necessary costs nothing, because the gate simply re-asks `granted`.

Dispatching too often is always safe. The framework holds no consent state of
its own, so an extra `fw:consent` makes it ask a question it already knows how
to answer.

### The reference banner

If you have no CMP and want one banner, `@pagedeck/design-system` ships one:
`consent_banner`, a component you register and place like any other.

It asks about `analytics`, `functional` and `marketing` together, and offers
two choices: accept all grants all three, and reject all refuses all three. It
has no control per category. `necessary` is never asked about. A record that
does not answer all three, such as one an earlier version of the banner wrote
before it asked about `functional`, is not used: the visitor is asked again,
and until they answer, your `consentDefaults` govern. So in an opt-out market,
a visitor who rejected under such a record has the defaults grant again until
they answer the banner again.

It is **static HTML plus a small island** — the markup is server-rendered into
the page, so it is on screen at first paint with no request and no layout
shift, and the island only supplies the pressing. It fetches nothing, embeds no
vendor, and adds no third-party bytes;
`packages/design-system/src/consent-banner.build.test.ts` builds a page that
carries it and reads that claim off the emitted files.

Two things to know before you use it:

- **It is not a CMP.** It records one visitor's answer in that browser's
  `localStorage` and answers `granted` from it. It keeps no audit log and syncs
  nothing, so a site that has to *prove* consent wires a real consent manager
  to the interface above instead.
- **It installs nothing until the visitor answers.** An island hydrates after
  the page's script loader has run, and a source is the authority once
  installed — so a banner that installed one on arrival would overwrite your
  market default with "no answer yet". Until there is an answer, your
  `consentDefaults` govern, which is what "What the page assumes before your CMP
  answers" below is about. A visitor who answered on an *earlier* visit has
  answered, though, and getting that answer to the page in time is the next
  thing here.

Its own script, if you give it one, belongs in `category: "necessary"`: a
banner that waited for consent could never be answered.

#### Declare its pre-paint script, or a returning visitor is not honoured

The banner is an island, and an island hydrates after the loader at the end of
the body has already fired its first trigger. For a visitor who has answered
**nothing** that is correct and is the bullet above. For a visitor who answered
on an earlier visit it is not: their decision is in this browser's
`localStorage`, and until the island runs, the page is still going by your
`consentDefaults`. In an opt-out market that means the analytics script a
visitor rejected loads again on every page they open.

The banner ships the fix and your config turns it on:

```ts
import { CONSENT_PRE_PAINT_SCRIPT } from "@pagedeck/design-system/consent";

build: {
  outDir: "./site",
  prePaint: [CONSENT_PRE_PAINT_SCRIPT],
  // ...
}
```

`build.prePaint` is a head slot for synchronous scripts of your own, described
in [Page head](./page-head.md). It is not part of this layer and it is not a
fifth strategy: the four strategies say when a *deferred* script runs, and this
runs at parse, in the head, before the loader exists. The banner's snippet reads
the same `localStorage` record the banner writes — one key, one shape, one
module — and installs a `ConsentSource` from it.

Two properties are worth stating, because they are what make it safe to declare
unconditionally:

- **It installs nothing when there is no record**, so a first-time visitor is
  still governed by your `consentDefaults` exactly as before.
- **It only ever reports the answer the visitor gave.** The island hydrates over
  the same decision later and dispatches `fw:consent`; the gate re-asks and gets
  the same answer, so nothing changes twice.

Wiring a real CMP instead? The same slot is available to you and the same
argument applies — a CMP that reads a stored answer synchronously can install
its source from `prePaint` and be ahead of the loader too.

### What the page assumes before your CMP answers

A CMP is itself a script, and it may not have run when the page's first trigger
fires. Until a `ConsentSource` is installed, each category answers whatever the
site declared for that page:

```ts
defineScripts({
  scripts: [{ name: "pixel", src: "https://example.com/px.js", strategy: "idle", category: "analytics" }],
  consentDefaults: {
    "/**": { analytics: "denied" },
    "en-US:/**": { analytics: "granted" },
  },
});
```

That is the multi-market case, and it is why this is a map. In an opt-in market
the pixel waits for the banner; in an opt-out market it loads on idle and stops
if the visitor opts out. The keys are the same page-pattern language everything
else here uses, so a market is a locale scope and a page is a path — and the
most specific key that names *that category* wins. `necessary` cannot be given a
default, because it does not have one to give.

Once a source is installed it is the authority, in both directions: a visitor in
an opt-out market who opted out gets nothing, whatever the default said.

**Installed when?** Declare the banner's `CONSENT_PRE_PAINT_SCRIPT` in
`build.prePaint`, and the promise above holds from the first byte of the page: a
decision this browser already holds is installed at parse, ahead of the loader
that reads it. That declaration is what makes it hold, so it is a requirement of
the promise rather than a tuning of it. Leave it out and the source arrives
whenever your wiring gets to it — a CMP that answers on a callback installs one
when that callback runs, and the reference banner's island installs one when the
island hydrates, which is after this page's first trigger, so that trigger was
answered from the defaults above.

### Consent gates whether; the strategy still decides when

The two conditions are independent, and the gate is applied **at** the trigger
rather than in front of it:

- a granted `interaction` script still waits for an interaction;
- a granted `idle` script still waits for idle;
- a denied `idle` script whose idle moment has passed loads the instant consent
  arrives — it does not wait for a second idle;
- a denied `interaction` script the visitor has already interacted for does the
  same: the interaction happened, so the grant is the last condition;
- a denied `interaction` script the visitor has *not* interacted for is not
  loaded by the grant. It goes back to waiting for the interaction.

**A facade is the exception, and it is one on purpose.** A press made while the
category is denied loads nothing, and the grant that follows loads nothing
either — the placeholder simply stays pressable, and the visitor presses it
again. The other two strategies ask whether the page is ready or in use, and
that stays true; a facade asks whether this visitor wants this embed right now,
and that does not keep. A chat widget appearing by itself some minutes after a
banner was answered is the behaviour the strategy exists to avoid.

What the press is not is *silent*: the placeholder carries `data-fw-consent`,
so the refusal and the grant that follows it are both things your CSS can see —
"A gated facade says which consent state it is in", above.

The one thing consent does decide is **which strategy the build can deliver**,
and that is the last section here.

### What revocation does, and what it cannot do

**Revocation prevents subsequent loads.** A script still waiting on its trigger,
or waiting on the gate, will not load: the gate re-asks `granted` every time the
answer moves and at every trigger, so it never runs on an answer it read
earlier.

**It does not unload a script that has already loaded.** The `<script>` element
stays in the document and a vendor that has executed has already installed
whatever it installs — no framework can take that back. The documented answer is
a page reload, which is what the visitor's next navigation is anyway.

### A categorized script is never loaded on `worker`

A `worker` script is loaded by the elements your `runtime` adapter returned, and
this framework never reads those bytes. So the gate the build writes cannot wrap
them — and rather than load a categorized script with no gate on it, the build
loads it on `idle`, where the gate works. It tells you once:

```
Script consent: 1 script declares a consent category and can resolve to the worker strategy, so it loads on idle instead — the consent gate this build writes lives in the loader that backs the main-thread strategies, and a worker script is loaded by the elements build.scripts.runtime returned, which core never reads, so leaving it there would load a categorized script with no gate on it at all; this is a warning and not a refusal because idle is the fallback spec §12 states for a worker script this build cannot deliver, and it is the strategy the gate does reach — declare strategy: "idle" to say the downgrade is what you meant, or drop the category and gate the script inside the adapter, which is the only place a worker script can be gated:
  "pixel" — category "analytics" — declares no strategy, so it takes the worker default
```

**This costs you the strategy, and it is worth saying what the exchange is.** A
categorized script you wired a worker runtime for runs on the main thread
instead, once the browser is idle. The alternative was a script that could run
without permission, and only one of those two can be undone.

`resolveScriptStrategy` still reports `worker` — your config reads back as you
wrote it — and only the loaded strategy moves.

If your own runtime applies the gate, **declare no `category`** and gate inside
the adapter: it is handed whole declarations, so a filter on `scripts` is all it
takes, and it is the only place a `worker` script can be gated. Declaring a
category is asking this build for the gate, and this build can only write one
around a script it loads itself.

If you configure no `runtime` at all you will not see this message: those
scripts already fall back to `idle` for the other reason, and the warning above
has named them.

## Where all of this is written

Everything the layer emits goes **last in the `<body>`**, after the page's
content and after its own entry chunk: the adapter's elements, then the one
`<script>` that carries the loading code. The exception is a facade's
placeholder, which is markup a visitor sees and goes inside `<main>` with the
rest of the page's content. Nothing
this layer writes reaches the `<head>`, which has one writer and one order (see
[the page head](./page-head.md)). The cost is that a worker runtime cannot boot
earlier than the document — the point of the feature is that third-party code
does not get in front of your page.

The pre-paint script above is the other side of that placement and is not an
exception to it: it is *your* code, declared in `build.prePaint` rather than in
this layer, and the head writer puts it there. Being in the head is the whole of
what it buys — every element on this list is behind it.

The loading code is inlined rather than emitted as a chunk, and it is
conditional all the way down. A page with only `idle` scripts carries no
interaction listeners; a page with only facades carries no idle machinery; a
page the layer puts nothing on carries nothing at all.
