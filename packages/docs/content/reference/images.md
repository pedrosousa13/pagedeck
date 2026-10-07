---
section: reference
title: Images
description: Declare how your CDN resizes images and get srcset, sizes, dimensions, loading hints and a dominant-color placeholder for every img you render.
---

# Images

An image is the heaviest thing on most pages and the easiest one to get wrong:
served at one size to every screen, converted by nobody, and sized by the
browser only once the bytes arrive — which moves everything under it.

The framework's answer is one contract and one adapter. You declare how your CDN
spells a resized image; the framework works out which sizes to ask for, writes
the `srcset`, `sizes`, `width`, `height`, `loading` and `fetchpriority`
attributes, paints a dominant-color placeholder behind the image while its bytes
arrive, and refuses to build a page whose images have no dimensions.

**It renders no markup.** There is no `<Image>` component to configure. Your
component owns its own `<img>`, and the framework hands it the attributes to
spread onto it.

## Declaring your CDN

```ts
import { defineImages, urlTemplate } from "@pagedeck/core/images";

export const images = defineImages({
  adapter: urlTemplate(
    "https://images.example{src}?w={width}&q={quality}&fm={format}",
  ),
  widths: [320, 640, 1280, 1920],
  quality: 70,
  format: "auto",
  sizes: "(min-width: 60rem) 50vw, 100vw",
});
```

`defineImages` checks the settings and hands them straight back. It is where a
typo fails — a `quality` in quotes, a misspelled key — rather than a minute into
a build, or never.

There is no `build.images` in `pagedeck.config.ts`, on purpose. Nothing in the build
reads these settings; your own component does. A config field would have been a
second place to write them and no way to notice when the two disagreed.

Keep this in a module of its own and import it wherever you render an image. A
component that imported your config to reach it would drag the store and every
loader into the browser.

### The template

`urlTemplate` fills five placeholders, and knows nothing else:

| Placeholder  | What it becomes                                       |
| ------------ | ----------------------------------------------------- |
| `{src}`      | the image source, escaped for a **path** — slashes kept |
| `{srcParam}` | the image source, escaped for a **query parameter**   |
| `{width}`    | the width this candidate is for                       |
| `{quality}`  | your `quality`                                        |
| `{format}`   | your `format`                                         |

Use `{src}` when your service takes the image as part of the path, and
`{srcParam}` when it takes it as a parameter — `?url={srcParam}`. Either way the
source is escaped, so a filename holding an `&` cannot add a parameter of its own
to the request.

A template with no `{width}`, no source placeholder, or a placeholder that is not
on this list fails immediately, where you wrote it.

### The other fields

- **`widths`** — the sizes your layout actually uses. Order and duplicates do
  not matter. No image is ever asked for at a width larger than its own file, so
  a list that reaches 1920 costs a 600-pixel thumbnail nothing.
- **`quality`** — a number on your CDN's own scale. The framework has no default
  for it, because the scales differ between services.
- **`format`** — your CDN's format token. Most services take one meaning
  "whatever this request accepts" (`auto` above), and that is where format
  negotiation happens: this build emits static files and has no server to read
  `Accept` on, so the CDN does it at request time.
- **`sizes`** — your default CSS `sizes`, overridden per image. Left out, images
  get `100vw`, which is what a browser assumes anyway.

## Rendering an image

```tsx
import { imageAttributes } from "@pagedeck/core/images";
import { images } from "./images.js";

export function SiteImage({ image, page, alt }) {
  return <img alt={alt} {...imageAttributes({ images, image, page })} />;
}
```

`image` is the asset as your CMS holds it:

```ts
{
  src: "/uploads/hero.jpg",
  width: 2400,
  height: 1350,
  aboveFold: true,
  placeholderColor: "#2f3a28",
}
```

and the element that comes out carries:

```html
<img
  alt="…"
  src="https://images.example/uploads/hero.jpg?w=1280&q=70&fm=auto"
  srcset="…?w=320&q=70&fm=auto 320w, …?w=640&q=70&fm=auto 640w, …?w=1280&q=70&fm=auto 1280w"
  sizes="(min-width: 60rem) 50vw, 100vw"
  width="2400"
  height="1350"
  loading="eager"
  fetchpriority="high"
  style="background-color:#2f3a28"
/>
```

`width` and `height` are the file's own pixel size and not a layout size. The
browser uses the pair to reserve the right shape before the image loads; CSS is
still free to scale the element to anything.

