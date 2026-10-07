# `@pagedeck/font-subset`

The font adapter for `build.fonts`. For each face you declare, it keeps only
the characters in the face's `unicodeRanges`, writes the subset as WOFF2, and
reads the metrics the build uses to size a fallback font to match. The build
then names the file by a hash of its bytes, writes the `@font-face` rules, and
links them from every page, or from the pages you scope the face to.

```sh
npm install @pagedeck/font-subset
```

```ts
import { defineFontSubset } from "@pagedeck/font-subset";

// In the site's config, inside build:
fonts: {
  adapter: defineFontSubset(),
  faces: [
    {
      family: "Fira Sans",
      src: "./fonts/FiraSans-Regular.ttf",
      weight: 400,
      style: "normal",
      display: "swap",
      unicodeRanges: ["U+0020-007E"],
      fallback: ["Helvetica", "Arial", "sans-serif"],
    },
  ],
},
```

`defineFontSubset()` takes no options. The build resolves a relative `src`
against the directory of the config file. The build fails, naming the face, when its
`src` is a font collection, when the font has no `OS/2` table, or when the
font has no character in the face's `unicodeRanges`.

## Read more

[Fonts](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/fonts.md) covers every face field, unicode
ranges, fallbacks, preloads and scoping a face to some pages.
