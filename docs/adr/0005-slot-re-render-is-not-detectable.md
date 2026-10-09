---
title: 5. A container re-rendering slotted content is not detected, and that is accepted
description: A container re-rendering slotted content goes undetected, and the framework records that limit rather than guarding it with a check that misfires.
---

# 5. A container re-rendering slotted content is not detected, and that is accepted

Date: 2026-08-26

## Status

Accepted. No code change attached: the boundary is what the framework already
does, and this records the decision to keep doing it. Raised by #158, on the
criterion #67 left open. `packages/islands/src/slot.ts` is the mechanism,
`docs/research/2026-08-26-slot-rerender-detection.md` is the evidence, and
`packages/islands/src/slot.test.tsx` pins the behaviour.

## Context

Spec §14, as the 2026-08-24 review amended it, asks that the operations
production forbids — `React.Children`/`cloneElement` over slotted content, and
re-rendering it — *"assert loudly in preview rather than working silently"*.
#67 turned that into the criterion this row is measured against: *"A component
attempting to re-render slotted content fails loudly with a message naming the
constraint, rather than silently rendering stale DOM"*. Every other row of
`slot.ts`'s table is met — injected props, one child mounted twice, and the
build's own duplicate refusal all name the container and the child — and this
row is not. A container that re-renders around a slotted child has whatever it
was trying to say dropped, with nothing on either error channel.

#67 left the row reading "not detectable" on an argument. #158 asked whether the
`memo` comparator on `SlotContent` could be the guard: it is already the thing
that reports "equal" on every render, so a comparator that threw instead would
be a one-line fix if it could tell a container's re-render from React's own
re-invocations.

The spike measured it, on React 19.2.8 across four configurations — plain,
`StrictMode`, `@fw/core`'s `compileIslands()` React Compiler pass, and both
together — over seven container shapes. Three findings decide this, and the
research document carries the numbers:

**Four of the seven shapes never reach the comparator.** Passing `children`
through, reordering them under one parent, `Children.map` into a wrapper, and
holding them in `useState` each produce zero comparator calls. React bails out
one level above, at `AdoptedSlot`, on props-object identity: `adoptSlots` builds
one element per slot for the container's lifetime, so `oldProps === newProps` on
every render and React skips the subtree. The memo is not what swallows the
container's data; the bailout above it is, and no comparator can observe a
subtree React declined to enter.

**Of the three that do reach it, the legal shape and the faulty one carry the
same signal.** `cloneElement(child)` with no new props gets past the identity
bailout and arrives with `prev.html !== next.html` — 344 bytes against 433 —
while the container changed nothing, because `AdoptedSlot` swaps the DOM it
adopted for the pre-stash snapshot once its first effect has run. A container
that renders `SlotContent` itself with new markup arrives carrying the same kind
of difference, and there it is the fault. One signal, two meanings.

**The shape that carries the fault is one the framework never emits.**
`adoptSlots` on the client and `render.tsx`'s single build pass are the only two
places that construct `SlotContent`, and a container fed by `adoptSlots` has no
channel through which to express new data at all: the markup is read off the DOM
once, at mount, and a slotted child is opaque by construction. The fault is
therefore vacuous on every path the framework produces.

## Decision

**The framework accepts that a container's re-render of slotted content is
silent, and states it rather than guarding it.** #67's "fails loudly" half stays
unmet for this one row. This file says why, and `slot.test.tsx` pins both the
silence and the shapes that are legal, so the boundary is measured rather than
claimed.

**The comparator stays `() => true`.** Not because a throw is expensive, but
because on every path the framework produces there is nothing to throw on, and
on the one path where a difference is visible the difference belongs to
`AdoptedSlot` rather than to the container. The ranking that decides the rest is
the one #158 opened with, under "Why it is not just a docblock fix": *"A guard
that false-fires in a live page is worse than the gap it closes."* That is the
maintainer's framing of the problem this ADR answers, not a repo-wide standard.

**Preview does not close it either, and must not.** `packages/preview`'s parity
module is bounded by what production does (spec §14, the 2026-08-24 review), and
being *more* capable than production is the direction that masks a production
failure from the editor preview exists for. Preview drops the container's data
silently too, which is parity.