`page` is there so that a failure can say which page it happened on. Your
`build.content` callback receives one, so a site with no page prop to hand can
call `imageAttributes` there instead and pass the finished attributes down — they
are plain JSON and travel through an island's props like any other content.

## Above the fold

`aboveFold: true` sets `loading="eager"` and `fetchpriority="high"`; everything
else loads lazily at the browser's own priority. Say it on the image a visitor
sees before scrolling — usually one per page — and leave it off everywhere else.

You decide it, and the framework lends you the numbering and the comparison.
`foldPositions` numbers a tree the way the build numbers it, and `isAboveFold`
is the same rule that decides which islands hydrate on load:

```tsx
import { foldPositions, isAboveFold, resolveFoldStrategy } from "@pagedeck/core";

const fold = resolveFoldStrategy(config.build.foldStrategy);

// Number your own nodes once, then map the numbered tree into the one you
// return. The second argument reads a node's children, so this works on
// whatever shape your CMS hands you — return `undefined` for a leaf.
const nodesOf = (numbered) =>
  numbered.map(({ node, position, treeSize, children }) => ({
    component: node.component,
    props: {
      ...node.props,
      image: {
        ...node.asset,
        aboveFold:
          fold !== undefined &&
          isAboveFold({ position, treeSize, strategy: fold }),
      },
    },
    children: nodesOf(children),
  }));

const tree = nodesOf(foldPositions(cmsNodes, (node) => node.children));
```

Each numbered node carries `position` — its index in a pre-order walk, parents
before children — and `treeSize`, the whole tree's node count, which is what
`isAboveFold` reads to know whether the tree states an order at all. Both
numbers are the build's own: `islandInstances` calls the same function when it
tunes hydration, so position 3 is one node and not two.

Most sites will not need any of this, and should not reach for it first: say
`aboveFold: true` on the one image a visitor sees before scrolling and leave the
rest alone. `foldPositions` is for a site whose pages are composed from CMS
content it does not write by hand.

**It answers about the node, not about the image**, and that is a limit worth
knowing rather than a gap. A fold position counts nodes, so two images rendered
by one component get one verdict — if your card draws a photo and a logo, both
are eager when the card is above the fold. That is why the field stays yours to
set: where one node draws one image, pass the rule's answer straight through;
where it draws four, you know which of them the verdict was about and the
framework does not.

A page whose entry is a single node — a template-driven page — has no order for
a fold to divide, so `isAboveFold` says `false` for it whatever the threshold.
Say `aboveFold: true` yourself on such a page's hero.

## Dominant-color placeholders

An image can paint a flat colour behind itself while its bytes are in flight.
It costs one request per **unique** image, taken once at sync time and cached in
the store, so a repeat sync issues none at all and a render never waits for one.

The colour comes from a function you write, because Node cannot decode an image
and this framework ships neither a decoder nor a vendor's service:

```ts
import { defineCollection } from "@pagedeck/content";

export const pages = defineCollection({
  name: "pages",
  loader,
  schema,
  imageColors: {
    // Where the assets are in your own entries.
    extractSources: (entry) => entry.data.blocks.flatMap((block) => block.images ?? []),
    // One source in, one CSS colour out. Throw if you cannot reach it.
    probe: async (src) => {
      const response = await fetch(`https://images.example${src}?w=8&h=8`);
      if (!response.ok) throw new Error(`${response.status} from the CDN`);
      return averageColor(await response.arrayBuffer());
    },
    // How many probes may be in flight at once. Four by default.
    concurrency: 4,
  },
});
```

Render it by reading the cache back:

```tsx
imageAttributes({
  images,
  image: { ...asset, placeholderColor: store.getImageColor(asset.src) },
  page,
});
```

It becomes `style="background-color:…"`, which changes nothing the browser
reserves space with — the `width` and `height` above already do that, and the
colour cannot move anything.

A store written before this feature existed has no colours in it and says so:
`getImageColor` answers `undefined` for every source until a sync has run, so
the first build after an upgrade renders exactly as it did before rather than
failing.

**What happens when it goes wrong.** A source your probe cannot reach renders
with no placeholder and never fails the sync; the sync warns, naming every
source it could not fetch, and asks again on the next sync — every sync asks
about every source your collection holds that has no cached answer, not only the
entries that changed, so a source that failed during an outage is retried
without anybody editing the page it is on. A source with no colour to
give — return `undefined` — is remembered as answered, so it is asked about
once and never again. Only a probe that answers with something that is not a
string stops the run, because that is your code rather than a host.

Returning `undefined` and throwing are therefore two different statements, and
it is worth being deliberate about which one your probe makes.

## What the build refuses

Every one of these fails the build with the fix in the message. They are here so
you can search for the sentence you are looking at in a CI log.

**Settings that are not settings.** `defineImages` reports every fault at once,
one paragraph per kind:

```
Image settings: must be an object declaring an adapter, widths, quality and format — images: { adapter: urlTemplate("https://cdn.example{src}?w={width}&q={quality}&fm={format}"), widths: [640, 1280], quality: 70, format: "auto" }
```

```
Image settings: declares 1 field this build does not read — delete the field, or correct it to one of: adapter, widths, quality, format, sizes:
  "formats"
