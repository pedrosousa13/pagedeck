---
section: how-to
title: Deploy to Vercel
description: Build and publish a site on Vercel from a git repository, keep its content store between builds, and proxy a path prefix to an app.
---

# Deploy to Vercel

This page publishes a site on [Vercel](https://vercel.com/docs) from a
connected git repository. Vercel runs the build, and `vercel()` from
`@pagedeck/adapter-vercel` writes the site's redirects and headers into the
`vercel.json` Vercel reads. [Deploy a site](./deploy-a-site.md) covers what
every host shares: what to upload, the plan `pagedeck diff` writes, and
rolling back.

## Name the adapter

A new site can start with it: `npm create pagedeck@latest my-site -- --host vercel`
installs the adapter and names it in the config. For a site that already
exists, install it:

```sh
npm install @pagedeck/adapter-vercel
```

Then name its factory in `build.adapter`, in `pagedeck.config.ts`:

```ts
import { defineConfig } from "@pagedeck/core";
import { vercel } from "@pagedeck/adapter-vercel";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: vercel(),
  },
});
```

`vercel()` writes `vercel.json` at the root of each output tree,
`site/vercel.json` for a site with one tree. It is a tree file, so
`pagedeck diff` uploads it with the rest of the site like any other.

## Configure the project

Set these in the project's
[Build and Deployment settings](https://vercel.com/docs/project-configuration/general-settings):

| Setting | Value |
| --- | --- |
| Framework Preset | Other |
| Build Command | `npx pagedeck sync && npx pagedeck build` |
| Output Directory | `site` |
| Node.js Version | `22.x` or `24.x`, not `20.x`, which predates `@pagedeck/core`'s `engines.node` floor |

Vercel's own docs describe `vercel.json` as living at the project's root,
which for a Pagedeck site is where `pagedeck.config.ts` is, not where the build
writes `site/`. Setting Output Directory to `site` is what makes Vercel read
the one `pagedeck build` wrote instead. Check this on a staging deploy before
relying on it, by requesting a path the site redirects and reading the
response.

`vercel.json` sets `trailingSlash` from the site's own policy and `cleanUrls`
to `true`, since a Pagedeck page is never addressed by a `.html` name. Its
`redirects` and `headers` hold the site's redirects and header rules, and its
`routes` refuse the reserved deploy keys ahead of the site's files.

## Keep the content store between builds

Vercel's build runs in a fresh container on every deploy: it holds no
`content.db` and no `.pagedeck/` from any earlier build. A build that starts
with no `content.db` syncs every entry, so the Build Command above is the
normal case for this host, and it is always a full build:
`pagedeck build --incremental` needs `site/` from the previous run too, which
Vercel's build container does not carry over.

If a full sync is too slow for your content source, keep `content.db` between
builds with `npx pagedeck store pull` and `npx pagedeck store push`.
`PAGEDECK_SNAPSHOT_URL` is a credential (see
[PAGEDECK_SNAPSHOT_URL](../reference/cli.md#pagedeck-snapshot-url)), and any build
that has it can overwrite the snapshot production builds start from. In the
project's Environment Variables settings, add it with the type **Secret**,
which Vercel describes as "write-only after saving", and with Production as
its only target environment
([Config and Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)).

Then run the snapshot steps only on a production build. Vercel sets
`VERCEL_ENV` to "the environment that the app is deployed and running on",
one of `production`, `preview` or `development`, at build time
([system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)).
Commit this script beside `pagedeck.config.ts` and set the Build Command to
`sh build.sh`:

`build.sh`:

```sh
set -e
if [ "$VERCEL_ENV" = "production" ]; then
  npx pagedeck store pull
  npx pagedeck sync --incremental
  npx pagedeck build
  npx pagedeck store push
else
  npx pagedeck sync
  npx pagedeck build
fi
```

The build itself stays a full build, but a production sync no longer
re-fetches every entry from the content source. A preview build gets no
`PAGEDECK_SNAPSHOT_URL` and takes the `else` branch, which syncs every entry
and touches no snapshot. On the first production run there is no snapshot to
pull and no cursor for `--incremental` to start from: run `pagedeck sync` and
`pagedeck store push` once first.

## Send a path prefix to an app

A site that declares `build.routing.upstreams` sends each prefix to an app you
deploy yourself, as [Run an app beside the site](./run-an-app-beside-the-site.md)
describes. On Vercel each upstream must name `url`, the `https` origin the app
answers at:

```ts
import { defineConfig } from "@pagedeck/core";
import { vercel } from "@pagedeck/adapter-vercel";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: vercel(),
    routing: {
      upstreams: [{ prefix: "/api/", url: "https://api.example.com" }],
    },
  },
});
```

`vercel()` writes one route per prefix into `routes`, ahead of the site's
files, which sends `/api` and everything under `/api/` to the app:

```json
{ "src": "^/api(/.*)?$", "dest": "https://api.example.com/api$1" }
```

Deploy the app before the site, so no request under the prefix reaches a host
that has nowhere to send it. The site's header rules never reach the app's
answers, so the app sets its own headers, `Cache-Control` included: Vercel
caches proxied answers for a project created on or after 6 April 2026, and it
caches what the app's `Cache-Control` allows.

## Check it on a staging deploy

Some of what `vercel()` writes rests on Vercel behaviour its docs do not
state. Check each on a preview deploy before you rely on it, by requesting the
path and reading the status and headers:

- Vercel reads `vercel.json` from the Output Directory.
- A `routes` entry ahead of `{ "handle": "filesystem" }` wins over a real file
  at that path, and one after it is reached only where no file answers. A
  request for `/manifest.json` should answer 404.
- A route ahead of the files runs before the trailing-slash redirect, the
  request's query string reaches the app, and `$1` is empty for `/api`.

The "The edge artifacts" and "An app beside the site" sections of the
[deploy recipe](../deploy-recipe.md) list these facts beside every other
host's.
