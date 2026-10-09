---
section: reference
title: Page head
description: Write each page's title, description, social cards and structured data with the build.head callback, and how the build escapes and orders them.
---

# Page head

Every document `pagedeck build` emits has a `<head>` the framework writes. By default
it holds a character encoding and the page's stylesheets, and nothing that
describes the page — a title, a description or an Open Graph image would be
content, and the build never invents content a site did not write.

The `<body>`'s one landmark is written the same way: see [Page body](./page-body.md).

**`build.head` is where a site writes it.** It is a callback, taking the same
two arguments `build.content` takes: the page, and the store.

```ts
build: {
  outDir: "./site",
  head: (page, store) => {
    const entry = getEntry(store, articles, page.entry);
    return { title: entry.data.title };
  },
  // ...
}
```

Return `undefined`, or an object with no fields set, and the page's head is
exactly what it would have been without the callback. Nothing empty is written:
a page with no title has no `<title>` element, not an empty one.

## The fields

| Field | What it writes |
| --- | --- |
| `title` | `<title>`, and `<meta property="og:title">` |
| `description` | `<meta name="description">`, and `og:description` |
| `image` | `<meta property="og:image">` |
| `jsonLd` | `<script type="application/ld+json">` |

`og:title` and `og:description` are written from `title` and `description`
rather than declared separately, so a page's tab and its share card cannot
disagree about what the page is called.

`image` is a URL, and the build does nothing with it but write it: it is not
resolved, not fetched and not checked — bring the URL your CMS already holds.

## Cards the build draws

A build can draw the image instead of being handed one. `build.socialImages`
takes a renderer and a per-page `inputs` callback; the build content-hashes what
the renderer draws into `/social/`, and the URL arrives in this same `image`
field, followed by `og:image:width`, `og:image:height` and `twitter:card`
written from the size the renderer reported. Core ships no renderer —
`@pagedeck/social-image` is the reference one. Return `undefined` from `inputs` for a
page that gets no card.

