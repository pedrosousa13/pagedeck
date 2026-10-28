---
section: how-to
title: Deploy to Cloudflare Pages
description: Publish a site on Cloudflare Pages or Workers Static Assets, keep its content store between builds, and run an app under a path prefix.
---

# Deploy to Cloudflare Pages

`cloudflarePages()` from `@pagedeck/adapter-cloudflare-pages` writes the
site's redirects and headers as `_redirects` and `_headers`, the files
Cloudflare reads beside a static site. Two Cloudflare products serve them:
[Cloudflare Pages](https://developers.cloudflare.com/pages/), and
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/),
which serves the same directory from a Worker. This page covers both.
[Deploy a site](./deploy-a-site.md) covers what every host shares: what to
upload, the plan `pagedeck diff` writes, and rolling back.

## Name the adapter

A new site can start with it:
`npm create pagedeck@latest my-site -- --host cloudflare-pages` installs the
adapter and names it in the config. For a site that already exists, install
it:

```sh
npm install @pagedeck/adapter-cloudflare-pages
```

Then name its factory in `build.adapter`, in `pagedeck.config.ts`:

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: cloudflarePages(),
  },
});
```

`pagedeck build` then writes `site/_redirects`, and `site/_headers` when the
site declares header rules. Both are tree files: they are inside `site/` when
the build exits, and upload with the rest of the site.

`cloudflarePages()` refuses `trailingSlash: "never"`. Cloudflare redirects a
directory's `index.html` to its slashed address on its own, which the adapter
cannot override. Keep `trailingSlash: "always"`, the default.

## On Cloudflare Pages

Cloudflare Pages builds from a connected git repository. Set these in the
project's build settings:

| Setting | Value |
| --- | --- |
| Build command | `npx pagedeck sync && npx pagedeck build` |
| Build output directory | `site` |
| `NODE_VERSION` (environment variable) | a version meeting `@pagedeck/core`'s `engines.node`, `22.18.0` or later |

Cloudflare's build image otherwise runs an older Node that cannot load
`pagedeck.config.ts`, so `NODE_VERSION` has to be set explicitly; it is not
read from a file in the repository.

To publish a build without connecting a git repository, build it and upload
the output directory yourself:

```sh
npx pagedeck sync
npx pagedeck build
npx wrangler pages deploy site
```

## On Workers Static Assets

Pagedeck's own site, `https://page.deck.cool`, is served this way. A
`wrangler.jsonc` beside `pagedeck.config.ts` declares the Worker, and
`npx wrangler deploy` uploads `site/` after a build:

`wrangler.jsonc`:

```json
{
  "name": "my-site",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "./site",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none"
  }
}
```

Workers Static Assets reads `_headers` and `_redirects` from the upload, but
it serves every other file in `site/`, `manifest.json` among them. Keep the
deploy metadata out of the upload with a `.assetsignore` in `public/`:

`public/.assetsignore`:

```
/manifest.json
/.pagedeck
/404.html
/_routes.json
```

wrangler reads `.assetsignore` only from the upload directory, so pass
`public/` through to `site/` with `passthrough: { root: "./public" }` in
`build`. Leave `/404.html` out of the list if the site declares a 404 page,
and set `not_found_handling` to `404-page`.
[Passthrough](../reference/passthrough.md) covers the option.

## Keep the content store between builds

Cloudflare Pages is a directory-sync host: it reads no manifest and
republishes whatever `site/` holds, so the raced-deploy refusal that
[Deploy a site](./deploy-a-site.md) describes never applies to a Pages build.
A build that starts with no `content.db` syncs every entry, so a plain
`npx pagedeck sync && npx pagedeck build` on every push is the normal case.

If a full sync is too slow for your content source, keep `content.db` between
builds with `pagedeck store pull` and `pagedeck store push`.
`PAGEDECK_SNAPSHOT_URL` is a credential (see
[PAGEDECK_SNAPSHOT_URL](../reference/cli.md#pagedeck-snapshot-url)), and any build
that has it can overwrite the snapshot production builds start from. In the
project's Settings > Variables and Secrets, add it to the Production
environment only, and select **Encrypt** so it is stored as a secret.
Cloudflare's [bindings](https://developers.cloudflare.com/pages/functions/bindings/)
page documents **Encrypt** for secrets bound to Pages Functions and does not
say whether an encrypted value reaches the build. If the first production
build stops with the `pagedeck store pull` usage error that names
`PAGEDECK_SNAPSHOT_URL`, the build did not receive it.

Then run the snapshot steps only on a production build. Cloudflare sets
`CF_PAGES_BRANCH` to the name of the branch being deployed
([build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)).
Commit this script beside `pagedeck.config.ts` and set the build command to
`sh build.sh`:

`build.sh`:

```sh
set -e
if [ "$CF_PAGES_BRANCH" = "main" ]; then
  npx pagedeck store pull
  npx pagedeck sync --incremental
  npx pagedeck build
  npx pagedeck store push
else
  npx pagedeck sync
  npx pagedeck build
fi
```

Replace `"main"` with the production branch set in the project. If that
branch is ever renamed and the script is not, production builds take the
`else` branch and silently stop pulling and pushing the snapshot. A preview
build gets no `PAGEDECK_SNAPSHOT_URL`, so it syncs every entry and touches no
snapshot. On the first production run there is no snapshot to pull and no
cursor for `--incremental` to start from: run `pagedeck sync` and
`pagedeck store push` once first.

## Run an app under a path prefix

A site that declares `build.routing.upstreams` sends each prefix to an app, as
[Run an app beside the site](./run-an-app-beside-the-site.md) describes. On
Cloudflare the app runs beside the pages, so an upstream names no `url`, and
`cloudflarePages()` refuses one. The build writes `site/_routes.json`, which
sends `/api` and everything under `/api/` to Pages Functions:

```json
{
  "version": 1,
  "include": ["/api", "/api/*"],
  "exclude": []
}
```

On Cloudflare Pages, deploy the app as
[Pages Functions](https://developers.cloudflare.com/pages/functions/routing/)
under the prefix. On Workers Static Assets, the app is the Worker:
`wrangler.jsonc` names it in `main`, and `assets.run_worker_first` lists two
patterns per prefix, `["/api", "/api/*"]`. The build reads `wrangler.jsonc`
and fails when `run_worker_first` and `build.routing.upstreams` disagree, so
change `run_worker_first` whenever you add, move or remove a prefix, and keep
`/_routes.json` in `.assetsignore`, as above. To run the app before every
request, set `run_worker_first` to `true` and the adapter to
`cloudflarePages({ runWorkerFirst: true })`; the build refuses either one
without the other.
[Run an app beside the site](./run-an-app-beside-the-site.md) walks through
the whole Workers Static Assets setup with a working example.

## Check it on a staging deploy

The Workers Static Assets setup above has served a live deploy, and the
deploy recipe records what it answered. Some of what `cloudflarePages()`
writes rests on Cloudflare behaviour its docs do not state, which no deploy
has checked yet:

- `_headers` matches a proxied response against the path requested, not the
  page it is proxied to, and applies to a redirect at all.
- A missing page that is not a reserved deploy key is served by Cloudflare's
  own nearest-`404.html` lookup, with headers nobody has observed.
- `/api/*` in `_routes.json` does not match `/api`, hence the exact rule.

Check them on a preview deploy before you rely on them, by requesting a
missing path, a redirect source and `/manifest.json`, and reading the status
and headers. The "The edge artifacts" and "An app beside the site" sections of
the [deploy recipe](../deploy-recipe.md) list these facts beside every other
host's.
