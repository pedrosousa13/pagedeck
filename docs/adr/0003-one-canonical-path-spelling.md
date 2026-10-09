---
title: 3. One canonical spelling for a path, minted once
description: One function spells every path the build emits, in RFC 3986 normalized form, and it decodes only unreserved characters.
---

# 3. One canonical spelling for a path, minted once

Date: 2026-08-25

## Status

Accepted. Implemented by #85 for the route table, and by #30 for the redirect
and headers manifest, which normalizes every authored path through the same
function rather than minting a second spelling. The three this was written as
binding on have all since landed, and all three are bound by it: #37 (output
trees), #40 (per-locale sitemaps — `sitemap.ts` consumes `Page.output` and calls
the function for the one path it composes itself, its file's own) and #88
(`href` — templates lower onto #87's segment list rather than encoding of their
own). Binding on any later emitter that writes a path.

This section states the decision's reach and is maintained as work lands, the
way ADR-0001's names its implementors. What else an ADR may edit after the fact
is convention rather than written rule, and the convention has run both ways:
#148 edited ADR-0004's `Status` and its `Consequences`, while #133 rewrote
ADR-0001's and this file's `Consequences` and left both `Status` sections alone.
This edit takes the narrower of the two and touches `Status` only.

**Amended by #607: a redirect target is looked up as a file before the policy
spells it.** `planRouting` first spells a redirect's `to` without a trailing
slash, by `normalizeOutputPath` under `"never"`, and looks that spelling up in
the files the build emits into the rule's tree. If it names one, that spelling
is kept. Only a target that names no file is spelled by the site's policy, as a
page. This is not a second opinion about the spelling: every step is still
`canonicalizePath`'s, through the one normalizer, and an emitted file has one
spelling, its own, which the policy was never an address style for. Before
#607, `"always"` spelled `/sitemap.xml` as `/sitemap.xml/`, which names no file.

## Context

A URL has many spellings. `/café`, `/caf%C3%A9` and `/caf%c3%a9` are one address
to a visitor, and so are `/~a` and `/%7Ea`. Spec §11 asks that URL normalization
mean "S3/CloudFront resolution quirks can't create duplicate-content URLs", and
until #85 the route table still admitted every one of those pairs as two rows.

Leaning on the URL parser does not settle it. Measured on Node 24.18.1,
`new URL(route, origin).pathname` encodes non-ASCII as UTF-8 escapes, but does
not uppercase an escape's hex digits, does not decode an escape of an unreserved
character, and passes a malformed escape straight through. That is one of
RFC 3986 §6.2.2's three normalizations, so the parser leaves two of the three
duplicate-content pairs above intact.

The spelling is not a local question. It has to agree across the route table,
the links a page emits, its canonical tag, the per-locale sitemaps, the redirect
and headers manifest, the edge config, and the S3 object key — `café.html` and
`caf%C3%A9.html` are different keys to S3, and CloudFront forwards the encoded
path. Any emitter that re-spells a path locally is free to disagree with all the
others, and the failure it produces is a page that ships at an address nothing
links to. Nothing detects that: each emitter is internally consistent, and the
route table it disagrees with is a different file.

## Decision

**A path is spelled by `canonicalizePath` (`packages/core/src/pages.ts`) and
nowhere else.** Every emitter that writes a path — an output tree, a sitemap
entry, a manifest key, a rendered `href` — calls it, or consumes a `Page` whose
`path` and `output` already went through it. No emitter percent-encodes,
decodes, cases, or re-joins a path of its own.

**The canonical form is the RFC 3986 normalized URI form**, §6.2.2, in three
steps: non-ASCII becomes UTF-8 percent-escapes, every escape's hex digits go
uppercase, and an escape of an unreserved character (`ALPHA / DIGIT / "-" / "."
/ "_" / "~"`) decodes back to the character.

**Only unreserved characters decode.** `/` is reserved, so `%2F` stays escaped
and `/a%2Fb` remains one segment. This is not a detail of the encoder — it is
what keeps the function from inventing or destroying a path segment.

**The function normalizes spelling, not structure.** It does not resolve dot
segments: called directly, `canonicalizePath("/a/%2E%2E/b")` gives `/a/../b`,
because `%2E` is an escape of an unreserved character and decoding it is step
three. A caller assembling a path by hand therefore resolves dot segments before
calling it. Inside `normalizeRoute` that is already true — `removeDotSegments`
runs first and reads the escaped spellings itself — which is why the route table
never sees a `/a/../b`.

