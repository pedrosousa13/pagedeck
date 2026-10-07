---
description: Slot ids and island markers carry no authentication, and stripping the reserved names from content HTML is the defence instead.
---

# 6. Slot ids are not authenticated, and the content boundary is the defence

Date: 2026-08-29

## Status

Accepted. Decided on #109 and shipped in PR #122, which put the defence at the
content boundary — `unescapedHtml`'s reserved-name strip — rather than at the
read path. No code change is attached to this file: it records a decision
already implemented. Binding on the wire format and on `unescapedHtml`'s
contract. Raised by #137.

## Context

The security sweep on #25 measured a hand-typed `<fw-island>` in a rich-text
field being mounted like any other marker (#109): the runtime read the four
`data-fw-*` attributes, checked they were all *present*, and scheduled the
mount, so a CMS author chose which registered component ran on the client and
with what props. The general question underneath it is the one this ADR
answers, and it is about the wire format rather than about that one payload:
**should the client be able to tell control markup the build wrote from control
markup content wrote?** #128 asked it again about slot ids specifically, after
#114 had made ownership structurally correct for every forgery except the one
whose nearest marker genuinely *is* the target container.

**A slot id is a position, and a position is public.** `ISLAND_ID_PATTERN` is
digits joined by dots and nothing else; the id a `<fw-slot>` carries in
`ISLAND_SLOT_ATTRIBUTE` is the child's place in the entry tree, which is what
makes it unique page-wide. Content does not have to derive one or guess one,
only to write one down. There is no secret in it to check.

**The one identifier here that is derived has the same property.** A marker's
`useId` prefix (`ISLAND_PREFIX_ATTRIBUTE`) is `render.tsx`'s `islandPrefix`:
`i` — an id must not start with a digit — and twelve hex digits of
`sha256(locale \0 path \0 position)`. All three inputs are public to anyone who
can read the page, so the digest is reproducible by anyone who can read the
page.

**Both fixes #109's brief proposed were measured and neither survived.**
Validating `data-fw-prefix` against the `i` + 12-hex shape passes that issue's
own payload, `ideadbeef0000`, which is `i` followed by exactly twelve hex
characters. Recomputing the prefix at the read path is not available either:
the runtime has document order from `querySelectorAll`, which diverges from
entry-tree position as soon as islands nest — and it would not help if it were,
because the inputs are public.

**So the only real proposal was a per-build random value, and it collides with
a live invariant.** A nonce in the markup makes two builds of one unchanged
site differ, which is what `render.test.tsx`'s "rendering the same page twice
returns byte-identical HTML" pins for a render and what #20 pins for a whole
output tree — landed in PR #179 as `determinism.ts`, compared over two real
pipeline runs by `build.test.ts`, with the manifest's build stamp as the single
excused field. That test alone is narrower than the invariant it stands for, and
PR #179 said so itself: both of its runs are one process, with Rolldown, React
and React DOM externalized and keeping their module-scope values across the
pair, so what it certifies is that two builds agree *given one evaluation of the
toolchain*. **#220 closed that gap and it needed no new comparison**:
`pnpm check:build-twice` spawns two `fw build` processes over one unchanged
site and hands the two trees to the same `diffOutputTrees`, and CI runs it on
every push. So the invariant is now certified as it reads, over a site that
islands both ways — a registry override and a module's own `"use client"` — with
the toolchain evaluated twice and the build stamp still the one excused field.
None of this changes the collision here: a per-build nonce differs between two
builds however they are isolated, so it fails both pins.

Threading the nonce in as a `renderPage` input rather than
minting it per build avoids the invariant and buys a different fault: roughly
47 `renderPage` and 36 `hydrateIslands` call sites to plumb, and a site that
supplies none is silently unprotected, which is #116's shape.

## Decision

**Nothing on the read path authenticates a slot id or a marker, and that is the
call rather than the gap.** `adoptSlots` checks that an id has the shape a
build's id has (`ISLAND_ID_PATTERN`) and that the element is structurally this
marker's own (`owns`, issue #114). Both are questions about the page as it
stands. Neither is a question about who wrote the bytes, and no test at the
read path can be, because the wire format deliberately carries nothing to
answer it with.

**The defence is the door.** `unescapedHtml` is the single sanctioned entry for
content-authored HTML, and since PR #122 it strips the framework's reserved
vocabulary — `<fw-island>` and `<fw-slot>` in either tag form, and a named
list of attributes with each one's value in all three forms HTML allows. The
list is the six island attributes (`data-fw-prefix`, `-component`, `-mode`,
`-props`, `-slot`, `-template`), since #394 `data-fw-facade`, and since #566
the attribute `@fw/search` reads to leave an element out of its index. (That
one is described rather than named: this ADR is published on the docs site
through `unescapedHtml`, which would strip the name from the sentence.) It is an
enumeration and not a `data-fw-` prefix match, so a `data-fw-*` name that is
not on it, `data-fw-consent` among them, passes through unstripped. Content
coming through it cannot mint a marker or a slot id at all, so the runtime
needs no credential to refuse one. The sink splits in two and the split *is*
the boundary: `rawHtml` takes the build's own composed markup unstripped,
`unescapedHtml` strips and then calls it.

**The framework defends its own namespace, not the site's HTML.** Sanitising
content is the CMS's job and stays there. What `unescapedHtml`'s contract
changed to on #109 is "sanitises exactly the framework's own reserved names and
nothing else", which is the smallest claim that makes the trust boundary a
mechanism instead of an argument.

**The residual is stated rather than closed.** `unescapedHtml` is a convention.
A site that calls `dangerouslySetInnerHTML` itself, or hands the exported
`SlotContent` a string of its own, is past the boundary — and `SlotContent`
cannot be made to strip, because what it legitimately carries is the build's
own nested markers. That is the boundary the framework claims and no more.

**Reopening this needs a way to make a build-written id unforgeable that does
not cost the rebuild.** New evidence, not a new reading of the same facts. The
two directions already weighed are below.

**Owner: the slot mechanism in `@fw/islands`.** Whoever changes `slot.ts` owns
the read path this decision leaves unauthenticated, and whoever changes
`stripReservedNames` owns the door that stands in for it. It was #109's finding
and #109 is closed, so a reader looking for who holds the residual finds this
file.

## Consequences

A forgery whose nearest marker genuinely is the target container is
indistinguishable from that container's own panel, because by the only test
available it really does belong there. That is #128, and it is this decision's
residual seen from the read path rather than a second defect. It is **loud
rather than silent**: measured across five arrangements of a forgery and a real
panel, the container is handed one child more than the build's pass rendered
from, React's child-by-child walk runs off the end of the server DOM, and the
uncaught channel gets one hydration mismatch and regenerates the tree. The
recoverable channel is empty in all five, which is where #128's body's
"silently" came from, and the correction is on that issue.

**#129's undercount errs safe on the scan's own arithmetic: a miss can only
move the count down, never up.** The door is a second fact, not the reason.
`slotCopies` matches literal bytes, so it is case-sensitive and sees a
double-quoted value only, and it cannot see `<FW-SLOT DATA-FW-SLOT="0.1">`, an
unquoted value, a single-quoted one, or a tag whose earlier attribute holds a
`>`. Down means one of two things: to `0`, which stashes a child that was
placed, or off a duplicate, which declines a refusal rather than making a wrong
one. Neither drops a child. Separately, and because of this decision, none of
those spellings reaches a page through the sanctioned door at all, by two routes
rather than one. `RESERVED_NAMES` (`tree.tsx`) carries the `gi` that
`stripReservedNames` runs, where the scan is bytes, and its value alternation
takes unquoted and single-quoted values where the scan takes double-quoted ones
only. The `title="a>b"` tag is not the value alternation's doing: that regex's
tag alternative stops at the same inner `>` the scan stops at, and the
` data-fw-slot="0.1"` left standing falls to the attribute alternative later in
the same pass. The undercount is therefore reachable only from past the
content boundary, which is the residual above arriving from the build side.
Whether to widen the scan is a decision neither #129 nor this ADR makes.

Determinism is untouched, and that is the point of taking the door instead of
the credential. No marker carries a random value, no build reads a random
source, and #20's build-twice check holds over the emitted tree without an
exemption for hydration markup.

There is no secret to distribute, no config concept, no opt-in, and therefore
no site that is silently unprotected because it never passed one (#116). The
protection is a property of the sanctioned door rather than of a caller
remembering to use a parameter.

PR #122 corrected `runtime.ts` and `marker.ts` to say that completeness is what
they check, not authorship. A reader who arrives asking whether signing was
ever considered finds this file, which is why #137 filed it.

## Alternatives considered

**Validate `data-fw-prefix` against the `i` + 12-hex shape.** Rejected on
measurement, and it was #109's cheap proposal. The payload that issue measured
is `ideadbeef0000` — `i` followed by exactly twelve hex characters. The check
passes the attack it was proposed to stop.

**Recompute the prefix at the read path, or sign the ids deterministically.**
Rejected twice over. The runtime does not have the inputs: `islandPrefix`
hashes the entry-tree position, and `querySelectorAll` gives document order,
which diverges from it once islands nest. And it would authenticate nothing if
it did — `locale`, `path` and position are all public, so any value derived
deterministically from them is reproducible by whoever is authoring the
forgery. A slot id is worse still: it *is* the position, with no digest in
front of it.

**A per-build random nonce stamped on every marker.** Rejected on the
determinism invariant, and it is the strongest of the three. It genuinely buys
the distinction — an unguessable value is exactly what a deterministic one
cannot be — and the price is the property the framework will not trade: two
builds of one unchanged site emitting the same bytes, which #20 pins over the
output tree and `render.test.tsx` pins per render. Cache stability and
incremental correctness both rest on it. If this trade is ever reopened, it is
reopened on a mechanism that survives a byte-identical rebuild, not by ranking
the nonce above the invariant.

**Thread the nonce in as a `renderPage` input instead of minting it per
build.** Rejected. It keeps the rebuild identical for a site that passes the
same value twice, and it costs roughly 47 `renderPage` and 36 `hydrateIslands`
call sites of plumbing, for a defence that is absent by default: a site that
supplies no nonce is unprotected and is told nothing, which is #116's failure
mode rather than a fix for this one.

**Leave the decision in the issues, the PR and the docblock.** Rejected, and it
is why this file exists. The docblock serves a reader already looking at
`adoptSlots`; three adversarial passes rediscovered the same residual as a
defect, and #128's fix addressed only the direction of approach that ends at
the code. `docs/agents/domain.md` sends a reader asking "did we consider
signing these ids?" to `docs/adr/`, and until now that search found nothing.
ADR-0002 is the precedent: an option weighed and rejected, with no code change
to show for it, is still a decision the project has to be able to find.
