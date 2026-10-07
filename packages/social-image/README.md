# `@pagedeck/social-image`

Draws a social card for each page at build time: a 1200 by 630 PNG with the
page's title as the headline, in the fonts you give it. Declare it as
`build.socialImages`, and the build writes each card under `/social/` and names
it in the page's `og:image`, with its width and height.

```sh
npm install @pagedeck/social-image
npm install --save-dev @types/node
```

```ts
import { defineSocialImage } from "@pagedeck/social-image";

// In the site's config, inside build:
socialImages: {
  adapter: defineSocialImage({
    fonts: [{ family: "Fira Sans", src: `${import.meta.dirname}/fonts/FiraSans-Regular.ttf`, weight: 400 }],
  }),
  inputs: (page) => (page.path === "/features" ? { eyebrow: "Pagedeck" } : undefined),
},
```

`inputs` decides which pages get a card. It returns `undefined` for a page with
no card. The headline is the title your `build.head` callback gives the page,
unless `inputs` returns a `headline` string. An `eyebrow` string adds a smaller
line above it.

Each font's `src` is an absolute path to a `.ttf`, `.otf` or `.woff` file.
`import.meta.dirname` is the directory of the config file. Its type comes from
`@types/node`, which a site created with `npm create pagedeck` does not
install, so the second install line adds it.

The card uses only the fonts you list, never the build machine's own, so it
does not change with the fonts a machine has installed.

## Read more

[Page head](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/page-head.md#cards-the-build-draws) covers
`build.socialImages`, how a component reads its page's card, and what happens
when a page also declares an `image`.