**A path that is not a path is refused, as a `ConfigError`.** A malformed escape
(`/a%2`, `/a%zz`) is not an address two clients agree on; a query or a
fragment (`/a?b`, `/a#b`) is not part of a path at all — `?` and `#` are no
`pchar`, and `encodeURI` passes both through, so refusing them is what stops a
caller getting a query back from the function that is supposed to have settled
the spelling; and a lone surrogate (`/a<U+D800>`) is no character at all, so
`encodeURI` throws `URIError` on one rather than spelling it (#131). None of
the four can reach a path except from a `route` callback, which makes it wiring
rather than content — exit 2 under rule 7 of `docs/error-messages.md`. The
tested order is the delimiter, then the escape, then the surrogate, in
`unusableReason`'s order: `/x?token=…%2` cut at its `%` would quote the token
(rule 6).

**Non-ASCII paths are supported.** No transliteration requirement: whether a
site wants `/café` or `/cafe` is a content decision, and the build spells the
result one way regardless of how the author typed it.

## Consequences

Two spellings of one URL now land on one row of the route table, so a second
entry claiming it is reported as the collision it is, with both claimants named,
instead of shipping as two pages.

**A path prefix is spelled, but its trailing slash is not a spelling.** A
header rule's `prefix` (#30) is a matcher, not an address: `/docs/` scopes a
rule to what is under `/docs`, and `/docs` also matches `/docsearch`. Running
the trailing-slash policy over one does not canonicalize it, it changes what it
matches — under `"never"` the slash is stripped and the rule silently widens
onto a sibling the author scoped out, in all three of #33's compile targets at
once, since a prefix is precisely the matcher they agree on. So
`normalizeOutputPrefix` shares every step of the spelling with
`normalizeOutputPath` — the leading slash, dot segments, slash runs, and
`canonicalizePath` itself — and stops before the policy. That is one
normalizer with two endings, not the second normalizer this decision rejects:
the alternative is a caller applying the policy and then patching the slash
back on, which is a second opinion about the spelling in the place this
decision says there may not be one.

`canonicalizePath` runs inside `normalizeRoute`, after dot segments are resolved
and slash runs collapsed, before the trailing-slash policy is applied. The order
matters in one direction only: `dotSegment` reads `%2E` off the *raw* spelling
to recognize `/a/%2e%2e/b` as `/b`, so it must keep running first. A refactor
that reorders the two has a test in `packages/core/src/pages.test.ts` waiting for
it.

The refusal is detected in `collectPages`'s first pass, by `unusableReason`,
rather than at the throw inside `canonicalizePath`. Both read the same
`MALFORMED_ESCAPE`, `PATH_DELIMITER` and `LONE_SURROGATE` predicates, so they
cannot drift about what "not a path" means; the first pass is what enumerates
every unusable route in a run (rule 5) and classifies it (rule 7). The throw
inside `canonicalizePath` is the guarantee an emitter calling it directly gets.

The function is idempotent, which is what lets a path be canonicalized again
without a caller having to track whether it already was — `collectPages`
normalizes `output` a second time after prefixing a locale, and that stays a
no-op on the spelling.

#87 lets a `route` callback return the segments of a path rather than the
finished string, and percent-encodes each of them on its own before joining
them. That happens before this function sees the result, and stays per-segment:
it is what stops a slug containing `/` from inventing a segment, which
`unusableReason` cannot catch because it reads the finished route.
`unusableSegmentReason` is the third reader of `LONE_SURROGATE`, and the only
reader of that one predicate alone: `encodeURIComponent` throws on a lone
surrogate too, so the segment form needs its own guard, taken before anything
is encoded. The other two predicates do not apply to it — a delimiter or a
malformed escape in a segment is encoded, not refused. Templates are #88's, and
they lower onto the same segment list, so nothing gains a second place where a
path is spelled.

## Alternatives considered

**Canonicalize to the decoded spelling (`/café`).** Rejected. A URI path is
ASCII by definition, so `/café` is an IRI. It is a spelling to show a human, not
one an emission layer can write to an S3 key or a manifest.

**Use `new URL()` as the canonicalizer.** Rejected, on measurement. It performs
one of the three normalizations and passes malformed escapes through, so it
leaves the pairs this decision is about unmerged.

**Refuse non-ASCII paths and require transliteration.** Rejected as the
framework overreaching on a content decision, and unnecessary — step one spells
them unambiguously.

**Normalize per emitter, at emission.** Rejected. It is the failure mode in the
Context above: every emitter is free to disagree, and nothing checks that they
do not.
