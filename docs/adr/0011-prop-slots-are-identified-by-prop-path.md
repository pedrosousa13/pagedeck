---
title: 11. A prop slot is identified by its island marker and a prop path
description: An island that another component renders takes server elements in its props as prop slots, each named by a prop path on its marker.
---

# 11. A prop slot is identified by its island marker and a prop path

Date: 2026-11-02

## Status

Accepted. Decided on #241, the last ticket of map #237. It answers the feature
request #175 and supersedes `.out-of-scope/proxied-slots.md` (marked superseded
in #244). No code ships with this file. The slices filed under #175 implement
it. The evidence is #238's research and #240's prototype, which ran through the
real build. Its branch, `prototype/proxied-slot` (cdd86d3), is never merged.

## Context

A slot is server-rendered content an island carries as static HTML. The client
keeps that HTML and never renders it. Until now every slot was a **tree slot**:
a child the entry tree places under an island, identified by its entry-tree
position, digits joined by dots, which `ISLAND_ID_PATTERN` guarantees.

An island that another component's code renders (a proxied instance) has no
entry-tree children. Handing it JSX children was refused at build (#168),
because a proxied child has no position to be named by. The refusal offered two
fixes: place the island in the entry tree, or move `"use client"` down to the
interactive leaves. #175 is the case neither fits. A third-party design system
ships both the server wrapper and the client half, and the wrapper passes
server-rendered elements to the client half as `children` and inside props,
such as `items: [{ id, node: <Card/> }]`.

#238 found a way to deliver such an element with no flight payload. The build
wraps each element prop in its own `<Suspense>` boundary, which delimits its
HTML at any depth. On the client, a stand-in that never settles keeps that HTML
dehydrated. #240 built it through `pagedeck build` and hydrated the page in
jsdom with the real runtime. Regions kept their DOM nodes, a nested island
hydrated on its own, a keyed reverse kept its nodes, and a slot placed after
hydration showed the server HTML. The maintainer accepted that shape as this
decision's starting point.

## Decision

**A prop slot is an element in the props of a proxied island instance. It is
identified by the island's marker and a prop path.** The path is an array of
segments, each a string key or a non-negative array index, such as
`["items", 0, "node"]` or `["children"]`. The marker lists every path once, in
the order the walk finds them, in the attribute `ISLAND_SLOT_PATHS_ATTRIBUTE`
names. That constant, `ISLAND_REGION_ATTRIBUTE` and
`ISLAND_REGION_STASH_ATTRIBUTE` are the names the slices under #175 add
beside `marker.ts`'s existing constants: #246 the first two, #247 the stash.
Segments rather than a dotted string mean a key that contains a dot needs no
escaping. Ownership is "nearest marker", the same as for tree slots, so a path
never repeats the island's prefix.

**Only proxied instances take prop slots.** An island the entry tree places
keeps tree slots for its children and keeps refusing elements in its other
props. A marker never mixes the two kinds.

**An element is found at any depth through plain objects and arrays.** The walk
uses the depth limit (32) and the cycle guard that `refusedProps` already has.
An element inside any other container, such as a `Map`, a `Set` or a class
instance, is refused at build, and the fix is to move the element into a plain
object or array. Serializing that container would silently drop the element.

**Each region arrives whole.** The build renders with `progressiveChunkSize:
Infinity`, so no boundary is streamed as pending and the client mapping below
only ever sees complete regions.

**Each placed region carries a mark.** A `<template>` with the region attribute
(`ISLAND_REGION_ATTRIBUTE`) is the first child inside the region's boundary, and
its value is the index of the region's path in the marker's list. The mark is
needed for two reasons. The build learns which slots the island placed by
whether the mark rendered. The client needs it to map a region to a path,
because DOM order follows the island's render and not the path order. A
`<template>` is valid inside `<tbody>` and `<tr>`, where a wrapper element is
not.

**An unplaced prop slot is stashed.** For each slot the island did not place,
the build runs one more `prerender` pass under the prefix `<prefix>s<n>`, and it
writes the HTML escaped into a `<template>` that carries
`ISLAND_REGION_STASH_ATTRIBUTE`. That is the same escape the tree-slot stash
uses. The runtime removes the stash before any island mounts.

**`ISLAND_ID_PATTERN` does not change.** It stays the tree-slot pattern. A
region index has its own pattern, `^(0|[1-9]\d*)$`, must be less than the
length of the marker's path list, and names one region of the island at most.
The path list must parse as an array of paths whose segments are strings or
non-negative integers. Each attribute has one reader
and one shape, so neither id space can pass for the other.

**On the client, each path gets one stand-in, built once for the island's
lifetime.** The stand-in is a `<Suspense>` whose child suspends on a promise
that never settles. Its fallback is the slot's HTML in a pagedeck-slot element.
The runtime copies the JSON props with `structuredClone` and puts each stand-in
at its path. One shape covers three cases: the dehydrated region in place, a
slot the island places later (the fallback shows the stashed HTML), and a lost
region (the fallback rebuilds it). The runtime reads every region's HTML before
any island on the page mounts, which is #67's rule for tree slots. Read later,
the HTML could already hold a nested island's client state.

**Inside a region, the content belongs to the server wrapper, not to the
island.** While the build renders a region, it restores the enclosing render's
proxy scope. A client component inside the region therefore becomes an island
of its own, with its own marker, instead of HTML that nothing hydrates.

**Element props skip the JSON props check structurally.** The build replaces
each element with `null` before `refusedProps` and `islandProps` run. Element
paths never reach the JSON check or `build.islandPropsBudget`. Only the `null`
placeholders count. Every other refusal stays as it is: functions, symbol keys,
accessors, depth past the limit, and the refused prop names in
`REFUSED_PROP_NAMES` (`__proto__`, `constructor`, `dangerouslySetInnerHTML`,
`key` and `ref`).

**ADR-0006 holds for the new kind unchanged.** A prop path, like a position, is
public and holds no secret, so nothing on the read path authenticates a prop
slot. The three new attributes join `RESERVED_NAMES`, so content that comes
through `unescapedHtml` cannot write a marker's path list, a region mark or a
stash. This file names the attributes by their constants and not by their
values, because this page ships in `@pagedeck/docs`, and a site that renders
it through `unescapedHtml` would rename the values in the text (#258).

**ADR-0005 holds for the new kind, with one difference.** A container that
re-renders around a prop slot drops what it meant to say, silently, because the
stand-in keeps its identity and never renders slot content. Under
`cloneElement`, a tree slot and a prop slot behave differently. A tree slot is
legal and silent, as ADR-0005 pins. A prop slot's stand-in
loses its subtree and the fallback rebuilds the HTML as new DOM. The content
stays, but node identity is lost. A nested island inside the rebuilt region
hydrates again from its server HTML, as a tree slot's does when it mounts
anywhere but in place, so it works but starts from its initial state. The
framework states this and does not guard it, for the reason ADR-0005 gives: no
build-time signal tells a legal handling of a slot from a faulty one. ADR-0005's
harness measures it on the real stand-in (#248): passing a prop slot through,
reordering it, wrapping it or holding it in state never reaches the stand-in
and keeps its node, while `cloneElement` rebuilds each region once, with no
report on either error channel, plain, in `StrictMode` and under the React
Compiler, which leaves the stand-in uncompiled. The nested-island case reads
the same in all four configurations. The table is §7 of
`docs/research/2026-08-26-slot-rerender-detection.md`.

**A prop slot rendered from a list sits inside a keyed element.** A keyed
wrapper (`<li key={id}>`) keeps each region's nodes across a reorder. Bare,
unkeyed sibling regions leave the DOM in server order, and nothing reports it
(#238). The build cannot see the island's client keys, and React already warns
about missing keys in development. So this is a documented rule, not a check.

**Owner: the slot mechanism in `@pagedeck/islands`, and the client-reference
split in `@pagedeck/core`.** Whoever changes either one owns this decision.

## Consequences

A server wrapper can hand a client island elements in `children` or at any
depth of its props, and they arrive as HTML the client keeps. The JSX-children
refusal on a proxied instance goes away, and its fix message goes with it.

The marker carries more bytes: one path per slot, a mark per placed region, and
a stash per unplaced slot. Byte budgets are optional (ruled on #230), so this
costs no budget change.

There is no flight payload. A container still cannot re-render a slot with new
data. That remains the flight-payload direction ADR-0005 leaves open, and it is
out of scope for map #237.

Two boundaries are stated, not closed. `cloneElement` over a prop slot rebuilds
its HTML, and a nested island in it hydrates again with its state reset.
Unkeyed sibling regions keep server order. The island how-to documents both.

The build gains one `prerender` pass per unplaced prop slot. A page with no
proxied instances pays nothing.

## Alternatives considered

**Widen `ISLAND_ID_PATTERN` to admit a dotted prop path.** Rejected. A key
containing a dot would need escaping, and one pattern could no longer tell a
position from a path, so a tree-slot id and a region could each pass for the
other.

**Mark a region with a wrapper element instead of a `<template>`.** Rejected. A
wrapper is invalid inside `<tbody>` and `<tr>`, and it would change the
island's own layout.

**Give entry-tree islands prop slots too.** Rejected for now. One marker could
then carry both kinds, and no request asks for it.

**Leave a nested island inert after a `cloneElement` rebuild.** Rejected
(#247). The stand-in's fallback hydrates the island markers in any DOM it
mounts, which a slot placed after hydration needs anyway, so a rebuilt region's
nested island hydrates again by the same rule tree slots follow.

**Warn in preview when sibling regions reorder without moving.** Rejected.
ADR-0005 bounds preview by what production does, and preview being more capable
than production is the direction that hides a production failure.

**Keep the refusal (`.out-of-scope/proxied-slots.md`).** Overturned. Its reopen
trigger was met: a site where neither documented fix fits (#175).