**Declare `build.origin` with your cards.** With an origin, a drawn card's
`og:image` is an absolute URL: the origin followed by the card's path, as
`https://example.com/social/en.1a2b3c4d.png`, on the domain of the page's own
locale when that locale declares one. Without an origin it is the path alone,
`/social/en.1a2b3c4d.png`. The Open Graph protocol asks for an absolute URL, and
most platforms show no image for a path. See
[Canonicals and hreflang](./canonicals-and-hreflang.md#declaring-the-origin).

A build whose output holds a card and whose config declares no `origin` prints
one warning:

```
Social image: this site draws share cards with build.socialImages and declares no build.origin, so each card's og:image is a path and not an absolute URL — the Open Graph protocol asks for an absolute URL, and most social platforms drop a relative og:image and show no share image; this is a warning and not a refusal because every page and every card this build emitted is correct — declare the site's address in build.origin, as origin: "https://example.com" (Pagedeck documentation: Page head, Cards the build draws)
```

**Upgrade, or add or change `origin`, and run a full build.** An incremental
build reuses each page that did not change, and has no way to see that the
framework or a config value moved, so a reused page keeps the `og:image` an
earlier build wrote.

**A page's components can show its own card.** The build draws every card
before it renders any page, so `useSocialCard()` from `@pagedeck/core/tree` hands a
component its page's card: `href`, the card's path, which is the page's
`og:image` without the origin, and the `width` and `height` the renderer
reported. It answers `undefined` on a page
that gets no card, on a site with no `build.socialImages`, under `pagedeck dev`, which
draws no cards, and in preview. It works only in a component the page renders
on the server: an island that calls it fails the build, because the browser
re-renders an island without it. An island that needs the card takes it as a
prop.
The landing site's `/features/` page shows its card this way.

Drawing first has one consequence you can see: your `head`, `inputs` and
renderer run before your `content` and `chrome` callbacks, so a renderer that
fails stops the build before any page renders. The order is the same on every
build.

**A page cannot have both.** A page that `inputs` returns inputs for and that
`build.head` declares an `image` for fails the build, naming every such page at
once: two social images for one page is a contradiction only you can settle, and
picking one would either discard the URL you wrote down or write a card nobody
sees.

Watch for this where the site declares a **fallback** — a `head` callback that
returns the same `image` on every page, with `socialImages` asked for on the
posts. That site is refused whole. Return `undefined` from `inputs` for the
pages that keep the fallback, or stop returning `image` for the pages that get a
card.

## Per page type

There is no per-template registry, because the page you are handed already
carries its template. Dispatch on it:

```ts
head: (page, store) => ({
  title: titleOf(page, store),
  jsonLd: {
    "@context": "https://schema.org",
    "@type": page.template === "article" ? "Article" : "WebPage",
  },
}),
```

## Structured data

`jsonLd` takes one JSON-LD node object, or an array of them, and the build
writes it as one `<script type="application/ld+json">` element. An empty array
writes no element.

The framework does not check your vocabulary — which terms schema.org defines
is your decision, exactly as the shape of an entry is. What it guarantees is the
encoding.

## Escaping

Every field is content, and content comes from a CMS. The build escapes all of
it, and the guarantees are worth stating exactly:

- A **title** goes in as character data with every `&` and `<` encoded, so no
  value can start a tag or end the element.
- A **meta value** goes into a double-quoted attribute with every `&` and `"`
  encoded, so no value can close the attribute.
- A **JSON-LD payload** is serialized with `JSON.stringify` and then has
  **every** `<` replaced with the JSON escape `\u003c`. Not the `</script`
  sequence — every `<`, with no pattern involved. That is what makes a payload
  containing `</script><script>alert(1)</script>` inert by construction rather
  than by a filter being written correctly: with no `<` in the block, there is
  no input that can end it early.

`\u003c` is ordinary JSON string escaping, so every consumer — including
Google's parser — reads back the identical string. Nothing you publish is
altered; it is spelled differently in the file.

## Metadata a component renders

A component may render `<title>` and `<meta>` itself, and the icon links below. React hoists them out of
where you wrote them, and because each island is rendered as its own fragment
they would land in `<body>` — where a crawler reading head metadata does not look
and where two islands leave two `<title>` elements. The build takes them out of
the body and writes them into the `<head>` instead, after the fields
`build.head` declared.

Two of them claiming one thing with two different values fails the build, naming
both components and both values:

```
Entry /en/home: 2 claims on <title> disagree — a document holds one <title>, and the build absorbs into the <head> what a render hoisted rather than picking a winner; make the claims agree, or leave one:
  "Alpha" — "from Alpha"
  "Beta" — "from Beta"
```

A document holds one title, and there is no honest way to pick: whichever won
would be decided by which island hydrated first, which depends on where the
reader scrolled. Claims that **agree** are not a conflict — a shared component
that sets a title can be on a page twice, and the head gets one element.

What collides is the thing claimed, not the tag. A `<meta>` is claimed by the
first of these it carries:

| Attribute | Example |
| --- | --- |
| `charset` | `<meta charSet="utf-8">` |
| `name` | `<meta name="description">` |
| `property` | `<meta property="og:title">` |
| `http-equiv` | `<meta http-equiv="refresh">` |

So two `og:image` elements are ordinary and two `og:title` elements are not, and
a `<meta>` carrying none of the four is written as often as you rendered it.
`charset` and `http-equiv` are in the list because they speak for the whole
document too — a second charset restarts the parser, a second `refresh` decides
where the page goes.

`build.head` is a claimant too: a component that sets a title on a page whose
`head` callback also set one is the same conflict, and so is a component that
contradicts the `<meta charset>` the build writes. A `<meta itemprop>` is
microdata rather than document metadata — React leaves it where you wrote it,
and so does the build.

A stylesheet is the one thing this does not extend to. A component that declares
one with React's `precedence` prop is refused, because a sheet that reaches the
document this way outranks every stylesheet the build placed. Import it from the
component's module instead, or list it in `build.css` if every page needs
it.

### Icon links

A `<link rel="icon">` or `<link rel="apple-touch-icon">` a component renders is
taken into the `<head>` the same way, after the metadata, on a site with islands
or without them. An icon claims nothing, so a page can carry several, one per
size or format:

```tsx
export function Icons() {
  return (
    <>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    </>
  );
}
```

Render it anywhere in the page's tree: a layout component is the usual place.
Every other `<link>` stays where you rendered it.

## What the head carries besides this

`<link rel="canonical">` and `<link rel="alternate" hreflang="…">` are written
from your locale map rather than from this callback — you declare an origin
once and the build derives every page's links. See
[Canonicals and hreflang](./canonicals-and-hreflang.md).

They sit between the metadata above and the page's stylesheets, and the order
of the head's children is fixed: adding a field here never moves one of them.

The page a `build.routing.notFound` rule names gets neither link. It gets
`<meta name="robots" content="noindex">` in their place, with or without an
origin. See [Routing](./routing.md#the-404-page).

A page with islands also gets one `<link rel="modulepreload">` for each chunk
its entry script imports statically, after any font preloads, so the browser
fetches them alongside the entry instead of one after another. A chunk the page
loads through `import()` is not preloaded: an island that waits for its
trigger, or React and the islands runtime on a page whose islands all wait. A
page with no islands gets no such link.

## Code that has to run before the paint

One slot in the head is yours: `build.prePaint` is a list of scripts, and the
build writes each one into a `<script>` in the head, in front of the page's
stylesheets and therefore in front of everything else the page does.

```ts
build: {
  outDir: "./site",
  prePaint: [
    `document.documentElement.dataset.theme = localStorage.theme || "light"`,
  ],
  // ...
}
```

Each entry is **the JavaScript to run**, not an element — the head has one
writer, and it writes the `<script>` around what you declare.

It exists for state a page has to read before a visitor sees anything. A theme
kept in `localStorage` is the plain case: set it in an island and the page shows
the other theme first and then corrects itself. A returning visitor's consent
decision is the same shape and matters more, because the script it holds back
is somebody else's — see
[Third-party scripts](./third-party-scripts.md).

Four things are worth knowing before you use it:

- **It is synchronous and it is first.** The browser stops parsing, runs your
  code, and only then reaches this page's stylesheets. A slow snippet is a slow
  page, so keep it to reading one value and setting one thing.
- **It runs before your islands, your entry chunk and any third-party script.**
  That ordering is the whole feature: everything else on the page is behind it.
- **The build refuses a snippet it cannot carry.** `</script` ends a script
  element wherever it appears, and `<!--` changes how the parser reads the rest
  of one, so a snippet holding either is a config failure naming the entry.
  Nothing is escaped for you: a program is not data, and an encoder that
  rewrote a `<` would be rewriting your code.
- **It is an inline script, and a strict Content-Security-Policy has to allow
  it.** `script-src 'self'` does not cover a `<script>` with no `src`, so a
  policy that strict needs either a hash of these exact bytes or a nonce on the
  element. The build writes your entry unchanged, so the hash is one you can
  compute from your own source. What the framework does not do is either half
  of the wiring: it mints no nonce and emits no policy — a CSP is yours to
  write, for the reason [Routing](./routing.md) gives. The build records the
  hash of each of these scripts on every page's row in `manifest.json`, beside
  the hashes of the framework's other inline scripts, and
  [Third-party scripts](./third-party-scripts.md) shows how to build a policy
  from them.

Declare none and your documents are byte for byte what they were before this
field existed.
