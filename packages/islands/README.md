# `@pagedeck/islands`

The component registry, and the browser runtime that hydrates islands. A
component whose module starts with `"use client"` is an island: the build
renders it to HTML like any other component, then bundles its code for the
pages that render it, and the runtime hydrates it in the browser. A page with
no island loads none of this.

```sh
npm install @pagedeck/islands react react-dom
```

A site created with `npm create pagedeck` has one island,
`components/counter.tsx`:

```tsx
"use client";

import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  );
}
```

Its `pagedeck.config.ts` declares each component once, by name and by the path
of its module, relative to the config file:

```ts
// Inside defineConfig({ build: { ... } }):
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
},
```

A component that an installed package ships is declared by its package
specifier, such as `"@acme/design-system/components/hero"`. A design system
can export its registry through `defineComponents`, which checks each entry's
shape, and a site merges it with its own through `mergeComponents`.

A page renders the counter by naming it in its tree, as
`{ component: "counter" }`. Only `/counter` does, so only `/counter` ships
JavaScript. The whole config is in [`@pagedeck/core`'s README](https://www.npmjs.com/package/@pagedeck/core).

An island hydrates when it scrolls into view, unless it sits near the top of
the page, where the build hydrates it on load. To choose for yourself, declare
it as `{ path: "./components/counter.tsx", hydrate: "load" }`, with `"load"`,
`"idle"`, `"visible"`, `"interaction"` or `"none"`. `"interaction"` hydrates on
the first focus or press inside the island, and does not replay that event. The build can still move a declared `"load"`
to `"visible"` on a page where the island sits far down. `"none"` renders a component on the server only, and the build
refuses it for a module that starts with `"use client"`.

## Read more

- [Fold strategy](https://pagedeck-docs.pedrodsousa.workers.dev/reference/fold-strategy/) covers when each
  island hydrates, and how the build moves islands near the top of a page to
  `load`.
- [Shared store](https://pagedeck-docs.pedrodsousa.workers.dev/reference/shared-store/) shares state
  between islands.
- [JavaScript budgets](https://pagedeck-docs.pedrodsousa.workers.dev/reference/javascript-budgets/) caps
  what each page may ship.
