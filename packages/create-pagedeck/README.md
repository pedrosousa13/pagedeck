# create-pagedeck

Writes a new Pagedeck site into a directory: a markdown collection, three
pages, a layout component and one `"use client"` counter island. The site
syncs and builds with no edits.

```sh
npm create pagedeck@latest my-site
```

It prints the next steps:

```sh
cd my-site
npm install
npx pagedeck sync
npx pagedeck dev
```

`npx pagedeck build` writes the finished site to `site/`. Only `/counter`, the
page that renders the counter, ships JavaScript.

The site's `package.json` pins `@pagedeck/core`, `@pagedeck/content`,
`@pagedeck/islands` and `@pagedeck/markdown-loader` at this package's own
version.

## Arguments

```sh
npm create pagedeck@latest [directory] [--host <vercel|cloudflare-pages|netlify|none>] [--yes]
```

The directory's name becomes the site's package name, so it must be a valid
npm package name. The directory must not exist yet, or must be empty:
`create-pagedeck` never writes over files. `--help` prints usage and exits 0.
A refused argument exits with code 2 and writes nothing.

`--host` sets the site up for that host: the written `package.json` depends on
its `@pagedeck/adapter-<host>`, and `pagedeck.config.ts` imports it and names
it in `build.adapter`. `--host none`, the default, writes the site with no
adapter. Choosing a host also appends that host's build settings to
`README.md`.

On a terminal (both stdin and stdout are TTYs), a missing directory or host is
prompted for, defaulting to `my-site` and `none`. Off a terminal — a pipe, a
redirect, CI — nothing is prompted: a missing directory is still an error, and
a missing host defaults to `none`, exactly as before this flag existed.
`--yes` skips every prompt and takes both defaults, even on a terminal.

Pagedeck needs Node 22.18 or later. On Node 23, it needs 23.7 or later.

## Read more

[Your first site](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/tutorials/your-first-site.md) starts from
this site: it edits a page under `pagedeck dev`, adds one and builds the result.
