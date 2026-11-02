---
section: how-to
title: Add an island
description: Write a "use client" component, place it on one page, choose when it hydrates, and pass it server-rendered elements.
---

# Add an island

This page adds an island to the site `npm create pagedeck` writes. If you have no site
yet, [Your first site](../tutorials/your-first-site.md) makes one. Every file below
is relative to the site's directory.

The island is a greeting, a text box and a line that answers with what you
type. It needs JavaScript, because it changes after the page has loaded.

## 1. Write the component

Save this as `components/greeting.tsx`:

```tsx
"use client";

import { useState } from "react";

export default function Greeting() {
  const [name, setName] = useState("");
  return (
    <p>
      <label>
        Your name <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <output>Hello, {name === "" ? "whoever you are" : name}.</output>
    </p>
  );
}
```

The first line, `"use client"`, is the whole opt-in. It goes once, in the
component's own module. A page that uses the component writes nothing extra,
and a component without the line renders to HTML and ships no JavaScript.
[Why this site ships no JavaScript](../explanation/why-this-site-ships-no-javascript.md)
explains where the build gets the script tag from.
The build compiles an island with [React Compiler](../reference/react-compiler.md),
which memoizes its components for you and warns about one it has to skip.

Register the component under a name, in `build.components` in `pagedeck.config.ts`:

```ts
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
  greeting: "./components/greeting.tsx",
},
```

A registered module can also hold its islands as named exports. A component
that imports `{ Header, Footer }` from one and renders both puts two islands on
the page, and each hydrates as its own export. A name in a page's `components`
list stands for the module's default export.

## 2. Put it on one page

A page names its components in its frontmatter. Save this as `content/greet.md`:

```
---
components: [greeting]
---

# Greet

Type your name, and the box below answers.
```