```

```
Image settings: declares 2 fields images cannot be built from — declare each as the type its own line names:
  "adapter" — not a function — pass a function of (src, width, quality, format) returning a URL, or urlTemplate("https://cdn.example{src}?w={width}")
  "quality" — "70" — not a number — write the number your CDN's quality scale takes, such as 70
```

```
Image settings: declares no widths, so there is no srcset entry to build — list at least one, such as widths: [640, 1280]
```

```
Image settings: declares 1 width that is not a pixel width — write each as a whole number of pixels above zero, such as widths: [640, 1280]:
  widths[2] — 0 — not a whole number of pixels above zero
```

The misspelled-key one is the one to know about. `{ wdiths: [640] }` is an
object with nothing visibly wrong in it that does none of what you asked for.

**Templates that cannot build a URL.** A template missing a placeholder would
build the same URL for every image, or the same URL for every width:

```
Image URL template: holds no "{src}" or "{srcParam}" placeholder, so every image would get the same URL — write the source where the CDN takes it, {src} in a path or {srcParam} in a query parameter, as "https://cdn.example{src}?w={width}"
```

```
Image URL template: holds no "{width}" placeholder, so every srcset entry would be the same URL — write the CDN's width parameter as {width}, as "https://cdn.example{src}?w={width}"
```

```
Image URL template: holds 1 placeholder this adapter cannot fill — correct each to one of: {src}, {srcParam}, {width}, {quality}, {format}:
  "{quailty}"
```

Your template is never printed in any of these, and neither is a URL built from
one: image CDN URLs carry signing keys, and these messages are read in CI logs.
For the same reason, every value quoted above is cut at its `?` or `#`.

**An image that would shift the page.** This is the one thing the framework will
not let you ship. An `<img>` with no dimensions jumps under the reader's finger,
it costs a real Core Web Vitals score, and the fix is a field in the CMS rather
than a line of code — so the build names the page and the image and stops.

```
Entry /en/home: image "/uploads/hero.jpg" declares 2 intrinsic dimensions that are not pixel sizes, so the browser reserves no space for it and the page shifts as it loads — pass the asset's own pixel width and height:
  width — undefined — not a number
  height — undefined — not a number
```

An asset with no usable source is refused first, in a paragraph of its own —
with no source there is no image to have dimensions:

```
Entry /en/home: image source is not usable, so no URL can be built for it — pass the asset's own path or URL, such as "/hero.jpg":
  "   " — the source is only whitespace
```

**A concurrency that is not a count.** `{ concurrency: 0 }` asks for a sync that
may run no probe at all. It is refused rather than quietly read as `1`:

```
Collection "pages": "imageColors.concurrency" is not a number of probes — write a whole number of probes above zero, such as { concurrency: 4 }:
  0 — below one, and a sync that may run no probe at all would never cache a color
```

**A colour that is not a colour.** Your probe answering with anything but a
string or `undefined` is a declaration that will answer that way on every run,
so the sync stops and names every source it happened for:

```
Collection "pages": the image color probe answered 1 source with something that is not a CSS color — return a CSS color such as "#2f3a28", or undefined for an image that has none:
  "/uploads/a.jpg" — 17 — not a string
```

A source the probe could not reach is a warning instead, written by `pagedeck sync`
and never a refusal:

```
Collection "pages": 2 image sources could not be probed for a dominant color, so they render with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site's wiring; the next sync asks again:
  "/uploads/a.jpg" — timed out
  "/uploads/b.jpg?" — 502 Bad Gateway
```

A runnable version of everything above is
`packages/examples/src/rendering-images.tsx`, compiled and executed by CI.