**This does not accept the gap as unclosable by anything.** Two directions stay
open and neither is small: refusing at `AdoptedSlot`, which is unmemoised and
does re-render but would need a state machine rather than a predicate to tell a
container's second render from its own source flip; and giving containers real
elements rather than opaque nodes, which means the flight payload.
`docs/research/2026-08-23-flight-free-rsc.md` §4 is what that direction would
cost and buy: across the flight a slotted child arrives as an ordinary React
element a container can re-render, and the opaque-HTML downgrade the framework
runs instead is what turns "re-render it with new data" into a **no** in §4's
table. That document decides nothing — its status is "Decision input — no
decision taken" — it measures the downgrade. Either direction is its own piece
of work. Neither is opened here.

**Owner: the slot mechanism in `@fw/islands`.** Whoever changes `slot.ts` owns
this row. It was #67's criterion and #67 is closed, so a reader looking for who
holds the gap finds this file.

## Consequences

A container island that re-renders around a slotted child renders the DOM that
is already there. The data it meant to push is dropped, and nothing is logged.
That is the cost, and it is paid against a guard that would fire on
`cloneElement(child)` with no new props — a shape `slot.test.tsx` pins as legal
and silent — in a browser, on a page a visitor is looking at.

The boundary is pinned at the point of use rather than only stated here:
`slot.test.tsx` holds the silence and the legal shapes, so a change that
crosses the boundary fails there.

The research document is the evidence and this is the decision, which is why
both exist. **Most of the measurement can be re-run, and one part cannot.** The
harness is `packages/islands/src/slot-rerender.harness.tsx`, excluded from
`pnpm test` by the root config's `*.test.tsx` include and run by
`pnpm test:slot-harness` through `packages/islands/vitest.harness.config.ts`. It
covers the research document's §1–§3 — the call pattern, StrictMode and the
compiler — over a replica of `slot.ts`'s two components. It does **not** cover
§4, which is the only measurement against the real module and the source of the
"344 bytes against 433" this ADR's Context states.
§4 has no harness and cannot have one: it is a temporary edit replacing
`slot.ts`'s shipped comparator with a logging one, plus the whole workspace
suite, and committing it would mean committing a comparator that is not the one
that ships. Re-checking that figure is a manual re-run of that edit, as the
research document's method note says.

**A future React invalidating the props-identity bailout reopens this.** The
bailout is an optimisation React does not document as a guarantee, and the
first four rows of the spike's table are zeroes only because React takes it. A
release that stops taking it would start delivering a container's re-renders to
the comparator, at which point the question #158 asked has a different answer and
this decision should be re-argued rather than inherited. The harness asserts
those four zeroes, so the change surfaces as a failing run instead of as a
document that quietly stopped being true.

## Alternatives considered

**Throw from the comparator on `prev.html !== next.html`.** Rejected on
measurement. It fires on none of the four shapes a container normally uses,
because it is never called on them, and it fires on `cloneElement(child)` with
no new props, which is legal. That is a guard with no true positives and one
false positive.

**Rewrite `AdoptedSlot` to hand `SlotContent` a stable string, then throw.**
Rejected as out of proportion. It would remove the false-fire and leave a guard
that catches exactly one shape: a site component rendering the exported
`SlotContent` by hand with markup of its own — already past the content boundary
#109 draws, and not a shape the framework emits. The cost is the two-string
mechanism in `AdoptedSlot`, which exists because hydrating a slot and rebuilding
one genuinely need different markup: with one string shared, a container
nested two deep came back with every unrendered slot gone. Recorded rather than
dismissed, because it is the one way
the row could partly move.

**Leave the reason in a docblock alone.** Rejected, and it is why this file
exists. #158's criterion asked for an ADR specifically, so that the boundary has
an owner and a date rather than a paragraph. A docblock says what the code does;
it does not record that the project looked at the alternative and declined it.

**Count renders inside `SlotContent` instead of comparing props.** Rejected on
the same measurement as the comparator. `SlotContent`'s body does not run on a
container's re-render either — React never reconciles it — so a counter there
sees exactly what the comparator sees, which is nothing.
