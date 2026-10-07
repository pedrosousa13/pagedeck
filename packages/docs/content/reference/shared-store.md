---
section: reference
title: Shared store
description: Share state between separate island roots through the atom store the framework ships: declaring atoms, reading and writing them, and hydrating them.
---

# Shared store

Islands are independent React roots, so React Context carries nothing between
them. State two islands share lives outside React, in one module, and the
framework ships that module: `@pagedeck/islands/store`.

Everything a site needs to use it comes from the same place, including Jotai's
own `atom` and hooks. Do not add `jotai` to the site's own dependencies — a
second copy of the library is a second `atom` factory, and atoms are compared by
object identity.

## Declaring atoms

```ts
// site/atoms.ts
import { atom } from "@pagedeck/islands/store";

export const cartCount = atom(0);
cartCount.debugLabel = "cartCount";
```

The `debugLabel` is optional and worth writing: it is how an atom is named if
the framework ever reports something about it.

## Delivering the store to every island root

The store reaches components through the root provider stack
(`build.rootProviders`), which the build wraps the page render in and the
runtime replays around every island root:

```ts
// site/providers.ts
import { Provider, store } from "@pagedeck/islands/store";

export default [{ component: Provider, props: { store } }];
```

```ts
// pagedeck.config.ts
import providers from "./site/providers.js";

export default defineConfig({
  build: {
    rootProviders: { stack: providers, module: "./site/providers.js" },
  },
});
```

Both halves, always. `stack` is what the build renders with and `module` is what
the generated island entry imports in the browser; declaring one without the
other is refused at config load.

## Reading and writing

```tsx
"use client";
import { useAtom } from "@pagedeck/islands/store";
import { cartCount } from "../atoms.js";

export default function CartBadge() {
  const [count, setCount] = useAtom(cartCount);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

Any island on the page reading `cartCount` sees that write, whichever chunk it
shipped in and whenever it hydrated. So does plain JavaScript with no React
involved: `store.set(cartCount, 3)`.

## Hydrating from the page

Server values go into the store **once, from the page, before any root mounts**:

```ts
import { hydrateStore } from "@pagedeck/islands/store";
import { cartCount } from "./atoms.js";

hydrateStore([[cartCount, initialCount]]);
```

Not from a hook inside a component. An atom hydrates once per store, and island
hydration order is not controlled under the `visible` and `idle` strategies — so
a value handed over by the second island to hydrate would be dropped, and which
island that is depends on where the reader scrolled. Hydrating from the page
takes the question away. A second hydration of an atom keeps the first value and
reports the drop in the browser console.

## Callbacks and other escape hatches

Jotai's `useAtomCallback` reads the *default* store unless it is passed
`{ store }`, and says nothing when it does. On a page built this way that
default store is one nothing else uses, so a callback that fell through to it
would read stale values and write into nowhere. Use the framework's hook, which
threads the store for you:

```tsx
import { useStoreCallback } from "@pagedeck/islands/store";

function AddToCart({ sku }: { sku: string }) {
  const addToCart = useStoreCallback((get, set) => {
    set(cartCount, get(cartCount) + 1);
  });
  return <button onClick={() => addToCart()}>Add {sku}</button>;
}
```

**Nothing else from `jotai/utils` is re-exported, and that is deliberate rather
than an oversight.** `useHydrateAtoms` is the one this framework replaces —
`hydrateStore` above exists because a hook cannot hydrate before roots mount.
The rest of that module builds atoms rather than reaching stores
(`selectAtom`, `atomFamily`, `atomWithStorage`), so nothing about them would
change here, and re-exporting a surface no site has asked for yet would be
guessing at which half of it matters. If you need one, say which and why: the
re-export block in `packages/islands/src/store.ts` is where it goes, and the
door stays shut rather than being left half open.

## What happens if there are two stores

Two stores share nothing — every component still renders, and state simply stops
crossing islands. Nothing in Jotai reports this: its own duplicate-instance
warning lives inside `getDefaultStore()`, which this design never calls.

Three things stand between a site and that page:

- The build asserts on the emitted chunk graph that no module is in two chunks,
  and fails naming the module. This is the real guarantee, and it runs where the
  fault can still be fixed.
- The store module stamps `globalThis`, so a second copy of the module adopts the
  first copy's store instead of minting one. A module evaluated twice therefore
  yields one store, which is why a linked monorepo package under `pagedeck dev` — which
  Vite legitimately evaluates twice — costs nothing.
- What is left — a store the framework did not mint, delivered by the `Provider`
  above — is checked wherever the stack is applied. `pagedeck build`, `pagedeck dev` and a
  preview app all refuse it; only a shipped page reports it and carries on,
  because a canary should not take a visitor's page away.

A store you create yourself and deliver through a provider of your own is not
this check's business, and builds. The check reads one prop of one component:
the `store` prop of the `Provider` this package exports.

## Version

Jotai is pinned to an exact version rather than a range, because the multi-root
behaviour this design rests on is not something Jotai documents. Upgrading it is
a decision to re-verify, not a patch bump.
