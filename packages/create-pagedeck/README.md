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
npm create pagedeck@latest [directory] [--host <vercel|cloudflare-pages|netlify|none>] [--app] [--yes]
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

`--app` also writes an app beside the site, from `template-app/`:

```sh
npm create pagedeck@latest my-site -- --app
```

`app/index.ts` is a [Hono](https://hono.dev) app that answers `/api/`, and
`app/dev.ts` serves it on `http://127.0.0.1:8787`. `pagedeck.config.ts`
declares `/api/` in `build.routing.upstreams`, so `pagedeck dev` forwards it
there. `components/hello.tsx` is an island on `/hello` that calls the app
through `hc<AppType>` with only `import type`. The written `package.json` adds
`hono`, `@hono/node-server` and a `dev:app` script, and `README.md` says how to
run both. `--app` takes no `--host` but `none`: each host deploys the app its
own way, and
[Run an app beside the site](https://pagedeck-docs.pedrodsousa.workers.dev/how-to/run-an-app-beside-the-site/)
gives the steps. On a terminal, `--app` prompts for no host.

On a terminal (both stdin and stdout are TTYs), a missing directory or host is
prompted for, defaulting to `my-site` and `none`. Off a terminal — a pipe, a
redirect, CI — nothing is prompted: a missing directory is still an error, and
a missing host defaults to `none`, exactly as before this flag existed.
`--yes` skips every prompt and takes both defaults, even on a terminal.

Pagedeck needs Node 22.18 or later. On Node 23, it needs 23.7 or later.

## Read more

[Your first site](https://pagedeck-docs.pedrodsousa.workers.dev/tutorials/your-first-site/) starts from
this site: it edits a page under `pagedeck dev`, adds one and builds the result.
