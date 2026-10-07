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

It takes one argument, the directory to write, and no options. The directory's
name becomes the site's package name, so it must be a valid npm package name.
The directory must not exist yet, or must be empty: `create-pagedeck` never
writes over files. A refused argument exits with code 2 and writes nothing.

Pagedeck needs Node 22.18 or later. On Node 23, it needs 23.7 or later.

## Read more

[Your first site](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/tutorials/your-first-site.md) starts from
this site: it edits a page under `pagedeck dev`, adds one and builds the result.
