# Can a `memo` comparator tell a container's re-render from React's own?

**Date:** 2026-08-26
**Status:** Finding — negative result, recorded. Closes the spike issue #158 asked for.
**Question:** `packages/islands/src/slot.ts` memoises `SlotContent` with a comparator that always reports "equal", so a container that re-renders slotted content with new data has that data dropped with nothing on either error channel. Could the comparator **throw** instead — that is, can it tell a container's re-render from React's own re-invocations, including StrictMode's double render and the React Compiler's memoisation?
**Relates to:** [Flight-free RSC](2026-08-23-flight-free-rsc.md) §4, whose table carries the row this spike was opened to re-test; and the criterion #67 set against spec §14 as the 2026-08-24 review amended it — *"A component attempting to re-render slotted content fails loudly with a message naming the constraint, rather than silently rendering stale DOM"*, in #67's words, inherited by #158.
**Method note:** React 19.2.8 and `react-dom` 19.2.8 in jsdom 30.0.1, driven through `createRoot` under `act`, with a replica of `slot.ts`'s two components whose comparator logs every call. Four configurations, the same seven container shapes in each: plain, `StrictMode`, the repo's own `compileIslands()` React Compiler plugin (`babel-plugin-react-compiler` 1.0.0, `target: "19"`), and Compiler + `StrictMode`. The one claim the replica could not carry — what the *real* comparator is handed — was measured by temporarily replacing `slot.ts`'s `() => true` with a logging comparator and running the whole workspace suite against it.

**Re-running it.** §1–§3 are a committed harness rather than prose about a scratch directory, because §6 says a future React would need them re-measured and the first harness was thrown away:

```
pnpm test:slot-harness
FW_REACT_COMPILER=1 pnpm test:slot-harness
```

`packages/islands/src/slot-rerender.harness.tsx` is the file, and the two commands are the two halves of §3. It is under `src/`, so `pnpm typecheck` compiles it against the module it replicates; the root `vitest.config.ts` includes `*.test.tsx` only, so it does not run in `pnpm test` and costs a normal suite nothing. §4 has no harness and cannot have one — it is a temporary edit to `slot.ts` plus the whole workspace suite, and committing it would mean committing a comparator that is not the one that ships.

---

## Verdict

**Cannot** — and "cannot" is not one argument. Of the seven container shapes measured in §1, **four never reach the comparator and three do**, so the finding is stated as two groups rather than as one absolute.

**Four shapes never reach it, and for those the word is literal.** Passing `children` straight through, reordering them under one parent, `Children.map` into a wrapper, and capturing them in `useState` each produced **zero** comparator calls, in all four configurations. React bails out one level above, at `AdoptedSlot`, on props-object identity: the elements `adoptSlots` built are the same objects on every render of the container, so `oldProps === newProps` and React skips the subtree before `SlotContent` is reconciled. The memo is not what swallows the container's new data — the identity bailout above it is, and no comparator can observe a subtree React declined to enter. A comparator that threw would never run.

**Three shapes do reach it, and for those the word is "cannot without false positives".** They are `cloneElement(child)` with no new props, and a container that renders `SlotContent` itself with the same `html` or with new `html`. The middle one carries no difference at all, so there is nothing for a guard to fire on. The other two carry the **same** difference — `prev.html !== next.html` — and one of them is legal:

- `cloneElement(child)` with no new props arrives with 344 bytes against 433 while the container changed nothing. The difference is `AdoptedSlot`'s own: it swaps the DOM it adopted for the pre-stash snapshot once its first effect has run. `slot.test.tsx` pins that shape as legal and silent ("cloning a slotted child with no new props is allowed, and stays silent").
- A container rendering `SlotContent` itself with new `html` arrives with the same kind of difference, and there it *is* the fault the criterion names.

One signal, two meanings, and nothing in the comparator's arguments separates them. A guard that threw on it would throw on the legal shape, which is the outcome issue #158 ranks below the gap itself.