The layout renders `greeting` after the page's text, where it puts its
`children`. [Rendering a page](../reference/site-config.md#rendering-a-page) covers
the `components` list and the names it accepts.

Sync the new page into the store, and build:

```sh
npx pagedeck sync
npx pagedeck build
```

`site/greet/index.html` has a `<script>` tag, which loads the greeting.
`site/about/index.html` and `site/index.html` have none.
The build bundles an island's JavaScript for the pages that name it and for no
other page.

## 3. Choose when it hydrates

The build renders the greeting to HTML. In the browser, the island hydrates,
which means its JavaScript loads and the box starts to answer. A component's
registry row says when, with `hydrate`:

- **`"load"`** hydrates as soon as the page's script runs. Pick it for
  something a visitor uses the moment the page opens.
- **`"idle"`** hydrates when the browser has finished loading the page. Pick
  it for something a visitor needs soon but not first.
- **`"interaction"`** hydrates on the first focus or press inside the island.
  Pick it for something many visitors never touch. The
  [site search](../reference/site-search.md) box hydrates on `interaction`.
  The press that hydrates the island is not replayed, so a button pressed
  before hydration must be pressed again.
- **`"visible"`** hydrates when the island scrolls into view. This is what
  `"use client"` gives you with no `hydrate`. Pick it for anything below the
  first screen.
- **`"none"`** never hydrates. It is what a component without `"use client"`
  gets, and the build refuses it on a module that has the line. To stop an
  island shipping JavaScript, delete `"use client"` from its module.

With no `hydrate`, the build also moves the island for you.
[Fold strategy](../reference/fold-strategy.md) promotes an island near the top of
its page to `load`, which is what happens to the counter and to the greeting:
each is the second node of its page. An explicit `hydrate` is never promoted,
but an explicit `"load"` below the fold is demoted to `visible`.
[What gets moved](../reference/fold-strategy.md#what-gets-moved-and-what-never-does)
has the full table.

Each island is wrapped in a `<pagedeck-island>` element. Once the island's
tree has hydrated, the islands runtime sets `data-pagedeck-hydrated` on that
element. The built HTML never carries it, and an island whose JavaScript fails
to load never gets it. The attribute means the island's root has committed: an
error that the island's own error boundary catches still leaves the island
marked, and a `<Suspense>` boundary inside the island can still be waiting
when the attribute appears. A test or a script that must wait for every island on a page
waits until `pagedeck-island:not([data-pagedeck-hydrated])` matches nothing,
and one island is ready when its own element matches
`pagedeck-island[data-pagedeck-hydrated]`.

Pin the greeting to `idle`, so its JavaScript waits until the page has
loaded. Change its row in `pagedeck.config.ts`:

```ts
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
  greeting: { path: "./components/greeting.tsx", hydrate: "idle" },
},
```

To fail the build when a page ships more JavaScript than you allow, declare a
[JavaScript budget](../reference/javascript-budgets.md). A budget is optional.

## 4. Pass server-rendered elements to an island

A server component can render an island and hand it elements: as `children`,
or anywhere inside a prop made of plain objects and arrays. Each element is a
**prop slot**. The build renders it once, on the server, and the browser keeps
that HTML. The island places the slot, but never renders what is inside it.

Save this as `components/card-list.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { ReactNode } from "react";

export default function CardList({
  items,
  children,
}: {
  items: { id: string; node: ReactNode }[];
  children?: ReactNode;
}) {
  const [reversed, setReversed] = useState(false);
  const shown = reversed ? [...items].reverse() : items;
  return (
    <section>
      <button type="button" onClick={() => setReversed(!reversed)}>
        Reverse
      </button>
      <ul>
        {shown.map((item) => (
          <li key={item.id}>{item.node}</li>
        ))}
      </ul>
      {children}
    </section>
  );
}
```

A server component renders it. Save this as `components/cards.tsx`:

```tsx
import CardList from "./card-list.tsx";

function Card({ name }: { name: string }) {
  return (
    <article>
      <h3>{name}</h3>
    </article>
  );
}

export default function Cards() {
  return (
    <CardList items={["Alpha", "Beta"].map((name) => ({ id: name, node: <Card name={name} /> }))}>
      <p>Two cards</p>
    </CardList>
  );
}
```

Register both components in `pagedeck.config.ts`:

```ts
components: {
  layout: "./components/layout.tsx",
  counter: "./components/counter.tsx",
  greeting: { path: "./components/greeting.tsx", hydrate: "idle" },
  cards: "./components/cards.tsx",
  "card-list": "./components/card-list.tsx",
},
```

Put the list on a page of its own. Save this as `content/cards.md`:

```
---
components: [cards]
---

# Cards
```

Sync and build again:

```sh
npx pagedeck sync
npx pagedeck build
```

`site/cards/index.html` loads one island, the list. `Card` ships no
JavaScript: its HTML reaches the browser inside the list's three prop slots,
`items[0].node`, `items[1].node` and `children`. A client component inside a
prop slot becomes an island of its own.

Follow these rules for a prop slot:

- **Put a slot rendered from a list inside a keyed element**, as `<li key>`
  above. A keyed wrapper moves the slot's HTML when the list reorders. Bare
  sibling slots stay in server order, and nothing reports it.
- **The island cannot change a slot's content.** A container that re-renders
  a slot with new data drops that data silently. To show different content,
  pass a different element from the server.
- **`cloneElement` over a slot rebuilds it.** The content stays, but as new DOM
  nodes. An island inside the rebuilt slot hydrates again and starts from its
  initial state.
- **A slot the island does not render on the server still works.** The build
  stores its HTML, and the slot shows that HTML when the island places it
  later, after a state change. An island inside it hydrates when it appears.
- **Render each slot once.** The build refuses an island that renders the same
  slot in two places.

The build looks for prop slots only in plain objects and arrays. It refuses an
element inside a `Map`, a `Set` or a class instance, because serializing that
container would drop the element. Move the element into a plain object or an
array.

Every other prop must still be data that JSON can hold. The build refuses:

- a function
- a symbol key
- an accessor
- a value nested more than 32 levels deep
- a prop named `__proto__`, `constructor`, `dangerouslySetInnerHTML`, `key` or
  `ref`

Prop slots belong only to an island that another component renders. An island
the page places itself, by a name in its `components` list or as a node of the
tree `build.content` returns, takes its node's children as **tree slots**, and
the build refuses an element in any of its other props.
