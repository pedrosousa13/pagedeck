# Pagedeck

Pagedeck builds static sites from your content and React components.
`pagedeck sync` reads your content through a loader into a SQLite store. A
loader can read a directory of markdown files, a CMS's API, or any other source
you can list, and it is the one place that knows where your content lives. You
connect a CMS by writing a loader for it. `pagedeck build` renders every page
to HTML and bundles JavaScript only for the components that run in the
browser, on the pages that render them.

A component runs in the browser when its module starts with `"use client"`. You
write that line once, in the component's own file. Every page that renders the
component gets it as an island. You need no wrapper file and no per-page
setting.

A page ships JavaScript only when it renders an island, or when the site turns
on a feature that adds a script: third-party scripts in `build.scripts`, the
web-vitals beacon in `build.beacon`, or inline snippets in `build.prePaint`.

[`docs/success-criteria.md`](docs/success-criteria.md) measures this on the
repository's own test site, `packages/site`:

- The three content pages it measures ship 0 B of JavaScript.
- Its page with an island, `/en/pricing`, ships 6,376 B raw and 3,093 B gzip
  of Pagedeck's own JavaScript. React adds 189,881 B raw and 58,990 B gzip.
  For both gzip figures, the measurement first replaces each content hash in a
  file name with a same-length placeholder, so renaming a file cannot move
  them.

## Quick start

Pagedeck needs Node 22.18 or later. On Node 23, it needs 23.7 or later.

```sh
npm create pagedeck@latest my-site
```

This writes a working site into `my-site` and prints the next steps:

```sh
cd my-site
npm install
npx pagedeck sync
npx pagedeck dev
```

`pagedeck sync` reads the markdown files in `content/` into `content.db`.
`pagedeck dev` serves the site at `http://127.0.0.1:5173`. When you are ready,
`npx pagedeck build` writes the finished site to `site/`.

The new site has three pages and one island, a counter on `/counter`. The
other two pages ship no JavaScript.

## Packages

| Package | What it is for |
| --- | --- |
| [`create-pagedeck`](packages/create-pagedeck) | Writes a new site, for `npm create pagedeck` |
| [`@pagedeck/core`](packages/core) | The `pagedeck` command, and `defineConfig` for pages, routing and the build |
| [`@pagedeck/content`](packages/content) | Collections, the loader contract and the content store |
| [`@pagedeck/islands`](packages/islands) | The component registry, and the browser runtime that hydrates islands |
| [`@pagedeck/markdown-loader`](packages/markdown-loader) | A loader for a directory of markdown files, with code highlighted at sync time |
| [`@pagedeck/search`](packages/search) | A search index written at build time, and a search box island that reads it |
| [`@pagedeck/social-image`](packages/social-image) | Draws a social card for each page at build time |
| [`@pagedeck/font-subset`](packages/font-subset) | Subsets each font to the characters you list, as WOFF2 |
| [`@pagedeck/edge`](packages/edge) | Compiles the site's redirects and headers for CloudFront, Netlify, nginx or a Cloudflare Worker |
| [`@pagedeck/preview`](packages/preview) | The preview app a build can emit, which renders drafts from an editor |

A site created with `npm create pagedeck` installs `core`, `content`, `islands`
and `markdown-loader`. Add the others when you need them.

## Read more

The documentation is written as markdown in this repository:

- [Your first site](packages/docs/content/tutorials/your-first-site.md) creates
  a site with `npm create pagedeck`, edits it under `pagedeck dev` and builds it.
- [Write a loader](packages/docs/content/how-to/write-a-loader.md) reads content
  from a source of your own.
- [Add an island](packages/docs/content/how-to/add-an-island.md) ships one
  component's JavaScript and holds each page to a budget.
- [Connect a CMS](packages/docs/content/how-to/connect-a-cms.md) builds a site
  from a headless CMS through a loader.
- [Deploy a site](packages/docs/content/how-to/deploy-a-site.md) uploads a
  build, then only what changed, and rolls back.
- [Reference](packages/docs/content/reference) has a page for the `pagedeck`
  command and one per build feature, such as routing, fonts and site search.

To work on Pagedeck itself, read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