**And the shape that carries the fault is one no path in the framework emits.** §4 establishes it: `adoptSlots` and the build's `render.tsx` are the only two places that construct `SlotContent`, and a container fed by `adoptSlots` has no channel through which to express new data at all. So on every path production produces, the fault is vacuous; the shape on which it is detectable is a site rendering an exported build-side primitive by hand. §4 also records the one qualification that leaves — what a *partial* guard would cost and what little it would buy.

The criterion is therefore unmeetable **by a comparator**, and the row of the [flight-free RSC](2026-08-23-flight-free-rsc.md) table stays as it reads. What changes is that it now reads on evidence. The decision to accept the boundary is [ADR-0005](../adr/0005-slot-re-render-is-not-detectable.md); this document is the evidence it cites.

---

## 1. The comparator's actual call pattern

Seven container shapes, each mounted and then driven through one or two of its own state changes. `SlotContent` bodies are counted alongside the comparator calls, because they are what tells a mount from a re-render.

The four configurations produced **identical** numbers, so one table serves for all of them; §2 and §3 say what each configuration changed and did not change.

| Container shape | Comparator calls on mount | Comparator calls per re-render | What the comparator was handed |
| --- | --- | --- | --- |
| Passes `children` straight through (`Restyled`, and `slot.test.tsx`'s own fixture) | 0 | **0** | — |
| Reorders them under one parent (`Reversible`) | 0 | **0** | — |
| `Children.map` into a new wrapper element (`Framed`) | 0 | **0** | — |
| Captures them in `useState` and re-renders around them (`Held`) | 0 | **0** | — |
| `cloneElement(child)` with no new props (`Recloned`) | 0 | 1 per child | **`html` differs**, and the container changed nothing — §4 |
| Renders `SlotContent` itself, same `html` (`DirectSame`) | 0 | 1 | equal by value |
| Renders `SlotContent` itself, new `html` (`DirectSlot`) | 0 | 1 | **`html` differs** |

Read the first four rows together: they are every way a container is supposed to treat a slotted child, and all four are invisible to the comparator. React's bailout is `oldProps === newProps` on the `AdoptedSlot` fiber, and `adoptSlots` hands out one element per slot for the container's lifetime, so that test passes on every re-render. `Children.map` does not break it either — it re-keys through `cloneAndReplaceKey`, which carries the **same props object** over, which is why row three reads the same as rows one and two.

The last three rows are the ones that get through. Two of them carry a difference, and they carry the same one: the last row's is the container's new markup, which is the fault, and row five's is `AdoptedSlot`'s own source flip on a container that changed nothing, which is legal. §4 is that pair.

## 2. StrictMode

**StrictMode adds no comparator call. It doubles the render function and nothing else.**

Measured on `Restyled` with two slots: two `SlotContent` bodies on mount without StrictMode, four with it, and **zero** comparator calls either way. The same holds for the reorder and `Children.map` shapes. On `DirectSlot` — the one shape with a real difference to report — StrictMode produced **one** comparator call, the same as without it, with the same `prev`/`next`.

So the hazard issue #158 named — "StrictMode double-renders … call comparators
in ways a naive guard would read as a re-render" — is real in kind and absent in
fact: the double render is a second invocation of the *parent's* render function inside one reconciliation pass, not a second reconciliation. The child element the second invocation produced is the only one React reconciles against. A guard would not have false-fired here. It also would not have fired at all.

## 3. The React Compiler

**Exercisable, exercised, and it changed nothing.** This is the repo's own integration rather than a hypothetical: the spike ran under a Vite config carrying `@fw/core`'s `compileIslands()` plugin, and the compiler's output is visible in the transformed module — `import { c as _c } from "react/compiler-runtime"` at the head of the harness, which is the plugin's `target: "19"` memo cache and the proof the pass ran rather than a claim that it did.

Every number in §1's table is the same compiled as uncompiled, StrictMode or not. That direction is the expected one and worth stating plainly: the compiler's job is to hold element identity *stable* across renders, so where it acts at all it makes the identity bailout above `SlotContent` fire more readily, never less. It cannot manufacture a comparator call that the uncompiled code did not make.

**Why the numbers are unchanged rather than merely unsurprising**, which the committed harness added to this section: the compiler **refuses `AdoptedSlot`**. It reports `Cannot access refs during render` — the ref `AdoptedSlot` holds for issue #114 goes into `createElement`'s props — and `panicThreshold` is left at its default, so the component is emitted as written, with no memo cache. The whole subtree between a container and `SlotContent` is therefore uncompiled code in every build the framework produces. Measured by running `compileIslands()` over `slot.ts` itself and reading the output.

That is worth knowing in the other direction too. When the harness's replica of `AdoptedSlot` was first written *without* the ref, the compiler took it and cached its returned element on `adopt.inPlace` — a `Set` the real code **mutates** rather than replaces, so the cache key never changes, the source flip never happened, and the `Recloned` row measured 0 compiled against 2 uncompiled. That number was about the replica and not about the framework, and it is the reason the harness carries a ref it otherwise has no use for.

The one thing this spike did **not** test is a compiled *container* that constructs `SlotContent` elements itself, because nothing in the framework does: on the client `adoptSlots` builds them, and on the build side `render.tsx` builds them in a single pass that never re-renders.

## 4. The false-fire, measured on the real module

§1's `Recloned` row is the whole of the guard's problem, and the replica is not evidence enough for it, so it was measured against `slot.ts` itself. The comparator was temporarily replaced with one that logs `prev`/`next` and still returns `true`, and the workspace suite was run against a fixture built from `slot.test.tsx`'s own machinery: a `Recloned` container over a panel holding a nested `Tabs` container with a stashed second tab.

Across the **entire** workspace suite the real comparator was reached **once**, and this is the call:

```
PROBE slot=0.0/0.0 equalHtml=false prevLen=344 nextLen=433
```

The container added no props, removed none, and changed nothing about the child. The difference is `AdoptedSlot`'s own, and it is deliberate — `source` is the DOM the slot adopted while `adopt.inPlace` still holds the id, and the pre-stash snapshot out of `adopt.slots` once the first effect has deleted it, because a rebuild needs the stash back and an adoption must not have it. The 89 bytes between 344 and 433 are the nested container's `<template>`.

A comparator that threw on `prev.html !== next.html` would therefore throw on a container doing something `slot.test.tsx` asserts is allowed and silent — "cloning a slotted child with no new props is allowed, and stays silent", which mounts a `Recloned` container, clicks it into a re-render and finds both panels unmoved and both error channels empty. That is the outcome issue #158 ranks below the gap itself, in the words it opened with: *"A guard that false-fires in a live page is worse than the gap it closes."*

### Why removing the false-fire would not rescue the guard

`AdoptedSlot` could be rewritten to hand `SlotContent` a stable string, and the false-fire would go with it. An earlier draft of this document dismissed that in one line — the guard would then "fire on nothing at all" — and its own table refutes it: §1's last row is a container rendering `SlotContent` with new `html`, and that row **does** reach the comparator with `html` differing. A guard freed of the false-fire would fire on it, correctly. The honest argument is a different one, and it is stronger.

**A container fed by `adoptSlots` cannot express new data at all.** That is what makes the fault vacuous rather than undetectable on every path production produces, and it is a property of the wire format rather than of the comparator:

- `adoptSlots` (`packages/islands/src/slot.ts`) builds one `AdoptedSlot` element per slot, once, out of the DOM under the marker and the stash the runtime kept. Its `html` is read at that moment and never again. The container receives those elements as `children` and has no argument, prop or callback that reaches the string — a slotted child is opaque by construction.
- `mount()` in `packages/islands/src/runtime.ts` (the `import("./slot.js")` at line 680) is the only caller of `adoptSlots`, and it is reached once per container marker, at hydration.
- The one other place in the framework that constructs `SlotContent` is `render.tsx`'s `islandElement` (`packages/core/src/render.tsx:590`), on the build side, in a pass that renders once and never re-renders.

So there is no framework path on which a container *has* new data for a slotted child. Rows five through seven of §1's table are shapes the framework never emits: a container reaching `SlotContent` itself. The criterion's literal fault is detectable exactly where the framework does not produce it.

**The one qualification, and it is not "test-only".** `SlotContent` is exported from `@fw/islands`' index (`packages/islands/src/index.ts`, pinned by `index.test.ts`), so a site component can render it directly with a string of its own. `@fw/core`'s `tree.tsx` already names that as one of the two ways past the content boundary #109 draws, alongside calling `dangerouslySetInnerHTML`. Such a component re-rendering with a new string is the fault, it is not a test fixture, and after the rewrite above a comparator could catch it. What that would be worth:

- It catches nothing the framework emits — only a site using a build-side primitive by hand, already past the boundary the framework claims.
- It costs the two-string mechanism in `AdoptedSlot`, which exists because hydrating and rebuilding a slot genuinely need different markup (sharing one was measured: a container nested two deep comes back with every unrendered slot gone).
- Until that rewrite lands it is not available at all, because the legal shape and the fault arrive at the comparator carrying the identical signal.

That is a real option and it is not the one #158 asked for. It is recorded here so the verdict is not read as broader than what was measured: **not detectable on any path the framework produces, by a comparator or otherwise, because there is nothing there to detect** — and detectable off those paths only at the cost above.

## 5. What is therefore unmeetable, and what is not

The criterion #67 wrote against spec §14's amendment, inherited by #158 — *"A component attempting to re-render slotted content fails loudly with a message naming the constraint, rather than silently rendering stale DOM"* — **cannot be met by `SlotContent`'s comparator**, on the evidence above. That is the specific claim this document supports.

What it does not claim is that the criterion is unmeetable by anything. Two directions are untried and neither is small:

- **Refuse at the container's own boundary rather than at the slot's.** `AdoptedSlot` is unmemoised and does re-render, so a guard placed there sees what the comparator cannot. It also sees the `Recloned` case, and would need a way to tell a container's second render from `AdoptedSlot`'s own `source` flip — which is a state machine, not a predicate.
- **Give the container something other than an opaque node.** The whole gap is a consequence of §4's downgrade in [flight-free RSC](2026-08-23-flight-free-rsc.md): a container holding real elements would have nothing to detect, because a re-render would simply work. That is the flight payload, and §4 is the measurement of what dropping it costs rather than a decision to drop it — that document's status is "Decision input — no decision taken". What §4 establishes is the downgrade itself: across the flight a slotted child is an ordinary React element, and the opaque HTML string the framework hands a container instead is what turns "re-render it with new data" into a **no** in §4's table.

Neither is what #158 asked for, and neither is opened by this document.

## 6. What remains unverified

- **A real browser.** All of it is jsdom 30.0.1. The bailout under test is React's own reconciler and has no DOM in it, so a browser is unlikely to differ — but it was not run in one.
- **`hydrateRoot` rather than `createRoot`** in the replica harness. The real path hydrates. The §4 measurement, which is the one that touches `slot.ts`, went through `hydrateIslands` and therefore through `hydrateRoot`; §1's table did not.
- **React beyond 19.2.8.** The props-identity bailout is not an API React documents as a guarantee. It is an optimisation, and a release is free to stop taking it — at which point §1's first four rows would start producing calls. That is the event [ADR-0005](../adr/0005-slot-re-render-is-not-detectable.md) names as reopening the decision, and the harness in the method note is how it is checked: the four zero rows are assertions, so a React that stopped taking the bailout fails them rather than going unnoticed.
