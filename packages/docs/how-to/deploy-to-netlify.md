---
section: how-to
title: Deploy to Netlify
description: Build and publish a site on Netlify with a netlify.toml, keep its content store between builds, and proxy a path prefix to an app.
---

# Deploy to Netlify

This page publishes a site on [Netlify](https://docs.netlify.com/) from a
connected git repository. Netlify runs the build, and `netlify()` from
`@pagedeck/adapter-netlify` writes the site's redirects and headers into the
files Netlify reads. [Deploy a site](./deploy-a-site.md) covers what every
host shares: what to upload, the plan `pagedeck diff` writes, and rolling back.

## Name the adapter

A new site can start with it: `npm create pagedeck@latest my-site -- --host netlify`
installs the adapter and names it in the config. For a site that already
exists, install it:

```sh
npm install @pagedeck/adapter-netlify
```

Then name its factory in `build.adapter`, in `pagedeck.config.ts`:

```ts
import { defineConfig } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: netlify(),
  },
});
```

`pagedeck build` then writes `site/_redirects`, and `site/_headers` when the
site declares header rules. Both are tree files: they are inside `site/` when
the build exits, and Netlify uploads them with the rest of the site.

## Configure the build

A `netlify.toml` at the repository root, beside `pagedeck.config.ts`, builds
and publishes the site on every push:

`netlify.toml`:

```toml
[build]
  command = """
    npx pagedeck sync &&
    npx pagedeck build
  """
  publish = "site"

[build.environment]
  NODE_VERSION = "22.18.0"

[build.processing.html]
  pretty_urls = false
```

`publish = "site"` is the directory `pagedeck build` writes. `NODE_VERSION`
must meet the adapter's own `engines.node`, `^22.18.0 || >=23.7.0`.

[Pretty URLs](https://docs.netlify.com/build/post-processing/overview/) is a
Netlify post-processing option that rewrites `/about` to `/about/` on its own,
ahead of the site's own `trailingSlash` policy and the rows `netlify()`
compiles for it. Set `pretty_urls = false` so Netlify does not move a page to
its other spelling against the site's policy.

## Trailing slashes and the 404 page

Netlify's
[redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/)
say: "Our CDN edge nodes do URL normalization before the redirect rules kick
in", so "Netlify will match paths to rules regardless of whether or not they
contain a trailing slash", and "you cannot use a redirect rule to add or
remove a trailing slash". So `netlify()` writes no row from a redirect
target's other spelling to the target. Other hosts get that row. On Netlify it
would redirect the target to itself. For the same reason `netlify()` refuses a
configured redirect whose two paths differ only by a trailing slash. A
redirect source still answers both spellings with its redirect. What Netlify
serves at a page's other spelling has not been checked on a live deploy.

Netlify documents only 301, 302, 200 and 404 for a redirect, so `netlify()`
sends a 308 as 301 and a 307 as 302. Where a redirect goes is unchanged.

Each tree's 404 page is written at the tree's root as `404.html` too (see
[the 404 page](../reference/routing.md#the-404-page)), and
[Netlify picks it up](https://docs.netlify.com/manage/routing/redirects/redirect-options/)
for any path `_redirects` does not already answer with its own 404 row.

## Keep the content store between builds

A Netlify build starts from a clean checkout: nothing survives between builds
unless a [build plugin](https://docs.netlify.com/extend/install-and-use/build-plugins/)
restores it first, so `command` above runs a full `pagedeck sync`, not
`--incremental`, on every build. Keeping `content.db` and `.pagedeck/` between
builds, to sync and build incrementally instead, takes the same two pieces
[Deploy a site](./deploy-a-site.md) covers for any CI runner, a snapshot for
the store and a cache for `.pagedeck/`, wired into that plugin or into
`command` here.

If you keep the snapshot, set `PAGEDECK_SNAPSHOT_URL` in the site's
environment variables with **Contains secret values** selected, and give it a
value only in the Production deploy context. Netlify says "Secret values must
be set to explicit deploy contexts and scopes to avoid unexpected exposure"
([secrets controller](https://docs.netlify.com/build/environment-variables/secrets-controller/)).
Run `pagedeck store pull` and `pagedeck store push` only when `CONTEXT`, the
"name of the build's deploy context", is `production`; the other values are
`deploy-preview`, `branch-deploy` and `dev`
([environment variables](https://docs.netlify.com/build/configure-builds/environment-variables/)).
Commit this script beside `pagedeck.config.ts`, and in `netlify.toml` above
set `command = "sh build.sh"` in place of the two `pagedeck` lines:

`build.sh`:

```sh
set -e
if [ "$CONTEXT" = "production" ]; then
  npx pagedeck store pull
  npx pagedeck sync --incremental
  npx pagedeck build
  npx pagedeck store push
else
  npx pagedeck sync
  npx pagedeck build
fi
```

Deploy previews and branch deploys get no `PAGEDECK_SNAPSHOT_URL` and take
the `else` branch: a full sync and build that touches no snapshot. On the
first production run there is no snapshot to pull and no cursor for
`--incremental` to start from: run `pagedeck sync` and `pagedeck store push`
once first.

## Send a path prefix to an app

A site that declares `build.routing.upstreams` sends each prefix to an app you
deploy yourself, as [Run an app beside the site](./run-an-app-beside-the-site.md)
describes. On Netlify each upstream must name `url`, the `https` origin the
app answers at:

```ts
import { defineConfig } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: netlify(),
    routing: {
      upstreams: [{ prefix: "/api/", url: "https://api.example.com" }],
    },
  },
});
```

`netlify()` writes two forced proxy rows per prefix into `_redirects`, after
the rows that refuse the reserved deploy keys:

```
/api/* https://api.example.com/api/:splat 200!
/api https://api.example.com/api 200!
```

Deploy the app before the site, so no request under the prefix reaches a host
that has nowhere to send it. The app sets its own headers: the site's header
rules never reach its answers.

## Check it on a staging deploy

Some of what `netlify()` writes rests on Netlify behaviour its docs do not
state. Check each on a deploy preview before you rely on it, by requesting the
path and reading the status and headers:

- `_headers` is matched against a 404 row's target, the 404 page, and applies
  to a redirect at all.
- A `/api/*` row does not match `/api`, hence the second row; the method, body
  and request headers reach the app unchanged.
- A percent-escaped spelling such as `/%2Epagedeck/x` still meets the rows
  that refuse the reserved deploy keys.

The "The edge artifacts" and "An app beside the site" sections of the
[deploy recipe](../deploy-recipe.md) list these facts beside every other
host's.
