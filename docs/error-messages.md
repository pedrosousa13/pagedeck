---
title: Error messages
description: Pagedeck error messages follow eight rules, from naming the failing thing first to writing through the run's channel, each shown with real messages.
---

# Error messages

Spec §14b: "Error messages are documentation: build failures name the page,
field, or budget concerned and link to the relevant doc."

These are the rules the errors already in this repo follow. Follow them in new
code. Every message below is one this codebase produces, with the interpolated
names filled in.

The citations are checked on every run by
`packages/core/src/source-citations.test.ts`, here and in every other document
and source comment in the repo (#426). Counting a citation as a prose pairing of
a name with a repo source path — the forms `x` (`path`), `x` in `path`, and
`x` at/from `path`, outside fenced blocks — there are 115 below, 102 of them
distinct, naming functions and the types, classes and constants beside them, and
each names a file that declares or re-exports it. The rule is written down
because two readers applying different ones get different totals: the 2026-09-09
sweep (#344) read `a`, and `b` (`path`) as two citations and counted 74, where
the test reads one. Both totals are asserted by that test, so they are
reproducible rather than remembered — which is what a sweep by hand was not:
#344 corrected 4 citations here and 3 in code comments, and this test's first
run found 5 more it had not reached, none of them in this document.

The messages themselves are checked on every run by
`packages/core/src/catalogued-messages.test.ts` (#444), whose unit is a message
rather than a name. A message is held against the one string or template
literal in shipping source that produces it end to end, with the spans that
literal interpolates left as holes it cannot read. **Of the 276 messages fenced
below, 220 are checked that way and 56 are not**, and that test lists the 56
one by one with the reason each is out: 54 because the producer assembles the
message from more than one literal, 1 because the fence quotes an excerpt
rather than a whole message, and 1 because Babel wrote it rather than this
repo. `beacon.test.ts` is the stronger arrangement over four of the 150 — it
calls `beaconFaultReport` and asserts this document holds what came back, so
those four are pinned whole rather than around their holes.

**What a template interpolates is not checked, and that is most of what is
below**: the 220 checked messages pin 34612 of the 85751 fenced characters, and
the rest is values. An enumerated list a message fills a hole with is a value
like any other — the two stale field lists #440 corrected were exactly that,
and neither test would have found them.

Two holes in those tests matter to a reader of this catalogue.
`examples.test.ts` checks its
producer against a copy of the message written inside that file rather than
against this one, so it holds that producer still and says nothing about the
copy below. And a citation naming no path, or naming a property rather than a
binding, is skipped rather than checked.

**The catalogue is scoped, and the scope is a boundary rather than a backlog.**
Quoted below are `@pagedeck/core`, `@pagedeck/content`, `@pagedeck/islands`, `@pagedeck/edge`
and its adapters (#19), `@pagedeck/search`, the docs site's refusal of an unlisted
`docs/` entry from `@pagedeck/docs-site` (#576), the deploy's refusal of an origin that lost
its manifest from `@pagedeck/site` (#561), its refusal of an `--edge` target no adapter
names (#19), its refusals of a file of presigned URLs (#652) and the
signing step's refusals (#665), and the `@pagedeck/fixtures` and `@pagedeck/examples` scaffolding the
messages are asserted against. No other package is. The premise above is a soundness claim, that every message here is
one this codebase produces; it was never a completeness one, that every message
this codebase produces is here. The rules bind what is not quoted all the same:
a loader's refusal follows rules 1 to 3 whether or not it appears below, so an
absence here is not evidence of a violation.

A runnable example of one of these failures is
`packages/examples/src/a-broken-entry.ts`; the message it produces is asserted
in `packages/examples/src/examples.test.ts`.

## 1. Name the failing thing first

The first words say which collection, config, fixture or snapshot the message
is about. A reader scanning a CI log should not have to reach the stack trace
to know where to look.

```
Collection "pages": loader syncAll failed
Config "/site/pagedeck.config.ts": has no default export — export default defineConfig({ collections })
Fixture "/site/content/en/home.json": is not valid JSON
Snapshot pull from "https://cdn.example/store.db" failed
```

`packages/content/src/collection.ts`, `packages/core/src/config.ts`,
`packages/fixtures/src/loader.ts`, `packages/core/src/snapshot.ts`.

## 2. Go down to the entry and the field

A collection name alone is not a place to look. Schema failures name the
locale, the path and the field, dotted for nesting (`hero.title`):

```
Collection "articles": 1 entry does not match the collection schema — fix the content, or relax the schema:
  /en/no-title: title — Invalid input: expected string, received undefined
```

That is the message `packages/examples/src/a-broken-entry.ts` produces, asserted
character for character in `packages/examples/src/examples.test.ts`. The text
after the field name comes from the validator, so it is whatever zod, valibot
or arktype said; everything before it is `validateEntry` and `schemaFailure` in
`packages/content/src/collection.ts`. Both paths that write a loader's entries
share them — sync, and the `fetchOne` write-back in `getEntryCached` — so one
entry failing a cached fetch reads exactly the way one entry failing a sync
reads.

A failure with no field to name says so (`(whole entry)`) rather than leaving
the reader to guess the scope.

## 3. State the fix in the same sentence

The message ends with what to do, not just what happened. Before and after,
from `listDueEntries`:

- Without: `Collection "posts": no publishField`
- With: `Collection "posts": declares no publishField and no unpublishField, so
  no entry has a publication schedule — declare one to query due entries`

Others in the same shape:

```
Collection "posts": no cursor to sync since — run a full sync first
Config "/site/pagedeck.config.ts": declares no collections, so sync would do nothing — list at least one
No store to push at "/site/content.db" — run pagedeck sync first
Config "/site/pagedeck.config.ts": no store to read at "/site/content.db", so pagedeck dev has no pages to serve — run pagedeck sync if it has not been created yet
Dev server: no store to read at "/site/content.db" — run pagedeck sync if it has not been created yet
Snapshot target "https://cdn.example/store.db": scheme "s3:" is not supported — use file: or https: (an S3-style target is an https: presigned URL)
Edge target "fastly" is not supported — use one of: cloudfront-function, netlify, nginx, cloudflare-worker
Routing manifest: version 2 is newer than edge adapter "nginx" reads (1) — upgrade the @pagedeck/adapter-* package you compile with, or build with the @pagedeck/core that wrote it
```

The edge target names the supported list rather than describing it, because the
list is the deploy's adapters' names interpolated (`EDGE_ADAPTERS` in
`packages/site/src/deploy.bin.ts`): prose naming four hosts is prose that
drifts from that list the first time a fifth lands.

The two store lines for `pagedeck dev` share one fix, written once as
`UNREADABLE_STORE_FIX` (`packages/core/src/dev.ts`): the first is the refusal at
startup, the second what a request meets for a store file that will not open.
Rule 8 argues when each one runs.

Where the fix needs a reason, give the reason — the redirect failure in
`packages/core/src/snapshot.ts` explains that redirects are not followed
because they can move the transfer off `https:`, then says to point the target
at the final location.

The same file refuses a target on a loopback or link-local host, and the reason
is the direction that is dangerous rather than the address (#118): a push PUTs
the site's whole content store to whatever the target names, so a URL that came
out of an edited CI variable or a lost interpolation ships the store instead of
failing to fetch one.

```
Snapshot target "https://169.254.169.254/site.db": host "169.254.169.254" is a link-local host — no snapshot is served from this runner or its link, and a push to one would PUT the site's whole content store to whatever the target names; point the target at the host the snapshot lives on
```

One message serves both verbs, because `parseTarget` is what refuses and both
`pagedeck store pull` and `pagedeck store push` go through it. So the reason is written as a
standing fact about a push rather than as a report of what this run did — a
reader who typed `pull` is told why the check exists, not what their push
supposedly sent. `packages/core/src/snapshot.test.ts` asserts the sentence above
character for character, so this quote cannot drift out of date in silence.

The host is named because the target is the thing the reader edits and the host
is the part of it that is wrong, and it is named **through `redactTarget`** like
every other target-derived string this module prints (rule 6). No override is
offered: a switch that turns the refusal off is a switch the edited variable it
guards against can set too.

The same file refuses a pull whose body has no end it can recognise (#313). A
snapshot is the site's whole content store, and a transfer that stops half way
through one used to be renamed over the store and surface much later as SQLite
corruption, so the refusal says what is missing, what the two acceptable
framings are, and — where a store already existed — that it is still there:

```
Snapshot pull from "https://cdn.example/store.db" failed: the host declared neither a content-length nor a chunked transfer-encoding, so the body ends wherever the connection does and a cut transfer ends it as quietly as a complete one — whatever arrived would be renamed over the store; serve the snapshot with a content-length (a presigned S3 GET does) or chunked
Snapshot pull from "https://cdn.example/store.db" failed: the host declared 4112 bytes and the body carried 1000 — the store at "/site/content.db" is left as it was rather than replaced by a snapshot that is not the one the host described; re-run the pull
Snapshot pull from "https://cdn.example/store.db" failed: the host declared a content-length of "twenty", which is not a count of bytes, so there is nothing to check the snapshot against — serve the snapshot with a content-length that counts its bytes
Snapshot pull from "https://cdn.example/store.db" failed: the host sent the body with content-encoding: gzip, and fetch decodes it before it is written, so the declared length counts other bytes than the ones that would reach the store — serve the snapshot unencoded, or chunked, which needs no length
```

All four are the one sentence `pullFailed` writes — "Snapshot pull from X
failed" — with a detail after the colon, because a reader grepping a CI log for
a failed pull should meet the same opening whether it failed at the request, at
the framing, or part way through the body (rule 1).

The first two name the numbers the reader can act on. The count says *declared*
and *carried* rather than "truncated", because the same check catches a body
that is longer than was declared, and a message that has already decided which
mistake was made is a message that is wrong half the time. The store's path is
named in it for one reason: the reader's next question after a failed pull is
whether the store survived, and the answer is worth more than the inference.

The last two are refusals of things that work elsewhere, so each ends with the
framing that does work rather than with the rule alone — a host serving
snapshots gzipped is not doing anything wrong on the open web, it is doing
something this transport cannot check a length against.

**A refusal of something that works elsewhere needs the reason most of all**,
because without it the message reads as the framework being arbitrary. React 19
lets a component declare a stylesheet with a `precedence` prop; this framework
refuses one, and `hoistedReport` (`packages/core/src/render.tsx`) says what it
is protecting rather than merely that it refuses:

```
Component "Sheeted": declares a stylesheet with React's precedence prop, and entry /en/home renders it — React hoists "/island.css" to the front of the island's own fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component's module so the build places it in a tier, or remove the precedence prop
```

The `<head>` this build emits is written entirely by the build, and having one
writer for it is what makes the CSS tiers order deterministically at all. A
build-time render prerenders a *fragment*, so React hoists the sheet into
`<body>`, where it beats a `<head>` tier sheet at equal specificity — silently,
in every direction
`docs/research/2026-08-29-react-19-stylesheets-under-island-roots.md` measured.
So the refusal is stated as that ownership and not as a rule about one React
feature, which is also what makes it read correctly the next time React grows a
resource the build has to place.

A sheet React hoisted outside every island marker has no component to name — a
static component's sheet goes to the front of the *page's* fragment, and nothing
in the bytes says which component wrote it — so that one names the entry
instead, and is refused all the same:

```
Entry /en/home: declares a stylesheet with React's precedence prop — React hoists "/page.css" to the front of the page's fragment, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import the stylesheet from the component's module so the build places it in a tier, or remove the precedence prop
```

Rule 5 collects them, in the document order of the emitted bytes, and a line
that has no component to name says so rather than leaving a blank:

```
Entry /en/home: 2 stylesheets are declared with React's precedence prop — React hoists each to the front of the fragment it was rendered in, inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers; import each stylesheet from its component's module so the build places it in a tier, or remove the precedence prop:
  the entry's own tree — "/page.css"
  "Sheeted" — "/island.css"
```

A component rendering a plain `<link rel="stylesheet">` with no `precedence` is
not a React resource, keeps its place, and still builds. The rule is written
against the `data-precedence` attribute React stamps rather than against
`<link>`, which is what gets that right without a second case.

**Where the framework does the thing instead of refusing it, the message is
about the one case it still cannot do.** A `<title>` or a `<meta>` a component
renders is absorbed into the `<head>` and nothing is reported (#239,
`CONTEXT.md`). What has no answer is two of them claiming one head singleton
with two values, and `absorbedHeadConflicts` (`packages/core/src/head.ts`) says
what the build did with the rest before it says what it could not do with these:

```
Entry /en/home: 2 claims on <title> disagree — a document holds one <title>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:
  "Alpha" — "from Alpha"
  "Beta" — "from Beta"
```

Both claimants and both values (rule 2), because only the reader knows which of
them is the mistake. A claimant with no component to name is the site's own
declaration or the build's own head, and each says which it is:

```
Entry /en/home: 2 claims on <meta charset> disagree — a document holds one <meta charset>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:
  the build's own <head> — "utf-8"
  "Alpha" — "utf-16"
```

Rule 5 collects them: one paragraph per singleton the page disagreed over, in
the order the claims were made. A value that is a URL rather than content is
redacted first, by rule 6:

```
Entry /en/home: 2 claims on <meta property="og:image"> disagree — a document holds one <meta property="og:image">, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:
  build.head — "https://cdn.example/a.png"
  "Alpha" — "https://cdn.example/b.png"
```

**The body has a singleton region too, and `landmarkReport` in
`packages/core/src/build.ts` refuses a second claim on it the way the head's
refusal does** (#455). `documentHtml` wraps every page's tree in
`<main>`, so a component that renders its own nests inside it and axe reports
`landmark-main-is-top-level`:

```
Entry /en/: 2 <main> landmarks in one document — the build writes one around the page's whole rendered tree, so a component that renders its own nests inside it and axe reports landmark-main-is-top-level; render <section>, <div> or a fragment in the component instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

The entry is named and the component is not, for the reason the page-level
stylesheet message above names an entry: a document records nowhere which
component wrote a tag, and a page composed from CMS blocks has several
candidates. The page is the one name that sends a reader to the right file every
time. The fix offers three elements because the component wanted a wrapper and
only the name it chose is refused, and it cites `CONTEXT.md` instead of
restating the ownership rule, which is where a site author can read why the
landmark is not theirs to write.

**A landmark in a site's chrome is refused by a message of its own, and before
that count runs** (#409). `BuildSection.chrome` renders a header, nav or footer
beside core's landmark rather than inside it, and `chromeLandmarkReport` in
`packages/core/src/build.ts` refuses a `<main>` in either region:

```
Entry /en/: build.chrome rendered a <main> landmark — the build writes the one <main> around the page tree and places the chrome before and after it, so a landmark in the chrome is a second one and is not taken in place of the build's; render <header>, <nav>, <footer> or a <div> in the chrome instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

The count above would refuse the same document as two landmarks and send the
reader to the page's components, which did nothing wrong. This one names the
field instead: the chrome is one callback, so `build.chrome` is the one place to
look. It also refuses what the count cannot see as a fault, a chrome whose
landmark would be the page's only one if core did not write its own. The fix
offers the elements a chrome is made of, because the chrome wanted one of those
and chose the one core owns.

**The same rule reaches the tree at `outDir` by a second door, and there it is a
`ConfigError`.** An incremental build reuses a page it did not render by reading
the document back off that tree, so those bytes never pass through the composer
above — and a tree written before this refusal existed holds documents it would
have refused. `carryDocuments` in `packages/core/src/build.ts` counts them on
the way in, which is what makes "one landmark per document" true of every page
of every build rather than of the pages a run happened to re-render:

```
Output "/site/dist": 1 reused page cannot be carried from the previous build — an incremental build reads a page it does not render back off this tree rather than composing it again, so a document the previous manifest does not name, or that this tree does not hold as that build wrote it, has no bytes to carry, and one this build would refuse to compose is not carried past that refusal — run pagedeck build to write the whole site again:
  "/index.html" — en /'s document, and it holds 2 <main> landmarks — the bytes are the ones the previous build recorded, so that build wrote them before this one refused a second landmark; render <section>, <div> or a fragment where the component renders <main> (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

Rule 5 collects it under the headline the two faults about an intact tree
already share, because a component that renders `<main>` renders it on every
page that mounts it. The line states that the bytes match the row that recorded
them, which is load-bearing twice over: it rules out the edited-tree fault
reported a line above, and it dates the document to a build that predates the
refusal. Rule 7 is where the two classes are argued.

**The same function refuses a second thing about the same body, and there the
fix is usually to load the script on fewer pages.** A facade declares where its
placeholder goes by naming an element's `id`, and `mountFacades` in
`packages/core/src/build.ts` refuses a page that renders no such element (#461):

```
Entry /en/post: 2 facades declare a mount point no element on this page carries — a facade's placeholder is emitted inside the element its mount point names, so this page has nowhere to put one; render the element, or take the script off this page with a pages or pageTypes override set to "off":
  "comments" — no element carries id="comments"
  "chat" — no element carries id="chat"
```

The entry is named for `landmarkReport`'s reason and for one more: a facade is
declared once for a whole site, so the script's name says nothing about which
page failed to render its element. Rule 5 collects them because a site that
spelled one id wrong has likely spelled several, and the two lines are one edit
in one config object.

The fix names both ways out, and the second is what the message is for. A
site-wide chat widget whose mount point exists only on post pages is a script
that should have been scoped to post pages — the "Off broadly, on narrowly"
layering in
`packages/docs/reference/third-party-scripts.md` — and the alternative
reading, that every page now owes the site an empty element, is the one a
message naming only the first fix would leave. There is no fallback to the
default placement: a facade emitted somewhere other than where the site put it
is the fault this refusal exists to prevent, one step quieter.

**A mount point the site's chrome renders is refused with that reason instead**
(#409). The element exists, so "no element on this page carries" it would be
untrue and would send the reader looking for a typo. `chromeMountReport` in
`packages/core/src/build.ts` says where the element is and why that place
cannot hold a placeholder, and the two reports join one throw when a page has
both kinds:

```
Entry /en/: 1 facade declares a mount point only build.chrome renders — a facade's placeholder goes inside the <main> landmark with the page's content, and the chrome is outside it; move the element carrying the id into the page tree:
  "comments" — id="comments" is on an element build.chrome renders
```

The fix is the one move that keeps the placeholder in the landmark. Scoping the
script off the page is still available, but it is not what a site that put the
element in its footer on purpose wants to hear first.

**A fault in the chrome's own nodes names the chrome rather than the entry**
(#409). `renderPage` walks the chrome as the tail of the page tree, so the
component refusals, the island prop reports and a thrown component all read the
chrome's region off the node's place in that tree and say it (`nodeSource` in
`packages/core/src/tree.tsx`):

```
Component "Thrower": threw while rendering build.chrome (before <main>) on entry /en/ — fix the component, or the props build.chrome gives it
```

Without it the message would say the entry renders a component the entry's
content does not hold, and the fix would point at props the entry never gave.

**A deploy over an origin that lost its manifest names the build to put back**
(#561). `deploy.bin.ts` reads an origin with no `manifest.json` as a first
deploy, but only while the origin's deploy history is empty too. Every document
in that history is a build an apply published before it put `manifest.json`, so
a history with no manifest beside it is an origin that lost one, and a dangling
link there is the same loss. Planned as a first deploy, the prune does not know
which build was live and can delete the files that build serves at once, so the
run is refused before it plans.

The fix names a file, because "the build the origin serves" is a question the
reader would have to go and answer. Every apply writes the build's deploy
instant beside its document, rollbacks included, so the build with the newest
instant is the one the origin served, and the refusal names it and the exact
copy to make. `--from` that same document is the second way back. When an
instant there cannot be read, it could be the newest, so the refusal names no
build and points at the line the last apply printed, which names that build's
history file. Why the origin is refused rather than planned is left to the
paragraph above, so the message spends its length on the fix:

```
Deploy: there is no manifest at "/srv/origin/manifest.json", but the origin's deploy history at "/srv/origin/.pagedeck/manifests" holds 2 builds, so the origin is damaged rather than new; build "b2" has the newest deploy instant there, so it is the build the origin last served — copy "/srv/origin/.pagedeck/manifests/b2.json" to "/srv/origin/manifest.json", or pass --from "/srv/origin/.pagedeck/manifests/b2.json"

Deploy: there is no manifest at "/srv/origin/manifest.json", but the origin's deploy history at "/srv/origin/.pagedeck/manifests" holds 2 builds, so the origin is damaged rather than new; the deploy instants there do not say which build the origin serves — copy the history file the last apply's "Filed this build" line names to "/srv/origin/manifest.json", or pass --from that file
```

The copy is a full restore: a history document is byte-identical to the
`manifest.json` it was published as. Neither fix needs a new option.

## 4. Attach the cause, do not flatten it

Wrap with `{ cause }` instead of interpolating the inner message. The outer
message names the collection; the inner one says what actually broke, and the
CLI prints the whole chain (`describeError` in `packages/core/src/exit.ts`
joins it with `: `).

```ts
throw new Error(`Collection "${collection}": loader ${operation} failed`, {
  cause,
});
```

Flattening loses the inner error's type and stack for anything that catches it
programmatically, and gains nothing in the log.

**A report that collects (rule 5) quotes each inner message on its own line
instead, and that is not an exception to this rule.** A cause is a claim that
one error caused another, and several independent failures are not that: two
causes cannot both be *the* cause. So `readManifests`
(`packages/core/src/cli.ts`) flattens a pair of manifest failures into one
report rather than carrying either as a cause, and rethrows a lone one whole so
the common case keeps its chain. What this rule forbids is
losing the inner text, and a quoted line does not lose it — it keeps it for
every failure rather than for one. §2's schema failure is the shape: the
validator's text goes on the failing entry's line.

`unparsedReport` (`packages/core/src/island-facts.ts`) does the same with the
parser's text, indenting every line of it by the same four spaces so the caret
stays over the column it points at:

```
Island scan: 2 component modules will not parse, so the scan cannot tell whether a "use client" boundary is declared — fix the syntax error the parser names in each:
  "/site/components/Copy.js" —
    Parse failed with 1 error:
    Expected `}` but found `EOF`
    1: export default function Copy() { return "marker-copy-7c02";
    1: export default function Copy() { return "marker-copy-7c02";
                                      ^
  "/site/components/Hero.js" —
    Parse failed with 1 error:
    Expected `}` but found `EOF`
    1: export default function Hero() { return "marker-hero-41bd";
    1: export default function Hero() { return "marker-hero-41bd";
                                      ^
```

The source line appears twice because that is what the parser emits; the frame
is quoted as it arrived rather than edited into shape.

A site's `.tsx` or `.jsx` module that the `pagedeck` executable compiles itself
(#702) is the other case: one module and one compiler run, so its faults are
wrapped rather than quoted. `compileFault` (`packages/core/src/jsx-loader.ts`)
names the module, and the line when there is one fault, and carries the
compiler's text in the cause:

```
Module "/site/components/Bad.tsx" line 2: does not compile — fix the syntax at the line named
Module "/site/components/Typed.jsx": 2 syntax errors, so it does not compile — fix the syntax at each line named
```

The run prints the cause after the fix, so a config that imports the first
module fails with `Config "/site/pagedeck.config.ts": failed to load: Module
"/site/components/Bad.tsx" line 2: does not compile — fix the syntax at the
line named: column 16: Unterminated regular expression`. The second module's
faults print on that same line, joined by `; `, rather than one per line: its
error is a cause of the config's, and `describeError` prints a line break in a
cause as a replacement character. The cause is an `AggregateError` holding
rolldown's own errors rather than one of them, because their messages are
coloured, multi-line code frames that would print the same way.

Attach the cause when one failure is being wrapped; quote it per line when many
are being reported.

## 5. Report every failure, not the first

One run should reveal every problem of the same kind that it can see.
`validateBuffer` collects every failing entry and every issue on each of them
before throwing:

```
Collection "pages": 2 entries do not match the collection schema — fix the content, or relax the schema:
  /en/home: hero.title — Invalid input: expected string, received number
  /de/pricing: layout — Invalid input: expected string, received undefined
```

`syncSite` in `packages/core/src/sync.ts` does the same one level up: a failing
collection does not stop the others, and every failure is reported at the end.
The alternative is a build loop that reveals one broken field per run.

`listDueEntries` in `packages/content/src/collection.ts` collects the same way
over a collection's **publication windows** (#283) — an entry whose unpublish
instant is at or before its publish instant is due at no instant at all, so it
emitted no page and said nothing:

```
Collection "posts": 2 entries have an unpublishField instant at or before their publishField instant — fix the two instants, or declare only one end of the window:
  /en/equal: unpublishField "unpublish_at" (2025-01-01T00:00:00Z) is at or before publishField "publish_at" (2025-01-01T00:00:00Z)
  /en/transposed: unpublishField "unpublish_at" (2020-01-01T00:00:00Z) is at or before publishField "publish_at" (2030-01-01T00:00:00Z)
```

The field name repeats on every line rather than sitting once in the headline:
a collection has one `publishField` for every entry in the report, but the
instant a reader has to check is the entry's, and rule 2 is about that value.
An author who transposed one pair has likely transposed several, which is what
puts this here rather than on the first offender.

`layoutContents` in `packages/core/src/layout.ts` reads every entry a
collection renders into a layout (#712) before the first page renders. An entry
without a string `title` or `html`, or whose `frontmatter.components` is not a
list, is a shape fault. A name in `frontmatter.components` that the registry
does not hold is the other fault, and its line quotes every such name on that
entry. The two have different fixes, so each gets its own paragraph in one
throw:

```
Collection "pages": 2 entries do not have the shape a layout renders — give each a string title and html, and a list at frontmatter.components if it has one, as the markdown loader writes them, or render the collection through a content callback instead:
  /en/broken — html is not a string
  /en/listless — frontmatter.components is not a list

Collection "pages": 1 entry names components at frontmatter.components that build.components does not register — name only registered components, which are "counter", "layout":
  /en/counter — "./x.js", "@scope/pkg"
```

The message lists the registered names because its reader is often editing
content, not the config. The build looks a frontmatter name up in the registry
and never resolves it as a module, so it refuses `./x.js` above as an unknown
name, the same as a typo. A page that falls back to another locale's entry
renders that entry, and the report names the entry once. Both faults are
content, so they exit `1`; rule 7 argues the class.

`loadComponents` in `packages/core/src/tree.tsx` collects across a page's
whole tree, so one run names every component a rename left behind:

```
Entry /en/home: 2 components are not registered — declare each under build.components, or add each to the registry passed to renderPage, or remove the reference from the entry:
  Testimonials
  Quote
```
```
Entry /en/home: 3 components have no default export — export each component as its module's default:
  Hero
  Heading
  Icon
```

**Those are two throws, and they stay two throws because they are two
classes.** An unregistered name is the site's wiring — `RegistryError`, exit 2.
A module missing its default export is a page that will not render —
`RenderError`, exit 1 (rule 7). One combined report would have to pick one
exit code for both, which means dropping a classification to save a header. A
page with both faults reports the wiring one first: a name the registry does
not hold has no module to have a default export, so its export verdict does not
exist yet, and reporting the render fault first would send a reader to fix
modules while the registry naming them is still wrong.

`renderPage` is the second place a run splits for that reason.
`throwContradictedHydration` (`packages/core/src/client-reference.tsx`) reports
a `"use client"` module registered `hydrate: "none"` — the registry's wiring,
`RegistryError`, exit 2 — and `throwProxyFaults` reports every other proxy fault
on the same page as a `RenderError`, exit 1. The order is argued differently
there: a contradicted instance renders nothing, so the render report below it
was collected over a page with that component's subtree missing from it, and the
report that is incomplete is not the one to put first.

Collecting is also what decides where the collection lives. `resolveComponent`
answers about one name, and it is called one name at a time — by
`resolveHydrationMode`, and by `loadComponents` itself — so it keeps the
single-name sentence; `loadComponents` is what walks a whole tree and holds the
results, so it is the only place that knows what "every failure on this page"
means. Put a collection at the level that can see the whole set, not at the
level that happens to detect the fault.

A config load checks each component declaration's shape with the check
`defineComponents` runs (`componentFaults` in
`packages/islands/src/registry.ts`), so a plain object written without that
helper is refused before any component loads. Since #710 a component has one
declaration, a path or a package specifier. Before #710 a loader,
`{ import: () => import("…") }`, was a second form, and the check names each
component still declared that way, with or without a path beside it:

```
Config "/site/pagedeck.config.ts": "build.components" holds 3 components that are not usable — fix each one:
  "hero": declares no path — name its module by a path relative to the config file, such as "./components/<module>.tsx", or by a package specifier, such as "<package>/<module>"
  "legacy": declares a loader, import, which was removed — name its module by a path relative to the config file, such as "./components/<module>.tsx", or by a package specifier, such as "<package>/<module>"
  "lead": declares both path and import, and import was removed — keep path and drop import
```

`build.modules` went in the same change. A path names a component's module for
the render and the client build alike, so the map had nothing left to add. A
config that still declares it fails at load, in the same run as the build
section's other faults. The message lists every entry the map holds, each with
the path to declare under `build.components`:

```
Config "/site/pagedeck.config.ts": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules"; it lists 2 components to declare there by these paths:
  "counter" — "./components/counter.tsx"
  "pricing" — "@acme/design-system/components/pricing"
```

A map with no entry it can read, empty or not an object, gets the form by
example instead:

```
Config "/site/pagedeck.config.ts": "build.modules" was removed — declare each component once, by the path of its module under "build.components", and delete "build.modules", as components: { counter: "./components/counter.tsx" }
```

Then `deriveComponents` (`packages/core/src/components.ts`) resolves every
declaration, a relative or absolute path as a file against the config's
directory and anything else as a package specifier, through the island scan's
own resolver. It names each one that resolves to nothing, rather than leaving
the first to surface as a Node import error mid-render:

```
Config "/site/pagedeck.config.ts": 2 components declare a module that does not resolve — point each path at a file, relative to this config file, or install the package each specifier names:
  "ghost" — "./components/Ghost.js" resolves to "/site/components/Ghost.js", and no file is there
  "phantom" — "@acme/phantom/widget" resolves to no module from "/site/pagedeck.config.ts"
```

The docs site collects the same way over the repository's `docs/` tree (#576).
`refuseUnclassified` in `packages/docs-site/src/site.ts` names every entry directly
under that tree which `REPOSITORY_DOCS` neither puts on the site nor excludes,
so a new directory and a new file beside it cost one run and not two. `pagedeck sync`
reports it as the cause of `Collection "repository": loader syncAll failed`:

```
Docs site: 2 entries directly under "/repo/docs" are on neither of the docs site's lists, so the site cannot tell whether to show them — add each entry to REPOSITORY_DOCS.published to put it on the site, or to REPOSITORY_DOCS.excluded to keep it off the site:
  drafts
  notes.md
```

The boundary is the *kind* of failure. Content that fails its schema is one of
possibly many, so it is collected. A validator that **throws** is not — it is a
wiring failure, the rest of the pass would be measured with a broken
instrument, and `collection.ts` rethrows on the first one
(`Collection "…": schema threw validating entry "…"`, with the thrown error as
`cause`). Collect the failures a run can meaningfully enumerate; stop on the
ones that invalidate the run itself.

An edge adapter's `compile` (`defineAdapter`, `packages/edge/src/adapter.ts`)
collects across a whole compile and reports once through `throwIfAny`
(`packages/edge/src/faults.ts`),
one paragraph per kind of fault so each keeps its own count and its own fix:

```
Edge target "nginx": 2 values cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/price$" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one
  the default tree's header "Content-Security-Policy" under prefix "/en/" — nginx interpolates "$" inside a quoted string, and offers no escape for a literal one

Edge target "cloudflare-worker": 2 redirect targets are not paths on this site — write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge:
  the default tree's redirect target on "/a" — the target holds a scheme
  the default tree's redirect target on "/b" — the target begins "//", which is a host
```

The second is `planRouting`'s own refusal of an off-site target, made again by
the Worker's compiler (#665): a compiler is handed a document, not necessarily
one `planRouting` wrote. The Vercel, Netlify and Cloudflare Pages compilers make
it again for a source as well as a target, through `refuseOffsite`
(`packages/edge/src/faults.ts`), and a source gets a paragraph of its own,
because its fix is `planRouting`'s source fix (#41):

```
Edge target "netlify": 1 redirect source is not a path on this site — write a tree-relative path like "/pricing"; the edge matches the path alone, so a source spelled as a URL is a rule that can never fire:
  the default tree's redirect from "https://evil.example/b/" — the source holds a scheme
```

Netlify and Cloudflare Pages write a path into a line of `_redirects` or
`_headers`, so each refuses a `:` anywhere in it, not only one that begins a
segment, and any whitespace character, named by code point (#41):

```
Edge target "netlify": 2 values cannot be expressed by this target — remove the character, or compile a target that can express it:
  the default tree's redirect from "/time-12:30/" — Netlify reads ":" in a path pattern as the start of a placeholder, and offers no escape for a literal one
  the default tree's header prefix "/p q/" — Netlify reads U+0020, a whitespace character, as the end of a path pattern, and offers no escape for a literal one
```

Every adapter makes `planRouting`'s header checks again, for the same reason
(#671). `defineAdapter` runs them before any adapter's own grammar, with
`unusableHeaderName` and `unusableHeaderValue` from
`packages/core/src/routing.ts`, so all six adapters refuse a field alike. Both
fixes are `planRouting`'s own, so each rule has one wording. A value is named
by the code point that broke it and never quoted:

```
Edge target "cloudflare-worker": 1 header name is not a token — write the name as a header field name, such as "X-Frame-Options"; a name that is not one is emitted verbatim, and each target then either reads that line as a different field than the one written, or refuses it outright after the build has already reported success:
  the default tree's header name "X-Frame Options" under prefix "/" — the header name holds " ", and a header name is one RFC 9110 token

Edge target "cloudflare-worker": 1 header value cannot be sent — remove the character; a field value may hold no control character but HTAB (RFC 9110 forbids the C0 ones and DEL, and a C1 one reaches a headers file as two bytes of UTF-8), since a line break can write a second header, and a Worker's Headers refuses any character above U+00FF:
  the default tree's header "X-Note" under prefix "/" — the header value holds U+000D
```

A name that begins `#` or `!` is an RFC 9110 token, so it passes that check,
but a line-based headers file can read it as a comment or a detach. It is
refused in a paragraph of its own, by `unwritableHeaderName`
(`packages/core/src/routing.ts`), and the line says which reading (#41):

```
Edge target "netlify": 1 header name cannot be written to a line-based headers file — drop the leading character from the name:
  the default tree's header name "#X-Frame-Options" under prefix "/" — the header name begins "#", which a line-based headers file can read as the start of a comment
```

A value may hold no control character but HTAB (#41). RFC 9110's `field-value`
forbids the C0 controls and U+007F. It admits a C1 control, U+0080 to U+009F,
as `obs-text`, but `obs-text` is an octet, and a headers file is UTF-8, so a C1
control is written as two bytes, and U+0085 is a Unicode line break. So a C1
control is refused too, and any other character up to U+00FF passes.

`planRouting` refuses a value by the same rule (#681), so a site's own config
fails at build time and the compiler's check catches a document edited after
planning. A Worker's `Headers.set` throws on a CR or LF inside the value, on a
NUL anywhere in it, and on a character above U+00FF, which it cannot convert to
a byte. It throws on every request under that prefix; a CR or LF at either end
it trims instead.

A tree is named here by its host key, the host the parser reads out of a
locale's `domain` (#396), because the routing manifest this compiler reads
carries the key and no declared spelling; `planRouting`, which has the pages,
quotes each declared spelling beside the key instead.

An unknown target and an unreadable routing version are thrown on the spot
instead, on the boundary above: one leaves no compiler to run, the other no
document to run it on.

`budgetFaultReport` (`packages/core/src/budgets.ts`) has the same shape over a
declared JavaScript budget, and needs it for the same reason: an unparseable
limit, a key that is not a page pattern and two keys no page can choose between
are three different edits, and one headline could carry only one of the three
fixes.

```
Config "/site/pagedeck.config.ts": "build.budget" declares 1 limit that is not a size — write a number and a unit, one of b, kb or mb, such as "15kb":
  "/pricing" — "big"

Config "/site/pagedeck.config.ts": "build.budget" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  "blog" — the path does not start with "/"

Config "/site/pagedeck.config.ts": "build.budget" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same limit:
  "/a/*" and "/*/b" — equally specific, and both match "/a/b"
```

A budget that is not an object at all is the one budget fault reported alone.
There is nothing to enumerate inside it, so the collection every other paragraph
is a collection *of* does not exist.

`islandPropsBudgetFaultReport` (`packages/core/src/budgets.ts`) refuses a
`build.islandPropsBudget` that is not a size, with the same fix. The field is one
size for the whole site rather than a map, so there is one line under the
headline and no pattern half (#653):

```
Config "/site/pagedeck.config.ts": "build.islandPropsBudget" is not a size — write a number and a unit, one of b, kb or mb, such as "4kb":
  "big"
```

**`assertBuildSection` (`packages/core/src/config.ts`) then joins those
paragraphs to its own missing-field report and throws once.** Unlike
`loadComponents` above, this is one throw rather than two: both faults are the
site's wiring, so rule 7 classifies them the same way and there is no exit code
to drop. A build section is written as one object literal, so a field the site
has not declared yet and a budget key it spelled without a leading slash are one
edit session, and revealing them one run at a time is the build loop rule 5
exists to prevent. They still cannot share a headline — a missing field and an
unusable pattern have different fixes — which is why the throw is paragraphs
joined rather than a report merged. The missing-field report names each field
with the shape it takes, and `pages` takes two:

```
Config "/site/pagedeck.config.ts": "build" is missing 3 fields pagedeck build needs — declare each in the build section:
  "pages" — declare it as a list of page sources, or as a page set from definePages
  "components" — declare it as an object
  "content" — declare it as a function, or name a layout on every page source
```

`content` is required unless every page source names a layout (#712). It
renders exactly the pages whose source names none, so a site can render a
collection into a layout and a paged list through the callback. A layout that
`build.components` does not register gets a paragraph in the same throw,
naming every such source, whether or not it emits a page yet:

```
Config "/site/pagedeck.config.ts": "build.pages" names 1 layout that build.components does not register — register each under build.components, or name a registered component, which are "counter", "layout":
  sources[0] — layout "Layout"
```

`contentOf` in `packages/core/src/layout.ts` throws this when it meets a page
with neither a layout nor a callback. `loadConfig` already refuses such a
config, so only a `LoadedConfig` built some other way reaches it, and it names
the first such page rather than collecting them:

```
Page /en/notes: names no layout, and the build section declares no content callback to render it — declare build.content, or name a layout on the page's source
```

Three more paragraphs join the same throw, from the same file and for the same
reason. `cssFaultReport` collects every `build.css` entry that is not a
stylesheet path, and every line says why it is not one, because an index and an
empty quote diagnose nothing — least of all the whitespace-only entry, whose
quote is invisible:

```
Config "/site/pagedeck.config.ts": "build.css" declares 3 entries that are not stylesheet paths — write each as a path to a stylesheet, relative to this config file:
  css[1] — not a string
  css[2] — "" — the path is empty
  css[3] — "  " — the path is only whitespace
```

`viteFaultReport` collects every `build.vite.plugins` entry that is not a Vite
plugin. The fix wording is the load-bearing part: the mistake it most often
catches is a plugin *factory* passed uncalled, which reads correctly and whose
own failure is a `TypeError` from inside Vite's plugin sort, naming no config
and no field.

```
Config "/site/pagedeck.config.ts": "build.vite.plugins" declares 1 entry that is not a Vite plugin — pass what a plugin factory returns, not the factory itself — call the factory, as plugins: [somePlugin()]:
  plugins[0] — not a plugin object
```

`criticalCssFaultReport` (`packages/core/src/critical-css.ts`) is the third,
and it is `budgetFaultReport`'s shape *by construction* rather than by
resemblance (#23): both fields are maps keyed by page pattern, so the key half,
the collection and the ambiguous-pair refusal are one implementation in
`packages/core/src/page-patterns.ts`, and each field supplies only what its own
values mean — that a budget's is a size, that this one's is a flag. A key legal
in one field and refused in the other, or refused with a different sentence, is
the drift that placement prevents.

```
Config "/site/pagedeck.config.ts": "build.criticalCss" declares 1 value that is not true or false — write true to inline a page's stylesheets into its HTML, or false to leave it linking them:
  "/landing" — "yes"

Config "/site/pagedeck.config.ts": "build.criticalCss" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same flag:
  "/a/*" and "/*/b" — equally specific, and both match "/a/b"
```

The value is quoted with `JSON.stringify` rather than interpolated, so `"yes"`
and `yes` are two different lines: a string that looks like a flag is the
mistake this paragraph is most often read for. The fix names the flag in this
field's own word for rule 3's sake — "the same value" would make a reader
translate the advice back into the field they are looking at, which is why
`PatternValueRule.ambiguousFix` is supplied per field rather than written once
in the shared module.

`foldStrategyFaultReport` (`packages/core/src/fold.ts`) is the fourth, and it
is the one field of the four that is neither a pattern map nor a list — so
nothing in `page-patterns.ts` applies to it and both of its messages are its
own. It joins the same throw for `assertBuildSection`'s reason: a threshold
somebody typed in quotes and a field the site has not declared yet are one
edit session.

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" declares a threshold that is not a tree position — write a whole number of nodes, 0 or more, such as { threshold: 8 }:
  "8" — not a number
```

There is exactly one value inside the field, so the collected shape here is not
about counting: it is about where the reason goes. `"8"`, `8.5` and `-1` are
three different mistakes — a number in quotes, a pixel measurement written where
a node count belongs, and a negative that would put a whole page below the fold
by arithmetic rather than by intent — and a headline can carry only the fix they
share. The value is quoted with `JSON.stringify` on `criticalCssFaultReport`'s
argument, and it is load-bearing in a numeric field: an interpolated `8` would
be indistinguishable from the `8` that would have worked. The `8` in both fixes
is deliberately not the default — a fix an author can copy without changing
anything is not a fix (rule 3).

A key the field does not take is a fault of its own, with a fix of its own, so
it is a second paragraph in the same throw:

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" declares 1 field this build does not read — delete the field, or correct it to "threshold", the only field foldStrategy takes:
  "treshold"
```

This is the quietest failure the field has: `{ treshold: 4 }` is an object with
nothing wrong in it that does none of what the site asked for — the build takes
the default and no artifact anywhere records that a threshold was written. It is
the same argument the value check is made on, one level up. The reason is in the
headline rather than on each line, because every key in the list has the same
one.

A `css` that is not an array and a `vite` that is not an object are each
reported alone, on the argument the non-object budget above makes: there is no
collection inside them to enumerate. So is a `criticalCss` that is not an
object, and so is a `foldStrategy` that is neither a flag nor an object:

```
Config "/site/pagedeck.config.ts": "build.foldStrategy" must be true, false, or an object with a threshold — write foldStrategy: false to turn fold-driven hydration off, or foldStrategy: { threshold: 8 } to tune it
```

**A `head` that is not a function is the fifth paragraph, and it is reported
alone for a reason the four above do not have** (issue #41). The others are
values — a map, a list, an object — and a value is reported alone when there is
no collection inside it to enumerate. This field is a *callback*, so there is
nothing inside it to enumerate even in principle: a function is not a container,
and the only thing that can be wrong with one at config load is that it is not a
function. It joins `assertBuildSection`'s throw all the same, on that function's
standing argument — a site wiring up a head and a budget writes one object
literal, and learning about them one run apart is the build loop rule 5 exists
to prevent.

```
Config "/site/pagedeck.config.ts": "build.head" must be a function returning one page's head fields — head: (page, store) => ({ title: "…" })
```

The fix carries the signature rather than naming the type, because the mistake
it catches is `head: { title: "…" }` — a site that wrote the head fields where
the function belongs. That reads perfectly well, type-checks nowhere in a `.js`
config, and would otherwise surface partway through a build as a call on a
non-function, naming a page and not the field.

**A `chrome` that is not a function is the sixth, and it is reported alone on
the same argument** (#409). It is the second optional field that is a callback, and the
mistake it catches is the same one, the regions written where the function
belongs:

```
Config "/site/pagedeck.config.ts": "build.chrome" must be a function returning one page's chrome — chrome: (page, store) => ({ before: [{ component: "Nav" }], after: [{ component: "Footer" }] })
```

`originFaultReport` is the seventh, and it collects (issue #39). The field is one
string, so the collection is not about counting either: a scheme a browser will
not fetch, userinfo, a path, a trailing slash, a query and a fragment are six
different mistakes with six different fixes in the author's head, and the
headline can carry only the one they share. Every line quotes the value, because a URL is
what the author typed and what they will search for.

```
Config "/site/pagedeck.config.ts": "build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":
  "https://example.com/shop" — the origin holds the path "/shop", and this build appends each page's own path to it
```

**The quote is redacted, and this is the field rule 6 is written for.** An
origin is a URL, and both places a URL hides a credential are cut out of it
before it reaches a log: the query at its delimiter, the way `unusableReason`
cuts a route, and the userinfo at the `@` that ends it. So the two faults that
would otherwise print a token name it instead — one report each, since each is
a different origin:

```
Config "/site/pagedeck.config.ts": "build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":
  "https://example.com?…" — the origin holds a query, and an origin is a scheme and a host
```

```
Config "/site/pagedeck.config.ts": "build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":
  "https://…@example.com" — the origin holds userinfo, and an origin is a scheme and a host
```

The cut is made on the string rather than on a parsed URL, because the value
that most needs it is the one that did not parse — and a value that did not
parse is reported as that, since every other verdict about it would be measured
on a URL nobody has:

```
Config "/site/pagedeck.config.ts": "build.origin" is not a site origin — write the scheme and host the site is served from and nothing else, as origin: "https://example.com":
  "example.com" — not an absolute URL, so it names no scheme and no host
```

An `origin` that is not a string is reported alone, on the argument the
non-object budget makes: there is no collection inside it to enumerate.

`xDefaultFaultReport` is the eighth, and its two paragraphs are the two ways a
locale code can be wrong in a build section. The first is the fault
`missingFallbackReport` (`packages/core/src/locales.ts`) reports about a locale
map, mirrored rather than shared: a field pointing at a locale the map does not
hold. It names the declared locales rather than describing them, for the reason
the edge target does — prose listing a site's languages is prose that drifts
from the map it is about.

```
Config "/site/pagedeck.config.ts": "build.xDefault" names a locale that is not declared — declare the locale, or point xDefault at a declared locale:
  "fr" — the declared locales are "en", "de"
```

The second is a cross-field refusal, and it is the one paragraph in this section
about a field that is *unusable* rather than malformed. `x-default` is emitted
as an absolute URL, so without `build.origin` there is nothing to compose one
from, and a site that declared it would get no tag and no word about why. The
fix offers both directions, because either is a whole answer:

```
Config "/site/pagedeck.config.ts": "build.xDefault" is declared without "build.origin", and the x-default link it names is an absolute URL — declare origin: "https://example.com", or remove xDefault
```

Both can be present at once and are joined into one throw (rule 5). An
`xDefault` that is not a string is reported alone, like a non-string `origin`.

`scriptsFaultReport` (`packages/core/src/scripts.ts`) is the ninth, and it is
the only one with **two doors** (#46). A site normally writes its script layer
through `defineScripts`, which refuses at construction for `urlTemplate`'s
reason; the value also lands on `build.scripts`, which a `.js` config may build
by hand, so `assertBuildSection` calls the same function and joins the same
paragraphs. One predicate, two doors, one set of words — ADR-0004's arrangement
over a different field.

The two doors differ in one thing, and it is `where` and the field name. At
construction the author is looking at the object they wrote, so a sub-field is
`"pageTypes"`; in a config it is the path they would search for:

```
Script settings: declares 1 field this build does not read — delete the field, or correct it to one of: scripts, pageTypes, pages, runtime, consentDefaults:
  "pagetypes"
```

```
Config "/site/pagedeck.config.ts": "build.scripts.pageTypes" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":
  "blog" — the path does not start with "/"
```

The override maps are `patternMapFaultReport`'s by construction, the way
`criticalCssFaultReport` is: `build.budget`, `build.criticalCss` and these two
are read by one author in one object literal, so the key half, the specificity
order and the ambiguous-pair refusal are one implementation. What this field
supplies is what a value means — a map of script name to strategy, or to `"off"`
to take the script off those pages — and every fault of one key's map is on that
key's line, joined with `; `, because they are one edit to one entry:

```
Script settings: "pages" declares 1 override no script can take — write a map of script name to strategy or "off", such as { "/blog/**": { analytics: "idle" } }:
  "/home" — "analitycs" — not a declared script, and the declared scripts are "analytics", "chat"; "chat" — "lazy" — not a loading strategy or "off" — write one of: worker, idle, interaction, facade, off
```

`"off"` is legal in an override map and refused in a declaration, so the two fix
lines name different sets on purpose: rule 3 asks a fix to name what is legal at
the door the reader is standing at, and a declaration that loads on no page is
the empty script layer refused a paragraph above.

An unknown script name is checked only when the declarations gave a set to check
against, which is `xDefaultFaultReport`'s silence over a locale set that is not
a `Map`: a `scripts` that is not a list has already been reported, and a
membership verdict measured against a set nobody has is a guess printed as a
fact. A set the declarations left **empty** is that same set — an empty
`scripts`, or one whose every name was refused above — and it is silent for a
second reason on top: the line it would print ends `the declared scripts are `
with nothing after it, which is the empty list rule 3 refuses.

The declarations themselves report in `defineImages`' shape, and the fix is on
each line for its reason — a name, a source, a strategy and a facade are fixed
four different ways, so a headline carrying one would carry the wrong one three
times out of four:

```
Script settings: declares 4 script fields that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "name" — "" — not a script name — write the name an override addresses this script by, such as "analytics"
  scripts[1] — "src" — 7 — not a script source — write the URL or path the script is served from, such as "https://example.com/analytics.js"
  scripts[1] — "strategy" — "lazy" — not a loading strategy — write one of: worker, idle, interaction, facade
  scripts[2] — "facade.html" — "  " — not placeholder HTML — write the markup the page shows until the script loads, such as "<button>Chat</button>"
```

A list entry that is not a declaration at all is a paragraph of its own rather
than a line under that headline: a value with no fields has no field to name.

```
Script settings: declares 1 entry that is not a script declaration — write each as a name and a source, as { name: "analytics", src: "https://example.com/analytics.js" }:
  scripts[1] — "https://example.com/a.js"
```

A key the declaration does not take is its own paragraph, on
`foldStrategyFaultReport`'s argument reaching one level further down:
`{ stratergy: "idle" }` is a script with nothing visibly wrong in it that
silently takes the default strategy.

```
Script settings: declares 1 script field this build does not read — delete the field, or correct it to one of: name, src, strategy, facade, category, attributes, integrity:
  scripts[0] — "stratergy"
```

Two paragraphs are about names rather than types. An override addresses a script
**by name**, so two scripts sharing one leaves an override with nothing to say
which it meant — refused rather than resolved, because a pick by declaration
order would be a guess the author never made:

```
Script settings: declares 1 name that more than one script uses, and an override addresses a script by name — give each script its own name:
  "analytics" — scripts[0], scripts[2]
```

And a script that can reach the `facade` strategy with no facade to render emits
neither a placeholder nor a script, so the widget is simply absent from the page
with nothing anywhere saying why. Both layers can reach it, so each line says
which one did, and a script that already declared `facade` is reported once
rather than once per override agreeing with it:

```
Script settings: 2 scripts can resolve to the facade strategy with no facade to render — declare the placeholder the page shows until the script loads, as facade: { html: "<button>Chat</button>" }:
  "chat" — declares strategy "facade"
  "video" — pageTypes "/support/**" sets "facade"
```

The last paragraph is about the field that backs the `worker` strategy. A
`runtime` this build cannot call is refused rather than ignored, because
ignoring it lands the site on the `idle` fallback below with a warning saying it
configured no runtime — a message that would be true and unfindable, since the
author is looking at the field it says is not there.

```
Script settings: declares a script runtime this build cannot call — "partytown" — write the adapter the worker strategy loads through, as runtime: ({ scripts }) => ["<script>…</script>"]
```

Three paragraphs are about consent, and they arrive by the two doors above with
the rest (#47). A category that is not one is a line under the type faults,
because it is one more field of a declaration that four different edits can fix:

```
Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "category" — "analytic" — not a consent category — write one of: analytics, functional, marketing, necessary
```

`consentDefaults` is `patternMapFaultReport`'s by construction, the way the two
override maps are, and every fault of one key's map is on that key's line joined
with `; ` for their reason — one market is one edit to one entry:

```
Script settings: "consentDefaults" declares 1 default no category can take — write a map of consent category to granted or denied, such as { "de:/**": { analytics: "denied" } }:
  "/**" — "analitycs" — not a consent category — write one of: analytics, functional, marketing, necessary; "marketing" — "maybe" — not a consent default — write one of: granted, denied; "necessary" — a necessary script loads without waiting on consent, which is what the category means — delete the key, or give the script a category a visitor can withhold
```

**The third line is the one that is not a type fault**, and it is refused rather
than honoured or ignored for the reason `foldStrategyFaultReport`'s unknown key
is. `necessary` *means* the script loads without waiting on consent, so
`{ necessary: "denied" }` is a site contradicting itself: honouring it would
break the promise the category makes to every other reader of the config, and
ignoring it would leave an author looking at a line that does nothing. Its fix
names both edits, because which one is right depends on what the author meant by
the script and no build can know that.

Unlike the override maps, no line here is checked against the declared scripts.
A key is a market and a value is a category, and a category the site has
declared no script in yet is a default waiting for one — a `marketing` pixel
added next week should not have needed its market default in the same commit.

Four more lines are about the attribute map a vendor is configured through
(#440), and all four sit under the type headline above, because `attributes`
is one more field of a declaration that its own edit fixes:

```
Script settings: declares 4 script fields that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "attributes" — "data-domain=example.com" — not an attribute map — write a map of data attribute to value, as attributes: { "data-domain": "example.com" }
  scripts[1] — "attributes.data-" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"
  scripts[2] — "attributes.data-domain " — a name setAttribute throws on — it holds 1 character outside XML's Name production, " " (U+0020), and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete it, or write the name the vendor documents, such as "data-domain"
  scripts[3] — "attributes.data-domain" — 7 — not an attribute value — write the text the vendor reads, such as "example.com"
```

The first line names the field and enumerates nothing under it, on `facade`'s
argument: a value with no keys has no key to name. The next two name the key and
quote no value, because there the key is what is wrong and the line already
carries it. Each is reported *instead of* a value fault rather than beside it: a
key that is not an attribute name has no attribute for a value to be wrong on,
and rule 5 asks for every failure, not for one failure twice. A key that fails
both key rules is reported on the prefix alone, for the same reason.

The second line refuses what the `ScriptAttributes` type refuses and nothing
further — the prefix, and at least one character under it. `data-Domain`,
`data-foo_bar`, `data-1` and `data-x.y` are all accepted: each reaches
`setAttribute` without a throw and lands on `dataset` as `domain`, `foo_bar`,
`1` and `x.y`, and each is a spelling some vendor documents. A door refusing one
would fail a config `tsc` had already passed, which is ADR-0004's two doors
disagreeing about one field. The bare `data-` is the one key this line refuses
that the type does not, because the type cannot: its `dataset` key is the empty
string, so the attribute configures nothing and reports nothing.

**The third line is the one refusal that is not the type read back, and the
distinction it turns on is whose rule is being enforced.** A `data-` key may
still fail XML's `Name` production — a space in it, a trailing space, an angle
bracket, a tab — and `setAttribute` throws `InvalidCharacterError` on every one
of those. The throw happens inside the loader, which sets every declared
attribute as it runs, so the site does not lose one attribute: it loses every
script on every page that carries the declaration, with no message anywhere. A trailing space is an ordinary
config typo, so this is reachable rather than theoretical.

That is the opposite of the stricter expression this door once carried, which
refused names *the browser accepts* and was rejected for it. This refuses only
names *the browser rejects*. The door is not adding an opinion about spelling;
it is reporting at config load what would otherwise be a runtime crash with
nothing to read. The character is printed with its code point because the
reachable form of the mistake is invisible without it — `"data-domain "` quoted
back is a key whose trailing space nobody reading a CI log will see — and every
character of the name that failed is named, in the order it appears, so one edit
fixes the key.

Two more lines are about the integrity metadata a pinned vendor bundle is
checked against (#314), and both sit under the same type headline, because
`integrity` is one more field of a declaration that its own edit fixes:

```
Script settings: declares 2 script fields that cannot be loaded from — declare each as the type its own line names:
  scripts[0] — "integrity" — "" — not integrity metadata — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
  scripts[1] — "integrity" — "oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" — holds no sha256-, sha384- or sha512- hash, and a browser ignores integrity it cannot parse, so the script would load unchecked — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"
```

The first line is the type read back: a `.js` config is never typechecked, so a
number or an empty string reaches this door as readily as a hash.

**The second line refuses a string the type accepts, and it is the permitted
exception to the two-doors rule the attribute lines argue above.** That rule
forbids a refusal of what `tsc` passed *and the browser honours*. A value with
no `sha256-`, `sha384-` or `sha512-` token is not honoured: a browser ignores
integrity metadata it cannot parse and runs the script unchecked, with nothing
in the console a site would read. The config passes, the page ships, and the
check the site declared is not made. Refusing it at config load is the only
place the fault can be seen.

**The token check is lowercase-only on purpose.** Every vendor prints the
algorithm in lowercase, and the two ways to be wrong are not the same size.
Accepting a spelling some browser ignores is the silent unchecked load again.
Refusing a spelling some browser would accept is loud, and it carries its fix
in the same line.

Three faults are reported alone, on the non-object budget's argument — settings
that are not an object, a `scripts` that is not a list, and a `scripts` that is
an empty one. The last is the right *type*, so it cannot sit under a headline
about types, and it is refused rather than accepted because it would otherwise
make "the site declared no scripts" and "the site declared none of them"
indistinguishable — the first is the case that must ship zero script-layer
bytes.

```
Script settings: must be an object declaring the site's third-party scripts — scripts: { scripts: [{ name: "analytics", src: "https://example.com/analytics.js" }] }

Script settings: declares no scripts to load — write scripts as a list of declarations, such as scripts: { scripts: [{ name: "analytics", src: "https://example.com/analytics.js" }] }

Script settings: declares an empty list of scripts, so the script layer would do nothing — list at least one, or declare no scripts at all
```

Every value is quoted through `quote` (`packages/core/src/quote.ts`), the same
function `defineImages` quotes through, and it redacts for rule 6's reason: a
script source is a URL, and a URL is where a credential hides. The cut never
fires on the values most of these paragraphs quote — a non-string, an empty
string, whitespace — and is the guard for the next check that quotes a value
that did parse. `runtime` is that next check: it is the first field of either
caller that plausibly holds an *object* of URLs, so the cut reaches **every
string at every depth** rather than the top-level one alone, and
`{ url: "https://cdn.example/x?key=SECRET" }` is quoted
`{"url":"https://cdn.example/x?…"}`.

`rootProvidersFaultReport` is the tenth, and it is the first build field with
**two halves that have to agree** (issue #66). `build.rootProviders` declares
the provider stack twice over: `stack`, the values the build-time render wraps
the page in, and `module`, the specifier the generated island entry imports the
same stack from in the browser. A site that declared one half and not the other
type-checks nowhere in a `.js` config and builds green — and then every island
on the site is a hydration mismatch at its first node, reported by React in a
browser as a page defect, naming no config field. So a half-declaration is a
refusal at config load, one paragraph per half, joined with everything else the
section got wrong:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a stack this build cannot apply — write the stack as an array of { component, props }, outermost first, the shape both sides apply:
  "stack" — absent, so the build-time render would wrap the page in nothing while every island root wrapped the stack

Config "/site/pagedeck.config.ts": "build.rootProviders" names no module for an island entry to import the stack from — name the module whose default export is that same stack, as module: "./providers.js"
```

A `stack` that is present but is not a list at all is the other single-line
paragraph, and it is one line for the reason the absent half is: there are no
indices to walk, so there is nothing under it to enumerate. It names the kind
the field takes rather than the kind the site wrote — `{ stack: 7 }` and
`{ stack: { hero: … } }` are the same edit — and it never quotes, for the
reason the whole stack half never quotes:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a stack this build cannot apply — write the stack as an array of { component, props }, outermost first, the shape both sides apply:
  "stack" — not an array of providers
```

Once it is a list, the stack's own faults are collected by index,
`cssFaultReport`'s shape, because a stack is a list and a site reads it as one:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a stack this build cannot apply — write the stack as an array of { component, props }, outermost first, the shape both sides apply:
  stack[0] — not an object
  stack[1].component — not a component
  stack[2].props — not an object
```

`component` is refused only where it is neither a function nor an object, which
is narrower than it looks: `memo`, `forwardRef` and `lazy` all return objects,
and a check for a function would refuse provider components React itself
produced. What is left is the mistake the line is read for — a renamed import
that is now `undefined`, whose own failure is a `createElement(undefined)`
thrown from inside a page render, naming a page.

**An empty stack is refused rather than accepted**, and that is the one refusal
here about a field that is *usable* rather than malformed:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a stack this build cannot apply — write the stack as an array of { component, props }, outermost first, the shape both sides apply:
  "stack" — declares no providers, and a site with no stack says so by leaving "build.rootProviders" out
```

Issue #66's sixth criterion is that zero configured providers costs zero bytes,
and an absent field is what buys that: every stage downstream reads the absence
and emits no wrapper, no import and no core-group pin. `{ stack: [], module: … }`
asks for the same nothing while still paying for the import the entry writes, so
it is refused with the shorter spelling as the fix rather than quietly rewritten
into it.

**The other half has its own paragraph, and it is the only one that quotes.**
`moduleFault` is where a `module` that is present and unusable is refused — not
a string at all, or a string with nothing in it:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a module no island entry can import — name the module whose default export is that same stack, as module: "./providers.js":
  "module" — not a string
```

Empty and whitespace-only are said apart, `cssFaultReport`'s reason: they are
two different typos — an interpolation that produced nothing, and a path
somebody half-deleted — and a quote alone shows neither, because a reader
cannot see the difference between `""` and `"   "` by looking at them:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares a module no island entry can import — name the module whose default export is that same stack, as module: "./providers.js":
  "module" — "   " — the specifier is only whitespace
```

The value is quoted here and nowhere else in this field's report, which is rule
6 read the right way round rather than an exception to it: a specifier is a path
the site wrote and the build is about to hand the bundler, so it is the one
thing here that is not a provider prop. What the stack holds *is* site config —
which is why `stackFaultLines` names a kind and never a value, and why the
browser's half of the same declaration hashes every prop it reports.

A `rootProviders` that is not an object is reported alone, on the argument the
non-object budget makes, and a key the field does not take is its own paragraph
with its own fix, exactly as `foldStrategy`'s is:

```
Config "/site/pagedeck.config.ts": "build.rootProviders" must be an object holding the stack and the module it is imported from — declare both halves, as rootProviders: { stack: providers, module: "./providers.js" }
```

```
Config "/site/pagedeck.config.ts": "build.rootProviders" declares 1 field this build does not read — delete the field, or correct it to "stack" or "module", the only fields rootProviders takes:
  "modules"
```

`driftThresholdFaultReport` (`packages/core/src/drift.ts`) is the eleventh, and it
is `foldStrategyFaultReport`'s threshold paragraph over spec §9's other
threshold (#29). One value, so the collected shape is again about where the
reason goes rather than about counting: `"5"`, `5.5` and `-1` are a number
somebody typed in quotes, a fraction of a page, and a count below the lowest one
a build can reach. It joins the same throw for that field's reason — two
thresholds a site tunes are two lines of one object literal.

```
Config "/site/pagedeck.config.ts": "build.driftThreshold" is not a count of drifted pages — write a whole number of pages, 0 or more, such as driftThreshold: 3:
  "5" — not a number
```

The value is quoted with `JSON.stringify` for the reason `foldStrategy`'s is,
and it is load-bearing in the same way: a `.js` config is never typechecked, so
a threshold in quotes reaches the comparison and is *coerced* rather than
refused — `6 > "5"` is `true` and `6 > "50"` is `false`, and nothing anywhere
would say a threshold had been misread. The `3` in the fix is deliberately not
the default (rule 3).

`driftSupplementFaultReport` (`packages/core/src/supplement.ts`) is the
twelfth, and it is `build.head`'s paragraph over #29's other field. It is a
*callback*, so there is nothing inside it to enumerate even in principle — a
function is not a container — and the only thing that can be wrong with one at
config load is that it is not a function. It joins the same throw as the
threshold beside it, because two lines of one object literal are one edit
session.

```
Config "/site/pagedeck.config.ts": "build.driftSupplement" must be a function returning a stylesheet for the classes it is handed — driftSupplement: (classes) => compile(classes)
```

The fix carries the signature rather than naming the type, `build.head`'s reason:
the mistake it catches is a site that wrote its toolkit's *stylesheet* or its
plugin where the function belongs, which reads perfectly well, type-checks
nowhere in a `.js` config, and would otherwise surface as a call on a non-function
partway through the first build that drifted. The value is not quoted, because
what this line is about is the kind and the site is looking at the field it
wrote.

`searchFaultReport` (`packages/core/src/search.ts`) is the thirteenth, and it is
`defineImages`' second paragraph over #62's field. Two things can be wrong with
a search adapter and no two of them are fixed the same way — a name is what
every later report calls the adapter, an `index` is the function this build
hands its rendered pages to — so the fix is on each line and the headline
carries only what they share. It joins the same throw as everything above,
because a site wiring up an indexer writes it in the same object literal.

```
Config "/site/pagedeck.config.ts": "build.search" declares 2 fields this build cannot index through — declare each as the type its own line names:
  "name" — undefined — not an adapter name — write the name this adapter is reported by, such as "lunr"
  "index" — undefined — not an index function — write the function this build hands its rendered pages to, as index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }]
```

**A key the interface does not name is not a fault here**, which is where this
field departs from `foldStrategy`, `rootProviders` and the script layer. Those
are settings the build reads, so a key it does not read is a line that silently
does nothing — the argument the unknown-key paragraphs are all made on. This
value is an adapter the *site* implements, and its options, its state and its
own methods are none of this build's business; refusing them would refuse a
class instance for having a class's fields. A `search` that is not an object is
reported alone, on the non-object budget's argument:

```
Config "/site/pagedeck.config.ts": "build.search" must be an object with a name and an index function — search: { name: "lunr", index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }] }
```

**Two more refusals are about what that adapter answers with**, and they are the
build's rather than the config's: `searchFiles` (same file) is on the far side
of the call, holding files a site's own code has just returned. Both name the
adapter, which is what `SearchAdapter.name` exists for — a message about a
returned file that could not say which library produced it would leave a reader
looking at a path and nothing else. Both are a `ConfigError` and exit 2 on
`compileSupplements`' criterion: a declared adapter that returns this file
returns it on every run until somebody edits it.

The first is a file at a deploy key the build already wrote. `buildManifest`
refuses a duplicated key too (`duplicateKeyReport`), and this is not a second
opinion about that fault: that report is handed a set of files with no author in
it and names none, and the reader of this one needs to know which of the two
arrived last and through which field.

```
Search index: the "lunr" adapter returned 1 file at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the adapter is called; return each derived file at a path of the adapter's own, such as "/search-index.json":
  "/index.html" — the build already emitted an html file there
```

The second is a file that sets `page` or `name`. Those two fields are claims —
`EmittedFile.page` says a file is one page's own HTML, `EmittedFile.name` says
which chunk of the client build it is, and the manifest answers a column of the
document from each — so a derived file carrying either answers for a page it is
not. `misclaimReason` covers two of the four ways to write it and this is why
that is not enough: a `page` naming a route this build did not emit claims a key
nothing reads, and a `name` no page entry joins to is never looked up. A refusal
that fires for half of one mistake is worse than none, because the half that
passes is the half nobody notices. Both fields are named on one line, because
they are one edit.

```
Search index: the "lunr" adapter returned 1 file claiming a page or a chunk of the client build — a "page" says a file is one page's own HTML and a "name" says which chunk of the client build it is, and the manifest answers a column of the document from each; return each derived file with neither field, and link it from the site's own pages:
  "/search-index.json" — sets "page" and "name"
```

An adapter that **throws** is wrapped with the throw as its cause (rule 4) and
named, because an indexer's own stack says which library failed and nothing in
it says which build field called it. A plain `Error` and exit 1, the class
`compileSupplements` gives the same event over the other site-supplied callback:
the wiring is intact, the field is a function and it was called, and what failed
is the site's own code running.

```
Search index: the "lunr" adapter threw while indexing 2 documents — "build.search" is the site's own indexer and is handed every page this build rendered; fix the adapter, or remove "build.search" until it indexes this site
```

**An adapter's optional `patch` is held to the same rules, and adds one of its
own** (#307). At config load, `searchFaultReport` refuses a `patch` that is
present and not a function, on its own line and with two fixes, because an
absent `patch` is a declaration — an adapter that cannot patch, whose
incremental builds render every page — and so removing the field is as good an
answer as writing the function:

```
Config "/site/pagedeck.config.ts": "build.search" declares 1 field this build cannot index through — declare each as the type its own line names:
  "patch" — true — not a patch function — write the function this build hands the previous index and the pages that moved to, as patch: ({ previous, documents, removed }) => ({ written, pruned }), or remove "patch" so an incremental build renders every page for the index
```

On an incremental build, `searchPatchFiles` (same file) holds the files a patch
writes to both refusals above, with the same words — a patch's answer is refused
exactly as `index`'s is. A patch that throws is wrapped the same way, and says
what it was handed:

```
Search index: the "lunr" adapter threw while patching the index over 1 document and 1 removal — "build.search" is the site's own indexer and is handed the previous build's index and the pages that moved since; fix the adapter's patch, or run pagedeck build to index every page
```

The refusal of its own is a pruned file the previous index does not hold. A
patch prunes what its own previous index wrote, which it is handed as
`previous`; a key outside that set is a patch reasoning about some other index,
and one naming a page's document would read as the adapter deleting it. Every
such key, one per line, as `fileKey` spells it:

```
Search index: the "lunr" adapter pruned 2 files the previous build's index does not hold — a patch prunes only files its own previous index wrote, which it is handed as "previous"; prune each file by the domain and path it was handed at:
  "/index.html"
  "//shop.example/search/en.json"
```

**The previous index is read back off the tree, and a tree that lost part of it
is refused before anything renders** (`carrySearchIndex` in
`packages/core/src/build.ts`). This is `carryDocuments`' refusal over the
index's files — the rows the previous manifest records under the adapter's name
(`ManifestFile.search`) — and it refuses rather than composes, where a sitemap
composes, because an index is a function of every page's render and an
incremental build does not hold them:

```
Output "/site/dist": 1 file of the "lunr" search index cannot be carried from the previous build — an incremental build hands the adapter's patch the previous index as this tree holds it, so a file this tree does not hold as that build wrote it leaves an index no build wrote to patch — run pagedeck build to write the whole index again:
  "/search-index.json" — the tree does not hold it
```

A file that is there and cannot be opened says so rather than reading as
missing — "the tree holds it and it could not be read" — and every read that
threw rides as the refusal's cause (rule 4): the one error itself, or an
`AggregateError` of all of them, so an `EACCES` reaches the log instead of
sending a reader to rebuild a tree that is whole. A file whose bytes no longer
hash to the recorded row is the third line, "the bytes there are not the ones
the previous build recorded", and has no cause because nothing threw.

**Two refusals belong to an adapter rather than to the seam**, and they are the
only ones `@pagedeck/search` has of its own. The first is `localeFaultReport`
(`packages/search/src/shards.ts`). That indexer writes each locale's files under
`/search/<locale>/`, so a locale that is not a path segment writes them
somewhere the query will not look — or, for a dot segment, out of the search
directory altogether. A `ConfigError` and exit 2 on rule 7's criterion: the
locale set is the site's own declaration and fails identically on every run. The
class is `@pagedeck/core`'s rather than a local one, because a local class would have
to be named in `isWiringFault` and that would make core import a search package.

```
Search index: 3 locales are not path segments, and each locale's shards are written under "/search/<locale>/" — declare each locale the way a path spells one, such as "pt-BR":
  "" — the locale is empty
  ".." — the locale is a dot segment, which resolves out of the search directory
  "en/us" — the locale holds "/", which would write the shards into another directory
```

Every offending locale and not the first (rule 5), because a site that spelled
one locale as a path usually spelled its neighbours the same way. Sorted by the
locale rather than by the order the documents arrived in, so two builds of one
site report identically (spec §11) — a message that reorders between runs is a
message a reader cannot diff. Each line carries its own reason rather than
sharing one, because the three are three different edits.

The second is `refuseUnreadable`'s (same file, #307): a previous index its
patch cannot read back. `patchDocuments` rebuilds a directory out of the
previous files, so before it reads any it checks every directory — its `format`,
moved or not, because a directory left alone at another format would be carried
beside directories written at this one, and that it holds every file its
`index.json` names. Every such fault is one line (rule 5), each naming its
directory's `index.json` by `fileKey`, so a directory in a domain's tree says
which tree (rules 1 and 2), and sorted by that key so two runs report
identically. A `ConfigError` for the locale refusal's reason, with `pagedeck build` as
the fix, because a full build is the one thing that writes the index without
reading the old one. Core wraps it as the thrown cause of its patch refusal
above, so the adapter's name comes with it.

```
Search index: the previous index cannot be patched, for 2 reasons — a patch reads each directory back out of its previous files, so every one has to be this format and whole; run pagedeck build to write the whole index again:
  "//de.example/search/de/index.json" is format 0, and this @pagedeck/search writes format 1
  "/search/en/index.json" names "terms-0000.json", and the previous index holds no such file
```

`retentionFaultReport` (`packages/core/src/retention.ts`) is the fourteenth, and
it is `foldStrategyFaultReport`'s three paragraphs over spec §11's retained
manifests (#32). The field is a small object the build reads, so all three
apply: a value that is not an object at all is reported alone, the count carries
its reason on its own line, and a key this build does not read is a paragraph of
its own. It joins the same throw as the drift threshold beside it, because two
counts a site tunes are two lines of one object literal.

```
Config "/site/pagedeck.config.ts": "build.retention" is not a count of manifests to keep — write a whole number of builds, 0 or more, such as retention: { keep: 10 }:
  "20" — not a number
```

```
Config "/site/pagedeck.config.ts": "build.retention" declares 1 field this build does not read — delete the field, or correct it to "keep", the only field retention takes:
  "kepe"
```

```
Config "/site/pagedeck.config.ts": "build.retention" must be an object with a keep count — retention: { keep: 10 }
```

The value is quoted with `JSON.stringify` for `driftThreshold`'s reason, and it
is load-bearing in the same way: a `.js` config is never typechecked, so a count
in quotes reaches the prune as a string — `slice(0, "2")` keeps nothing, and
every retained manifest of a site that asked to keep two is deleted by the next
build with nothing anywhere saying the count was misread. The `10` in both fixes
is deliberately not the default (rule 3).

**Three refusals belong to the store rather than to the field**, and they are
`localeFaultReport`'s argument over the other value this repo turns into a path
segment. Each retained build is written to `<build id>.json`, so an id that is
empty, starts with a dot, or holds a `/` or a `\` writes the document out of the
store, into another directory, or over the store's own directory name. A
`ConfigError` and exit 2 on rule 7's criterion: `runBuildVerb` mints a uuid, so
an id like this comes from a CI wrapper that mints its own and fails the same
way on every run until that wrapper is edited.

The **family** is refused rather than the spellings that can be listed, and the
reason is that a list is wrong on a host it was not written for. `join` is the
platform's: `..\..\victim` is on Windows exactly what `../../victim` is here,
and `""` names the store's directory rather than a document in it. Every leading
dot goes with the two dot segments for the same reason — a name in that family
is a hidden file at best. Nothing this framework mints has one, and neither do
the ids a CI wrapper mints from a branch name, a short sha or a run number,
which `retention.test.ts` asserts beside the refusals so that a widened guard
cannot start refusing real builds unnoticed. Each reason is its own sentence
(rule 2): an empty id, a separator and a leading dot are three different edits
to whatever minted it.

```
Retained manifest "..": the build id is a dot segment, which resolves out of the retention store, and each retained build is written to "<build id>.json" — mint the build id as a name a path can hold, such as a uuid
```

The second is a rollback naming a build the store does not hold. It names what
the store *does* hold rather than describing it, which is the edge target's
reason: prose saying "roll back to a retained build" sends a reader to list a
directory the message has already listed. An empty store gets a sentence of its
own, because the first would otherwise end with nothing after the dash — the
empty list rule 3 refuses — and because "nothing has been retained yet" and "the
build you asked for was pruned" are two different things to do next.

```
Retained manifest "b9": is not in the store at "/site/.pagedeck/manifests" — the retained builds are "b1", "b2", so roll back to one of those, or raise build.retention.keep before the build you want is pruned

Retained manifest "b9": is not in the store at "/site/.pagedeck/manifests" — the store holds no retained build, so run pagedeck build to fill it
```

The third is a document at the named path that will not open, and it arrived
when #387 closed the symlink this door still followed.
`readRetainedManifest` opens through the same `O_RDONLY | O_NOFOLLOW` the
store's listing uses, so a link planted at `<store>/<id>.json` fails the open
instead of being followed into a file whose first bytes V8's parse error would
quote back onto stderr — rule 6, out of a directory a site owner does not think
of as sensitive.

**The refusal is keyed on a listed set of errnos, and what is not in the set is
rethrown as it arrived.** `UNREADABLE_DOCUMENT_CODES`
(`packages/core/src/retention.ts`) holds the codes that are a fact about the
path — the two spellings of a refused link, the two permission codes, a
directory or a non-directory in the way, a name the file system will not take —
because each is what rule 7 asks for: no retry changes any of them. `EMFILE`,
`EIO` and `EBUSY` are deliberately absent. They are open failures a retry
fixes, and exit 2 is a promise that it will not, so classifying them would tell
CI to stop retrying in the one case where retrying is the answer. An unlisted
code therefore leaves the verb at exit 1, which is where every non-`ENOENT`
failure of this door landed before the flag went on it.

Which member it was is the cause's to say (rule 4), so the sentence enumerates
instead of diagnosing: a reader who took the read bit off a document meets "a
mode that forbids the read" among four faults rather than a claim about a
symlink they did not plant. That is the same rule the declared/carried byte
counts above are written under. The `O_NOFOLLOW` clause stands behind the
enumeration rather than in front of it, and is phrased as a standing fact about
how the store opens rather than as a finding about this run — a refusal of
something that works everywhere else still needs its reason. The path is in the
sentence rather than left to the cause, because one member does not supply it:
`EISDIR` reaches a log as `illegal operation on a directory, read`, naming no
file at all. The listing
door answers all of this by skipping the file and pruning it, because a caller
that named no document has asked for none in particular.

```
Retained manifest "b1": nothing opened at "/site/.pagedeck/manifests/b1.json" — the open ends there on a link, on a directory, on a mode that forbids the read, or on a name the file system will not take, and the store opens every document read-only and never through a symlink, so a link is refused rather than followed; put a document this pagedeck can open at that path, or roll back to a build id the store already holds
```

`routingFaultReport` (`packages/core/src/routing.ts`) is the fifteenth, and it
is the config door spec §11's routing document went without until #270. Four
paragraphs, joined into the same throw as everything above, because a site
declaring redirects writes them in the same object literal as the rest of its
build section.

**What it checks and what it leaves to `planRouting` is the whole design of it.**
Every refusal `planRouting` already makes — an off-site target, a rule starting
at a path this build serves, a target that is no page, two rules on one path, a
404 page nothing routes, a loop — is a verdict against the *route table*, which
does not exist when a config is loaded. This door answers only what needs no
route table and what a `.js` config makes real: whether each field is the type
the pass will read it as. That is `isConfiguredCollection`'s reason with a
measured failure behind it — `draft` calls `rule.set.forEach`, so a header rule
written without a `set` reaches the build as a `TypeError` naming neither the
config, the field nor the rule, a minute in, after every page has rendered.

```
Config "/site/pagedeck.config.ts": "build.routing" declares 4 rule fields this build cannot route with — declare each as the type its own line names:
  redirects[0] — "from" — 7 — not a string — write the path this rule starts at, as authored, such as "/old"
  redirects[0] — "status" — "301" — not a number — write the 3xx a static host answers with, as status: 301, or leave it out for 308
  notFound[0] — "path" — undefined — not a string — write the path the route table spells this page with, such as "/404"
  headers[0] — "set" — undefined — not a list of header fields — write the headers this prefix carries, as set: [{ name: "X-Frame-Options", value: "DENY" }]
```

The fix is on each line and not in the headline, `defineImages`' second
paragraph: a path, a status and a header list are fixed three different ways, so
a headline carrying one would carry the wrong one most of the time. The value is
quoted through `quote` — rule 6, and it is load-bearing twice over.
Either end of a redirect can be a whole URL with a query string on it, and
`status: "301"` and `status: 301` are one line to an interpolation and two
different mistakes, of which only the first is invisible in a config nobody
typechecks. **The status is checked for being a number and not for being one of
four**, which looks like half a check and is the boundary drawn on purpose: the
value set is `planRouting`'s and has to be, because `RoutingInput.removals`
reaches that pass without passing this door at all.

A field that is a string and holds nothing is refused on the same line, and it
says which of the two typos it is — an empty value and a whitespace-only one are
different mistakes, and a quote of two spaces diagnoses neither on its own. Each
names **its own field's noun** rather than "the value", which is
`canonicalizePath`'s wording one door along and `defineImages`' at the third:

```
Config "/site/pagedeck.config.ts": "build.routing" declares 2 rule fields this build cannot route with — declare each as the type its own line names:
  redirects[0] — "from" — "  " — the path is only whitespace — write the path this rule starts at, as authored, such as "/old"
  redirects[0] — "to" — "" — the path is empty — write the path this rule ends at, as authored, such as "/pricing"
```

An experiment's arms are checked the same way a header rule's `set` is, and for
that rule's measured reason (#34): `draft` calls `rule.variants.forEach` and
walks each name character by character, so a split written without a `variants`
list, or with a name a `.js` config left as a number, is the same `TypeError` a
minute into the build. Which numbers are *shares of visitors* stays
`planRouting`'s, beside the route table this door does not have.

```
Config "/site/pagedeck.config.ts": "build.routing" declares 2 rule fields this build cannot route with — declare each as the type its own line names:
  experiments[0] — "variants" — undefined — not a list of variants — write the variants of this experiment, as variants: [{ name: "b", weight: 50 }]
  experiments[1].variants[0] — "weight" — "50" — not a number — write this variant's share of visitors, such as weight: 50
```

**A member the rule leaves `undefined` is a member the rule left out**, for
`domain` and `status` alike, and neither is reported. This repo sets
`exactOptionalPropertyTypes` nowhere, so `{ from, to, domain: undefined }` is a
`RedirectRule` a typechecked site can write — a spread of a partial rule
composes one without anybody typing the word — and a door refusing what its own
published types accept is a door no site can get past.

The other three paragraphs are the three other shapes a routing config can be
wrong in, and they are separate for rule 3's reason — a value that is not an
object, a key this build never reads, a member that is not a list and an entry
that is not a rule are four edits with four fixes.

```
Config "/site/pagedeck.config.ts": "build.routing" declares 1 field this build does not read — delete the field, or correct it to one of: redirects, notFound, headers, experiments:
  "redirect"

Config "/site/pagedeck.config.ts": "build.routing" declares 1 member that is not a list of rules — write each as an array, as routing: { redirects: [{ from: "/old", to: "/pricing" }] }:
  "notFound" — 7

Config "/site/pagedeck.config.ts": "build.routing" declares 1 entry that is not a rule — write each as an object, as routing: { redirects: [{ from: "/old", to: "/pricing" }] }:
  redirects[0] — "/old"
```

The unknown-key paragraph is the quietest failure this field has, which is
`foldStrategyFaultReport`'s argument one level up: `{ redirect: [...] }` is an
object with nothing visibly wrong in it that puts no rule in the document and
records nowhere that any were written. A `routing` that is not an object at all
— an array included, since `RoutingConfig` is the object holding the four lists
and not one of them — is reported alone, on the non-object budget's argument.

```
Config "/site/pagedeck.config.ts": "build.routing" must be an object of redirects, 404 pages, header rules and experiments — routing: { redirects: [{ from: "/old", to: "/pricing" }] }
```

**`planRouting`'s own reports name the same field on the line rather than in the
headline**, and that asymmetry is #270's, not an oversight. Those are thrown
from inside a build, where the only thing the first words can honestly name is
the document — the same pass also reports over `removals`, which comes off the
previous manifest through `planIncremental` and no config holds. So the config
path travels on the locator, and rule 1 is met at rule 2's level:

```
Routing manifest: 1 redirect target is no page of this build — point it at a page this build routes or a file it emits, or drop the rule:
  build.routing.redirects[0] — "/nowhere" in the default tree
```

Since #553 a redirect may also target a file the build emits into the rule's
own tree, such as the sitemap, the feed or `robots.txt`, and the fix names both
options: a page this build routes or a file it emits. The headline still says
"no page", because it is greppable and pinned. A target is refused on that line
when it is neither, and also when it is a file in another tree, a file at a
reserved deploy key, or a file under the experiment segment. A page's own
document, such as `/about/index.html`, is refused too, although the build emits
it: it would give the page a second address. The fix clause cannot say that
without growing a third option, so it is said here. Since #607 a file target
is matched before the `trailingSlash` policy spells it, so under `"always"` it
keeps the file's own spelling and is not refused.

A known limitation, not a rule: a refused target is quoted after the policy has
spelled it, not as the author typed it. Under `"always"` a target that names no
file in the rule's tree, such as a file of another tree, is quoted with a slash
the author did not write: `"/sitemap-shop.xml/"` for `to: "/sitemap-shop.xml"`.
The locator still names the rule, so the author can find it.

A bare `redirects[0]` is where #270 found the locator: a real site tripping
that refusal was told a position in a list nothing named. The same pass reports
over deletion records, which no config holds, and those are named by a phrase
rather than by a fourth path — `a redirect for a page this build deleted`. That is
rule 2's shape for a claimant with no authored name, and it is what keeps a
report carrying both kinds honest: the paragraphs are collected, so a
`removals[0]` printed beside `build.routing.redirects[0]` would read as a
second config field and send its reader searching for a `removals` nothing
declares.

```
Routing manifest: 1 path is redirected by more than one rule — give each path one target and one status:
  "/gone" in the default tree — build.routing.redirects[0] (config) to "/pricing" 301, a redirect for a page this build deleted (deleted-page) to "/about" 308
```

A header field named `Location`, in any letter case, is refused in a paragraph
of its own (#559). It is a valid token, so `unusableHeaderName`
(`packages/core/src/routing.ts`) passes it, and its fix is a different edit:
drop the field. Since #559 a rule's set rides every redirect under its prefix,
and each target writes `Location` on a redirect itself; on any other response
the field means nothing. So it is refused wherever it is declared.

```
Routing manifest: 1 header field is named "Location" in some letter case — remove it; every target writes "Location" itself on the redirects it answers and it means nothing on any other response, so it is refused wherever it is declared — to send a path elsewhere, write a redirect rule:
  build.routing.headers[0].set[0] — "location"
```

A header value is refused by the rule every edge target applies at compile
time, `unusableHeaderValue` (`packages/core/src/routing.ts`), with the same fix
(#681). Without it, a site declaring a value with NUL or a character above
U+00FF would build, write its routing manifest and fail on deploy. The value is
named by code point and never quoted:

```
Routing manifest: 1 header value cannot be sent — remove the character; a field value may hold no control character but HTAB (RFC 9110 forbids the C0 ones and DEL, and a C1 one reaches a headers file as two bytes of UTF-8), since a line break can write a second header, and a Worker's Headers refuses any character above U+00FF:
  build.routing.headers[0].set[0] — "X-Note" — the header value holds U+0000
```

`packages/core/src/routing.build.test.ts` reads every one of these refusals off
a spawned `pagedeck build`'s stderr, which is the difference that issue was about: the
refusals were all unit-tested and none of them could fire.

`sitemapFaultReport` (`packages/core/src/sitemap.ts`) is the sixteenth, and its
two paragraphs are `xDefaultFaultReport`'s two shapes over spec §7's sitemaps
(#40). The first is the field's one value read as a type: `pattern` is a choice
between two spellings, so the line quotes what the site wrote and the fix names
both of them rather than describing them — a message telling an author their
pattern is invalid without saying what a valid one looks like sends them to the
source.

```
Config "/site/pagedeck.config.ts": "build.sitemap" declares 1 field this build cannot write sitemaps from — declare each as the type its own line names:
  "pattern" — "flat" — not a sitemap URL pattern — write "suffix" for /sitemap-en.xml, or "directory" for /en/sitemap.xml
```

The second is `xDefault`'s cross-field refusal one field along, and for its
reason: every `<loc>` a sitemap holds is an absolute URL, so a site that
declared this and no origin would get no sitemap and no word about why. The fix
offers both directions, because either is a whole answer.

```
Config "/site/pagedeck.config.ts": "build.sitemap" is declared without "build.origin", and every <loc> a sitemap holds is an absolute URL — declare origin: "https://example.com", or remove sitemap
```

Both can be present at once and are joined into one throw (rule 5). A `sitemap`
that is not an object is reported alone, on the non-object budget's argument.

```
Config "/site/pagedeck.config.ts": "build.sitemap" must be an object naming the URL pattern its files take — sitemap: { pattern: "suffix" }
```

**One more is the build's rather than the config's**, and it is `searchFiles`'
collision one emitter over: `sitemapFiles` (same file) refuses a sitemap at a
deploy key the build has already written, which is what a site whose route table
puts a page at `/sitemap.xml` gets. A `ConfigError` and exit 2 on the same
criterion — a route table that collides today collides on every run until
somebody edits it — and every colliding key is reported rather than the first
(rule 5), because a pattern that collides in one tree usually collides in all of
them. The fix offers the other pattern beside the edit, since changing where the
sitemaps go is as whole an answer as moving the page.

```
Sitemaps: 1 sitemap is at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the sitemaps are; move the page off that address, or declare the other URL pattern — sitemap: { pattern: "directory" }:
  "/sitemap-en.xml" — the build already emitted an html file there
```

**A page's document can also collide with an emitted file along the path, and
that refusal is one check over the whole staged set** (#622). A path in an
output tree is a file or a directory, never both. Under `trailingSlash:
"always"` a page at `/sitemap.xml/` writes `/sitemap.xml/index.html`, which
needs `/sitemap.xml` as a directory where the sitemap index is a file. The keys
differ, so every emitter's check passed and the build failed at the write with
a raw `EISDIR` or `ENOTDIR`. `pathCollisionReport`
(`packages/core/src/manifest.ts`) runs once the last emitter has staged its
files and before anything is written. It compares each page's document with
every file the build emits into the same tree, in three shapes: the same path,
the file's path as a directory of the document, and the document's path as a
directory of the file. A `ConfigError` and exit 2, for the sitemap refusal's
reason, and every collision is on its own line (rule 5). Each line names the
page by its `(locale, path)` identity, then the document and the file by their
deploy keys. The fix offers both directions, because either is a whole answer:
move the page, or move the file when it is a passthrough file the site placed:

```
Site build: 1 page document collides with a file this build emits into the same tree — a path in an output tree holds a file or a directory, never both, so no page below can be written beside the file its line names; route each page below at another path, or move the file if it is a passthrough file:
  en /sitemap.xml/ — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file
```

**A file whose deploy key a deploy refuses is refused by the build that emits
it** (#674). `readManifest` refuses a manifest whose file row spells a key
`deployKeyFault` refuses, and the build collected passthrough files with no
name filter. A file named `Icon\r` in `public/`, which macOS writes for a folder
with a custom icon, became the key `"/Icon\r"`, and every later read refused
the manifest that build wrote. `deployKeyReport`
(`packages/core/src/manifest.ts`) runs beside `pathCollisionReport`, through
the same `deployKeyFault`, over every file the build emits and before anything
is written. A `ConfigError` and exit 2, and every such file is on its own line
(rule 5), named by its key and, for a passthrough file, by the source file to
rename or delete:

```
Site build: 2 files are at a key a deploy refuses — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character; rename or delete each:
  "/Icon\r" — from "/site/public/Icon\r"
  "/a\\b.txt" — from "/site/public/a\\b.txt"
```

**A page an incremental build reuses must not name a chunk or stylesheet that
build did not emit** (#720). The build reads a reused page back off the output
tree, so the page keeps the script and stylesheet names it was written with.
An incremental build pins the previous build's split, but a chunk's bytes can
still change when an island moves, and then the chunk and every chunk
importing it get new names. `movedReferences` (`packages/core/src/links.ts`)
finds each reused page that names a chunk or stylesheet the previous build
emitted and this one did not. `stageUntilSettled`
(`packages/core/src/build.ts`) then renders those pages again and bundles
again, until no reused page names a missing file. Each bundle runs the head
callbacks, social cards, renders and bundler again, so an incremental build
runs at most three, and a reused page that still names a missing file after
the third is refused, whatever `build.links` declares, because a page that
loads a missing script is broken for every visitor. A `ConfigError` and exit
2, one line per reference (rule 5):

```
Site build: 1 page this build reuses still names a chunk or stylesheet this build did not emit after 3 bundles — each bundle after the first renders again every reused page the one before found naming a file it did not emit, and an incremental build runs no more bundles than that — run pagedeck build to write the whole site again:
  en /signup — "/assets/entry-01ec8b620130b05a-CSeRjcbH.js"
```

**Seven emitters refuse a deploy key this build already wrote, and the line
under the headline is one implementation** (#434). `collisionLines` and
`collisionLine` (`packages/core/src/manifest.ts`) compose it for the sitemaps,
the search index, the icon, the robots.txt, the preview app, the passthrough
files and the feed, beside the `fileKey` those refusals are keyed through.
`collisionLines` also sorts, so that none of the six reports collecting a set of
keys depends on the order its files were composed in; the feed checks one key
rather than a set and takes the line alone. What stays with each emitter is the
headline and the fix clause, and those clauses are five rather than seven: the
icon, the robots.txt and the feed each have one address and one fix, and write
it in the same words, "move the page off that address". Rule 3 is what keeps
even that one out of the shared line — a fix names what the author writes, and a
sitemap pattern, an adapter's return value, a `build.preview.path` and a
passthrough directory are not corrected by one sentence. That is
`criticalCssFaultReport`'s placement argument reaching a line rather than a
field — seven copies of the sentence were seven chances for one emitter's
refusal to drift from the one beside it.

The passthrough stage publishes from both `build.passthrough.root` and
`build.passthrough.contentRoot`, and naming the right key is not the whole of
its fix, because the two collide for different reasons (`COLLISION_FIX`,
`packages/core/src/passthrough.ts`). A file beneath `root` collides with
whatever sits at its address, so moving the page or taking the file out clears
it. A file beneath `contentRoot` collides only across output trees: a reference
reached an address one tree holds and another does not, and the file is
published into both. Taking that file out trades this refusal for the
unresolved-reference one below, so its fix is to point the reference at a file
no tree already holds, or to have every tree emit a file at that address.

**The passthrough stage refuses two more, and both name the directory a reader
wrote rather than the field it sits in** (#439, #474). `build.passthrough` holds
two directories now — `root`, published whole, and `contentRoot`, the content
tree a page's content-relative references resolve into — so the field is
interpolated into `passthroughDirectory`'s pair of refusals
(`packages/core/src/build.ts`) rather than written out: "build.passthrough"
alone would send the reader of a two-key setting to check the wrong one. Both
are `ConfigError` and exit 2, and both fire before a page is rendered, so a run
does not pay for the renders first.

Removing the broken key is only a fix while the other key is declared (#491).
Without it, what is left is `passthrough: {}`, which the refusal further down
rejects. So its fix is to remove the key when the other one is declared, and to
remove `passthrough` when it is not. The first line below is a site that
declares only `root`, and the second is a site that declares both:

```
Config "/site/pagedeck.config.ts": "build.passthrough.root" names a directory that does not exist — "/site/nowhere" — point root at the directory of files the site publishes, or remove passthrough
Config "/site/pagedeck.config.ts": "build.passthrough.contentRoot" names a path that is not a directory — "/site/src/logo.png" — point contentRoot at the content tree a page's content-relative references resolve into, or remove contentRoot
```

**A setting that names neither directory is refused at config load** (#491).
Both keys are optional, so `passthrough: {}` is well formed and publishes
nothing, and a setting that does nothing is refused, as `defineScripts` refuses
an empty list. The fix names both keys, because either one alone is a setting
this build can act on (`passthroughFaultReport`,
`packages/core/src/passthrough.ts`):

```
Config "/site/pagedeck.config.ts": "build.passthrough" declares neither root nor contentRoot, so it publishes nothing — declare root as the directory of files the site publishes whole, such as root: "./public", declare contentRoot as the content tree its pages' relative references resolve into, such as contentRoot: "./src", or remove passthrough
```

**The last one is the gate #439 could not land on its own** (#474). A post
writing `../../assets/images/ferry/logo.png` reached the emitted HTML untouched
and nothing in the build looked at it, so the page shipped a dead `<img>` on a
green build; the refusal is what closes that, and it ships with the emission
that gives such a reference somewhere to resolve to, because a gate with no fix
available behind it turns a passing build into a failing one. Collected over
every reference rather than thrown at the first (rule 5) — a post that lost its
images lost all of them at once — and each line carries the four things a reader
acts on: the page the dead image shows up on, what it wrote, the address this
build went looking at, and the content entry the reference is written in.

That last one is rule 2, and it is the one a reader edits. A route is a fact
about where the page landed and a reader who has only that has to map it back to
a markdown file themselves; the entry is `refKey`'s spelling of the file the
reference sits in, which is the column `driftWarnings`' report spells "own
entry" further down this document. A
page no stored entry backs — a source composing its instances from a literal
list, a JSON file or a build-time fetch (#87) — ends its line
`no content entry: no stored entry backs this page, so the reference is in whatever composed it`
instead, which is §2's `(whole entry)` read at a page rather than at a field:

```
Passthrough: 2 references a page makes to a file beside its content resolve to nothing this build can publish — put the file at that path beneath the directory "build.passthrough.contentRoot" names, or point the reference at a file that is already there:
  en /posts/ferry — "../../assets/images/ferry/rules.png" → "/assets/images/ferry/rules.png" — content entry "posts en posts/ferry"
  en /posts/json-bonsai — "../../assets/images/json-bonsai/query.png" → "/assets/images/json-bonsai/query.png" — content entry "posts en posts/json-bonsai"
```

`speculationFaultReport` (`packages/core/src/speculation.ts`) is the seventeenth,
and it is `searchFaultReport`'s shape over spec §13's Speculation Rules (#42).
Two fields, each read as the type its own line names, both of them collected
into one paragraph (rule 5) with the count interpolated rather than written out
— the drift `sitemapFaultReport` is written against, one field along.

```
Config "/site/pagedeck.config.ts": "build.speculation" declares 2 fields this build cannot emit speculation rules from — declare each as the type its own line names:
  "action" — "preload" — not a speculation action — write "prefetch" to fetch the next page's bytes, or "prerender" to render it
  "max" — 0 — not a whole number of pages above zero — write the most pages one document may list, such as max: 5
```

Each fix names the supported values rather than describing them, which is rule
3's edge-target lesson at a two-valued field: an author told their action is
invalid, without being told what a valid one is, goes to the source. `max: 0` is
refused rather than read as "emit nothing", because a site that declared the
feature and got no element would have set a field and watched it do nothing.

A `speculation` that is not an object is reported alone, on
`searchFaultReport`'s argument about a non-object adapter — the same one
`sitemapFaultReport` reports on: there is nothing inside it to enumerate, so the
collection the paragraph above is a collection *of* does not exist.

```
Config "/site/pagedeck.config.ts": "build.speculation" must be an object naming the action its rules take and how many pages one may list — speculation: { action: "prefetch", max: 5 }
```

`viewTransitionsFaultReport` (`packages/core/src/view-transitions.ts`) is the
eighteenth, and it is the same issue's other door — **one line and no
collection**, because the field is a boolean and there is nothing inside it to
enumerate, which is `build.head`'s argument about a function. It is checked at
all because `viewTransitions: "auto"` is the spelling the CSS at-rule itself
uses, and therefore the mistake a reader of the at-rule makes first; unchecked,
it is truthy and the site would never learn it wrote something this framework
does not define.

```
Config "/site/pagedeck.config.ts": "build.viewTransitions" must be true or false — viewTransitions: true
```

`safelistFaultReport` (`packages/core/src/drift.ts`) is the nineteenth, and it
is the threshold's field one line along — spec §9's *other* declaration, every
class a site's code states (#260, #261). It collects for `budgetFaultReport`'s
reason and counts in the headline for the same one: a key written as a string, a
key holding a whole `className` unsplit and a key holding a number are three
different edits, and an author fixing one at a time is the build loop rule 5
exists to close. The count names the *keys* that are wrong rather than the
safelist they are in, because a safelist with one bad entry and nine good ones
is a usable declaration with an edit to make.

*Key* rather than *field*, because #261 gave the declaration a second key shape.
A key is a CMS styling field, `"hero.theme"`, or a component whose own source
states the class, `"hero"` — spec §9's two clauses, one each — so a report
calling either a field would send half its readers looking for a CMS field that
does not exist. The fix carries both spellings for the same reason.

```
Config "/site/pagedeck.config.ts": "build.safelist" declares 3 keys that enumerate no class names — declare the classes each CMS styling field can render and each component states for itself, as safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] }:
  "hero.theme" — is a string, not an array of class names
  "button.variant" — holds "bg-indigo-600 text-white", which is several classes in one string — declare each class on its own
  "hero" — holds a number, and a class name is a string
```

**The second line is the fault this field is checked for at all**, and it is a
failure of silence rather than of the build. `"bg-indigo-600 text-white"` is the
shape a design system's styling table holds a value in — one `className` per
CMS option — so writing the table's values straight into the safelist reads
correctly and declares nothing: no rendered class ever equals that string, so
the site gets exactly the build of a site that declared no safelist, and drifts
on every option it believed it had sanctioned. Nothing downstream could tell the
two apart, which is why the refusal is here and not later.

The class is quoted with `JSON.stringify` and the key with its own quotes, on
`criticalCssFaultReport`'s argument: the whole diagnosis is that this value is
one string where two class names belong, and an interpolated one would look like
the two that would have worked. A safelist that is not an object is reported
alone, on the argument the non-object budget makes — there is no collection
inside it to enumerate:

```
Config "/site/pagedeck.config.ts": "build.safelist" must be an object keyed by where each class came from — the CMS styling field, or the component whose source states it — declare the classes each CMS styling field can render and each component states for itself, as safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] }
```

`beaconFaultReport` (`packages/core/src/beacon.ts`) is the twentieth, and it is
the same rule over a field with **one door** (#48). There is no `defineBeacon`
to refuse it at construction, because there is nothing here for a site to
construct — `build.beacon` is one string in an object literal, the shape
`build.origin` has — so the config load is the only place these faults can be
found, and every one of them is found in one pass:

```
Config "/site/pagedeck.config.ts": "build.beacon" must be an object saying where real-user metrics are sent — beacon: { endpoint: "https://example.com/rum" }

Config "/site/pagedeck.config.ts": "build.beacon" cannot be used as declared — beacon: { endpoint: "https://example.com/rum" }:
  "endPoint" is not a field this build reads — delete it, or correct it to: endpoint
  endpoint "wss://collector.example/rum?…" has the scheme "wss:", and a browser reports over http: or https: — write https://example.com/rum
```

The first is reported alone on the non-object settings' argument one field up:
there is no field inside it for the other lines to be about.

**The refusal worth reading twice is userinfo**, and it is the one place in this
document where rule 6's cut is not enough on its own. This endpoint is written
into the HTML of every page of the site, so a credential in it has already been
published by the time anything can complain; redacting it in the message would
have shipped it anyway. So it is refused — and every line of this report quotes
the endpoint through `quoteAddress` (`packages/core/src/quote.ts`), because the
line that names a password must not be the line that prints it:

```
Config "/site/pagedeck.config.ts": "build.beacon" cannot be used as declared — beacon: { endpoint: "https://example.com/rum" }:
  endpoint "https://…@collector.example/rum" carries userinfo, and this URL is written into every page of the site — take the credential out, and authenticate the collector another way
```

**That cut is structural rather than a pattern, and the difference is a bug this
document briefly promised was impossible.** The first version matched the
userinfo with a regular expression, which has to decide where a credential
*ends* — and nothing in the string says: a password holding a `/` was printed
whole and one holding a `@` was printed in part. Parsing does not settle it
either, since `user:p/w@collector.example/rum` parses as the scheme `user:` with
the credential in its path. So the end of the credential is the value's last
`@`, found with `lastIndexOf`, and the scheme is what is kept in front of the
marker — which is what lets the scheme still be named in the line above. The cut
belongs to `redactSource` (`packages/core/src/quote.ts`) rather than to this
field, and `quoteAddress` is a name for the field it is reached through: rule 6
below states the rule once, with the spans it takes for a credential, the one it
knowingly does not, and the property to check any edit of it against.

```
Config "/site/pagedeck.config.ts": "build.beacon" cannot be used as declared — beacon: { endpoint: "https://example.com/rum" }:
  endpoint "user:…@collector.example/rum" has the scheme "user:", and a browser reports over http: or https: — write https://example.com/rum
```

**Two more belong to the deploy rather than to the store**, and they are the
same issue's serialization half read at the verb. `racedDeployReport`
(`packages/core/src/diff.ts`) refuses a `pagedeck diff` whose target build was not
based on the build it is deploying over — spec §11's last-write-wins detection,
which is a comparison of `BuildStamp.parent` against the other document's
`build.id`, made only of a plan that has files to upload or prune. Both name the two builds, because only the reader knows which of the
two deploys is the one that should not have happened, and both end in the flag
that proceeds anyway. A `ConfigError` and exit 2 on `pruneWindow`'s criterion
one function along: the manifests are intact, and the same command line fails
the same way until someone edits it.

```
Manifest diff: build "b3" was built on "b9" and is being deployed over build "b2", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy
```

A build that records no parent at all gets its own sentence, on the argument the
empty store above gets one: it is a different fact with a different thing to do
about it. The build recorded no base, so nothing in it says it followed the
build being deployed over — which is not evidence of a race, it is the absence
of the evidence that would rule one out. It is refused all the same, because the
feature is deploy safety and failing toward asking is the direction that keeps a
site's bytes.

```
Manifest diff: build "b1" records no parent, so nothing in it says it was built on build "b2" — a build records the newest manifest its retention store held when it started, and one that ran before the store existed records none; re-run pagedeck build so it records this base, or pass --force to deploy it anyway
```

**One build on both sides is exempt from both**, and that is the rule not
applying rather than a hole in it. A build cannot race itself: the document is
empty by construction, the deploy writes nothing, and there is no ordering for
the refusal to protect. A false positive costs more here than the case it
catches is worth — an author who meets `--force` on a no-op deploy learns that
`--force` is what you pass to make `pagedeck diff` work, and passes it next on the
deploy that is racing. A refusal is worth having only while it fires rarely and
means something every time it does.

**`pagedeck rollback` refuses neither**, and that is the design rather than an
omission: a rollback deploys a build that came before what is live, so it is out
of order by definition. That the refusal is at the verb and not inside
`diffManifests` is what buys it — one document shape, one ordering, one code
path, and no direction flag (`packages/core/src/diff.ts`).

What that verb collects instead is rule 5 over the two halves of one command
line. A grace period it cannot read and a build id the store does not hold are
one edit, and reporting them a run apart is the loop this rule exists to close;
each line keeps the fix it arrived with, `defineImages`' second paragraph, and
the headline carries only what they share. A lone failure is rethrown whole so
the common case keeps its cause (rule 4) and the sentences above.

```
Rollback to build "b9": 2 things stopped this run — each line names its own fix:
  pagedeck rollback --grace-seconds takes a whole number of seconds, and got "a while".
  Retained manifest "b9": is not in the store at "/site/.pagedeck/manifests" — the retained builds are "b1", "b2", so roll back to one of those, or raise build.retention.keep before the build you want is pruned
```

A site with no build section is thrown on the spot rather than collected, on the
boundary argument the deploy's unknown `--edge` target is: `outDir` defaults to
`./site` only inside a build section, so without one there is no `outDir` and
no manifest to have failed to read, and the collection would have nothing to
collect.

```
Config "/site/pagedeck.config.ts": declares no build section, so pagedeck rollback has no outDir to find the current manifest in — add a build section to pagedeck.config.ts — build: { pages, components, content }
```

**Eight belong to `planRouting` (`packages/core/src/routing.ts`) and none of
them joins that throw either**, because the routing config is not a build field:
it is compiled into its own document, so its faults arrive under that document's
name rather than under a config path (rule 1). They are spec §12's build-time
experiments (#34), and all eight are a `ConfigError` and exit 2 on rule 7's
criterion — a split an author declared fails identically on every run until the
config or a route is edited.

Five of them are the shape of a declaration, collected in one pass and reported
as five paragraphs for `defineImages`' reason: an empty split, a name a URL
cannot hold, a name written twice, a weight nobody can be assigned by and a
cookie key a browser will not carry are five different edits, and a headline can
carry only one of the five fixes.

```
Routing manifest: 1 experiment declares no variants — list at least one variant, or drop the experiment; an experiment with no variants emits nothing and assigns nobody:
  experiments[0] — en /pricing

Routing manifest: 2 variant names are not path segments, and each variant is written under "/_v/<name>/" — name each variant the way a path spells one segment, such as "b":
  experiments[1].variants[2] — ".." — the variant name is a dot segment, which resolves out of the variant tree
  experiments[1].variants[3] — "b/c" — the variant name holds "/", and a variant name is one path segment of a URL

Routing manifest: 1 experiment declares one variant name more than once, and a name is what the experiment assigns a visitor to — give each variant of one page its own name:
  experiments[1] — "b"

Routing manifest: 1 variant weight is not a share of visitors — write a positive number, such as 50; the shares are relative, so they need not total anything in particular:
  experiments[1].variants[0] — 0

Routing manifest: 2 experiments declare cookie keys no browser will carry — write the key as a cookie name, such as "fw_pricing":
  experiments[0] — the cookie key is empty
  experiments[1] — the cookie key holds " ", which ends a cookie name
```

The variant name and the cookie key each name the **offending character**
rather than describing the value, `localeFaultReport`'s argument over the other
two values this repo turns into path segments: a reader looking at `fw pricing`
cannot see which of its characters the message is about. The weight is quoted
with `JSON.stringify` for `driftThreshold`'s reason and it is load-bearing in
the same way — a `.js` config is never typechecked, so `"50"` reaches the edge
and divides into a share as `NaN`, and an interpolated `50` in the report would
be indistinguishable from the one that would have worked.

**The variant name is quoted whole and the cookie key is not, and that split is
rule 6 applied rather than an inconsistency in one pass.** The rule redacts what
*could* be a credential, so the question is what each value is. A cookie key is
a name a browser carries — it goes out in a `Set-Cookie` and comes back on every
request, so it is the kind of value a site spells out of a token, and
`fw_${sessionId}` is a plausible line of config. A variant name is an authored
label written into a public URL as a path segment (`/_v/<name>/`), served and
crawled: a name holding a secret would have leaked it to every visitor long
before any build printed this report, so quoting it discloses nothing the site
is not already publishing. Each message then gives up what that costs it — the
cookie line can only name a character, which is why the check walks the key
character by character, while the variant line can show the whole name, which is
what lets an author with three near-identical names see which one it is about.
The page identity is unquoted for neither reason: `en /pricing` is spelled the
way the route table spells it, so the line reads as a lookup the author can make
rather than as a value being reported back at them.

The three below are the same declaration checked against the route table, which
is `NotFoundRule`'s precedent one shape along. A page identity is answerable —
`collectPages` enumerates every one of them — so a misspelled one is a build
failure that names it rather than a split that silently never runs, and the only
other evidence of that would be a flat line in an analytics tool weeks later.

```
Routing manifest: 2 experiments name no page of their trees — name a page by the locale and path the route table spells it with, or drop the experiment:
  experiments[0] — the route table holds no en /plans
  experiments[1] — de-ch /about renders into the "shop.example" tree

Routing manifest: 1 page carries more than one experiment, and a visitor is assigned to one variant of one page — give each page one experiment:
  en /pricing — experiments[0], experiments[1]
```

The last is the cost of the variant URL scheme, refused at the config door so
that it is never paid at emission. Variant outputs are written under `/_v/`, so
a real page there is a page a variant would overwrite:

```
Routing manifest: 1 page is written under "/_v/", the segment this build reserves for variant outputs — move the page out of "/_v/", or drop the experiments in its tree:
  the default tree — en /_v/b/en/pricing is written to "/_v/b/en/pricing"
```

**It fires only in a tree that declares a split**, and that is the segment being
reserved where it is claimed rather than everywhere. A site that declares no
experiment writes nothing under `/_v/`, so refusing its page there would be this
build failing a site over a feature it does not use — issue #34's fourth
acceptance criterion, "zero output difference for builds with no declared
variants", read at the refusal rather than at the document.

The reserved deploy keys are refused in every tree, because the edge denies
them in every tree whether or not a site uses anything (#556). They are not
every deploy key, only the deploy's own: a deploy publishes the build's
manifest at `/manifest.json` and files its history under `/.pagedeck/manifests/`, and
every target answers both with the site's 404. A page or a redirect there
would build green and never be served:

```
Routing manifest: 2 pages or redirects are at paths this build keeps off the edge for the deploy's own manifest and history — move each off "/manifest.json" and out of "/.pagedeck/"; every target answers 404 there, so nothing routed at one of them is ever served:
  "/.pagedeck/changelog" in the default tree — the page en /.pagedeck/changelog
  "/manifest.json" in the default tree — build.routing.redirects[0]
```

A redirect is read by its source with the trailing slash stripped, so
`/manifest.json/` is refused as well: the edge answers both spellings of an
address, and a row on the slashed one would put a second row on the key.

**The image contract is checked at construction rather than at config load, so
none of its refusals joins that throw** (#43). Spec §10's image settings are
read by the site's own component and by nothing in the pipeline — the framework
never wraps what a component rendered, so there is nothing to consume them — and
a `build` field nothing reads would have been a check bought with a drift
nobody can see: a site could declare one setting on the config and hand
`imageAttributes` a different object. `defineImages` and `urlTemplate` refuse
where the site writes them instead. Both are a `ConfigError` and exit `2` (rule
7): they are the site's wiring, and no retry improves them.

`defineImages` (`packages/core/src/images.ts`) is `budgetFaultReport`'s shape
over a value that is neither a pattern map nor a list, and reports in four
paragraphs:

```
Image settings: declares 1 field this build does not read — delete the field, or correct it to one of: adapter, widths, quality, format, sizes:
  "formats"

Image settings: declares 2 fields images cannot be built from — declare each as the type its own line names:
  "adapter" — not a function — pass a function of (src, width, quality, format) returning a URL, or urlTemplate("https://cdn.example{src}?w={width}")
  "quality" — "70" — not a number — write the number your CDN's quality scale takes, such as 70

Image settings: declares no widths, so there is no srcset entry to build — list at least one, such as widths: [640, 1280]

Image settings: declares 1 width that is not a pixel width — write each as a whole number of pixels above zero, such as widths: [640, 1280]:
  widths[2] — 0 — not a whole number of pixels above zero
```

The second paragraph is the one place in this document where the *fix* is on
each line rather than in the headline, and it is not a softening of rule 3. Four
different fields can be wrong at once and no two of them are fixed the same way
— an adapter is a function, a quality is a number on the CDN's own scale, a
format is that CDN's own token — so a headline carrying one fix would be
carrying the wrong one three times out of four. What the headline states is the
only thing the four share: which field, and that each line names the type it
needed. The alternative, a paragraph per field, is four headlines for what is
one edit to one object literal.

The third is separate for the opposite reason. `widths: []` is the right *type*,
so it cannot sit under that headline, and it is reported alone on the non-object
budget's argument: a list with nothing in it has no entry to enumerate a fault
against. Settings that are not an object at all are reported alone for the same
reason:

```
Image settings: must be an object declaring an adapter, widths, quality and format — images: { adapter: urlTemplate("https://cdn.example{src}?w={width}&q={quality}&fm={format}"), widths: [640, 1280], quality: 70, format: "auto" }
```

The unknown-key paragraph is the quietest of the four and half the reason the
function exists: `{ wdiths: [640] }` is an object with nothing visibly wrong in
it that does none of what the site asked for.

**Every value on those lines is cut at its `?` or `#` before it is quoted**, and
that is rule 6 reaching further than it looks. The line most often read is
`quality`, a numeric field, and the mistake that produces it is a paste into the
wrong place — a signed CDN template typed where a number belongs is exactly the
string that carries an account token, and it would otherwise be echoed whole
into a CI log by a message about a number. Cutting costs a well-formed value
nothing, because none of these fields holds either character.

The cut is **one implementation** — `packages/core/src/quote.ts`, which this
module and the script layer both quote through — and not a copy in each file
(#46). That is `criticalCssFaultReport`'s placement argument reaching a rule
rather than a field: rule 6 is not about images or about scripts, neither caller
supplies anything of its own to the quoting, and two copies under one sentence
is how one of them comes to cut a different depth from the other while both
still look like the same rule.

`urlTemplate` refuses a template with no `{width}`, one with no source
placeholder, and one holding a placeholder it cannot fill:

```
Image URL template: holds no "{src}" or "{srcParam}" placeholder, so every image would get the same URL — write the source where the CDN takes it, {src} in a path or {srcParam} in a query parameter, as "https://cdn.example{src}?w={width}"

Image URL template: holds no "{width}" placeholder, so every srcset entry would be the same URL — write the CDN's width parameter as {width}, as "https://cdn.example{src}?w={width}"

Image URL template: holds 1 placeholder this adapter cannot fill — correct each to one of: {src}, {srcParam}, {width}, {quality}, {format}:
  "{quailty}"
```

**No message here quotes the template, and that is rule 6 rather than
concision.** An image CDN's URL is exactly the kind that carries a signing key,
and these refusals are read in CI logs where nothing masks a string the site
composed. So a fault is stated by placeholder name — what the author typed, and
not a secret — and the fix carries an example template of the framework's own
instead of the site's. No message this module can produce ever quotes a *built*
URL either: every refusal happens before the adapter is called.

`imageAttributes` is the last, and it is the CLS guard #43's third criterion
asks for: an `<img>` with no `width` and `height` reserves no space, so
everything under it jumps as the bytes arrive. It is a `RenderError` and exit
`1` under rule 7 — the site's wiring is intact and what is missing is a field of
one asset — and it is squarely "will only render wrong", since the page builds,
ships, and reflows.

```
Entry /en/home: image "/uploads/hero.jpg?…" declares 2 intrinsic dimensions that are not pixel sizes, so the browser reserves no space for it and the page shifts as it loads — pass the asset's own pixel width and height:
  width — undefined — not a number
  height — 0 — not a whole number of pixels above zero
```

The source is cut the same way, `unusableReason`'s cut and for its reason: an
image source is as often a path as a URL, and a signed one carries its
credential in the query. An unusable source is a second paragraph of its own and
comes first, on `loadComponents`' argument — an image with no usable source has
no image to have dimensions, so its dimension verdict is about nothing:

```
Entry /en/home: image source is not usable, so no URL can be built for it — pass the asset's own path or URL, such as "/hero.jpg":
  "   " — the source is only whitespace
```

That report collects every fault of *one* image and no more, and the level is
the argument rather than a shortcut. A page's images are computed one call at a
time by the site's own code — there is no pass that holds them all — which is
the position `resolveComponent` is in when it keeps the single-name sentence.

**`renderPage`'s byte scan joins its two reports the same way** (issue #22). The
scan reads one page's emitted HTML once and finds three things in it, two of
which are faults: a hydration marker the parser will defeat, and a stylesheet
React hoisted. The third is document metadata React hoisted, which the same walk
takes out of the page for the `<head>` to hold and reports nothing about (#239)
— so the join below is still over two reports. Both
are a `RenderError` and exit 1 (rule 7), so unlike `loadComponents` there is no
classification a split would preserve — and a page holding both would otherwise
cost two builds. They cannot share a headline either: a defeated marker is where
the content put a component, a hoisted sheet is what a component's own source
declared, and the two fixes are two files. So the marker paragraphs come first,
the hoisted-sheet paragraph second, in a fixed order so two builds of one page
report identically (spec §11).

`checkBudgets` (`packages/core/src/budgets.ts`) collects over pages instead of
over fields. A component added to a shared tier breaches every page that uses
it at once, so a report naming one of them would send the author back for the
same edit as many times as the site has sections:

```
JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /pricing — "/pricing" allows 15360 B, the page transfers 70813 B over 3 chunks:
    /assets/fw-core-DO-Blg1p.js — 52397 B
    /assets/Chart-9f31.js — 18004 B
    /assets/en_pricing-1a2b.js — 412 B
    fold strategy promoted "Chart" at tree position 0 from "visible" to "load" — position 0 is above the fold threshold of 4
```

**Every breaching page and every cause, but only each page's three largest
chunks**, and the cutoff is not a softening of this rule. Rule 5 is about the
failures a run can enumerate, and each page is one of those; a chunk is not a
failure but evidence about one, and a page over budget by a hundred chunks of
2 kB is diagnosed by three lines exactly as well as by a hundred. The page's own
line carries the total count and says `the 3 largest` whenever it is quoting
only some of them, and `budget-report.json` — written immediately before this
throw, so it is on disk by the time the message is read — holds every chunk.

**Inlined JavaScript is evidence of that second kind, not a fourth** (#346),
and it is cut at nothing because there is only ever one line of it. A budget
counts what the page runs, and two emitters write an executable `<script>`
straight into the document rather than into a chunk — the script layer's consent
loader and the RUM beacon. Those bytes are in the headline figure, so a message
printing only chunk lines would name a smaller number than the one it failed on
and send the reader hunting for a chunk that does not exist. The line carries a
phrase where a chunk's carries a path, because there is no file to open — and
the page's own line splits the sum rather than attributing all of it to a chunk
list that may be empty:

```
JavaScript budget: 1 page transfers more JavaScript for first render than its budget allows — ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts's build.budget:
  en /about — "/about" allows 0 B, the page transfers 300 B, all of it inlined into its document:
    inlined into the document — 300 B
```

That page has no entry chunk at all — a `0b` budget and a consent loader in its
document — which is the shape #346 was filed on. A page carrying both halves
names both — `the page transfers 2100 B, 1500 B of it over 3 chunks and 600 B
inlined into its document` — and a page that inlines nothing keeps the sentence
above and gets no such line, reading exactly as it did before.

A cause is the third kind and is cut at nothing. Fold-driven hydration (#24) can
change what a page transfers with nothing in the page's own declarations changed
— a copy edit that pushes a block above the threshold — which is spec §9's
"promoted by fold score after content edit", and a reason for a failure is what
rule 5 is about rather than evidence about one: there is no such thing as the
three most important reasons. There are never many either, since a page has as
many as it has islands the fold rule moved. They sit below the chunks because
the chunks are what the limit was exceeded by and a cause says why one of them
is there.

**`checkBudgets` also reports every island whose serialized props are over
`build.islandPropsBudget`** (#653). The props are the JSON in the island's
marker, so a server component that hands an island a whole CMS entry ships the
whole entry in the page, and no JavaScript budget sees it:

```
Island props budget: 1 island carries more props in its marker than the limit allows — pass the island only the fields it renders, or raise the limit in pagedeck.config.ts's build.islandPropsBudget:
  en /products/shirt — "variant_picker" at prefix "i3f2a0b1c2d3e" carries 69109 B of props against a limit of 3072 B, over 4 top-level props, the 3 largest:
    "entry" — 66804 B
    "variants" — 2250 B
    "price" — 9 B
```

The island is named twice, and each name does a different job. The registry name
says which component to open. The prefix says which instance, because a page
can render one island twice with different props, and `data-fw-prefix` finds it
in the HTML. The props are cut at three on the chunks' argument: a prop is
evidence about the breach, the largest is almost always the one to drop, and
`budget-report.json` holds every one. Every island over the limit on every page
is reported, by rule 5.

A page over both limits gets both paragraphs in one throw, the JavaScript one
first. Both are `ConfigError` and exit 2, so a split would keep no
classification, and they cannot share a headline because the fixes are two
different edits.

`inlineStyleElements` (`packages/core/src/critical-css.ts`) collects over every
flagged page and throws once, as two paragraphs, on `assertBuildSection`'s
argument for joining and `loadComponents`' argument for not merging: both are
`ConfigError` and exit 2, so a split would preserve no classification, and the
two fixes are two files — a spelling drift in this repo, and a byte in the
site's own stylesheet.

The first is coverage this feature would otherwise lose. `checkSiteLinks` reads
`<link href>`, and a sheet that is inlined has no link for it to see, so an
inlined href nothing emitted would ship a page that is silently unstyled rather
than one that 404s. It is refused in `checkSiteLinks`' own words, because it is
the same drift reaching the same reader by a different door:

```
Critical CSS: 1 inlined stylesheet was never emitted, so the page it is on would render unstyled — the inlined URL and the file name must be one spelling: see chunkPath in client-build.ts:
  "/assets/gone.css" — inlined into en /landing, emitted by nothing
```

The second refuses a stylesheet holding `</style`, which an HTML parser reads
as the end of the element — putting the rest of the sheet into the page as
markup. Escaping it is not on the table: this build promises never to edit a
stylesheet's bytes.

```
Critical CSS: 1 stylesheet cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — remove the "</style" sequence from the stylesheet, or drop the page from build.criticalCss so the sheet is linked instead:
  "/assets/quote.css" — inlined into en /landing, "</style" at line 2, column 20
```

**The position is what makes that line diagnostic on its own**, and it is a
position rather than a quote because both halves of this document apply at
once. Rule 5 asks every line of a collected report to say why it is there, and
"this sheet holds it" leaves a reader searching a bundler's minified output by
hand; rule 6 governs what may be quoted, and a snippet of the sheet around the
match would put a site's own bytes in a CI log to say what two numbers say
exactly. Line *and* column, because a bundled sheet is one very long line where
the column is the whole answer, and a hand-written one is the other way round.
That is rule 6's "name the position instead of the value" used where rule 5
asks for a reason — the two rules agree here rather than trading off.

Both messages are asserted character for character in
`packages/core/src/critical-css.test.ts`, which is what `inlineStyleElements`
taking two plain maps instead of a `ClientBuild` is for: a refusal reachable
only through a whole fixture site is a refusal nobody pins.

`buildClient` (`packages/core/src/client-build.ts`) reports the two specifier
sets `LoadedBuildSection.componentModules` feeds it, and they stay two reports on
`loadComponents`' argument read at the headline rather than at the class. Both
are a `ConfigError` and exit 2 (rule 7), because a path or specifier the
site's config declares resolves the same way on every run until someone edits
it. Both end with the same fix sentence, `UNRESOLVED_FIX`, because both are one
edit to one field of one file. What differs is what each names.

The first is the tier plan's grouped specifiers, read before the emitted graph
is looked at so that no later fault is measured with a broken instrument:

```
Client build: 2 grouped specifiers did not resolve — install the package, or fix the component's path or specifier in build.components:
  "@ds/absent" — resolved against "/site/pagedeck.config.ts"
  "@ds/also-absent" — resolved against "/site/pagedeck.config.ts"
```

The second is the specifiers a generated entry imports a component by (#235). A
tail component is in no tier group, so the grouped headline is not true of it,
and it arrives by a different door: the entry importing it is an unresolvable
import, so the bundler refuses the invocation before the report above is
reached. That refusal is a plain `Error` at exit 1 whose advice is to add the
specifier to `build.rolldownOptions.external` — the one thing spec §11 and
`docs/adr/0007-islands-are-built-in-one-module-graph.md` refuse, since an
externalized island module is loaded by the browser on its own and the singleton
guarantee stops at the invocation boundary. So it is caught, the component and
the entry that imports it are named, and the bundler's own error is kept as the
cause rather than dropped:

```
Client build: 1 component specifier did not resolve — install the package, or fix the component's path or specifier in build.components:
  "Ghost" — "@ds/absent-component" — imported by the entry for en /, resolved against "/site/pagedeck.config.ts"
```

**A collected report keeping a cause is not the exception to rule 4 it looks
like.** What that rule carves out is several failures competing to be *the*
cause, and this invocation stopped once: there is one thrown object, so there is
no choice to make about which error caused this one, and the lines are read out
of the build's resolver record rather than out of errors. The bundler's error is
an aggregate, but it stops at the first import it cannot place — two
unresolvable component specifiers still arrive as one "Build failed with 1
error" naming one of them. So there is no second message to quote on the second
line, and the one there is carries what the record cannot: the module the
invocation gave up on.

**Which of the two it is, is read off the build's own resolver record and never
off the bundler's message.** The failure arrives as a plain `Error` holding more
plain `Error`s, with no code, no kind and no field naming the specifier, so the
only thing in it that says "unresolved import" is prose a bundler release is
free to reword. `resolveModuleIds` answers in `buildStart`, before a module is
loaded, with the same resolver and the same origin the invocation itself uses,
so its record is complete whatever the invocation went on to fail at — and a
failure it does not account for is rethrown exactly as it arrived, which is the
line `island-facts.ts` draws in the same shape: a `ConfigError` around every
bundler rejection would call a crash in Rolldown the site's wiring.

`scanIslandFacts` resolves the same map earlier in a full `pagedeck build` and refuses
an uninstalled package there first, in `unresolvedReport`'s own words. What
reaches this one end to end is a specifier that resolves for the scan's SSR
invocation and not for the browser build — a package exported under the `node`
condition alone. #235 measured that case on a spawned `pagedeck build`;
`client-build.test.ts` pins the report directly rather than spawning one.

`defineLocales` (`packages/core/src/locales.ts`) collects at the door a locale
map is written at, and both halves of this rule land in the one function. A
`domain` that is not a bare host (#319) and a `fallback` naming a locale the map
does not declare are two paragraphs of one throw, on `assertBuildSection`'s
argument: a locale map is one object literal, both faults are the site's own
wiring at exit 2, and neither report is measured on what the other reads — so
they join, and they keep separate headlines because a host and a locale code are
fixed differently. One `domain` can carry several faults, so `evil.com/#` gets a
line each for the path and the fragment, and every line repeats the value for
`listDueEntries`' reason. Every value is quoted through `quoteAddress` for rule
6's: a domain holding userinfo is a credential written into a config field.

```
Locale set: 1 locale declares a domain that is not a bare host — write the host a locale's pages are served from and nothing else, as domain: "example.de":
  "de": "https://example.de" — the domain opens with the scheme "https:", and the origin supplies the scheme

Locale set: 1 locale falls back to a locale that is not declared — declare the target, or point the fallback at a declared locale:
  "de" falls back to "de-AT"
```

A declared domain the scan finds nothing else wrong with must still have a tree
key that is a host name (#677): dot-separated labels of 1 to 63 ASCII letters,
digits and hyphens, none starting or ending with a hyphen, 253 characters at
most, with one trailing dot allowed. The rule reads the tree key, the host the
URL parser reads out of the declared domain, so `münchen.de` passes as
`xn--mnchen-3ya.de`, and a bracketed IPv6 literal the parser accepts passes as
it is. The parser turns `..`, `%2e%2e` and `。。` all into `..`, whose labels
are empty, and a tree keyed `..` would be written beside the output directory
rather than inside it. Every locale the rule refuses gets a line of its own:

```
Locale set: 2 locales declare domains that are not bare hosts — write the host a locale's pages are served from and nothing else, as domain: "example.de":
  "de": ".." — the domain parses to a tree key that is not a host name, so it cannot key a tree under the output directory; a host name is dot-separated labels of 1 to 63 ASCII letters, digits and hyphens, none starting or ending with a hyphen, at most 253 characters in all and optionally ending in one dot
  "de-AT": "-a.com" — the domain parses to a tree key that is not a host name, so it cannot key a tree under the output directory; a host name is dot-separated labels of 1 to 63 ASCII letters, digits and hyphens, none starting or ending with a hyphen, at most 253 characters in all and optionally ending in one dot
```

The cycle report stays a throw of its own, and that is the boundary above rather
than an exception to it: it walks the graph the fallbacks describe, and a
fallback naming nothing is a hole in that graph, so a cycle report collected
beside the paragraphs here would be a partial answer printed as a whole one.

`readManifest` (`packages/core/src/manifest.ts`) collects over a manifest of
the current version whose fields are not what `pagedeck build` writes (#529). The
version check comes first. After it, the document is compared against every
field `Manifest` declares, at every depth: the top-level objects, each files
and pages row, the routing document and the tier plan. Each field that is
absent or of the wrong type gets a fault, and the refusal names all of them:

```
Manifest "/site/dist/manifest.json": 2 fields do not hold what pagedeck build writes there (pages[0].dependencies: expected a list, found nothing; tiers.groups: expected a list, found nothing), which pagedeck build never writes — run pagedeck build, and read the manifest it writes in place of this one
```

Six readers take fields off a parsed manifest: the incremental planner,
`pagedeck rollback`, `pagedeck diff`, `pagedeck deploy`, the retention store and parity. Before
this check, a hand-edited or truncated document at the current version reached
them unchecked, and each one threw a `TypeError` far from the file. The check is
in the one reader they share, so a seventh reader gets it too. It checks types
only, and each fault names the field and the type it found. It quotes no value,
so no byte of the document reaches the log.

The faults are on one line, not one line each. Two callers put this message
into their own report as one line and pass it through `printable`: the full
build's warning that it could not prune, and the retention store's warning.
`printable` would change each line break into a replacement character.

The fix is the same for every reader. A document with these faults cannot be
repaired to the document a build wrote, so the fix is a new one: `pagedeck build`
writes a whole manifest, and the reader then reads that one. This holds for
`pagedeck build --incremental`, which reads the new manifest in the output directory.
It also holds for `pagedeck diff`, `pagedeck rollback`, deploy and parity, which read the
document the operator points them at.

What a value means is not checked here: a `kind` outside the four, a path that
goes outside the output tree, two rows at one key. The readers that act on
those values check them where the value decides a deletion (`untrustedRows` in
`packages/core/src/build.ts`, `indexFiles` in `packages/core/src/diff.ts`).

## 6. Redact anything that could be a credential

Presigned snapshot URLs carry their credential in the query string, and CI
secret masking will not catch a URL that CI composed itself. Every snapshot
message and success line goes through `redactTarget`
(`packages/core/src/snapshot.ts`), which keeps scheme, host and path and drops
the rest. Apply the same rule to any new message that could hold a token.

**Redaction covers messages, and that is all it can cover.** A target passed as
`pagedeck store pull <url>` is an argument of the process before it is ever a string
in a message, and the two places it lands there are outside this document's
reach: `/proc/<pid>/cmdline` is world-readable on stock Linux, so any other user
on a shared CI runner can read it out of a running `pagedeck`, and most CI providers
echo the `run:` line they are about to execute, arguments and all. A careful
in-message redaction defeated one layer up is not a defence, and calling it one
would be worse than not having it.

So `pagedeck store` reads its target from `PAGEDECK_SNAPSHOT_URL` when the command line
names none (#117). What does the work is that the target is never named on the
command line: the process reads the variable rather than being handed its value,
so nothing lands in `cmdline` and nothing is echoed. A workflow written as
`pagedeck store pull "$PAGEDECK_SNAPSHOT_URL"` gets none of that — the shell expands the
variable before `pagedeck` starts — and it is the argument-less form that is worth
documenting. Even that is a smaller exposure rather than none: a workflow that
echoes the variable puts the credential back in the log, and no framework code
can stop it. What the framework can do is stop being the reason it is there.

Both sources given at once is refused rather than ranked, and the refusal quotes
both through `redactTarget` like every other message — a refusal that printed the
URL whole would be this rule's own failure.

**A deploy through presigned URLs quotes keys, never URLs** (#652).
`deploy.bin.ts` reaches a presigned origin through a file of presigned URLs named by
`PAGEDECK_DEPLOY_URLS`, and every URL in it carries a credential. No message
redacts one, because no message prints one: each refusal names the method and
the deploy key the URL is listed under, which is also what the operator has to
fix. A key or a field is quoted through `redactTarget`, because a map written
backwards puts a URL where the key belongs. A URL with a user name or password
is refused, because `fetch` refuses one with a message that quotes it whole. A
request that fails keeps its cause, copied with the URL and its query string
cut wherever the chain repeats them. The file's own path is quoted, because a
path is not a credential. A file that is not JSON is refused without the
parser's message, because Node's `JSON.parse` quotes the text around the fault,
and the text is URLs:

```
Deploy URLs "/ci/signed.json": is not valid JSON — write it as {"get": {key: URL}, "put": {key: URL}, "delete": {key: URL}}; the parser's own message is not printed, because it quotes the file and the file holds credentials

Deploy URLs "/ci/signed.json": could not be opened (ENOENT) — point PAGEDECK_DEPLOY_URLS at the file the signing step wrote

Deploy URLs "/ci/signed.json": 5 entries cannot be used, and nothing was sent — fix each in the signing step that wrote the file:
  get "/manifest.json": is a http: URL — presign it over https, because a presigned URL carries its credential and a deploy sends bytes only over https
  put "/index.html": names a loopback host — point it at the origin, not at this runner
  put "/app.js": carries a user name or password before its host — presign it without one; a presigned URL carries its credential in the signature
  put "https://bucket.example/site/about.html": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character
  put "/en/index.html": names a different host, or a different path before the key, than the other URLs do, so it could write another key — sign every URL for one origin

Deploy: PAGEDECK_DEPLOY_URLS holds no PUT URL for 2 keys this apply writes, so nothing was sent — re-run the dry run with --requests, sign every key it lists, and apply with the file that signing writes:
  "/assets/app-a1b2c3.js"
  "/.pagedeck/manifests/b2.json"

Deploy: PAGEDECK_DEPLOY_URLS holds no DELETE URL for 1 key this prune deletes, so nothing was sent — re-run the dry run with --prune and --requests, sign every key it lists, and apply with the file that signing writes:
  "/assets/app-000000.js"

Deploy: the prune would delete 1 key the deploy writes for itself, so nothing was sent — no build emits such a key, so the document in the origin's deploy history that names it was not filed by an apply; replace that document with the manifest.json its build wrote, and the prune plans no DELETE for the key:
  "/manifest.json", named by "/.pagedeck/manifests/b0.json"

Deploy history index "/.pagedeck/deploy-history.json": is not valid JSON — rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named

Deploy history index "/.pagedeck/deploy-history.json": is larger than 24600014 bytes, the most an index of 100000 builds of 243-byte ids takes, so the rest was not read — rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named

Deploy history index "/.pagedeck/deploy-history.json": names 100001 builds, more than the 100000 an index holds — rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named

Deploy history index "/.pagedeck/deploy-history.json": entry 2 is a build id of 244 bytes, longer than the 243 a "<build id>.deployed-at" file name can hold — rewrite it as {"builds": ["<build id>", ...]}, naming each build whose document is under "/.pagedeck/manifests/", or delete it: the next apply writes a new one, and a prune then never finds the files only the builds it lost had named

Deploy of "/old.txt": PAGEDECK_DEPLOY_URLS holds no DELETE URL for this key — re-run the dry run with --prune and --requests, and sign every DELETE it lists

Deploy of "/../sentinel.txt": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character, so it could name a file outside the origin at "/srv/origin"

Deploy: the origin holds no "/manifest.json", but its history index "/.pagedeck/deploy-history.json" names 2 builds, so the origin is damaged rather than new — put the document of the build it last served, "/.pagedeck/manifests/<build id>.json", back at "/manifest.json", or pass --from a copy of it; that build is the one whose "/.pagedeck/manifests/<build id>.deployed-at" holds the newest instant

Deploy read of "/manifest.json": PAGEDECK_DEPLOY_URLS holds no GET URL for this key, which the run reads before it plans — sign a GET for it; a dry run with --requests lists every key to sign

Deploy read of "/manifest.json": the host answered 403 to GET — re-presign the URL, and check that the credential it was signed with may read this key. The URL is not printed: it carries the credential in its query string.

Deploy read of "/manifest.json": the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.

Deploy of "/index.html": the request failed — check that the origin is reachable from this runner. The URL is not printed: it carries the credential in its query string.
```

The last three exit 1, and every other one exits 2. The command line has five
refusals of its own, and a rollback to a presigned origin has four more. Each
of the first five is followed by the usage text:

```
Option "--origin" and PAGEDECK_DEPLOY_URLS are both given, as "../../.origin" and "/ci/signed.json" — two sources for one origin are refused rather than ranked; pass one.

No --origin given, and PAGEDECK_DEPLOY_URLS is not set.

Options "--requests" and "--apply" are given together — --requests lists what a dry run would ask the signing step for, and an apply signs nothing; drop one.

Option "--requests" names "/ci/signed.json", which is the file PAGEDECK_DEPLOY_URLS names — the dry run would write the requests over the presigned URLs; write the requests to another file.

Option "--requests" is given without PAGEDECK_DEPLOY_URLS — it lists the requests a presigned origin needs signed, and a directory origin needs none; set PAGEDECK_DEPLOY_URLS, or drop "--requests".

Rollback to build "b1": there is no manifest at "/site/dist/manifest.json", so there is no tree to restore from — pass --out the tree build "b1" wrote

Rollback to build "b1": the tree at "/site/dist" is build "b2", and a rollback uploads the restored build's own bytes from that tree — pass --out the tree build "b1" wrote.

Rollback to build "b1": the origin holds no "/manifest.json", so no build is live to roll back from — deploy the build without --rollback

Rollback to build "b1": the origin's deploy history holds no "/.pagedeck/manifests/b1.json", so the origin never served that build — name a build the history holds
```

**The signing step quotes variable names, never values** (#665).
`presign.bin.ts` is the one process that holds the credential, so its refusals
name the variable a value belongs in and print none of the five. The endpoint
is withheld as well: it carries the account id. A requests file that is not
JSON is refused without the parser's message, like the deploy's own file:

```
Signing takes two files — pass the requests file deploy.bin.js --requests wrote, then the file to write the URLs to.

Signing: "requests.json" is both the requests and the file to write — write the URLs to another file.

Signing: 4 variables are not set — set each from the repository's secrets, in the step that signs and in no other: PAGEDECK_S3_ENDPOINT, PAGEDECK_S3_REGION, PAGEDECK_S3_BUCKET, PAGEDECK_S3_ACCESS_KEY_ID

Signing: PAGEDECK_S3_ENDPOINT is not an https: origin with no path, user or query — set it to the bucket host's S3 endpoint, such as https://<account id>.r2.cloudflarestorage.com; its value is not printed

Signing: "/ci/requests.json" could not be opened (ENOENT) — pass the file deploy.bin.js --requests wrote

Signing: "/ci/requests.json" is not valid JSON — pass the file deploy.bin.js --requests wrote; the parser's own message is not printed, because it quotes the file

Signing: "/ci/requests.json" is not an object — pass the file deploy.bin.js --requests wrote

Signing: "/ci/requests.json" has 3 entries that cannot be signed, and nothing was signed — pass the file deploy.bin.js --requests wrote:
  "post": is not a field the deploy reads — the fields are "get", "put" and "delete"
  get "manifest.json": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character
  "put": is not an object of key to request — write it as {key: {}}
```

The first is followed by the usage text. Every one exits 2.

**A redactor is written for an input set, and a new door widens it.** Reading a
target from a variable rather than an argument changed what `redactTarget` has to
survive, and the four shapes it gained are worth naming because the next
credential-bearing input will arrive the same way. A URL with no authority —
`data:`, `mailto:` — keeps its whole payload in `pathname`, so "scheme, host and
path" was the entire string; one of those is now cut to its scheme, `file:`
excepted, whose path is its address. A fragment is cut like a query, at the
delimiter and keeping it, which is `unusableReason`'s spelling above rather than
a second one. And a value holding a newline could forge a line into a report, so
control characters are replaced with `U+FFFD` — the same thing an unprintable
code unit already reaches a log as. The fourth arrived later through the same
door (#320): an interpolation that lost its scheme — `//AKIAX:SECRET@bucket…` —
is not a URL at all, so it never reaches the parsed branch. Nothing on that
branch *strips* userinfo either. It composes its quote out of `URL.protocol`,
`URL.host` and `URL.pathname`, and userinfo is absent from it because `host`
excludes userinfo, not because a rule removes one. The fallback has no parse to
compose from, so it carries the rule instead, and that rule runs in the opposite
direction to the delimiter's: a query or a fragment means drop what follows,
userinfo means drop what came before, so the span before the `@` is replaced
where it stands and what is left of the string names the target.

**The fallback's rule is broad on purpose, and the breadth is its residual
risk.** It replaces everything before the last `@` standing ahead of the
target's query, whether or not the URL grammar would call that span userinfo, so
an identifying prefix is spent whenever an `@` appears anywhere before the
query: `/reports?notify=someone@example.com` is quoted `…@example.com`, the mail
host kept and the path that said which report was meant gone. That is the
deliberate direction. A narrower rule bounded to the authority — where RFC 3986
ends userinfo — was tried first and returned
`https//AKIA:SECRET@bucket.example/store.db` whole, one dropped colon being
enough to put the credential past the bound; a value reaches the fallback by
failing to parse, so reading it with the grammar is reading a string already
shown not to obey one. `redactSource` below judges the span in front of an `@`
instead of redacting in front of every one, and this rule does not: a target is
one string out of a CI secret store, and no message here has to name a file
inside it. None of that makes the function a sanitizer: a path is still printed
whole, and the CLI's real answer to a presigned target is to keep it out of the
process table.

**One rule, at every door that quotes a value a site wrote.** Three functions
made this cut and only one of them made it whole, which is the shape of #378
and #383. `redactOrigin` bounded its span to the authority and a slash in front
of the `@` — a dropped colon, a stray `/`, a password holding one — walked past
the bound; `redactSource` (`packages/core/src/quote.ts`, and its copy in
`colors.ts`) dropped no userinfo at all, so an image source or a script source
behind basic auth printed its credential whole, and printed it whole even when
the query cut fired, because that cut takes what stands *behind* a delimiter and
userinfo stands in front of one. Both are `redactSource` now: everything between
a leading scheme and the last `@` goes, and the query or fragment is cut after
it. The fallback above is the third function and keeps its own rule, for the
reason stated there.

**Which `@`s it fires on is narrower than "every one of them", and the narrowing
is what keeps these messages legible.** A rule that redacted in front of every
last `@` quoted three different failing CDN sources as `"https://…@2x.jpg"`, two
of the three lines identical byte for byte, inside a report whose own reasoning
is that the source is the thing a reader acts on; a link report quoting
`https://…@pedro` spends the host it exists to name. So the span in front of the
last `@` is judged, on the value with any `scheme://` taken off it, and it is
taken for a credential when it holds no `/`, or holds a `:`, or holds a second
`@`. `https://user:s3cret@cdn.example.com/hero.jpg`,
`https://user:s3c/ret@example.com`, `https//user:s3cret@example.com`,
`user:s3cret@example.com` and `mailto:tok@example.com` all still lose every byte
in front of the `@`. Every other `@` is one a path wrote, and the value is kept
whole with its host and its file name: `/hero@2x.png`,
`https://cdn.example.com/photos/hero@2x.jpg`, `https://mastodon.social/@pedro`,
`./components/@ui/Button.tsx`. What breadth is left is paid by a span with no
path in front of it, which is where a scoped specifier sits — `@pagedeck/islands` is
quoted `…@pagedeck/islands` — and that is the same trade every paragraph above makes.

**The rule's residual is written down rather than hidden.** A credential holding
a `/` and carrying no `:`, standing alone in front of a single `@`, is not
redacted: `https://b64/tok==@host/x` is printed whole, which is a
standard-base64 key written as bare userinfo. It is accepted rather than missed.
Basic auth — the shape that puts a credential in front of a host in the first
place — always carries the `:` the second clause reads, and the token forms
written bare hold no `/`: `ghp_`, `glpat-`, a JWT and a hex digest are all
slash-free. A span that does not say what it is cannot give a narrower residual
than that, and the wider rule is the one this replaced. `quote.test.ts` pins
both sides of it, the shapes now kept whole beside this one.

A route is cut the same way and for the same reason. `unusableReason` in
`packages/core/src/pages.ts` quotes a route only as far as its `?` or `#`,
keeping the delimiter so the reader still sees which of the two it was:

```
Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:
  sources[0] "pages" /en/home — the route holds a query or fragment: "/search?…"
```

A route holding a malformed percent-escape is cut the same way, at the `%` that
failed:

```
Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:
  sources[0] "pages" /en/home — the route holds a malformed percent-escape: "/a%…"
```

A route holding a lone surrogate is cut at the surrogate, the same way:

```
Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:
  sources[0] "pages" /en/home — the route holds a lone surrogate: "/a\ud800…"
```

The kept character there is the offending code unit itself. A lone surrogate
has no UTF-8 spelling, which is the fault being reported, so `quoteIdentifier`
writes it as a `\ud800` escape (#730). The words are what name it; the quote is
only the prefix that says which route failed.

`canonicalizePath` makes every one of these cuts on a path handed to it
directly, and tests the delimiter first for this rule's sake:
`/x?token=SECRET%2` cut at its `%` would quote the token, cut at its `?` quotes
nothing past the delimiter. The order is a fixed precedence, not a search for
the leftmost fault: a path is cut at the match of the first test it fails,
wherever that lands, so `/a<U+D800>%2` is cut at its `%`, to the right of the
surrogate. What that buys is the rule above — append a test at the end and it
cannot change the cut for any path an earlier test already matched, so the
delimiter's cut stays first however many refusals there are.

The cut is written there rather than reusing `redactTarget`, which parses a
URL and would leave a fragment whole on a string that is not one.

Where there is no prefix worth keeping, name the position instead of the value.
A route returned as segments is refused when one of them is `.`, `..`, empty, or
holds a lone surrogate — the first three survive percent-encoding and then
resolve away path structure, the last is the one value `encodeURIComponent`
cannot spell — and each offending segment is named by index, never quoted:

```
Route table: 1 route is not a usable path — return a path like "/pricing", or undefined to emit no page:
  sources[0] "pages" /en/home — the route holds a segment that is not a path segment: segments[1] is a dot segment
```

A header value is cut the same way and named rather than quoted. A header set
is authored config, and a value is exactly the field that can hold a token, so
`packages/adapter-nginx/src/nginx.ts` locates one by its field name and the prefix it
sits under and names the character that broke, never the value. A path or a
prefix in the same report *is* quoted: it has already been through
`canonicalizePath`, so it holds no query and no fragment, and it is what the
author edits.

The segment *is* the param value, so quoting it would put a slug in the log for
nothing: the index is what the author edits. Rule 5 applies inside the line as
well as across the report, so every offending segment of one route is listed.
`unusableSegmentReason` in `packages/core/src/pages.ts`.

**A build id is quoted through a door of its own, and the marks are the
door's.** `racedDeployReport` (`packages/core/src/diff.ts`), the retention
store's three refusals and its misfiled-document warning
(`packages/core/src/retention.ts`) and `pagedeck rollback`'s collected report
(`packages/core/src/cli.ts`) all name build ids, and an id is not the
framework's: `runBuildVerb` mints a uuid, but `readManifest` checks only that
an id is a string, and `unusableId` answers only whether an id can be a
*path* — a newline, a `"` and an erase-line escape are none of the shapes it
refuses. So an id read back off disk, or composed by a CI wrapper out of a
branch name, is arbitrary bytes arriving in a report that `bin.ts` marks per
line. Every one of those messages calls `quoteIdentifier`
(`packages/core/src/quote.ts`), and the quotation marks around each id come
from `JSON.stringify` inside it rather than from the sentence around it — a
value that supplied its own `"` would otherwise close a hand-written quotation
and write the rest of the line.

**One of them now quotes a path through the same door, and that is a second
kind of value at it rather than an oversight.** The store's third refusal names
the file it could not open, and a retained document's file name *is* the build
id with `.json` after it — so the bytes that make an id dangerous here are in
the path too, and quoting the path by hand while quoting the id through the
door would leave the newline in the half that was not escaped. `misfiledWarning`
had already brought a `readdir` name through it for the same reason. What the
path must not meet is the *other* rule's cut, and both of its halves reach a
path. The delimiter half fires on a `#` or a `?`, which `unusableId` permits:
`/site/.pagedeck/manifests/run#7.json` is quoted `"/site/.pagedeck/manifests/run#…"`, the
file name gone. The userinfo half fires whenever the span in front of the id's
last `@` also carries a `:` or a second `@` — `credentialEnd`'s second and
third clauses, which a store path cannot escape through the first, that one
asking whether the span holds no `/`. It is the worse cut, because it replaces
everything in front of the `@`: `/site/.pagedeck/manifests/main:v1@sha.json` is
quoted `"…@sha.json"` and `/site/.pagedeck/manifests/a@b@c.json` is quoted
`"…@c.json"`, the store's own directory gone from a sentence whose job is to
say which file to open. An id carrying a single `@` and no `:` in front of it
is kept whole — `main@sha`, and `@pagedeck` and `hero@2x` alike.
Either half alone makes `quote` the wrong door here.

**It is not `quote`, and the difference is this rule having two halves rather
than one.** The cut argued for above is aimed at a value that *addresses*
something, because that is the shape a credential gets pasted into. `unusableId`
permits `@`, `#` and `?`, so `<branch>@<sha>` is an id a CI wrapper mints
without being asked to, and `quote` renders `main@9e1f4a02` as `…@9e1f4a02`.
That is the raced-deploy line naming the racing build with the half that
identifies it gone, and the store's refusal listing, as the builds to roll back
to, ids that are not the ids on disk — rule 2 lost in one message and rule 3 in
the other. So the identifier door escapes and cuts nowhere, and what that costs
is written down at the function rather than left implicit: an id a wrapper
minted out of a credentialed URL prints whole.

**What the operator typed goes through the same door** (#398). Five parsers in
`packages/core/src/cli.ts` echo command-line input into their refusals:
`parseSyncArgs`, `parseBuildArgs`, `parseDevArgs`, `parseDiffArgs` and
`parseRollbackArgs`, for an unknown option and for a flag's value. `runCli`
does the same for an unrecognised verb, `runStoreVerb` for an unrecognised
`pagedeck store` subcommand, `resolveSnapshotTarget` for a target given twice, and
`pagedeck diff` for a manifest path it cannot read. The two bins in `packages/site`
do the same (#519): `deploy.bin.ts` for an unknown option, an option given
twice, `--rollback` beside `--from`, the rollback's build id and the manifest
paths built from `--out` and `--from`, and `parity.bin.ts` for an unknown verb,
an unknown option, an option given twice and the `--baseline` path. The
modules those bins call quote the same paths: `readBuiltSite` and
`readBaseline` in `parity-read.ts` for the `--build` and `--baseline` paths,
`applyPlan` in `deploy-target.ts` for the `--out` tree a planned file is
missing from, and `readManifest` for the manifest paths `deploy.bin.ts` reads
and passes its refusals through (#532). `pagedeck diff` hands `readManifest` the path
the operator typed too (`loadAttempt` in `cli.ts`), so the same quoting closes a
forged line there that predates #532. Each of these calls `quoteIdentifier`. An
option name the bin spells itself, such as `"--from"`, is not typed input and
keeps its literal quotes. The operator who typed the value is not always its
only reader: these verbs run in CI, and other people read the stderr that CI
captures. A snapshot target goes through `redactTarget` first and
`quoteIdentifier` after, so redaction still sees the raw value. A plain value
reads as it did before, so `and got "a while".` in the rollback report above is
unchanged.

**A cause walks past every one of these doors, so the chain is neutralised
where it is flattened.** The store's missing-target refusal attaches its ENOENT
as a cause under rule 4, and Node's own text re-prints the id inside
`open '<path>'` with nothing done to it — so a message whose own line was
closed still reached stderr as two, the second wearing `pagedeck: ` and then erasing
it. What `runCli` writes is `describeError` (`packages/core/src/exit.ts`), and
that is where every message *but the first* goes through `printable`. The first
is the framework's own and carries rule 5's layout; everything joined after it
with `": "` is being pasted into the middle of a line and never had any.

**Both doors cover the C1 controls as well as C0 and DEL** (#520).
`JSON.stringify` escapes C0, `"` and `\`, but it leaves U+007F–U+009F, U+2028
and U+2029 raw, so `quoteIdentifier` writes each of those out as a `\uXXXX`
escape after it. The output is still a JSON string literal that reads back to
the value. `printable` replaces U+0000–U+001F, U+007F and U+0080–U+009F with
`U+FFFD`. U+009B is the single-byte CSI, which a terminal that honours 8-bit
controls reads as `ESC [`: without this, `\u009B2K` erases a line there as
`\u001B[2K` does everywhere. U+2028 and U+2029 are not terminal controls, so
`printable` leaves them alone.

`quote` (`packages/core/src/quote.ts`) and its copy for the color probe's
answer, `quoteValue` (`packages/content/src/colors.ts`), now do the same
(#742). Each passes its `JSON.stringify` output through
`escapeUnescapedByJson`, which is the step `quoteIdentifier` takes after
`JSON.stringify`. Each passes a value `JSON.stringify` cannot write, such as a
symbol, through `printable` instead. Those two quote the hrefs and URLs that
the link check and a content-relative reference report, an image source, and
the probe's answer, and a CMS can supply any of them. The undeclared-locale
refusal of `href` quotes its code through `quoteIdentifier`, because page code
can pass an entry's locale there.

An ordinary id reads exactly as it did before any of this, which is why the two
lines below are byte for byte the ones §5 above already quotes:

```
Manifest diff: build "b3" was built on "b9" and is being deployed over build "b2", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy
Retained manifest "b9": is not in the store at "/site/.pagedeck/manifests" — the retained builds are "b1", "b2", so roll back to one of those, or raise build.retention.keep before the build you want is pruned
```

**An entry id is the loader's, so every collection message that names one
neutralises it first** (#730). A loader reports the id, and a CMS loader takes
it from the CMS. `refusedFieldReasons` (`packages/content/src/collection.ts`)
refuses a NUL, a backslash, a leading `/` and a `..`, and lets ESC, CR, a
newline and U+009B through, because those are not path faults. Each of these
messages is a first message, which `describeError` prints as it is. So a sync
used to print an id holding `ESC [2K` as a line that erased itself and wrote
`pagedeck: sync complete` in its place. Both doors now live in
`packages/content/src/escape.ts`, exported as `@pagedeck/content/escape`, and
`@pagedeck/core` re-exports them, so there is still one `printable` and one
`quoteIdentifier`. The subpath imports nothing, so a browser bundle that takes
core's quoting does not take `node:sqlite` with it.

Where rule 2's layout puts the id at the head of a line, as `/locale/path:`,
the id goes through `printable`. There are no marks around it for a `"` to
close, and an ordinary id prints as it always did. These are the unusable-id
refusal, `validateEntry`'s schema-failure lines and `invertedWindowReport`'s
lines. A schema-failure line passes whole, because the field name is a key
from the entry's data. An inverted-window line also passes the two instants,
which are entry content. A build reaches the same ids later, so the route
table's reports and a layout's entry reports pass the id through `printable`
too. Here is the refusal for an ordinary id, and then for
an id holding ESC, CR, a newline, U+009B and a NUL:

```
Collection "pages": 1 entry does not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:
  /en/../secret: its path holds a ".."
```

```
Collection "pages": 1 entry does not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:
  /en/x�[2K�pagedeck: sync complete��2K�/../y: its path holds a NUL and a ".."
```

Where a message puts the id inside quotation marks, the id goes through
`quoteIdentifier`. These are `getEntryCached`'s refusal of an unusable id, a
validator that threw, a write that failed and an entry absent right after its
write. A template name that `templateOf` read out of an entry's data takes
the same door. An ordinary id reads as before. A backslash now prints as
`\\`, which is what `JSON.stringify` writes:

```
Collection "pages": entry id "/en/x\u001b[2K\rpagedeck: sync complete\n\u009b2K\u0000" is not a usable identifier — its path holds a NUL — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop
```

`colorFailureWarning` takes both doors. An image source is the entry's, so it
is quoted through `quoteIdentifier` after `redactSource` cuts it. The probe's
own text goes through `printable`, because a probe that throws often names the
source it failed on.

**Validator text is the one exception, and it is deliberate.** §2's schema
failure interpolates `issue.message` from zod, valibot or arktype verbatim
apart from its control characters, which `printable` replaces (#730), and
several validators quote the value they received — zod's enum mismatch renders
`… received '<value>'`. So a CMS field value can reach a CI log. That is the
trade §2 makes on purpose: a schema failure that named the field but not what
was in it sends the reader back to the CMS to find out what the message could
have told them. The boundary is what the value *is*. A content value is
content, and the log it lands in is the log the site's own content is built
from. A credential is not content, and nothing that could hold one — a URL, a
target, a header — is exempt: those go through `redactTarget`, whatever the
message is about.

**A message that quotes values of both kinds decides per value, not per
message.** `quotedValue` (`packages/core/src/head.ts`) is the case: a head
claim's value is a title or a description on one page and an `og:image` URL on
the next, and the same line prints either. So an absolute URL goes through
`redactTarget`; a path-shaped value — one beginning `/` or `.` — is cut at its
first `?` or `#` with the delimiter kept, `unusableReason`'s cut rather than
`redactTarget`'s, for the reason that function is not reused above; and anything
else is quoted whole, because it is content and the report's job is to let a
reader tell two values apart. A title ending in a question mark is a likelier
input than a credential written with no scheme and no leading slash, and cutting
every value at its `?` would redact the first to protect against the second.

## 7. Classify by throwing the right class

The exit code comes from the class, not from the prose, so CI can branch
without parsing text (`packages/core/src/exit.ts`).

Throw `ConfigError` — exit `2` — when the fault is in how the site is wired and
will fail identically on every retry until a human edits something: a missing
or malformed config, an unsupported snapshot URL scheme or a snapshot target on
a loopback or link-local host (`packages/core/src/snapshot.ts`), a command line
the CLI does not understand
(`usageError` in `packages/core/src/cli.ts`).

**A package that cannot import `ConfigError` declares its own wiring-fault
class.** `ConfigError` lives in `@pagedeck/core`, the orchestrator that consumes
every other package, so a package `@pagedeck/core` depends on cannot import it
without inverting the dependency. The rule is not to move the class and not to
downgrade the fault to exit `1`: declare a class local to the package, name it
for the thing that is miswired, and add it to `isWiringFault` in
`packages/core/src/cli.ts`. That function is the single place the split is
resolved, so however many classes there are, CI sees one exit code.

Four exist today:

- `ConfigError` (`packages/core/src/exit.ts`) — the config and the command
  line, as above. Also a `route` callback that returns something no page can be
  built from — a query, a fragment, a malformed percent-escape, or a lone
  surrogate — and an entry in a locale the site never declared
  (`packages/core/src/pages.ts`). A path handed straight to `canonicalizePath`
  carrying any of the four is the same fault reaching the same class by a
  different door.

  The lone surrogate is there because `encodeURI` throws `URIError` on one, and
  `URIError` is a class this rule does not name: the run exited by an
  unclassified path with the message "URI malformed", which names no collection,
  no entry and no fix. Refusing it in the wiring pass is what gives it a class,
  and it is refused only because the encoder cannot take it — not as a
  well-formedness policy over Unicode. A route returned as *segments* is
  encoded by `encodeURIComponent` instead, before the wiring pass reads
  anything, so that form is refused a step earlier by
  `unusableSegmentReason` — same predicate, same class, same report.
- `RegistryError` (`packages/islands/src/registry.ts`) — a component registry
  that is malformed, a reference to a component nobody registered, a
  `"use client"` directive contradicted by `hydrate: "none"`.
- `StoreError` (`packages/islands/src/store-stamp.ts`) — a provider in the root
  provider stack delivering a store the framework did not mint (#252). Named for
  the store rather than for the provider that carried it, because what is wrong
  is the instance: a site that calls `createStore()` of its own gets a page in
  which every component works and no state crosses an island. It reaches a build
  through `renderPage`, which checks the stack before it renders a page through
  it, and it fails there identically on every run until the module that minted
  the store is edited — which is what puts it here and not on exit `1`. A
  preview entry and a dev server's page entry throw it too, where there is no
  exit code to pick and the class is only what says which fault it is; a shipped
  page reports instead (rule 8). It is declared in `store-stamp.ts` rather than
  in `store.ts` so that `cli.ts` can name it without pulling a state library
  onto the CLI's graph for one `instanceof`.
- `CollectionError` (`packages/content/src/collection.ts`) — a template an
  entry names that the collection's `byTemplate` declares no component usage
  for, and a collection that declares no `schema` at all (the field is
  required: a Standard Schema, or `false` to store what the loader hands over
  unchecked). Also a loader that reports an authoritative sync from
  `syncSince`, where only a full sync can have observed the whole source — the
  loader is code the site wired in, and it makes that claim on every run until
  somebody edits it. And a collection that declares neither `publishField` nor
  `unpublishField`, queried for the entries inside a publication window
  (`listDueEntries`, #36): the window a collection declares is part of its
  declaration, so a collection that declares none is the same fault as one
  that declares no schema, one field along. A collection that declares *both*
  ends, on entries whose `unpublishField` instant is at or before their
  `publishField` instant, is the same argument one field further still
  (`listDueEntries`, #283) — `listDue` ANDs `publishField <= now` with
  `unpublishField > now`, so such an entry is due at no instant at all and
  emitted no page while saying nothing. Collected across the collection under
  rule 5 rather than thrown on the first offender, because an author who
  transposed one pair has likely transposed several. Named for the collection because
  the collection's own declaration is what is at fault, and because a
  `ContentError` would read as the opposite of what it means: content that
  fails its schema is not wiring, and exits `1`.

None of the four comes right on a retry.

**A class in a package `@pagedeck/core` does not depend on cannot join them, and
does not need to.** That is the paragraph above pointing the other way:
`isWiringFault` reaches a class by `instanceof`, and core depends on no loader,
so naming a loader's own error class would invert the dependency rather than
respect it. The exit code arrives anyway, by a different door: a loader such as
`defineExampleCmsLoader` (`packages/cms-example/src/loader.ts`) validates its
options when it is *called*, and it is called while `pagedeck.config.ts` is
being evaluated, so `loadConfig` catches the throw out of its dynamic import
and rewraps it as a `ConfigError` — exit `2`,
with the loader's own sentence on the cause chain. A fault only a request can
discover stays exit `1`, correctly: that is the network and not the wiring.
`@pagedeck/search` reaches the same place by the other route, throwing
`ConfigError` itself, which rule 5 argues where `localeFaultReport` is quoted.

**`isWiringFault` reads the class of the error it is handed, and never its
cause chain.** That is the part worth getting right, because rule 4 wraps
failures and it is tempting to walk down to the class underneath.

A cause is whatever the failing code happened to be holding, and one of the
things it holds is an error a content-authored component threw: a `RenderError`
for "a component threw while rendering" attaches the component's own throw as
its cause. A walk would let a component that threw a `RegistryError` pick the
framework's exit code. That is content controlling the build, which is the same
fault issue #114 ruled on when it dropped content-minted island ids rather than
let them throw over the framework.

So a wrapper that needs to preserve a classification carries the class itself.
`runSync` in `packages/content/src/collection.ts` wraps a replay failure to
name the entry it happened on, and rewraps a `CollectionError` as a
`CollectionError` — everything else it wraps is a store or loader failure and
stays a plain `Error`. Wrap this way whenever a wiring fault can reach the
wrapper: the wrapper adds a place to look, and it must not erase whose fault it
is.

The `sync` verb reads the same predicate over the failures rule 5 collected,
since a run that reports its failures instead of throwing them still has to be
classified.

Throw `RenderError` — exit `1` — when a page will not render, or will only
render wrong: a component threw, its module has no default export, it suspended
on data the framework did not resolve, an island's props will not go into its
marker — because they do not serialize to JSON, because they use a prop name the
framework refuses such as `dangerouslySetInnerHTML` or `__proto__`, or because
they are not plain JSON data — the document composed around the render holds a
second `main` landmark (`landmarkReport` in `packages/core/src/build.ts`) or a
`main` landmark in the site's chrome (`chromeLandmarkReport` in
`packages/core/src/build.ts`), or
the render was handed a locale that is not the one the page's entry names
(`refuseMismatchedLocale` in `packages/core/src/tree.tsx`). That last one is
thrown where both paths pass rather than in `renderPage`: a preview builds its
tree with `buildPageTree` and never reaches `renderPage`, so a guard sited there
refused the wrong pairing on the build and let it through in front of the person
watching the page (#206). A
node that is not an island has no marker to go into, and a refused *name* on one
is the same class of fault for the same reason: the build spreads those props
into React, so the name is an instruction whatever else the node does or does
not do.

**"Will only render wrong" is part of the criterion, not a stretch of it.** A
page built under another language's locale does render: it produces bytes, and
the build stays green while the reader gets a right-to-left English page. That
is a render fault as squarely as an exception is, because what the class means
is that the output of this render cannot be shipped. A run that produces the
wrong page has failed to produce the page, and it fails the same way on every
retry until the call site is fixed — but not by editing `pagedeck.config.ts`, which
is what `ConfigError` would send the reader to do. The locale set is intact;
the pairing of locale and page at the call is what is wrong.

**The landmark is the one entry in that list thrown as a `ConfigError` too, and
what the class follows is the subject rather than the count.** A document
composed with two `main` landmarks is a page that renders and ships wrong, so
it exits `1` on the argument the paragraph above makes. `carryDocuments`
(`packages/core/src/build.ts`) counts the same landmarks in a document an
incremental build reads back off the tree at `outDir` instead of composing
(#455), and nothing rendered there at all: what is at fault is an input to the
run, and the run fails that way on every retry until the full build its report
names is run. One rule, two subjects, and the subject is what rule 7 reads.

`layoutContents` (`packages/core/src/layout.ts`) throws a `RenderError` too,
for an entry a layout cannot render and for a name in `frontmatter.components`
that the registry does not hold (#712). Both are entry content, and the entry
may come from a CMS. No `ContentError` exists; content that fails its schema is
a plain `Error` from `@pagedeck/content`, which exits `1` for the same reason.
A `RegistryError` or `ConfigError` here would let an author's frontmatter pick
exit `2` for a site whose config is intact, which is content controlling the
build's exit code, the fault #114 ruled on. A layout name is different: the
config writes it, so an unregistered layout is a `ConfigError` at load.

Exit `1`
rather than `2` because the registry and the config are intact — they resolved
the component, which is what the wiring is for. What failed is the component's
own code or the content the entry gave it, the same class of fault as a loader
throwing. So `isWiringFault` in `packages/core/src/cli.ts` does not name it —
and because that function does not walk causes, the wiring-fault class a
component threw and a `RenderError` carries as its cause cannot promote the
run to exit `2`.

**A bundler hook is the one place this classification used to be lost, and it
is no longer.** Rolldown flattens anything thrown out of a build hook into a
plain `Error` — the class gone, the `cause` dropped — so a `ConfigError` raised
there arrived at `isWiringFault` as something it could not name, and a site
wiring fault exited `1` (#94). Every bundler invocation a verb runs now goes
through `runBundle` (`packages/core/src/bundler.ts`), which guards each of the
framework's own hooks, records what one raised, and rethrows it once `build()`
has settled — unchanged, so the class this rule branches on and the cause rule 4
attaches both reach the CLI.
`packages/core/src/bundler-invocations.test.ts` is what keeps that the only
door: it refuses a second *non-suite* module importing `build` from `vite`, so a
new plugin cannot reach an unguarded invocation without a suite being written to
hand it one. A `*.test.ts` file may still call `build()` directly and ten do,
because a suite building its own fixture is measuring a plugin rather than
reporting to a reader; that test enumerates the exclusions, and they scope this
paragraph too.

The wrapper reports the first fault it recorded and only that one, which is this
rule winning a direct conflict with rule 5 — several errors of different classes
cannot be reported as one without flattening them, which is the fault being
fixed. A plugin that wants rule 5's collection collects in its own closure and
reports after the build, the way the island scan reports every unparseable
module in a run.

Everything else exits `1`, which means "the run did not finish" — a loader
threw, content failed its schema, a snapshot host refused, or the framework
itself has a bug. It is deliberately not a promise that a retry will help; it
only says the fault is not the site's wiring.

## 8. Write it through the run's channel, and mark it on the way out

A message follows rules 1 to 7 and still fails its reader if the reader cannot
tell it apart from the output of everything else in the process. A spawned
`pagedeck build` loads Babel and the bundler into itself, and they write to the same
stderr. Until #70 stopped compiling React's own packages, every build printed:

```
[BABEL] Note: The code generator has deoptimised the styling of .../react-dom/cjs/react-dom-client.production.js as it exceeds the max of 500KB.
```

So "did this build cleanly?" cannot be answered by asking whether stderr is
empty — a fully successful build's stderr need not be empty, and the set of tools
loaded is not something this repo controls. Issue #184 ruled that the promise
to keep is "nothing of *mine*", and rejected suppressing other people's
advisories: enumerating their prefixes is a treadmill, and they are worth
reading in a CI log. `packages/core/src/bin.test.ts` holds the passthrough: its
fixture provokes Babel's note, and the build must write it unmarked.

Two halves follow, and new code has to hold both.

**One channel.** Every diagnostic the framework produces **in a build process**
goes to the run's `io.err` (`CliIo` in `packages/core/src/cli.ts`). Nothing else
in these packages writes to `console.warn`, `console.error` or
`process.stderr` — `packages/core/src/bin.ts` is the single place the channel
becomes a stream. A message written past either is a message that keeps its
text and loses its provenance.

**Two console writes exist in the workspace, and they are two different things.**
`reportBrowserFault` (`packages/islands/src/browser-report.ts`) is a channel in
its own right: the browser has no `io.err` to write to, and this rule's closing
section argues why that is this rule rather than an exception to it. It has three
callers and one write — `reportRootProviderFault` delegates to it, the shared
store module calls it directly (#252), and `@pagedeck/search`'s island reports a query
it could not answer through it (#62) — which is the shape this half asks for,
and it is on its own rather than inside any of them because a site with no
provider stack must not carry the stack digest's machinery for the sake of one
line (#66 criterion 6), and a package outside `@pagedeck/islands` must be able to
reach it without importing a hydration runtime. The other write is a *fallback* — `mergeComponents` in
`packages/islands/src/registry.ts` ends `options.warn ?? installedWarn ??
console.warn`, and the third arm is reached only by a merge under no run and no
installed sink at all. Neither is a build diagnostic taking the short way out,
which is the thing this half forbids; count a third of either kind as the hole
#184 closed reopening.

The one call that cannot take the channel as an argument is that collision
warning in `mergeComponents`: it is written in the *site's* `pagedeck.config.ts`,
which the run imports and passes nothing to. `installRegistryWarnings`
(`packages/islands/src/registry.ts`) is how it reaches `io.err` anyway, and
`runCli` is its only caller — so under a run the `console.warn` arm above is
never taken, and what is left on it is a design system merging registries in a
process the CLI never started. Reach for the same shape only when there is
genuinely no argument to thread — a library warning from inside code the site
wrote — and restore it in a `finally`.

**A marker per line.** `bin.ts` prefixes every line it writes with
`DIAGNOSTIC_MARKER` — `pagedeck:`, exported from `@pagedeck/core`. Per line and not per
call, because rule 5's collected report is a headline plus one indented line
per failure written through one `io.err`: marking the headline alone would make
a four-fault report read as one, with the rest looking like somebody else's
output.

**A refusal has to reach the person who can act on it, and for `pagedeck dev` that
decides when it runs** (#433). A dev server that bound its port with no store
file announced itself as serving and then answered every request with a 500, so
the fix reached a browser, possibly on another device, and never the terminal of
the person who typed the command. So `startDevServer` checks that the store file
exists before the island scan and the bind, and refuses there. The check is
existence and nothing more. A file that exists and will not open still starts
the server, and each request names the store with the same fix, because
`pageHandler` reads the store per request so that a store `pagedeck sync --watch` is
rewriting is picked up without a restart.

The startup refusal is a `ConfigError`, exit `2`, as the maintainer ruled on
2026-09-24, and that sits beside `pagedeck push`'s "No store to push", which throws a
plain `Error` and exits `1` for what reads as the same absence. The asymmetry is
kept on rule 7's own test: a dev server with no store cannot answer any request
until a person runs a different verb, and retrying `pagedeck dev` fails identically
every time. This change leaves the push refusal classed as it was; whether it
should move to exit `2` as well is a question for its own issue.

**A warning follows both halves, and says why it is a warning.** The build
writes twenty-four, and each says what it cannot promise; a twenty-fifth is
written by `pagedeck sync` rather than by a build and is the last one described
below; three more are the browser's and are argued in this rule's closing
section, where they sit among the browser's refusals rather than after them.

**All twenty-four reach `io.err`, and four of them only through one verb**, and
this is the rule that has to say so, because it is the rule about the channel.
The twenty-fifth is reachable too, by the same shape through the other verb:
`syncSite` returns it on `SyncReport.warnings` and `runSyncVerb` writes it. It
is described after the twenty-four below, and kept out of their count because
`pagedeck sync` is what writes it and no build ever does. Twenty —
`resourcePlacerWarning`, `unlinkedStylesheetWarning`,
`unregisteredClientWarning`, `workerFallbackWarning`, `workerConsentWarning`,
`unloadedScriptWarning`, `undeclaredHeadersWarning`,
`undeclaredContentRootWarning`, `unprunedTreeWarning`, `absentFaviconWarning`,
`relativeCardWarning`, `checkSiteLinks`' two, `probeExternalLinks`' three, `retainManifest`'s two and
`compileIslands`' two — are collected into `SiteBuild.warnings` by `buildSite`
and written by `runBuildVerb`. All twenty are reachable; one of them was not
until #270, and its own section below records what closed it — a site's
redirects now reach `planRouting` through `build.routing`. The last two travel
one stage further to get there, and #242 is that stage: a bundler plugin has no
`io.err` to write to, so `compileIslands` records them and `buildClient` hands
them back on `ClientBuild.warnings`, which is what `buildSite` collects.

The four #29 adds, `driftWarnings`' two and `compileSupplements`' two, are
strings shaped for that same field, and #281 gave them the caller they were
waiting on: `buildSite` (`packages/core/src/build.ts`) runs `checkDrift` and
`compileSupplements` on a run given `incremental: true`, and puts both sets of
warnings into the same `warnings` list the twenty above go into. So all
twenty-four are reachable, and the four reach a reader through
`pagedeck build --incremental` and through nothing else — a full build cannot drift by
construction, since the class manifest it would check against is the one it is
writing, so it makes no plan, takes no check and produces none of these four.
That is the protocol rather than a gap.

`drift.build.test.ts` is where the text below is read off a real build's stderr,
which is what the top of this document promises of every message in it;
`drift.test.ts`, `supplement.test.ts` and `supplement.build.test.ts` still
execute each one where it is written.

The first is the weaker half of the refusal in
rule 3:
`resourcePlacerWarning` (`packages/core/src/island-facts.ts`) reports a module
in a `"use client"` closure that imports `preinit` or `preinitModule` from
`react-dom`. `preinit` places a stylesheet from *code*, so a call made from an
effect leaves nothing in the emitted HTML for the byte scan to refuse, and the
import specifier is the only anchor a build has — one a re-export or an alias
defeats. The message states that limit rather than reading like a rule the build
can hold, because a reader who trusted it as one would be trusting a promise the
build cannot keep:

```
Island scan: 1 module in a "use client" closure imports preinit or preinitModule from react-dom — a preinit call places a stylesheet past the <head> tiers the build owns, which the build refuses when the rendered HTML shows it; this is a warning and not a refusal because a call made from an effect leaves nothing in the HTML to see, and an import reached through a re-export or an alias leaves nothing here to see either:
  "/site/components/Copy.js" — preinit
```

It reaches `io.err` the same way every refusal does, and by the same route as
every other answer the island scan gives: `scanIslandFacts` returns it as data
on `IslandFacts.warnings`, `buildSite` passes it out on `SiteBuild.warnings`,
and `runBuildVerb` writes it — before the success line, so a reader meets the
caveat above the summary. `buildSite` takes no `CliIo` on purpose, so the verb
is where a diagnostic becomes a line.

The second is `workerFallbackWarning` (`packages/core/src/scripts.ts`), on the
same channel and by the same route (#46). It is a warning for the opposite
reason to the one above, and later warnings lean on its argument: not because
the build cannot see the fault, but because it can see it exactly and the
output is still correct, and refusing would fail a build nobody can fault.
Core defines the `worker` strategy and deliberately ships no mechanism to move a script off the main thread — the mechanism is
`build.scripts.runtime`, an adapter the site supplies — so a site that declared
`worker` and configured none loads those scripts on `idle` instead, which is the
fallback spec §12 states.

```
Script runtime: 2 scripts can resolve to the worker strategy and this site configures no script runtime, so each of them loads on idle instead — worker moves a script off the main thread, and core ships no mechanism to do that with because a framework that picked one would carry a vendor's runtime into every site that never asked for it; this is a warning and not a refusal because idle is the fallback spec §12 states for this case, and a site that did not want off-main-thread loading is served correctly by it — supply build.scripts.runtime, or declare strategy: "idle" to say the fallback is what you meant:
  "analytics" — declares no strategy, so it takes the worker default
  "pixel" — pageTypes "/blog/**" sets "worker"
```

Not a refusal, because the config is well formed and the fallback may be exactly
what the site wanted — `worker` is the default a site gets for saying nothing,
so refusing would fail every build that never thought about the field. Not
silence either, which the ruling on #46 named specifically: a site that
configured a strategy and quietly did not get it has no way to find out.

**Once per build, and the scope is the reason it can be.** `runtime` is one
field on one config, so the question the message answers is asked once; a line
per script per page would be the same sentence repeated down a route table.
That costs a precision the wording is careful about — it says a script *can*
resolve to `worker`, which is decided from the settings alone, rather than that
one did on some page, which would need the route table and still produce one
message. Each line says which door the script reaches `worker` through, and a
script reachable through more than one is named once. No `src` is quoted, which
is the field rule 6 would have to reach.

The third is `workerConsentWarning` (`packages/core/src/scripts.ts`), the same
argument one issue later and over a second reason the same fallback applies
(#47). A script that declares a consent category is gated by the loader this
build writes, and a `worker` script is not loaded by that loader at all — it is
loaded by the elements `build.scripts.runtime` returned, which core owns nothing
about by construction. Loading it there would be loading it with no gate, so the
build does not: the script takes `idle`, and this says so.

```
Script consent: 2 scripts declare a consent category and can resolve to the worker strategy, so each of them loads on idle instead — the consent gate this build writes lives in the loader that backs the main-thread strategies, and a worker script is loaded by the elements build.scripts.runtime returned, which core never reads, so leaving it there would load a categorized script with no gate on it at all; this is a warning and not a refusal because idle is the fallback spec §12 states for a worker script this build cannot deliver, and it is the strategy the gate does reach — declare strategy: "idle" to say the downgrade is what you meant, or drop the category and gate the script inside the adapter, which is the only place a worker script can be gated:
  "analytics" — category "marketing" — declares no strategy, so it takes the worker default
  "pixel" — category "analytics" — pageTypes "/blog/**" sets "worker"
```

Not a refusal, because the config is well formed and `idle` is a documented
fallback that serves the site correctly — refusing would fail a build this
framework knows how to make right, which is `workerFallbackWarning`'s position.
Not silence either: the site declared a strategy and did not get it, which is
the one thing rule 8 will not let a build keep to itself. Both fixes are in the
sentence, because which is right depends on something no build can know — a site
whose own adapter gates for it drops the category and keeps `worker`, and a site
that wanted core's gate writes the strategy it now has.

**It is mutually exclusive with the warning above, and that is the point rather
than a coincidence.** A site with no `runtime` has *every* `worker` script fall
back to `idle` already, and the warning above has named these same scripts for
that reason — saying it twice about one script would be two paragraphs for one
edit. Only a site that configured a runtime hears this one. The scope, the
ordering of the doors and the name-once rule are `workerReachingScripts`' and
are shared with it in code, so the two cannot come to describe the same config
differently.

The fourth is `unloadedScriptWarning` (`packages/core/src/scripts.ts`), the
third of the script layer's and the one of the three that is not decided from
the config alone (#345). An override map can set a script to `"off"`, which
takes it off the pages its key covers; a key that covers every page the site
builds leaves a declaration nothing acts on.

```
Script reach: 2 scripts resolve to "off" on every page this site builds, so no page loads any of them — this site builds 4 pages, and an override takes a script off every page its key covers, so a key that covers them all leaves a declaration nothing acts on while it still reads in the config like a script that loads; this is a warning and not a refusal because every field of the declaration is well formed and a site mid-migration may have taken a script off every page on purpose — drop the declaration from build.scripts.scripts, or narrow the override that takes it off so at least one page keeps it:
  "analytics" — pageTypes "/**" sets "off"
  "pixel" — pageTypes "/**" sets "off"
```

Not a refusal, on the two warnings above's argument: every field is well formed,
this build knows exactly what to do with the config, and a site mid-migration may
have taken a script off every page on purpose for one release. Not silence
either, and here the silence would be total — the declaration reads like a
script that loads, the override reads like a narrowing, and what the emitted
documents show is an *absence*, so a mistyped script name in an override and a
key that covers more pages than its author thought both look exactly like a
script that works.

**It reads the route table, which is what separates it from the two above.**
Those name the scripts that *can* resolve to `worker`, from the settings alone.
This one cannot be written that way: whether a key covers every page is a fact
about the pages, so a site whose only `"off"` key is `"/blog/**"` has dead config
exactly when every page it built is under `/blog/`, and no reading of the map
alone tells those two sites apart. It is still one message per build rather than
one per page, for the reason the two above give. A site that builds no pages
names no script at all — every declaration would resolve to `"off"` vacuously,
and the edit that fixes an empty route table is in neither `scripts` nor the
override maps.

**The count is of the route table and the sentence says so**, which is what
keeps it true on `pagedeck build --incremental`: that build re-renders a subset and is
handed the whole table anyway, because "does this script reach any page" is a
whole-site question, so a message counting the pages this run rendered would be
false on exactly the build that renders fewest.

`pagedeck dev` reports the two above and not this one, and that is the protocol rather
than a gap: it renders one page per request, so the widest question it could ask
is whether *this* page loads the script — which is not this question, and a page
carrying no scripts is the ordinary outcome the feature exists to produce.

Rule 5 lists every script and puts the overrides on the line, because the name
alone sends a reader back through two layers by hand; a script taken off page by
page names every key that did it, since dropping one of several is half an edit.
The lines are sorted and so are the keys on each of them, so two builds of one
site write one stderr (spec §11) — `checkSiteLinks`' reason above, over an order
that would otherwise come from the config and from the route table. No `src` is
quoted, which is the field rule 6 would have to reach.

The fifth is `undeclaredHeadersWarning` (`packages/core/src/routing.ts`), the
last of the ones decided from the config alone and the only one whose subject is
an *absence in the emitted output* rather than a downgrade inside it (#318).
`build.routing.headers` is wholly author-written and core supplies no default,
so a site that declares no rule gets no `_headers` file, no nginx `add_header`
block and no CloudFront viewer-response function at all — and a generated site
has no server of its own to add one later, which makes that field the whole
surface.

```
Security headers: this site declares no header set, so no response its output serves carries one — build.routing.headers is the only place a generated site can put a response header, and with the field absent no _headers file, no nginx add_header block and no CloudFront viewer-response function is emitted at all; this is a warning and not a refusal because every page this build emitted is correct and a host that already sets these headers would be handed duplicates by a default nobody wrote — spread SECURITY_HEADERS into the set of a rule over "/", which is these three, or declare a set of your own to say the host is doing it:
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
```

Not a refusal, on `workerFallbackWarning`'s argument: the pages are
correct, and a site whose CDN or reverse proxy already sets these headers has
nothing at all to fix. **Not a default either, and that is the half this one has
to state**: emitting the headers anyway is the fix that suggests itself, and it
would hand that same site each header twice, from two places, one of which its
config does not show. So the framework takes a posture and the site opts into
it — `SECURITY_HEADERS` is data next to `HeaderRule`, inert until a `set`
spreads it — which is what makes the fix one line without making it automatic.
Not silence either, and the silence here would be total for rule 8's own reason:
the absence produces no artifact, so there is nothing a reader can open that
distinguishes "never asked" from "answered one layer out".

**Any rule at all ends it, whatever that rule carries.** A site whose only
header is a `Cache-Control` on `/assets/` gets silence. Grading a declared set
against a list of names the framework would have preferred is the silent default
arriving by another door — it would make the build the judge of a posture the
site already took — and no reading of a header table says whether the missing
half is set by the host. The question asked is the one that can be answered:
did anybody take the question.

**The fix names the constant rather than describing it**, rule 3, because the
constant *is* the edit. The three indented lines are the offer and not a
collected report, which is the one place a message in this document departs from
rule 5's shape: there is exactly one fault and the headline states it, and what
the lines carry is what the author would be spreading, so the decision can be
made without opening the source. Rule 6 reaches none of it — three fixed names
and three fixed values, none of them the site's.

Two headers are deliberately not in that constant, and the reference page at
`packages/docs/reference/routing.md` carries both arguments in full.
`Strict-Transport-Security` is left out because a browser told once to refuse
plain HTTP keeps refusing, so a site not yet fully on HTTPS — or one sharing a
domain — can lock itself and its siblings out, and none of that is knowable from
anything a build reads; a value spread unread may not be able to do that.
`Content-Security-Policy` is left out because a page whose script layer this
build composes has no policy correct by default. #315 settled the other half of
that story without a header: each page's manifest row records the inline script
loader's CSP hash, and the site writes the policy that uses it.

`pagedeck dev` does not report it, and unlike the fourth's case that is not a question
it could ask badly — it is a question with no subject there at all. That server
answers requests itself and emits none of #33's three artifacts, so a site with
no header set is missing nothing yet.

The sixth and seventh are `driftWarnings`' (`packages/core/src/drift.ts`), and
they are the two paragraphs of one report — spec §9's drift protocol, #29. An
incremental build extracts the classes of the pages it re-rendered and checks
them against the class manifest the last full build recorded and against the
safelist the site declared; a class neither set holds is a class no stylesheet
covers, which spec §9 says "is always a safelist gap or content-hygiene bug".

The declaration is why the report names two causes and not one. `build.safelist`
carries every place spec §9 says a class may come from — a CMS-exposed styling
option, and a class a component states in its own source (#260, #261) — so a
class outside both it and the manifest is either a place the site forgot to
declare or the invariant broken outright. Naming both is rule 3's: the two have
different edits.

```
Class drift: 2 re-rendered pages use classes the last full build's class manifest does not hold — spec §9's invariant is that classes derive from code and never from content, so a class in rendered HTML that no recorded class covers is either a class this site's code states and the site's declared "build.safelist" does not — a CMS-exposed styling option, or a class a component writes for itself — or a component writing a class name out of a content value; check "build.safelist" for the option the source entry below sets and for the components that entry renders, then read those components. This is a warning and not a refusal because the supplement spec §9 inlines into each page below leaves that page correctly styled and the site's stylesheets byte-identical:
  en /pricing — "bg-lime-300", "text-lime-900" — own entry "pages en pricing"
  de /pricing — "bg-lime-300" — dependency "globals en nav"
```

Every drifted page and every missing class on each (rule 5), because a safelist
gap reaches every page rendering the component it belongs to, and a report
naming one of them is as many build loops as the site has sections. Rule 2's
field is the **source entry**: each line names what put that page in the render
set, read off `AffectedPage.reasons`, and a page in it for several reasons names
all of them joined with `; ` rather than having one picked for it. A page
re-rendered for a *structural* reason has no entry to name and says so, which is
§2's `(whole entry)` one document along:

```
  en /pricing — "bg-lime-300" — no source entry: the route table holds this page and the previous manifest does not
```

A class name is quoted whole, and it is rule 6 read at what the value is. The
case this report exists for is a component writing a class out of a content
value, so the class *is* content by construction — §2's boundary, where a
content value goes into the log the site's own content is built from — and it is
the whole diagnosis besides: naming a position instead would send a reader to
search a page for a class the message declined to spell.

Not a refusal, on `workerFallbackWarning`'s argument: spec §9 inlines a
supplement into each drifted page, so the emitted pages are correct and
`core.css` is byte-identical, and refusing would fail a build whose output
nobody can fault. Not silence either — drift is a bug every time, and the report
is the only thing that says a safelist has stopped covering the site.

The seventh is the threshold breach, a second paragraph rather than a line under
the first, on `loadComponents`' argument: the fix above is a safelist or a
component, and the fix here is a build to run.

```
Class drift: 6 pages drifted and "build.driftThreshold" allows 5, so this build's manifest records a full rebuild request — an incremental build carries the previous build's class manifest forward rather than re-extracting it, so every class above drifts again on every incremental build until a full build records it, and each of those builds inlines the same supplement into the same pages. This is a warning and not a refusal because every page this build emitted is correct: the request is the manifest's "fullRebuild" field, and spec §9 leaves scheduling the rebuild to the site's CI — run a full pagedeck build, and fix the safelist gap or the component the lines above name.
```

Once per build, and the scope is `workerFallbackWarning`'s reason: the
threshold is one field on one config compared against one count, so the question
is asked once however many pages drifted. The message names the field, both
numbers and the manifest column, because the thing it is reporting is a *record*
this build wrote — `Manifest.fullRebuild`, which carries why a rebuild is needed
and not merely that one is, so a deploy stack holding the manifest alone can act
on it.

The eighth and ninth are `compileSupplements`' (`packages/core/src/supplement.ts`),
and they are the other half of the same protocol — spec §9's step 1, the
supplement inlined into each drifted page. The framework compiles nothing: no
source of it names a CSS toolkit (`CONTEXT.md`), so `build.driftSupplement` is
the site's compiler, handed one page's missing classes and returning a
stylesheet covering them. Each warning is one way that seam can produce no
supplement, and each is loud because the page it is about is the one thing this
protocol cannot make right on its own.

The eighth is the seam left undeclared. It is the case the drift warning above
cannot cover: that one calls drift a warning *because* a supplement leaves the
page correctly styled, which is a promise nothing keeps when there is no
compiler to make one with.

```
Class drift: 2 drifted pages have no supplement, because this site declares no supplement compiler — spec §9 inlines a stylesheet holding only the missing rules into each page below, and this framework names no CSS toolkit to compile one with, so the compiler is the site's to declare; without it each page below ships the classes it drifted on with no rules behind them, which is a page that renders unstyled where those classes are used. This is a warning and not a refusal because a site whose CSS is hand-written has no compiler to declare and the fault is the drift itself — fix the safelist gap or the component the drift report names, or declare build.driftSupplement, as driftSupplement: (classes) => compile(classes):
  en /pricing — "badge-rogue"
  de /pricing — "badge-rogue"
```

Not a refusal, on `workerFallbackWarning`'s argument plus one this field has
of its own: a site whose CSS is hand-written has no compiler to declare and never
will, so refusing would turn every content-hygiene bug on such a site into a
failed build with a fix its author cannot take — and the pages the build emitted
are the pages it would have emitted anyway. Not silence either, because an
unstyled element is the one defect a reader cannot see from a green build. Both
fixes are in the sentence for `workerConsentWarning`'s reason: which is right
depends on something no build can know — a site with a toolkit wires the seam,
and a site without one fixes the class.

The ninth is the seam declared and answering with nothing. A second paragraph
rather than a line under the first, on `loadComponents`' argument: this site
*has* wired the seam, so "declare a compiler" is not its fix, and what an empty
answer means is that the compiler does not generate these classes.

```
Class drift: 1 supplement compiled to no rules, so each page below ships the classes it drifted on with no rules behind them — "build.driftSupplement" was handed those classes and returned a stylesheet holding nothing, which is what a compiler answers about a class it does not generate: a name somebody typed by hand, or a safelist the toolkit was never told about. This is a warning and not a refusal because the page renders and only the rules for these classes are missing, and an empty answer is the compiler's rather than a fault in this build — fix the safelist gap or the component the drift report names, or generate rules for these classes:
  en /pricing — "badge-rogue"
```

A stylesheet of whitespace is the same answer as an empty one and is reported on
the same line: it covers no class, and an element holding it would be bytes on
the page for the compiler having had nothing to say. Every class is quoted whole
on both, `driftWarnings`' reason — the class is content by construction here, and
it is the whole diagnosis.

**Three refusals sit under the same field, and none is a warning.** A compiler
that *throws* stops the pass on the first one, with the throw attached as the
cause (rule 4) rather than collected — rule 5's own boundary, the one
`collection.ts` draws over a validator that throws: the remaining pages would be
measured with a broken instrument. A plain `Error` and exit 1, the class a
loader's throw takes (rule 7): the wiring is intact, the field is a function and
it was called, and what failed is the site's own code running.

```
Class drift: the supplement compiler threw on en /pricing — "build.driftSupplement" is called with the classes one page used that the last full build's class manifest does not hold, "badge-rogue" here; fix the compiler, or fix the safelist gap or the component the drift report names so the page does not drift
```

The second is a compiler that answers with something that is not a stylesheet,
refused on the spot because a `.js` config is never typechecked and the value is
checked where it is used. The kind is named and the value never quoted (rule 6):
a compiler's output is the site's own CSS, and the kind is the whole diagnosis —
the mistake it catches is a compiler that forgot to return, whose own failure is
a `TypeError` on `undefined` naming no page and no field. A `ConfigError` and
exit 2, and **not** the exit 1 the throw above takes: rule 7's criterion is
whether the fault comes right on a retry, and a declared function that returns a
number returns one on every run until somebody edits it. The throw is the other
side of that line — a compiler that failed once failed while *running*, which is
what a loader's throw is — so the two sit apart by the criterion rather than by
which line of this function noticed them.

```
Class drift: the supplement compiler answered with undefined on en /pricing, and a supplement is a stylesheet — return the CSS covering the classes it is handed, as driftSupplement: (classes) => compile(classes)
```

The third is `inlineStyleElements`' `</style` refusal over the other kind of
inlined sheet, collected over every page and thrown once, with the position
named rather than the bytes quoted for that message's reasons exactly. A
`ConfigError` and exit 2, the class the refusal above takes and for the same
reason: the same compiler answers the same way on every run until somebody edits
it.

```
Class drift: 1 supplement cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup — return a stylesheet with no "</style" sequence in it, or fix the safelist gap or the component the drift report names so the page does not drift:
  en /pricing — "</style" at line 1, column 23
```

The tenth and eleventh are `checkSiteLinks`' (`packages/core/src/links.ts`), and
they are the two halves of issue #31's reference check: a document names a route
or a file, and this build knows which of them it emitted.

The tenth is the broken half, and it is a warning **only** where the site asked
for one. `build.links` defaults to `broken: "error"`, which is the refusal the
build already made over a `<script src>` naming a file nothing emitted (#56), so
the paragraph below is what a site declaring `broken: "warn"` gets instead of
that throw — same sentence, same lines, with the reason it is not a refusal
appended. The setting is named in the text, because a reader meeting a warning
about a page that points at nothing should be able to see why the build went on:

```
Site build: 2 references name nothing this build emitted — check each against the page or the file it should name: an asset URL and its file name are minted at two stages (see chunkPath in client-build.ts), and a route is served only where a page renders one. This is a warning and not a refusal because "build.links" declares broken: "warn":
  en / — "/apple"
  en / — "/zebra"
```

One paragraph over both kinds of reference, and the fix carries both edits: an
href that resolves to no page and a URL that resolves to no file are one
question to a reader — "what does this point at" — and the document does not say
which of the two an author meant. The page comes first on each line and the
lines are sorted, so one page's references sit together and two builds of one
site write one stderr (spec §11).

The eleventh is the redirected half, and it is a warning **at either setting**,
which is issue #31's second acceptance criterion in as many words: a link that
resolves through a redirect works, so there is nothing for a refusal to be right
about. What it costs is the hop, so the line carries the direct target — the
whole of what a reader does about it — beside the page and the href:

```
Site build: 1 reference resolves through a redirect — point it at the target on the line below, so a visitor's first request is the page rather than a hop. This is a warning and not a refusal because the redirect works and the page it lands on is one this build emitted:
  en / — "/old" → "/about"
```

**No build produced that paragraph until #270, and the reason was wiring rather
than absence.** `buildSite` called `planRouting` with no `config` and no field
of `BuildSection` carried one, so the routing document a real build handed the
check held no redirects at all — the warning was implemented, unit-tested and
unable to fire on any site in the world. `build.routing` is the field that
closed it, and the day it landed this paragraph started appearing with no change
to the wording above. It is asserted in two places for two reasons:
`packages/core/src/links.test.ts` composes the report, which is what keeps the
text above text this repo produces, and
`packages/core/src/routing.build.test.ts` builds a site that declares a redirect
and links its `from`, and reads this line off a spawned `pagedeck build`'s stderr —
beside the same corpus with the rule removed, which is refused as a broken
reference instead. Both paragraphs are skipped whole, along with the walk that
would produce them, by a site declaring `links: { broken: false }`.

The twelfth, thirteenth and fourteenth are `probeExternalLinks`'
(`packages/core/src/links.ts`), and they are the opt-in half of the same check:
the absolute `http:`/`https:` URLs a site's pages link, asked about one at a
time through a probe the site declared (`build.links.external`, spec §13).

**None of the three is ever a refusal, and that is this door's decision rather
than a gap.** What they measure is a host nobody in the build controls, and
rule 7's question — does the fault come right on a retry — answers *yes* for
every one of them: a 503, a timeout, a runner behind a firewall. A build that
failed on those would fail on a Sunday for a reason no reader can act on and
whose fix is to run it again. The `broken` setting governs references into this
site and does not reach here.

The twelfth is a URL that answered. Under 400 is silence; 400 and over is a
line, with the status the probe returned and every page that links it:

```
Site build: 1 external reference answered with a status a reader will not see the page at — check the link, or the host behind it; this build asks each URL once and takes the status its probe answers with. This is a warning and never a refusal, because a host this site does not control is not this site's wiring and the same URL usually answers on the next run:
  "https://example.com/moved" — 410 — linked from en /
```

The thirteenth is a URL the probe *threw* on, and it is a separate paragraph
because it has a separate fix: a timeout, a DNS failure and a proxy refusing the
request are how a network says nothing, and none of them says the link is
broken. The thrown value is quoted on the line rather than attached as a cause,
rule 4's own boundary for a report that collects — several hosts can fail in one
run, and two causes cannot both be the cause.

```
Site build: 1 external reference could not be checked, because the external link probe this site declared threw — the fault is the network, the host or the probe's own client rather than the page, so nothing here says the link is broken. This is a warning and never a refusal, because a build whose success depends on another host's uptime fails on a Sunday for a reason no reader can act on:
  "https://example.com/slow" — Error: ETIMEDOUT — linked from en /
```

The fourteenth is what the build did not ask about. Requests are sequential,
paced by `build.links.external.intervalMs`, and bounded in number by
`build.links.external.limit`, so a site with more URLs than the limit gets an
answer about some of them — and silence about the rest would read exactly like a
pass:

```
Site build: 1 external reference was not checked, because this build reached the 2 requests "build.links.external.limit" allows — raise the limit, or read this as the check having stopped rather than as a link that answered:
  "https://example.com/c" — linked from en /
```

Every URL on these three lines is quoted through `quote`
(`packages/core/src/quote.ts`) and so is cut at its `?` or `#` — rule 6, and
this is a field where it bites: an outbound link in a CMS field is exactly the
string that carries somebody's tracking token or a signed asset URL. The one
string this build does not compose is cut too: a probe's thrown message is the
site's client talking, and `fetch` embeds the request in its own message, so
every `http(s)` run inside it is cut the same way before the line is written
(`describe`, `packages/core/src/links.ts`).

**One refusal sits under this field and it is the site's own function**, on the
bargain CONTEXT.md records for `build.driftSupplement`. A probe answering with
something that is not an HTTP status is a declared function returning the wrong
kind on every run until somebody edits it, so it is a `ConfigError` and exit 2 —
while a probe that *throws* is the warning above rather than a stopped pass,
because a throw here is the network and not the code.

It is collected and thrown after the pass rather than from inside it (rule 5).
A probe that answers wrongly once usually answers wrongly for every URL, so
stopping at the first would reveal them one build at a time and leave the rest
of the site's URLs unasked:

```
Site build: the external link probe answered with something that is not an HTTP status 2 times — return the status code the request came back with, as probe: async (url) => (await fetch(url, { method: "HEAD" })).status:
  "https://example.com/a" — answered "200"
  "https://example.com/c" — answered NaN
```

What a refusal costs, here as everywhere in this build, is the warnings the same
run collected: `buildSite` returns them and a throw returns nothing. That is the
shape of a refusal rather than a fault in this one.

The fifteenth is `retainManifest`'s (`packages/core/src/retention.ts`, #32),
and it is about a directory rather than about the site, as the twentieth
below is too: a document in the retention store that this `pagedeck` cannot read, removed rather than kept.
`listRetainedManifests` skips such a file instead of throwing over it, because
its two callers want the newest id and the deletion list and neither needs to
understand an old document — throwing would make the first build after a
`MANIFEST_VERSION` bump refuse, so a `pagedeck` upgrade would brick every build of
the site and the only fix would be deleting a directory the site was never told
exists. `readRetainedManifest` keeps the refusal, because rolling back *to* a
document this build cannot read has to fail.

```
Retention store: 1 retained manifest could not be read and has been pruned — a build reads the store to record its own parent and to prune by the site's keep count, and a document this pagedeck cannot read answers neither; ignore this once after a pagedeck upgrade, or pin one pagedeck version across CI and local if it returns on every build:
  Manifest "/site/.pagedeck/manifests/9e1f4a02.json": is version 10, and this build reads version 11 — upgrade pagedeck, or read a manifest this version wrote
```

**The case that makes it a diagnostic rather than silence is not the upgrade.**
An upgrade clears the store once, and a reader told nothing loses little. Two
`pagedeck` versions building one site — a CI image that moved while a developer's did
not, one workflow pinning a version and another taking the release — clears it
on every run for ever, and the symptom is a store that is always one build deep
and a rollback that never reaches past yesterday. Nothing else in the run says
so: the build writes a correct site and exits `0`.

Rule 5 lists every file rather than a count of them, because a store carried
across an upgrade holds one per retained build. Each line is the read's own
failure message, which is `readManifests`' shape in `cli.ts` and is what tells
the two failures apart — a document an older `pagedeck` wrote and a file that is not
JSON at all send a reader to different places. It is appended after everything
`stageSite` collected, last in the list: the store is written after the tree, so
the fault is not known until every warning about the site itself already is.

The sixteenth is `misfiledWarning`'s (`packages/core/src/retention.ts`, #312),
and it is the other thing a run can find in that same directory: a document
whose file name and whose `build.id` disagree. Only `retainManifest` writes the
store and it writes each document to `fileOf(root, id)`, so the two agree in
every file a `pagedeck build` produced — a pair that disagrees was written by hand.

It is counted as its own warning on this rule's convention rather than as a
second paragraph of the fifteenth, which is the same convention `driftWarnings`'
two and `compileSupplements`' two are counted on: what is numbered here is a
message a reader can meet — its own subject, its own fix, its own reason for
being a warning — and not the value it travels in. `retainManifest` returns the
two joined by a blank line, so they reach `SiteBuild.warnings` as one entry and
`runBuildVerb` writes them in one call. That is why the collected count above
says `retainManifest`'s **two**.

```
Retention store: 1 retained manifest is filed under a name that is not its build id — pagedeck build writes each document to "<build id>.json" and reads it back by that id, so a document filed elsewhere is unreachable by rollback and was written by hand; rename the file to the name its own build id spells, or delete it — and if that id cannot itself be a file name, mint the build id as a name a path can hold, such as a uuid, and file the document under that:
  "/site/.pagedeck/manifests/planted.json" — the build id is "../../../victim", and the file is still in the store
```

```
Retention store: 2 retained manifests are filed under names that are not their build ids — pagedeck build writes each document to "<build id>.json" and reads it back by that id, so a document filed elsewhere is unreachable by rollback and was written by hand; rename each file to the name its own build id spells, or delete it — and for any id that cannot itself be a file name, mint the build id as a name a path can hold, such as a uuid, and file the document under that:
  "/site/.pagedeck/manifests/backup.json" — the build id is "9e1f4a02", and the file is still in the store
  "/site/.pagedeck/manifests/planted.json" — the build id is "../../../victim", and the file has been pruned by this build
```

**It is a warning rather than the refusal issue #312 asked for**, and the reason
is what the fix did to the fault. The prune used to compose a path from the id
inside each document, so a planted `"../../../victim"` deleted a file outside
the store — and deleted it again on every build, because the planted document
was never the file that prune unlinked. The prune now unlinks the name `readdir`
gave it, so no id read off disk reaches a path and there is no traversal left to
refuse. A refusal would fail the build *before* the prune, which leaves the
planted document in place to fail the next build the same way: the
self-perpetuating half of the fault kept, with a bricked build where a deleted
file used to be. So the build finishes, the count removes the document when its
turn in the order comes, and this line says what was found.

Every misfiled document and not only the ones a run pruned (rule 5). One inside
the keep window is the same fault with a longer life, and it has a consequence
of its own: `runBuildVerb` stamps the newest document's id as the next build's
`parent`, so a misfiled newest makes every later build record a parent no
rollback can reach. Both the file and the id are named (rule 2), because the
whole fault is that they disagree and neither of them alone says so.

**Each line says whether the file is still there**, which the fifteenth settles
in its headline instead — it prunes every document it reports, so "and has been
pruned" is true of all of them. Here it is true of some: a misfiled document
past the keep count went with this build's prune and one inside the window is
on disk, both are reported, and a single headline could only be right about one
half. Rule 3 is why it matters rather than tidiness: the fix below starts with
an edit to a file, and sending a reader to rename or delete one this build has
already unlinked is a fix that cannot be carried out.

**The fix is a rename and not a new id**, which is where this message parts from
the refusal in rule 7 that shares its store. That one answers "this id cannot be
a path", so a new id is the whole of it. Here the id is usually fine — a
document called `backup.json` whose `build.id` is `9e1f4a02` needs the file
renamed to `9e1f4a02.json` and nothing minted — so the rename leads, and minting
is kept for the subset where the id genuinely cannot be a file name, which is
the only case where renaming the file to it would not work. The clause is
written in a singular and a plural form (`MISFILED_FIX.one` and `.many`, on
`MISSING_ID_FIX`'s shape in `tiers.ts`), because a subject counting several
documents followed by "rename the file" tells a reader to fix one of them.

**Both interpolated values pass through `printable`** (`packages/core/src/exit.ts`),
and so does every line of the fifteenth. Neither value is the site's: the file
name is what `readdir` answered with and the id is bytes out of a document
`readManifest` checks for types and not for content — the same document this
message exists to say was written by hand. `bin.ts` marks per line, so a
`build.id` holding a newline would forge a line carrying `pagedeck:` and a carriage
return with an erase-line escape would take that marker off the line already
written; a planted document could otherwise write whatever it liked into a build
log as this framework's own diagnostic. Every control character becomes `U+FFFD`
instead. That is not rule 6, which is about a value that should not be printed
at all; it is about a value that must not be able to stop being a value.

The seventeenth and eighteenth are `bailoutWarning`'s and `crashWarning`'s
(`packages/core/src/react-compiler.ts`, #106), and they are the two things React
Compiler can say about a module the client build compiled: it refused a
component over a rule, or it fell over on one. Both leave the same output — the
component the author wrote, rendering correctly and memoizing nothing — so a
reader who is not told cannot tell either event from a component there was
nothing to do for, and the two need opposite responses.

The seventeenth is the bailout. The compiler's own `reason` names the rule and its
`description` states the fix, so both are quoted rather than paraphrased, and
the closing sentence is what makes the loss visible at all. The line below is
`packages/core/src/react-compiler.test.ts`', which pins it character for
character off a build of a component that writes to its props:

```
Module "/site/components/Title.tsx" line 3: React Compiler skipped component "Title" — This value cannot be modified: Modifying component props or hook arguments is not allowed. Consider using a local variable instead. It renders as written, without automatic memoization.
```

The eighteenth is the crash, and the wording is the whole of what separates it
from the line above: one is a rule to accept or rewrite around, the other is a
compiler bug to report. Only the first line of the thrown error is quoted, rule
6's reason — the rest is the compiler's own stack under absolute paths from
whatever machine ran the build. The line below is
`packages/core/src/react-compiler.harness.ts`', which provokes a real crash by
exhausting the stack and therefore runs under
`pnpm test:compiler-crash-harness` rather than under `pnpm test` — `AGENTS.md`
gives the placement and the trigger to re-measure on.

```
Module "/site/components/Chart.tsx" line 2: React Compiler crashed on component "Chart" — RangeError: Maximum call stack size exceeded. That is a fault in the compiler rather than a rule the component broke, so report it as a React Compiler bug; "use no memo" does not silence it, because the crash is logged whether or not the directive is present. It renders as written, without automatic memoization.
```

Neither is a refusal, on `workerFallbackWarning`'s argument: the compiler's
`panicThreshold` is left at its default, which does not throw, and failing a
site's build over a memoization it can do without would fail a build whose
output nobody can fault. Not silence either, which is the whole reason these
exist — a bailout is invisible from a green build and from the emitted bytes
alike. A bailout inside a dependency *is* silent, and that is the one narrowing:
the author cannot edit the component, so the line would be noise. A crash is not
narrowed, because reporting a compiler bug needs the module named rather than
editable (`isAuthored`).

One entry per event, in module id order with each module's own events in the
order the compiler raised them, so a reader can diff one build's stderr against
the next; `compileIslands` sorts, because Rolldown transforms modules
concurrently and recording order is the scheduler's.

**Until #242 these two were the exception to this whole rule**, written through
Rolldown's `this.warn` and so reaching stderr unmarked. The move costs two
things. A reader hears of a bailout after the build rather than while its
module compiles, which every warning on this route already pays. The other
belongs here, because it is about this channel: a
build that *fails* after a bailout now says nothing about it, since
`SiteBuild.warnings` is written by a run that finished and `this.warn` printed
as it went. That is rule 5's boundary rather than a gap — a stopped run's later
readings were taken with a broken instrument — and the bailout is still there on
the next green build. `packages/core/src/bin.test.ts` is where the marked line
is read off a spawned `pagedeck build`, over a site whose one component the compiler
refuses for a different rule than the one quoted above: the line is marked, the
build still exits 0, and no unmarked copy of it reached the descriptor.

The nineteenth is `undeclaredContentRootWarning` (`packages/core/src/build.ts`),
and it is the silent half #474 left behind (#485). A site that declares
`build.passthrough.contentRoot` has every content-relative reference resolved,
and refused where it names nothing. A site that declares no content tree ships
the same reference as written, with nothing published at the address it
reaches, and before #485 nothing said so. The build now collects those
references with the same call the refusal reads, and reports them:

```
Passthrough: 2 content-relative references resolve to nothing this build publishes, because this site declares no build.passthrough.contentRoot — a content-relative reference resolves against the address its page is served at, and the file it names is published from the content tree that key declares, so without it each page below points at an address nothing in this build emits; this is a warning and not a refusal because the host may serve these files from somewhere this build never reads — declare build.passthrough.contentRoot as the directory these files sit beneath, and the build publishes each one and refuses any that is missing:
  en /posts/ferry — "../../assets/images/ferry/logo.png" → "/assets/images/ferry/logo.png" — content entry "posts en posts/ferry"
  en /posts/json-bonsai — "../../assets/images/json-bonsai/query.png" → "/assets/images/json-bonsai/query.png" — content entry "posts en posts/json-bonsai"
```

Not a refusal, on `workerFallbackWarning`'s argument: the config is well formed,
and this build cannot know that nothing serves these addresses, because a host
can hold files the build never reads. Refusing would fail a site for a key it
never declared. Not silence either, because a dead `<img>` on a green build is
exactly the defect #474 was filed about. Each line is the refusal's own line
(`contentReferenceLine`, `packages/core/src/build.ts`): the page, what it wrote,
the address it reaches and the content entry it is written in, one line per
address, in address order. So two builds of one site write one stderr, and a
reader who declares the key finds the refusal's lines where the warning's were.

Once per build. The subject is one field the site left empty, so a line per
page would be one sentence repeated down a route table. Only an asset reference
is reported: a relative `<a href>` names a page and not a file, so declaring
`contentRoot` would not fix it, and `contentRelativeReferences` leaves it out.

**A site whose host really does serve these files cannot clear it yet.** The
one fix the message names is `contentRoot`, and declaring it is a claim the
build checks: each reference must name a file in the tree, so a host-served one
refuses the build. `undeclaredHeadersWarning` gives its host case a way out,
because any header rule ends it and a rule is a field the site already has.
This warning has no such field, and a way out would be a new setting. None is
added: no site has this case yet, and a setting that silences the warning puts
#474's silent default one line away, so its shape waits for a site that needs
it. Until one exists, such a site builds, its
output is correct, and every build writes this warning, one line per address.

The twentieth is `unprunedTreeWarning` (`packages/core/src/build.ts`), and
it is the one case a full build cannot prune the tree it builds into (#515). A
full build reads the `manifest.json` already in `outDir` and, after writing its
own, deletes each file the old one named and the new one does not, so a post
retracted since the last build leaves the directory a sync-based deploy
publishes. When that document is there and this build cannot use it, the
build deletes nothing and says so:

```
Output "/site/dist": this build removed no file an earlier build wrote there, because the manifest.json it left is not one this build can prune against — a full build deletes each file the previous build's manifest names and its own does not, and without that document it cannot tell a file an earlier build wrote from one placed there by hand, so a page that build published and this one did not, such as a post set to draft since, may still be in the directory; this is a warning and not a refusal because every file this build wrote is correct and the manifest it wrote is the one the next build prunes against — before a deploy that syncs this directory, delete the pages that build published and this one did not, or point build.outDir at a new, empty directory and build again; a deploy that reads the manifest needs neither:
  Manifest "/site/dist/manifest.json": is version 10, and this build reads version 11 — upgrade pagedeck, or read a manifest this version wrote
```

It opens on the output directory, as the two incremental refusals about this
tree above do, and the opening does not say why the document was unusable,
because the reasons differ. The lines below it say, each in the
`Manifest "<path>":` shape: `readManifest`'s own refusal, as above, which
since #529 includes a document of this version with no files list or any other
field `pagedeck build` writes (rule 5); a file that could not be opened, with its
code; or a row no build could have written. The rows are the prune's
input, so these are containment checks and not tidiness: `writeSite` deletes
the path each row names, and one row that escapes would have the default verb
delete a file outside the tree. A row whose deploy key holds a `.`, `..` or
empty segment, a backslash or a control character never gets here: `readManifest` refuses
the document (#659), and that refusal is the line. Of the rest, a row is
refused when its path or domain resolves outside `outDir` as text, when the
directory it sits in resolves outside `outDir` through a symbolic link, when it
names a directory or a link rather than a regular file (`rm` is not recursive,
and would throw after the tree was written), and when it names the root
`manifest.json` this build has just written. A row naming nothing on disk
passes: there is nothing to delete. Every refused row is listed (rule 5), each
value through `quoteIdentifier`:

```
Output "/site/dist": this build removed no file an earlier build wrote there, because the manifest.json it left is not one this build can prune against — a full build deletes each file the previous build's manifest names and its own does not, and without that document it cannot tell a file an earlier build wrote from one placed there by hand, so a page that build published and this one did not, such as a post set to draft since, may still be in the directory; this is a warning and not a refusal because every file this build wrote is correct and the manifest it wrote is the one the next build prunes against — before a deploy that syncs this directory, delete the pages that build published and this one did not, or point build.outDir at a new, empty directory and build again; a deploy that reads the manifest needs neither:
  Manifest "/site/dist/manifest.json": files row 0 names "/manifest.json", which is the manifest this build writes — pagedeck build never lists its own manifest as a file, so this row was not written by a build
```

Not a refusal, on `retainManifest`'s argument one directory over: the case a
reader meets is the first build after an upgrade that moved `MANIFEST_VERSION`,
and refusing it would fail every site that upgraded. `pagedeck build --incremental`
refuses over the same document, and that is not a disagreement: an incremental
run cannot plan without it, and a full run needs it only to prune. Not silence
either, because what is left behind is #515's own leak, a retracted page in a
tree a directory-sync host copies whole. It lasts one build: the manifest this
build wrote is one the next build reads.

**The fix never says to empty the directory.** Nothing refuses an `outDir` of
`.` or an ancestor of the site, so "empty it" could mean deleting the site's
source. Both edits it names reach build output only: the stale pages
themselves, or a new directory the build fills from nothing.

A `manifest.json` that is absent is not this warning. That is a first build or
an emptied directory, and it prunes nothing and says nothing, as a full build
always did. Each line passes through `printable` for the fifteenth's reason:
it can carry a parser's echo of bytes somebody wrote.

The incremental refusal runs the same row check, `untrustedRows`
(`packages/core/src/build.ts`), from `previousBuild` (#524). It runs after
`readManifest` accepts the document and before the store position is read, so
a refused run has written and deleted nothing. Its lines are the ones above,
under a headline that names the document, as `readManifest`'s own refusals do:

```
Manifest "/site/dist/manifest.json": pagedeck build --incremental cannot trust this document to decide which files to delete, so it wrote and deleted nothing — an incremental build deletes each file the previous build's manifest names and its own does not, and each fault below shows this document was not written by a build, so none of its rows can be trusted to choose a deletion — run pagedeck build, which builds the whole site, deletes nothing this document names, warns that it did not, and writes a manifest the next incremental build can use:
  Manifest "/site/dist/manifest.json": files row 12 names "/link/victim", which resolves outside the output directory through a symbolic link — pagedeck build writes only paths inside it, so this row was not written by a build
```

The fix is a full build, and not an edit to the document: that build warns as
above, prunes nothing, and leaves a manifest of its own, which is the one the
next incremental run plans against.

The twenty-first is `absentFaviconWarning` (`packages/core/src/favicon.ts`), and
its subject is a request nobody wrote (#76). A browser asks for `/favicon.ico`
on its own when a page names no other icon, so a site that declares no
`build.favicon` answers that request with a 404, which the browser logs as a
console error and Lighthouse counts against best practices. Before #76 nothing
said so:

```
Favicon: this site declares no build.favicon, so no output tree has a file at /favicon.ico — a browser requests that address on its own when a page names no other icon, and the 404 it gets is logged as a console error and fails Lighthouse's errors-in-console audit; this is a warning and not a refusal because every page this build emitted is correct — set build.favicon to the site's icon file, as favicon: { src: "./favicon.ico" } (Pagedeck documentation: Favicon)
```

Not a refusal, on `undeclaredHeadersWarning`'s argument: every page is correct,
and a host may answer `/favicon.ico` itself. Not a default icon either, which
the maintainer ruled out: the bytes would be the framework's and not the site's.
A site whose `build.passthrough.root` already publishes `/favicon.ico` is not
warned, because nothing at that address 404s.

The twenty-second is `unlinkedStylesheetWarning`
(`packages/core/src/island-facts.ts`, #71): a stylesheet that only modules
outside every island's import closure import. It takes the island scan's route,
`IslandFacts.warnings` to `SiteBuild.warnings` to `runBuildVerb`, and
`pagedeck dev` prints it too, since the dev server writes the scan's warnings.
An island is `CONTEXT.md`'s **Island**, whether its module carries
`"use client"` or its registry entry declares a `hydrate` mode other than
`"none"`. Render replaces each `.css` import with an empty module, and the
client build starts from `build.css` and the island modules, so that
stylesheet reaches no page. Before #71 the build said nothing, and the missing
styles were the only sign:

```
Island scan: 2 stylesheets are imported only by modules outside every island's import closure, so no page links them — import each stylesheet from an island's module, or list it in build.css; this is a warning and not a refusal because every page still renders, and a page may link a stylesheet some other way the scan cannot see, such as a head link to a passthrough file:
  "/site/components/landing.css" — imported by "/site/components/Landing.js"
  "/site/components/legal.css" — imported by "/site/components/Legal.js", "/site/components/Terms.js"
```

Not a refusal, on `undeclaredHeadersWarning`'s argument: every page is correct
HTML, and a site may link the stylesheet itself. A stylesheet that a module in
an island's import closure also imports, or that `build.css` lists, is not
reported; a `build.css` path is matched by its real path, so a symbolic link
in it does not hide the match. Only a plain import is a candidate: an import
with a query, such as `?inline` or `?url`, hands the stylesheet to the module
that asked for it. Linking the stylesheet into the pages that render its
importer was the other answer #71 offered; the maintainer ruled it a separate
feature, and this warning goes when it lands.

The twenty-third is `unregisteredClientWarning`
(`packages/core/src/island-facts.ts`, #72): a `"use client"` module that a
module outside every island imports, and that `build.components` does not
register. An island is `CONTEXT.md`'s **Island**, as in the twenty-second. The
scan finds every reachable `"use client"` module, but only a registered one
becomes an island, so an unregistered one renders as static HTML with no
JavaScript: it looks interactive and does nothing. Before #72 the build said
nothing. The warning takes the twenty-second's route, so `pagedeck dev` prints
it too, and names each module with the import chain from a registered
component to it:

```
Island scan: 2 modules carrying "use client" are imported from outside every island but are not registered in build.components, so they render as static HTML with no JavaScript — register each under build.components, or import each only from an island's module; this is a warning and not a refusal because an import is not a render, and a client module can render correctly as static HTML:
  "/site/components/Knob.js" — /site/components/Frame.js → /site/components/Knob.js
  "/site/components/Toggle.js" — /site/components/Shell.js → /site/components/Toggle.js
```

Not a refusal: the scan sees imports, not renders, and a package that marks
every file `"use client"` can render correctly as static HTML. Only the
outermost module is reported, the one some module outside every `"use client"`
closure and every island imports. A client module nested inside a reported one
is not reported, because registering the outer module brings the inner one
into its island. Neither is a client module that only a registered island
imports, with or without the directive: it is already part of that island.

The twenty-fourth is `relativeCardWarning`
(`packages/core/src/social-image.ts`, #99): a site that draws share cards with
`build.socialImages` and declares no `build.origin`. Without an origin each card's `og:image` is a path such as
`/social/en.1a2b3c4d.png`, and most social platforms drop a relative
`og:image`, so a shared link shows no image. Before #99 the build said nothing.
The build writes it once, when its output holds at least one card, whether this
run drew it or an incremental build carried it:

```
Social image: this site draws share cards with build.socialImages and declares no build.origin, so each card's og:image is a path and not an absolute URL — the Open Graph protocol asks for an absolute URL, and most social platforms drop a relative og:image and show no share image; this is a warning and not a refusal because every page and every card this build emitted is correct — declare the site's address in build.origin, as origin: "https://example.com" (Pagedeck documentation: Page head, Cards the build draws)
```

Not a refusal, on `undeclaredHeadersWarning`'s argument: every page and card is
correct, and only the platforms that read the page are let down. A site whose
`inputs` returns `undefined` for every page draws no card and is not warned. A
relative `og:image` that the site's own `build.head` returns is the site's to
write and is not warned either.

**The twenty-fifth is not a build's at all, and it is `colorFailureWarning`**
(`packages/content/src/colors.ts`, #44): the image sources a sync could not
fetch a dominant color for. It is written by `pagedeck sync` and reaches `io.err`
through `runSyncVerb`, which writes `SyncReport.warnings` before the failures —
a caveat about a collection that did sync belongs above the collections that did
not.

```
Collection "pages": 2 image sources could not be probed for a dominant color, so they render with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site's wiring; the next sync asks again:
  "/uploads/a.jpg" — timed out
  "/uploads/b.jpg?" — 502 Bad Gateway
```

A warning for `probeExternalLinks`' reason, and it is that entry's argument
about a host this site does not control, applied to a fetch whose whole product
is a background color: a sync that failed on an image host's uptime would fail
on a Sunday for a reason no reader can act on, and what a reader loses by it
finishing is decoration. Not silence either — the sources named here are the
ones that will be asked about again on every sync until somebody looks, which is
the visible cost of the ruling `CONTEXT.md` records against caching the failure.

Rule 5 lists every source and rule 6 redacts each one, which the second line
above shows: an image source is as often a signed CDN URL as a path, its
credential is in the query string when the URL is signed and in front of the
host when the CDN is behind basic auth, and both go. The cut is `quote`'s
(`packages/core/src/quote.ts`) and is made again in `colors.ts` rather than
imported, because `@pagedeck/core` consumes `@pagedeck/content` and the import would invert
the dependency — the constraint that put `CollectionError` in that package in
the first place. The copy is checked rather than promised: `quote.test.ts` reads
both files off disk and refuses a difference, because the claim that the two are
one rule was true for as long as nobody edited either (#383).

**One refusal sits under the same seam and it is the site's own function**,
which is `build.links.external.probe`'s bargain one door along. A color probe
answering with something that is not a string is a declared function returning
the wrong kind on every run until somebody edits it, so it is a
`CollectionError` and exit 2 — while a probe that *throws* is the warning above,
because a throw is the host and not the code. It is collected and thrown after
the pass, before anything is cached (rule 5): a probe that answers wrongly for
one source answers wrongly for all of them.

```
Collection "pages": the image color probe answered 1 source with something that is not a CSS color — return a CSS color such as "#2f3a28", or undefined for an image that has none:
  "/uploads/a.jpg" — 17 — not a string
```

The value is quoted through `quoteValue`, which is `quote`'s replacer and not a
bare `JSON.stringify` — a probe answering with the CDN's response object carries
the signed URL it just asked for, so the cut has to reach a *nested* string
(rule 6). It is the same cut `quoteSource` above makes, deliberately at the same
depth, because two copies cutting at different depths is a drift no reader
of either message can see (#46).

A declared `imageColors.concurrency` that is not a whole number of probes above
zero is refused beside it, before any request is made, rather than repaired —
`budgetFaultReport`'s treatment of every other site-declared number:

```
Collection "pages": "imageColors.concurrency" is not a number of probes — write a whole number of probes above zero, such as { concurrency: 4 }:
  0 — below one, and a sync that may run no probe at all would never cache a color
```

**The channel is threaded rather than declared**, which is this rule's first
half taken seriously at a seam a site fills. The color probe is site-supplied,
so the obvious place for a sink is beside it in the collection — and that is
exactly the `console.warn` in a `pagedeck.config.ts` that this rule forbids. So
`ImageColorsSetting` carries no sink, `CollectionSyncOptions.onWarning` carries
the run's, and the site declares only the thing that has to be its:
`installRegistryWarnings`' shape, at a door where there *is* an argument to
thread.

**A message a browser produces goes through the console, and that is this rule
rather than an exception to it.** Issue #66's last two criteria are both about
the root provider stack, and issue #252's two are both about the shared store;
all four are answered where the thing they are about is used — in a page, at
hydration — so there is no `CliIo` to write them to and no argument to thread
one through: the page was loaded by a reader, not run by a caller. So the
channel is `console.error`, and `reportBrowserFault`
(`packages/islands/src/browser-report.ts`) is the single place these packages
write a diagnostic of their own to one. The only other console reference in
`packages/islands` or `packages/preview` is `mergeComponents`' last-resort
`console.warn` arm, which is a build diagnostic falling back to a stream when
no run installed a sink and is argued at the top of this rule. A browser
diagnostic added later goes through `reportBrowserFault`, for the same reason
every build diagnostic goes through `io.err`. One has: `@pagedeck/search`'s island
reports a query the runtime could not answer, and it reaches the channel through
`@pagedeck/islands/browser-report` rather than writing a `console.error` of its own —
which is what keeps the count at two console writes rather than three.

`console.error` for all of them, the warning included, because a browser's
default console filter hides `warn` in some setups and a warning nobody sees is
not a warning. Which of the two it is is stated in the prose, which is a claim text
can make and a log level cannot. No marker: `bin.ts` writes `pagedeck:` because a
build's stderr is shared with Babel and the bundler, and a console line the
framework wrote is already attributed by the stack frame beside it.

The divergence report is the first (criterion 5). `build.rootProviders` is two
halves of one declaration — the `stack` the build renders with and the `module`
the entry imports — and a site whose halves stopped agreeing builds green and
ships a page whose every island root wraps in providers the markup was not
rendered with. The build writes its half into the entry as a digest and the
browser recomputes its own:

```
Root providers: the stack this page was built with and the stack the browser imported are not one declaration, so every island root wraps in providers the markup it hydrates was not rendered with — write both halves of "build.rootProviders" from one import in pagedeck.config.ts, and compute no provider prop from a clock, an environment or a random value:
  built with 1 provider:
    stack[0] store=object#7ee4f3ca
  imported 1 provider:
    stack[0] now=number#a2de48c1, store=object#7ee4f3ca
```

**Every prop value in it is hashed and none is quoted**, which is rule 6 applied
where it bites hardest: a provider prop is site config, site config is where a
token lives, and the digest is written into the entry module of *every* page. A
provider is named by index rather than by component name for a different reason
— the browser's half is computed from a minified bundle where every function has
been renamed, so a digest that read a name would report a divergence on every
correctly wired site. What the reader is left with is the index, the prop name,
the kind of the value and the fact that it moved, which is rule 2's field.

A prop that is a plain object, a null-prototype object or an array carries the
hash of its shape one level down (`store=object#7ee4f3ca`), so a `config` read
from the environment on one side and not the other names itself rather than
reading as `object` on both (#255). Any other non-primitive keeps the bare
word, and the missing suffix is the report saying the value was not read into —
a class instance, a function, a `Map`, a `Set`, a `Date`, a `URL`, a typed
array, a boxed primitive, an `Array` subclass. A divergence inside one of those
is therefore silent, which is the price of the walk stopping where it does: the
test is the prototype and never a constructor name, because the browser's half
of this digest is computed from a minified bundle where every class has been
renamed, and a digest that read a name would report every correctly wired site.

**Which store shapes are safe, plainly, and why each is.** A store holding its
state in a class is not read into at all — its prototype is not
`Object.prototype`, so it keeps the bare word. A store holding its state in a
closure *is* read into: it is a plain object of methods, and the
`store=object#7ee4f3ca` above is one. It digests alike on both sides because
every field it has is a function and a function is tagged by the bare word
`function`, so two instances — one per environment, which is what the design
asks for — hash the same text. A store that is a plain object carrying a
primitive on it is read into too, and there the two instances part: a counter
that moved while the build rendered the page will report a divergence the site
does not have. That is a real cost and not an argued-away one; the 2026-09-06
ruling on #255 took it because the alternative is that no object prop is
compared at all (`CONTEXT.md`, "A provider prop is digested one level down, and
no prop opts out").

A getter that throws when read, and a revoked proxy, keep the bare word rather
than stopping the build **when they are one level down**, inside a prop. A prop
that is *itself* a throwing getter still fails the build, exactly as it did
before #255: the digest reads each prop unguarded, and the render that ran
before the digest was taken read the same prop first and threw on it there.

The key names one level down are hashed with the values, because a key inside a
value is not a field the site typed into `props` and a map keyed by a token has
its secret in its keys. Only own enumerable string keys are seen at all, so a
symbol-keyed or non-enumerable field at that depth is invisible to the digest.

The second is a warning, and it is the ninth warning in this document
(criterion 4). A provider that creates its own state inside its component body
hands every island
root a different object, so two islands appear to share state and do not — the
failure that otherwise surfaces only in production. It cannot be decided
statically, so it is decided by watching: `rootProviderProbe`
(`packages/islands/src/root-provider-probe.ts`) reads each root's context value
for the same configured provider and reports when two roots disagree.

```
Root provider "OwnStoreProvider": delivers a different value to each island root, so two islands that look like they share state do not — the provider creates its own state instead of receiving one, so move that state to a module-level instance and pass it in, as { component: OwnStoreProvider, props: { store } }; this is a warning and not a refusal because the page renders and only its behaviour is wrong, and because this probe sees only a provider whose component is a plain function returning a context element
```

A warning for both of the reasons the two above are warnings at once. The output
is correct HTML, as `workerFallbackWarning`'s is — the page renders, and
only its behaviour is wrong, so a dev server that refused would take away the
page an author needs in order to see the fault. And the instrument cannot be
complete, as `resourcePlacerWarning`'s cannot: a class, a `memo` and a provider
that renders a wrapper of its own are all invisible to it, so it under-reports
by construction and the message says so rather than reading like a rule the
build can hold. This one is named here rather than by a component's own name for
the opposite reason to the digest's: it runs only under `pagedeck dev`, where nothing
is minified, so the name in the message is the name in the source.

**A third message shares the channel, and it is the boundary underneath the
other two.** `rootProvidersFaultReport` validates the *specifier* in
`build.rootProviders.module` and never what the module evaluates to — no config
load ever sees that value — so the browser is where a default export that is not
a provider stack arrives. It is reported here rather than thrown, because this
runs at the top of the generated entry, above `hydrateIslands`: a throw would
stop every island on the page from hydrating over one malformed export, which is
a worse page than the one the check exists to describe. The digest comparison is
skipped rather than attempted, on `loadComponents`' argument — a stack nobody
has cannot have a prop that moved — so one fault produces one report:

```
Root providers: the module "build.rootProviders.module" default-exports is not a stack this page can apply, so nothing here can check it against the stack this page was built with — default-export the same array of { component, props } that "build.rootProviders.stack" holds, outermost first:
  the default export — a function, not an array of providers
```

The lines are collected by index and worded exactly as `stackFaultLines` in
`config.ts` words them, because they are the two halves of one declaration
checked where each half arrives:

```
Root providers: the module "build.rootProviders.module" default-exports is not a stack this page can apply, so nothing here can check it against the stack this page was built with — default-export the same array of { component, props } that "build.rootProviders.stack" holds, outermost first:
  stack[0] — not an object
  stack[1].component — not a component
  stack[2].props — not an object
```

A value is named by its kind and never quoted (rule 6): the thing being
described is a provider stack, a provider's props are site config, and a module
that exported a config object where the stack belongs would otherwise put what
that object holds into a browser console. The kind is the diagnosis anyway — a
reader told the default export is a function knows they exported the provider
instead of the stack.

**Three more share the channel, and they are the shared store's** (#252).
`packages/islands/src/store-stamp.ts` and `store.ts` describe a fault nothing
else would ever say a word about: Jotai's own duplicate-instance detector lives
inside `getDefaultStore()`, which a framework built on `createStore()` plus
`<Provider store>` never calls, so a page holding two stores renders perfectly
and simply stops sharing state.

The first is the duplicate instance, and it is **the one message in this
document whose class depends on which caller reached it**. The stack is checked
where a store is handed in — `renderPage` for the build's half,
the generated island entry above `hydrateIslands`, and the generated preview
entry above `mountPreview` — and each caller states its own verdict rather than
sniffing one. A build and a preview app refuse: nothing has shipped, and in a
build the refusal is a `StoreError` and exit `2` (rule 7). A page entry passes
`import.meta.env.PROD`, which Vite folds to `false` on the dev server and `true`
in the shipped bundle, so the one place this reports rather than refuses is a
visitor's browser. That is the 2026-08-24 design review's ruling: #64's
chunk-graph assertion is the gate, and a canary must not take a visitor's page
away. The sentence says which it is, because a reader meeting it in a console
needs to know it did not stop the page:

```
Shared store: 2 providers deliver a store this framework did not mint, so two island roots resolve the same atoms on two stores and neither sees the other's writes — pass the one instance "@pagedeck/islands/store" exports, and call createStore() nowhere in site code; islands are separate React roots, so one store object reached through one module is the only thing that carries state between them, and a build, a dev server and a preview app refuse this where a shipped page only reports it, because the build's chunk-graph assertion is the gate and a canary must not take a visitor's page away:
  stack[0].props.store
  stack[2].props.cart
```

Every offending prop and never the first (rule 5), located the way the
divergence report above locates a provider: by index into the stack and then by
prop name, which is rule 2's field and is what the site edits. **No value is
quoted** — a store is closures over whatever state the site put in it, and there
is no reading of one a message could promise holds no credential (rule 6). The
prop path is the whole diagnosis anyway.

The second and third are the hydration seam's, and both are reports in **every**
environment rather than refusals in any. They are the tenth and eleventh warnings
in this document, and each says why it is one.

Jotai's SSR documentation states that atoms hydrate once per store, and
`useHydrateAtoms` enforces it by dropping the second value in silence. Under the
`visible` and `idle` strategies island hydration order is the reader's scroll
and the browser's idle callback, so two islands hydrating one atom is a race
whose loser disappears. Refusing would cost every island that had not hydrated
yet — the page taken away from the author who needs it to see what happened — so
the first value is kept, which is what Jotai would have done, and the report is
the whole of what changes. Rule 5's shape, one line per atom:

```
Shared store: 2 atoms are hydrated a second time, and an atom hydrates once per store, so the value this call brought was dropped and the first one kept — hydrate the shared store once, from the page and before any root mounts, and give an island its own atom rather than a second value for a shared one; island hydration order is not controlled under the "visible" and "idle" strategies, so which value survives is not the site's to choose. This is reported and not refused because the page renders and only its state is wrong, and refusing here would cost every island that has not hydrated yet:
  atom[0] "cart"
  atom[2] — no debugLabel
```

The third is the other half of "hydrated once, **before any root mounts**", and
it is reported alone with nothing enumerated under it. That is the non-object
budget's argument rather than a shortcut: every atom in the call has the same
fault, the same cause and the same fix, and the fault is not about an atom at
all — it is about when the call was made. `markRootsMounting`, written into the
generated entry immediately above `hydrateIslands`, is what gives this message a
fact to report; without it a first hydration arriving after two roots had
rendered was accepted in silence, because every atom in it was new.

```
Shared store: hydrateStore was called after island roots began mounting, so every root that had already rendered did it with the value the store held before this call — a visible flash where the value is rendered, and a wrong answer for anything that read it in an effect or an event before the write landed — call hydrateStore from the page, above the module that hydrates the islands, so the store is complete before the first root mounts. This is reported and not refused because the page renders and only its state is wrong, and refusing here would take away the roots that mounted correctly.
```

**No hydrated value reaches either report, and this is the message rule 6 is
written for.** A hydration payload is whatever the site put on the page — a CMS
field, a session, a signed URL — so a line that echoed one would put arbitrary
site data into a console anybody who opens the page can read, and unlike §2's
validator text there is no schema failure here that the value would explain. An
atom is named by its `debugLabel` where it has one and by its position in the
call otherwise, and a debug label is what the author wrote and what they edit.
An atom with no label says so rather than leaving the position bare, the way §2
writes `(whole entry)`.

**Three more are `@pagedeck/search`'s query runtime's** (`packages/search/src/query.ts`,
#62), and they are the browser's for the plain reason: this code runs when a
reader types into a search box, and there is no run to report to. All three are
thrown rather than written, because a query that cannot be answered has no
answer to fall back on; the island catches each one, shows no results, and puts
the message on the channel through `reportBrowserFault`.

The first is a file the deployment does not have. An index is several files that
have to travel together, so the one that is missing is named with the status that
said so:

```
Search index "/search/en/terms-0001.json": the request failed with status 404, so this query cannot be answered — check that the build wrote a search index for locale "en" and that it was deployed with the pages
```

The second and third are the format check, and **they are two messages because
they are two fixes** — `@pagedeck/edge`'s `checkVersion` split over a routing manifest,
and the same shape here. Both halves of a search index come from one package, so
the version says which half the deployment is carrying from another build: an
index ahead of the page means the page is stale, and an index behind it means the
index is. A single mismatch check would report every disagreement as "newer" and
send half its readers to rebuild the half that was already current.

```
Search index "/search/en/index.json": format 2 is newer than this query runtime reads (1) — the index was written by a newer @pagedeck/search than the page querying it, so the page is the stale half; rebuild and redeploy the site so the page ships the @pagedeck/search that wrote this index
Search index "/search/en/index.json": format 0 is older than this query runtime reads (1) — the index was written by an older @pagedeck/search than the page querying it, so the index is the stale half; rebuild the site so the index is written by the @pagedeck/search this page ships
```

A fourth message the same module carries is not a browser's at all, and is named
here because it is written beside them: `createSearchClient` falls back to
`globalThis.fetch` where a caller supplied none, and every browser this framework
targets has one. So the reader of this message is running the query runtime
somewhere else — a test, or an old runtime — and the fix is the option rather
than the environment.

```
Search query runtime: this environment has no global fetch, so no index file can be requested — pass a fetch to createSearchClient
```

Nothing else changes. A third-party advisory passes through unmarked and
unedited, and an in-process caller of `runCli` supplies its own `err` and
receives the message exactly as the CLI composed it — which is why every
assertion in this document quotes unmarked text.

A caller asserts about a spawned run by selecting the marked lines in, never by
subtracting prefixes out:

```ts
const mine = stderr.split("\n").filter((line) => line.startsWith(DIAGNOSTIC_MARKER));
expect(mine).toEqual([]);
```

`pagedeck:` is the command's own name rather than a `[SHOUT]` label, so it does not
read as one more tool's prefix. It is not collision-proof: this repo names its
bundler plugins `pagedeck:compile-islands` and the like, so a bundler line opening
with a plugin name would be selected too. That fails towards over-reporting
rather than towards a missed diagnostic; a caller that wants the narrow
question matches `pagedeck: `, with the space `markDiagnostic` always writes.

## Not yet: links to docs

§14b also asks that errors link to the relevant doc. None do, and that still
holds after #61.

The docs site now exists — `packages/docs-site` builds this file, the ADRs and the
deploy recipe into pages (#576) — but it is not deployed anywhere, so there
is no URL to put in a message. A path is not enough: a build failure is read in
a CI log, where `/error-messages` resolves to nothing.

When the site has an origin, the messages above are where the links belong: the
schema failure to the schema guide, the snapshot scheme failure to the snapshot
how-to. Until then, do not add a link to a page nobody can open; a dead URL in
a build failure is worse than no URL.

Three lines name a page instead, by the title, and heading where one helps, that
the docs site shows. The twenty-first warning above names the Favicon page
(#76), and the twenty-fourth names the Page head page's "Cards the build draws"
heading (#99). `pagedeck build` prints the third after its summary when the site
declares `build.preview` (#713):

```
preview: /_preview — this app authenticates nothing and renders any draft posted to it; put the deployment behind whatever the drafts need (Pagedeck documentation: Preview app, Security)
```

The preview line used to name a README path in this repository, which an
installed site does not have and which belongs to a private package. A page
title survives the move to an origin. When the site has one, the URL goes beside
the title.
