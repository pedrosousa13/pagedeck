---
section: reference
title: Fonts
description: build.fonts subsets your self-hosted faces, writes @font-face rules with metric-adjusted fallbacks, and links and preloads each where you scope it.
---

# Fonts

`build.fonts` takes the font files a site hosts itself. For each face it
declares, the build:

- hands the source file to an adapter, which returns a subset of the font and
  the font's metrics,
- writes the subset into the output tree under a content-hashed name,
- writes an `@font-face` rule for the face, and one metric-adjusted rule for
  each fallback family it names, into a stylesheet,
- links the stylesheet from every page, or only from the pages the face is
  scoped to, and preloads the faces marked `aboveFold` on the pages that link
  them.

The build writes `@font-face` rules only. It writes no `font-family` property.
Your own stylesheet names the family and its fallbacks, in the order the face
declares them, and text uses the face only where your CSS says so.

## Declaring faces

`build.fonts` has two fields: `adapter`, the object that subsets each font,
and `faces`, the list of faces. `@pagedeck/font-subset` is the adapter this
repository ships. The landing site declares one face for its features page:

```ts
import { defineFontSubset } from "@pagedeck/font-subset";

export const FEATURES_ROUTE = "features";
export const FEATURES_PATH = `/${FEATURES_ROUTE}`;

// FIRA_SANS is the path of the source file, FiraSans-Regular.ttf.
export const FONTS: FontsSetting = {
  adapter: defineFontSubset(),
  faces: [
    {
      family: "Fira Sans",
      src: FIRA_SANS,
      weight: 400,
      style: "normal",
      display: "swap",
      unicodeRanges: ["U+0020-007E"],
      fallback: ["Helvetica", "Arial", "sans-serif"],
      aboveFold: true,
      pages: [FEATURES_PATH],
    },
  ],
};

// In the site's config, inside `build`:
fonts: FONTS,
```

A face has these fields:

