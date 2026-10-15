---
section: how-to
title: Deploy to a Cloudflare Worker
description: Serve a site from an R2 bucket through the Worker the build compiles, roll back without republishing, and route a prefix to another Worker.
---

# Deploy to a Cloudflare Worker

`cloudflareWorker()` from `@pagedeck/adapter-cloudflare-worker` compiles the
site's routing into a Worker that serves the site from an
[R2](https://developers.cloudflare.com/r2/) bucket. You upload the site to the
bucket and publish the Worker in front of it. The Worker reads the bucket's
`manifest.json` on each request, so a deploy or a rollback goes live without
publishing the Worker again. [Deploy a site](./deploy-a-site.md) covers what
every host shares: the plan `pagedeck diff` writes, the wait before a prune,
and rolling back.

This adapter has not yet served a site in production. Test it on a staging
Worker before you rely on it.

## Name the adapter

```sh
npm install @pagedeck/adapter-cloudflare-worker
```

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: cloudflareWorker(),
  },
});
```

`pagedeck build` writes `edge/worker.js`, beside `site/`. It is not part of
the upload: you publish it as a Worker. Its redirects and header rules are in
the script, so publish it again whenever the build changes it.

## Upload the site to R2

Create a bucket, then upload `site/` to it. A file's key is its path in
`site/` with no leading `/`: `site/about/index.html` is stored as
`about/index.html`. R2 takes S3's API
([S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)), so
`aws s3 sync` uploads the directory with an
[R2 API token](https://developers.cloudflare.com/r2/api/tokens/) as its
credentials. Upload `manifest.json` last:

```sh
npx pagedeck sync
npx pagedeck build
aws s3 sync site/ s3://my-site/ --exclude manifest.json \
  --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com"
aws s3 cp site/manifest.json s3://my-site/manifest.json \
  --endpoint-url "https://$ACCOUNT_ID.r2.cloudflarestorage.com"
```

The Worker serves a path only when a row of the bucket's `manifest.json`
names it, so a build's pages go live together, when its manifest lands. It
sends each file with the `Content-Type` and `Cache-Control` the upload stored,
and a header rule that sets either wins.

The sync above deletes nothing. Delete the files a new build no longer writes
with the `prune` rows of the plan `pagedeck diff` writes, after the time the
plan gives, as [Deploy a site](./deploy-a-site.md) describes.

## Publish the Worker

Bind the bucket to the Worker as `PAGEDECK_ORIGIN`. A `wrangler.jsonc` beside
`pagedeck.config.ts`:

`wrangler.jsonc`:

```json
{
  "name": "my-site",
  "main": "edge/worker.js",
  "compatibility_date": "2026-10-01",
  "r2_buckets": [{ "binding": "PAGEDECK_ORIGIN", "bucket_name": "my-site" }]
}
```

Then publish it:

```sh
npx wrangler deploy
```

Give the Worker a route or a custom domain in front of the site
([routes](https://developers.cloudflare.com/workers/configuration/routing/)).

Each isolate reads `manifest.json` at most once every 10 seconds, so a deploy
or a rollback is served everywhere within 10 seconds of its manifest landing.
Before the first upload every path answers 404. A `manifest.json` that is not
a deploy manifest answers 503, and the Worker logs what is wrong with it.

## Roll back

`pagedeck rollback` writes a plan whose `upload` rows are the earlier build's
files that differ from the live build's, the pages among them. Upload those
rows from the earlier build's output, then its `manifest.json` last, as a
deploy does. The Worker serves it within 10 seconds, with no new
`wrangler deploy`. Publish the Worker again only when the earlier build's
`edge/worker.js` differs, because the routing changed between the two builds.

## Route a prefix to another Worker

A site that declares `build.routing.upstreams` sends each prefix to an app, as
[Run an app beside the site](./run-an-app-beside-the-site.md) describes. When
the app is a Worker too, name a
[service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
for its prefix:

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: cloudflareWorker({ upstreams: { "/api/": { binding: "APP" } } }),
    routing: {
      upstreams: [{ prefix: "/api/" }],
    },
  },
});
```

Then bind the app's Worker as `APP` in `wrangler.jsonc`:

```json
{
  "services": [{ "binding": "APP", "service": "my-app" }]
}
```

The Worker hands every request for `/api`, or under `/api/`, to the app
unchanged, whatever its method, and returns the app's answer with none of the
site's header rules. A service binding needs no public URL for the app.

An app that runs elsewhere takes `url` on its upstream in place of the
binding, and the Worker fetches it. Do not point `url` at a hostname in the
Worker's own zone: such a fetch goes to the zone's origin server and skips any
Worker routed there. Use a binding instead.
