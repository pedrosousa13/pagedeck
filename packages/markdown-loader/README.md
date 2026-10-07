# `@pagedeck/markdown-loader`

A content loader for a tree of `.md` files. Each file becomes one entry: its
frontmatter, its title, its body as HTML with every code fence highlighted at
sync time, and an outline of its headings with the heading slug each one is
anchored at. `marked` parses the markdown and `shiki` highlights the fences.
There is no remark or rehype pipeline, so there is no plugin passthrough
(issue #327's ruling).

```sh
npm install @pagedeck/markdown-loader @pagedeck/content
```

```ts
import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";

const docs = defineCollection({
  name: "docs",
  loader: defineMarkdownLoader({
    root: "content/docs",
    locale: "en",
    languages: ["ts", "sh"],
    smartQuotes: true,
  }),
  schema: false,
});
```

The collection goes in the site config's `collections`. A site created with
`npm create pagedeck` declares one like this, and
[Your first site](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/tutorials/your-first-site.md) walks through
it.

## Options

| Option        | Default        | What it does                                                                                     |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `root`        | required       | The directory the tree is read from                                                              |
| `locale`      | required       | The locale every entry is filed under                                                            |
| `languages`   | required       | Every language a fence may name. A fence naming any other fails the sync and names the language |
| `theme`       | `github-light` | The highlighter's theme, or `{ light, dark }` for a site with a dark look                        |
| `smartQuotes` | `false`        | Curls the straight quotes and apostrophes in prose (issue #541)                                  |

A `{ light, dark }` theme writes each token's light colour inline, so a page
renders light with no stylesheet. The dark colour sits beside it as
`--shiki-dark`, and the `<pre>` carries the dark background as
`--shiki-dark-bg`. Nothing reads them until the site adds one rule to its own
stylesheet, keyed on whatever attribute its toggle sets:

```css
[data-theme="dark"] .shiki,
[data-theme="dark"] .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
}
```

`!important` because the light colours it overrides are inline. The loader does
not ship the rule: which attribute means dark is the site's decision.

## `smartQuotes`

Off by default. A site that does not name it renders byte for byte what it
rendered before the option existed.

With it on, `"` becomes `“` or `”`, and `'` becomes `‘` or `’`:

```md
## What's next

She said "it's fine" in the '90s.
```

renders `What’s next` and `She said “it’s fine” in the ’90s.`

- **Quotes only.** Dashes and ellipses are not converted.
- **Prose only.** Quotes stay straight in inline code, fences, raw HTML, the
  text inside a raw `<code>`, `<kbd>`, `<pre>` or `<script>`, every attribute
  value (an image's alt text and a link's title included), the text of an
  autolink or a bare URL, and after a backslash.
- **Across inline markup.** `"*this*"` opens before the emphasis and closes
  after it. Every block starts afresh, so a quote at the start of a paragraph
  opens.
- **Heading slugs do not change.** A heading slug is made from the heading's
  straight text, so `## What's next` is anchored at `#whats-next` with the
  option on or off.
- **The outline and the title match the heading.** `TocEntry.text`, and the
  title a level-1 heading supplies, are curled the way the rendered heading
  is.

## Heading slugs

Every heading gets an `id`, and `RenderedMarkdown.toc` reports the same string
as `TocEntry.slug` (issue #327).

- **From the text a reader sees, never markup** (issue #542). Raw HTML in a
  heading adds nothing, so `## <a name="solution"></a>The solution` is
  anchored at `#the-solution` and still carries the author's own `solution`
  anchor. A link adds its text and not its URL, and an image adds nothing.
  `TocEntry.text` is read the same way, so the outline lists that heading as
  `The solution`. The title keeps its own reading: only `*`, `_` and backticks
  are removed from it.
- **Lowercase letters and digits, any script**, with every other run of
  characters turned into one hyphen and none at either end.
- **Apostrophes are dropped**, straight and curly, so `## What's next` is
  `#whats-next`. This is GitHub's and Astro's convention.
- **The framework's names are taken out.** `fw` and `data-fw` as whole
  segments are removed, after the apostrophes are dropped, so no heading can
  mint an id in the framework's namespace.
- **Never empty and never repeated.** A heading with nothing left is
  `section`, and a repeat is numbered `-1`, `-2`, skipping any heading slug
  the document already uses.
