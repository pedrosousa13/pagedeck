---
section: reference
title: Page body
description: The build writes one main landmark around each page's rendered tree, refuses a component that renders its own, and puts page chrome beside it.
---

# Page body

Every document `pagedeck build` emits has one `<main>` landmark, and the framework
writes it. Your page's rendered tree goes inside it. A header, a nav or a footer
that should sit beside it goes in `build.chrome`.

```html
<body>
  <!-- build.chrome, before -->
  <main>
    <!-- the page's rendered tree -->
    <!-- facade placeholders with no mount point -->
  </main>
  <!-- build.chrome, after -->
  <!-- the build's own script elements -->
</body>
```

## The one `<main>`

A document may hold exactly one `main` landmark, so it is a singleton, like the
`<head>`'s `<title>` (see [Page head](./page-head.md)). The build writes it
around the page's tree on every page, and no component writes one.

It cannot be a component's job, because of what a CMS page is. A page composed
from a flat list of blocks has no component that owns the whole page, so there
is nowhere in the tree for a landmark to go, and the content would sit in no
landmark at all. A site that asked each root component to render one could
forget, and a page that mounts two root components would get two.

Nothing about the wrap is conditional. The build does not skip it for a tree
that already holds a `<main>`, and a component cannot opt out of it.

## A component that renders `<main>` is refused

The build counts the `<main>` elements in each finished document, and a second
one fails the build with a `RenderError`:

```
Entry /en/: 2 <main> landmarks in one document — the build writes one around the page's whole rendered tree, so a component that renders its own nests inside it and axe reports landmark-main-is-top-level; render <section>, <div> or a fragment in the component instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

The reason is accessibility. A component's `<main>` nests inside the build's,
and a nested landmark is exactly what axe's `landmark-main-is-top-level`
reports.

**The message names the page, not the component.** A document does not record
which component wrote a tag, and a page composed from CMS blocks has several
candidates. Look at the components that page renders, and change the one that
renders `<main>` to a `<section>`, a `<div>` or a fragment.

**It counts what was emitted, not what was written in source.** A component that
renders `<main>` only behind a condition is refused on the pages where the
condition holds. Markup that reaches the body as raw HTML, such as a rich-text
field, is counted too: however the tag got there, it opens a second landmark.

`pagedeck dev` composes each page with the same function, so the dev server refuses
the same page and shows the same message in its error overlay.

## Chrome: markup beside the landmark

`build.chrome` is the one way to put markup outside `<main>`. It is a callback
with the two arguments `build.content` takes, the page and the content store, and it
returns two lists of entry nodes:

```ts
build: {
  outDir: "./site",
  chrome: (page) => ({
    before: [{ component: "Nav", props: { current: page.path } }],
    after: [{ component: "Footer" }],
  }),
  // ...
}
```

`before` renders ahead of `<main>` and `after` renders after `</main>`, so the
header or nav, the landmark and the footer are siblings in `<body>`. You can
leave either list out. Return `undefined` and the page has no chrome.

A top-level `<nav>` placed in the page tree instead is inside the landmark, and a
screen-reader user who jumps to the main landmark to skip the navigation lands
in front of it.

**It is called once for each page it renders.** That is how a nav marks the
current page: the callback hands it `page.path`, or anything else it reads off
the page, as a prop.

**Its nodes go through the same render as the page's own.** They resolve
through `components`, render under `rootProviders` and the page's locale,
hydrate as islands like any other node, join the page's JavaScript entry and its
class manifest. A `<title>` or `<meta>` they render is taken out of the body and
written into the page's `<head>`, as a page component's is.

A site that declares no `chrome` gets documents that are byte for byte what the
build wrote before the field existed.

### What the chrome cannot hold

**A `<main>`.** The chrome is refused before the landmark count runs, with a
message that names `build.chrome` rather than the page's components:

```
Entry /en/: build.chrome rendered a <main> landmark — the build writes the one <main> around the page tree and places the chrome before and after it, so a landmark in the chrome is a second one and is not taken in place of the build's; render <header>, <nav>, <footer> or a <div> in the chrome instead (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

This holds even for a chrome whose `<main>` would be the page's only one if the
build did not write its own. The build always writes its own, and the chrome's
is not taken in its place.

**A facade's mount point.** A facade's placeholder goes inside the landmark with
the page's content, so an element that only the chrome renders cannot hold one, and
the build refuses it. Move the element into the page tree. See
[Third-party scripts](./third-party-scripts.md) for mount points.

### Chrome and incremental builds

A chrome that reads the content store reads it for the page it is called with, so the
entries it reads are that page's dependencies and belong in its `dependsOn`, as
they would for `content`. An incremental build re-renders a page only when an
entry it depends on changes. It does not re-render anything because the chrome's
code changed.

**A nav built from a whole collection goes stale when that collection gains an
entry.** `pagedeck build --incremental` renders the new page, with the new link in its
nav, and carries every other page off the output tree as it was, without the
link. `dependsOn` cannot name an entry that did not exist at the last build. An
edit or a removal is covered when every page declares the collection's entries.
So a site whose chrome lists a collection runs a full `pagedeck build` when that
collection gains an entry.

**A carried page holding a second `<main>` is refused.** An incremental build
reads a page it does not render back off the output tree, so those bytes never
reach the landmark count above. It counts them as it reads them, and a document
a build older than the refusal wrote with two landmarks fails with a
`ConfigError`:

```
Output "/site/dist": 1 reused page cannot be carried from the previous build — an incremental build reads a page it does not render back off this tree rather than composing it again, so a document the previous manifest does not name, or that this tree does not hold as that build wrote it, has no bytes to carry, and one this build would refuse to compose is not carried past that refusal — run pagedeck build to write the whole site again:
  "/index.html" — en /'s document, and it holds 2 <main> landmarks — the bytes are the ones the previous build recorded, so that build wrote them before this one refused a second landmark; render <section>, <div> or a fragment where the component renders <main> (CONTEXT.md, "The <main> landmark is the framework's, written once per document")
```

Fix the component the message points at, then run a full `pagedeck build`.