| Field | What it is |
| --- | --- |
| `family` | The family name the `@font-face` rule declares, and the name your CSS uses. |
| `src` | The source font file. A relative path is resolved against the directory of the config file. |
| `weight` | A number from 1 to 1000. It becomes `font-weight`. |
| `style` | `"normal"` or `"italic"`. It becomes `font-style`. |
| `display` | One of `"auto"`, `"block"`, `"swap"`, `"fallback"` or `"optional"`. It becomes `font-display`. |
| `unicodeRanges` | The codepoints the subset keeps, in CSS `unicode-range` syntax. See [Unicode ranges](#unicode-ranges). |
| `fallback` | The families after this one in your `font-family` stack. See [Fallbacks and metric adjustment](#fallbacks-and-metric-adjustment). |
| `fallbackMetrics` | Optional. Metrics for fallback families, keyed by the spelling in `fallback`. |
| `aboveFold` | Optional, `false` when left out. `true` preloads the face. See [Preloads](#preloads). |
| `pages` | Optional. The pages the face is linked on, as page patterns. Left out, every page. See [Scoping a face to pages](#scoping-a-face-to-pages). |

Two faces of one family, at two weights or two styles, are two entries.

The config is checked when it loads. A face with no `family` or no `src`, a
`weight` outside 1 to 1000 or not a number, a `style` or `display` outside its
list, a malformed range, a fallback family with no metrics, or a `pages` value
that is not a list of page patterns fails the build before anything renders.
The message names each face by its index, and by its family where it has one.

A `faces` list that is empty writes nothing: no subset, no stylesheet and no
link.

## What the build writes

Before it calls the adapter, the build checks three things: that every face's
`src` exists, that no face is declared twice, and that every pattern in `pages`
matches a page. A face declared twice has the same `family`, `weight`, `style`,
`src` and `unicodeRanges` as another, so both would write one subset file. If
any check fails, the build fails with one message that names every fault of
all three kinds.

The adapter is then called once for each face, in the order of `faces`. It
answers with the subset's bytes and the source font's metrics. The build names
the subset file after the face and a hash of its bytes, such as
`/fonts/fira-sans-400-normal.<hash>.woff2`.

The name is the family, lowercased, with each run of characters other than `a`
to `z` and `0` to `9` turned into `-` and any `-` at either end dropped, then
the weight and the style. The hash is eight characters. The extension comes from
the subset's own first bytes (WOFF2, WOFF, OpenType or TrueType), not from the
extension of `src`. A file in none of those formats is written with no
extension.

The rules for every face with no `pages` go into one stylesheet at
`/fonts/fonts.<hash>.css`, named by a hash of its contents. The hash in a
subset's name and in this stylesheet's name changes only when that file's bytes
change. Faces that are scoped to pages get stylesheets of their own, whose hash
also covers the scope; see
[Scoping a face to pages](#scoping-a-face-to-pages).

On a site whose locales publish to more than one domain, the subsets and the
stylesheets are written into every output tree.

**Every page links the stylesheet of the faces with no `pages`.** It comes
first among the stylesheets each page links. A page also links the stylesheet
of each scope that matches it, after that one and before the site's other
stylesheets.

`pagedeck build --incremental` runs with `build.fonts`. A subset depends on the
declared ranges and the source file, not on which pages a run renders.

An incremental build copies each page it does not render from the previous
build, font links and preloads included. It sees one kind of edit to
`build.fonts`: a scoped stylesheet that is new, is gone, or has other patterns
or other rules. It then renders again the pages that the old patterns and the
new patterns match. It does not see these edits, and the pages it copies keep
the previous build's links:

- declaring `build.fonts`, or removing it,
- any change to the stylesheet of the faces with no `pages`, including adding,
  removing or editing such a face, or moving a face into or out of it,
- setting or clearing `aboveFold` on a face.

Run a full `pagedeck build` after one of these edits.

`pagedeck dev` runs no font stage. A dev page links no font stylesheet and carries no
preloads, whether the face is scoped or not.

## Scoping a face to pages

By default a face is linked on every page. `pages` limits a face to the pages
that match one of its patterns. The landing site scopes its one face to its
features page, `/features`, which is the only page that sets text in it.

The patterns are the page patterns that
[critical CSS](/reference/critical-css) uses: a path glob that starts with
`/`, optionally prefixed with a locale and `:`. `*` matches any characters
inside one path segment, and `**` as a whole segment matches any number of
segments. `"/features"`, `"/blog/**"` and `"en:/pricing"` are all patterns.
A page is in the scope when any one of its patterns matches it.

For each distinct list of patterns, the build writes one stylesheet, named
`/fonts/fonts.<hash>.css` with a hash of the list and the file's contents. Two
faces with the same patterns, in any order, share a stylesheet. Each face's
fallback rules go into the same stylesheet as the face.

To link one face on the pages of two scopes, declare it once and list both
scopes' patterns in its `pages`. Declaring it twice fails the build, because
both copies would write the same subset file.

A page links:

- the stylesheet of the faces with no `pages`, if any face has none,
- then the stylesheet of each scope that matches it, in the order of the first
  face of each scope in `faces`.

So a site whose every face is scoped links no font stylesheet on a page that
no scope matches. The landing site's front page is one of these.

A site that scopes no face writes the same files it wrote before `pages`
existed, with the same names and bytes.

A pattern that matches no page fails the build before any page renders. The
message says the patterns match no page of this build, and lists each one with
its face, such as `faces[0] ("Fira Sans") — "/featurs"`.

An empty `pages` list also fails, because it would link the face on no page.
Leave `pages` out to link the face on every page.

## Subsetting with @pagedeck/font-subset

`defineFontSubset()` takes no options and returns an adapter named
`@pagedeck/font-subset`. For each face it:

1. Opens the source file and reads the codepoints the font maps.
2. Keeps the codepoints that fall inside the face's `unicodeRanges`. A range
   wider than the font, such as `U+0-10FFFF`, keeps only what the font has.
3. Writes a subset with those characters, as WOFF2, whatever the format of the
   source file.
4. Reads the metrics that the fallback rules need: units per em, ascent,
   descent, line gap and x-height, and the glyph advance if the font is
   monospace (see [Monospace faces](#monospace-faces)).

It refuses, and fails the build with a message that names the face, when:

- `src` is a font collection rather than one face,
- the font has no `OS/2` table, so it has no x-height to read,
- the declared ranges share no codepoint with the font. An empty
  `unicodeRanges` list is refused for this reason too.

Running the adapter twice on the same file and ranges gives the same bytes, so
a rebuild with no font change keeps the same file names.

**Writing your own adapter.** An adapter is an object with a `name` and a
`subset(request)` function. The request carries the face's `family`, `src`
resolved to an absolute path, and `unicodeRanges`. `subset` returns
`{ bytes, metrics }`, or a promise of it. An error that `subset` throws fails
the build. A `ConfigError` from `@pagedeck/core` passes through as it is, so its own
message is what the build prints; each refusal of `@pagedeck/font-subset` is one, and
names the face's family and `src`. Any other error is wrapped in a message that
names the adapter and the face.

## Unicode ranges

Each entry of `unicodeRanges` is one of the three forms of CSS `unicode-range`:

- a pair of codepoints: `U+0000-00FF`,
- one codepoint: `U+0131`,
- a trailing wildcard: `U+4??`, which is `U+0400-04FF`.

An entry in any other form fails the config check, and so does a pair whose
start is after its end or whose end is above `U+10FFFF`, and a single
codepoint above `U+10FFFF`.

The ranges do two things. The adapter keeps only those codepoints in the subset.
And the build writes the same values, unchanged, as the `unicode-range`
descriptor of the face's `@font-face` rule. A browser downloads a face only when
a page has text set in that family with a character in its range, so a page with
no such text does not fetch the file. A face whose list is empty gets no
`unicode-range` descriptor. That case matters only to an adapter of your own:
`@pagedeck/font-subset` refuses an empty list.

The ranges are declared rather than read from the rendered pages. A character
outside them is not in the subset, and the browser draws it in the next family
of the stack. The landing site's specimen keeps to printable ASCII for this
reason.

## Fallbacks and metric adjustment

While the web font downloads, text is drawn in a fallback. If the fallback is
wider or taller, lines move when the web font arrives. For each fallback family
a face names, the build writes an `@font-face` rule that resizes a font on the
reader's system to the web font's proportions:

- `font-family` is the fallback's own name, and `src` is `local()` of that
  name.
- `font-weight` and `font-style` are the web font face's. Two faces of one
  family get two rules for the same fallback, one for each weight or style.
- `size-adjust` scales the fallback's glyphs to match the web font. See the
  next section.
- `ascent-override`, `descent-override` and `line-gap-override` are the web
  font's ascent, descent and line gap per em, each divided by `size-adjust`.
  So the fallback's line box is the web font's line box at any font size.

The rule reuses the fallback's family name. Every use of that name in the
document resolves through the adjusted face, including text that is not set
in the web font. If your site sets other text in Arial, a face that names
Arial as a fallback resizes that text too. The landing site chose Helvetica
and Arial for its specimen because its own font stacks name neither.

`local()` finds a font only if the reader's system has one under that name.
Where it does not, the adjustment does not apply. On Linux, a `Courier New`
rule was measured failing to load while the system's own substitute for
Courier New drew the text, unadjusted.

### Where the metrics come from

The web font's metrics come from the adapter. Each fallback family's metrics
come from the face's `fallbackMetrics` first, then from a table of five
families:

- `Arial`
- `Helvetica`
- `Georgia`
- `Times New Roman`
- `Courier New`

Both are looked up by exact spelling. A `fallbackMetrics` entry for one of the
five replaces the table's numbers.

A metrics entry has these fields, all in font units:

| Field | What it is |
| --- | --- |
| `unitsPerEm` | The size of the font's em square. |
| `ascent` | The distance above the baseline, as a positive number. |
| `descent` | The distance below the baseline, as a positive number. |
| `lineGap` | The line gap. |
| `xHeight` | The height of lowercase letters. |
| `monospaceAdvance` | Optional. The advance every glyph shares, on a monospace font only. |

The generic families `serif`, `sans-serif`, `monospace`, `cursive`, `fantasy`
and `system-ui`, in any letter case, need no metrics. A generic is a different
font on each system, so no one set of numbers is true of it. With no
`fallbackMetrics` entry, a generic gets no rule. Any other name, such as
`ui-monospace`, needs an entry, or the config check fails and lists the five
families above.

### Proportional faces

For a proportional face, `size-adjust` is the web font's x-height per em
divided by the fallback's. Most running text is lowercase, so with equal
x-heights the text keeps its visible size when the web font arrives.

### Monospace faces

In a monospace font every glyph has the same advance, and the advance decides
where a line wraps. So when both the web font and the fallback carry
`monospaceAdvance`, `size-adjust` is the web font's advance per em divided by
the fallback's, and every fallback glyph takes the same width as a web font
glyph. The overrides are still divided by `size-adjust`, so the line box is the
web font's either way.

If only one of the two carries `monospaceAdvance`, no single scale matches
every glyph, and the rule uses the x-height ratio.

Nothing reads the family name to decide this.

- `@pagedeck/font-subset` sets `monospaceAdvance` on the web font when the font's
  `post` table marks it fixed-pitch. The value is the advance of the space
  glyph. A font with no `post` table, or no space glyph, gets none.
- In the table, only `Courier New` carries it: 1229 units of 2048, about
  0.6 em.
- For any other monospace fallback, such as `Liberation Mono`, give its
  `fallbackMetrics` entry a `monospaceAdvance`. An entry without one is sized
  by x-height.

Sizing a monospace fallback by x-height can make the swap worse than no
adjustment. With Red Hat Mono and Liberation Mono, which both advance 0.6 em,
the x-height ratio drew Liberation Mono at 0.55 em, lines rewrapped on the
swap, and the layout shift was larger than with no rule at all.

## Preloads

A face with `aboveFold: true` gets a preload link, such as
`<link rel="preload" href="/fonts/red-hat-mono-400-normal.<hash>.woff2" as="font" type="font/woff2" crossorigin>`.

`type` is the MIME type for the subset's extension, and is left out when the
file has none. `crossorigin` is always written: a browser fetches a font in
CORS mode, and a preload without the attribute would be a second request the
`@font-face` rule does not use.

The links go in the `<head>`, in the order of `faces`, before the
stylesheets. That lets the browser start the download before it has read the
font stylesheet.

**A page preloads only the faces it links.** A face with no `pages` is
preloaded on every page, including pages that set no text in it. A scoped face
is preloaded only on the pages its scope matches. Preload a face that the top
of the pages it is linked on uses, and leave the others unmarked: an unmarked
face is still downloaded by any page whose text needs it, once the stylesheet
is read.

The site port in this repository preloads the regular weight, which its
body text is set in, and not the semibold:

```ts
const FONTS: FontsSetting = {
  adapter: defineFontSubset(),
  faces: [
    {
      family: "Fira Sans",
      src: join(FONTS_DIR, "FiraSans-Regular.ttf"),
      weight: 400,
      style: "normal",
      display: "swap",
      aboveFold: true,
      // unicodeRanges and fallback
    },
    {
      family: "Fira Sans",
      src: join(FONTS_DIR, "FiraSans-SemiBold.ttf"),
      weight: 600,
      style: "normal",
      display: "swap",
      // unicodeRanges and fallback, and no aboveFold
    },
  ],
};
```

The landing site's face is marked `aboveFold` and scoped to its features page,
so that page preloads it and no other page does.
