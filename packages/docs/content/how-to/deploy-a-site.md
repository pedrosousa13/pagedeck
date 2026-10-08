---
section: how-to
title: Deploy a site
description: Upload a built site to any static host, then only what changed, roll back, keep the content store between CI runs, and compile redirects and headers.
---

# Deploy a site

`pagedeck build` writes a static site, and no `pagedeck` command uploads it.
You upload it to your origin, the bucket or directory your host serves, with
the host's own tools. This page covers what to upload, how to upload only the
files that changed, how to put an earlier build back, what to keep between CI
runs, and how to give your host the site's redirects and headers.
[The pagedeck command](/reference/cli/) lists every verb, flag and exit code
used here.

The commands run in the site's directory, the one holding
`pagedeck.config.ts`. The paths are the defaults of the site
`npm create pagedeck` writes: the site goes to `site/`, and the content store
is `content.db`. If you have no site yet,
[Your first site](/tutorials/your-first-site/) makes one.

## 1. Upload the output directory

Sync the content into the content store, then build:

```sh
npx pagedeck sync
npx pagedeck build
```

Upload everything in `site/`. Any host that serves a directory of files can
serve it. Do not upload `content.db` or `.pagedeck/`: the build reads them, and
a visitor has no use for them. They are outside `site/` so that copying the
whole directory is safe.

A full build deletes from `site/` every file the previous build wrote and this
build did not. A retracted page is gone from the directory after the next
build. A host that mirrors the directory must also delete on its side. For an
S3 bucket, `aws s3 sync` deletes only when you ask it to:

```sh
aws s3 sync site/ s3://my-bucket/ --delete
```

`site/manifest.json` is part of the upload. It records every file the build
wrote and the hash of each, and the next section uses it. A plain static host
also serves it to anyone who asks for `/manifest.json`. The edge artifacts in
section 5 answer that request with a 404.

## 2. Upload only what changed

A full upload is simple, but it sends every file on every deploy. To send only
the files that changed, compare the manifest of the build your origin serves
with the manifest of the new build:

```sh
npx pagedeck diff live-manifest.json site/manifest.json > plan.json
```

`live-manifest.json` is the `manifest.json` your last deploy uploaded. Read it
from the origin itself, not from the site's public URL, because the edge
artifacts refuse `/manifest.json`. For an S3 bucket:

```sh
aws s3 cp s3://my-bucket/manifest.json live-manifest.json
```

Or keep the `site/manifest.json` of each deploy as a CI artifact, and download
the last one. The [deploy recipe](/deploy-recipe/#deploying-to-a-presigned-origin)
reads it from a bucket with a presigned GET. On a first deploy there is no live
manifest: upload the whole of `site/` as section 1 does.

`pagedeck diff` writes a JSON document, the plan. Your upload script reads it:

- `trees` has one entry per output tree. A site with no per-locale domains has
  one. A tree with a `domain` key is the directory of that name under `site/`.
- Each tree's `upload` lists the files that are new or changed. A row's `path`
  is the file's path in its tree: `/about/index.html` is
  `site/about/index.html`. Upload the rows in the order listed. The scripts,
  stylesheets and images come before the pages, so no page goes live before a
  file it loads.
- Each tree's `prune` lists the files the new build no longer writes. Delete
  them, but not before the time in the plan's top-level `prune.notBefore`. A
  visitor who loaded a page from the old build can still ask for a script that
  build used. The wait is seven days after the new build was made, and
  `--grace-seconds` changes it.
- `stats` counts the files added, changed, pruned and unchanged, and the bytes
  to upload.

Upload `site/manifest.json` last, after every row. It is the live manifest for
the next deploy.

**`pagedeck diff` refuses a build that was not made on top of the live build.**
Each build records the newest build in `.pagedeck/manifests` when it started.
If that is not the build the origin serves, another deploy happened in
between, and this plan would overwrite it. The refusal exits with code 2. Run
`pagedeck build` again so the new build starts from what is live. A build with
no record at all is refused the same way, which is what happens on a CI runner
that starts with an empty `.pagedeck/`. Section 4 keeps it.

`--force` deploys the build anyway. Pass it by hand, for one deploy you have
checked. A pipeline that always passes it has turned the check off.
[Deploy serialization and rollback](/reference/deploy-serialization/) explains
the record and how to keep two deploys from running at once.

## 3. Roll back

Each build keeps a copy of its manifest in `.pagedeck/manifests`, as
`<build id>.json`. To put an earlier build back, list them, and pass the name
without `.json`:

```sh
ls .pagedeck/manifests
npx pagedeck rollback 3c77b1de-52a0-4e77-bb0e-8f0a1c2d3e40 > rollback.json
```

`pagedeck rollback` writes the same kind of plan as `pagedeck diff`. It
compares `site/manifest.json`, the build your origin serves, with the kept
manifest. Run it where `site/` holds the live build. Your upload script runs
the plan as it runs a deploy. A rollback is always out of order, so it takes
no `--force`.

The plan names files, and the manifest holds no file contents. Upload the rows
from the output of the build you are restoring: keep each deployed `site/` as
a CI artifact, or build that commit again.

The build keeps the 20 newest manifests, and `build.retention.keep` changes
that number.
[Deploy serialization and rollback](/reference/deploy-serialization/#rolling-back)
covers how far back a rollback reaches.

## 4. Keep the content store and `.pagedeck/` between CI runs

A CI runner starts with no `content.db` and no `.pagedeck/`. Without
`content.db`, every run syncs all the content from the source. Without
`.pagedeck/`, every build records no earlier build, and `pagedeck diff`
refuses every deploy.

**Keep the content store as a snapshot.** `pagedeck store pull` downloads
`content.db` and `pagedeck store push` uploads it. Give the target in
`PAGEDECK_SNAPSHOT_URL` and none on the command line, as
[PAGEDECK_SNAPSHOT_URL](/reference/cli/#pagedecksnapshoturl) explains:

```
- run: npx pagedeck store pull
  env:
    PAGEDECK_SNAPSHOT_URL: ${{ secrets.SNAPSHOT_URL }}
- run: npx pagedeck sync --incremental
- run: npx pagedeck build
- run: npx pagedeck store push
  env:
    PAGEDECK_SNAPSHOT_URL: ${{ secrets.SNAPSHOT_URL }}
```

On the first run there is no snapshot to pull, and no cursor for
`pagedeck sync --incremental` to start from. Run `pagedeck sync` and
`pagedeck store push` once to create both.

**Keep `.pagedeck/` in your CI's cache.** Restore it before the build and save
it after. It holds the kept manifests, so it is also what `pagedeck rollback`
reads.

`pagedeck build --incremental` renders only the pages the content changes
touch, and reads the rest from the previous `site/`. On CI it needs `site/`
from the last run too, from the same run as the snapshot. A full build does
not.

## 5. Give your host the redirects and headers

`build.routing` declares the site's redirects, its 404 page and the response
headers for each path prefix. [Routing](/reference/routing/) covers the fields,
and [Security headers](/reference/routing/#security-headers) the headers to set
before a deploy. The build compiles them into one host-agnostic routing
document first, writing it into `site/manifest.json` in a form that names no
host.

An adapter compiles that document into edge artifacts, the files one host
reads. Each host has its own adapter package. Install the one for your host,
here Netlify, and name it in `build.adapter`:

```sh
npm install @pagedeck/adapter-netlify
```

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

A new site can skip this step: `npm create pagedeck@latest my-site --host netlify`
installs the adapter and writes both of these for a fresh site, and
`--host vercel` or `--host cloudflare-pages` do the same for those hosts. The
above is what to do by hand, or to a site that already exists.

`pagedeck build` runs the adapter after it plans the routing document and
before it reports success. Each edge artifact has a `role`, and the role says
where the build writes it: a `tree-file` into `site/<tree>/`, where it rides
`site/manifest.json` and `pagedeck diff` like any other file, and every other
artifact into `edge/<tree>/`, beside `site/`, which you install on the host
yourself (`<tree>` is empty for a site with one output tree). An incremental
build writes the same files a full build does, and an artifact an earlier
build wrote that this one does not is removed from wherever it was written,
the way a full build removes a retracted page from `site/`. `pagedeck dev`
runs no adapter: it renders pages from the store on request and writes
neither `site/` nor `edge/`.

For another host, install its adapter and name its factory in `build.adapter`
in place of `netlify()`:

- `netlify()` from `@pagedeck/adapter-netlify` writes `_redirects`, and
  `_headers` when the site declares header rules. Both are tree files, so
  `pagedeck diff` uploads them with the rest of the site, after the site's own
  files, so no redirect goes live before its target.
- `nginx()` from `@pagedeck/adapter-nginx` writes `routing.conf` into `edge/`.
  `include` it in the `server` block that serves `site/`.
- `cloudfront()` from `@pagedeck/adapter-cloudfront` writes a viewer-request
  and a viewer-response CloudFront Function, and configuration fragments when
  the routing needs them, into `edge/`. Publish each function and associate it
  with the distribution. A function left in `edge/` does nothing until you
  publish it.
- `cloudflareWorker()` from `@pagedeck/adapter-cloudflare-worker` writes
  `worker.js` into `edge/`, published as a Worker with the site's R2 bucket
  bound to it. This adapter has not yet served a site in production: test it
  on a staging deploy before you rely on it.
- `cloudflarePages()` from `@pagedeck/adapter-cloudflare-pages` writes
  `_redirects`, and `_headers` when the site declares header rules, the same
  as Netlify's. Both are tree files. It refuses `trailingSlash: "never"`; see
  "Cloudflare Pages" below for its build settings.
- `vercel()` from `@pagedeck/adapter-vercel` writes `vercel.json`, a tree
  file; see "Vercel" below for its build settings and where the file must
  end up.

Outside `pagedeck build` — against a manifest from another build, or to try an
adapter without building — call it directly over a routing document:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of netlify().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Every adapter's edge artifacts answer `/manifest.json` and `/.pagedeck/` with a
404, even for a site that declares no routing. Install them, and the manifest
you uploaded to the origin stays private.

## Cloudflare Pages

[Cloudflare Pages](https://developers.cloudflare.com/pages/) builds from a
connected git repository, or takes a build you upload yourself with
`wrangler` (below). Set these in the project's build settings:

| Setting | Value |
| --- | --- |
| Build command | `npx pagedeck sync && npx pagedeck build` |
| Build output directory | `site` |
| `NODE_VERSION` (environment variable) | a version meeting `@pagedeck/core`'s `engines.node`, `22.18.0` or later |

Cloudflare's build image otherwise runs an older Node that cannot load
`pagedeck.config.ts`, so `NODE_VERSION` has to be set explicitly; it is not
read from a file in the repository.

Install `@pagedeck/adapter-cloudflare-pages` and name its factory in
`build.adapter`: `adapter: cloudflarePages()`, imported with
`import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages"`. It
refuses `trailingSlash: "never"` — Cloudflare Pages redirects a directory's
`index.html` to its slashed address on its own, which the adapter cannot
override — with the fix `set trailingSlash: "always"`, the default since
pagedeck 0.1.

### Direct upload with `wrangler`

To publish a build without connecting a git repository, build it and upload
the output directory yourself:

```sh
npx pagedeck sync
npx pagedeck build
npx wrangler pages deploy site
```

### Full builds, or keeping the content store

Cloudflare Pages is a directory-sync host: it reads no manifest and
republishes whatever `site/` holds, so the raced-deploy refusal "Upload only
what changed" above describes never applies to a Pages build. A build that
starts with no `content.db` syncs every entry, so a plain `npx pagedeck sync
&& npx pagedeck build` on every push, as the build command above runs, is the
normal case for this host.

If a full sync is too slow for your content source, keep `content.db` between
builds the way "Keep the content store and `.pagedeck/` between CI runs" above
describes. `PAGEDECK_SNAPSHOT_URL` is a credential (see
[PAGEDECK_SNAPSHOT_URL](/reference/cli/#pagedecksnapshoturl)), and any build
that has it can overwrite the snapshot production builds start from. In the
project's Settings > Variables and Secrets, add it to the Production
environment only, and select **Encrypt** so it is stored as a secret.
Cloudflare's [bindings](https://developers.cloudflare.com/pages/functions/bindings/)
page says variables are set "for both your production and preview environments
at runtime and build-time", but it documents **Encrypt** for secrets bound to
Pages Functions and does not say whether an encrypted value reaches the build.
If the first production build stops with the `pagedeck store pull` usage error
that names `PAGEDECK_SNAPSHOT_URL`, the build did not receive it.

Then run the snapshot steps only on a production build. Cloudflare sets
`CF_PAGES_BRANCH` to the name of the branch being deployed
([build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)),
and its guide to
[build commands per branch](https://developers.cloudflare.com/pages/how-to/build-commands-branches/)
branches on it in a `build.sh` the same way. Commit this script beside
`pagedeck.config.ts` and set the build command to `sh build.sh`:

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

Replace `"main"` with the production branch set in the project. If that branch
is ever renamed and the script is not, production builds take the `else`
branch and silently stop pulling and pushing the snapshot.

A preview build gets no `PAGEDECK_SNAPSHOT_URL`, so it neither reads nor
writes the snapshot: it syncs every entry from the content source and builds
the whole site. It cannot run the production steps instead: `pagedeck store
pull` with no URL stops with a usage error that names `PAGEDECK_SNAPSHOT_URL`,
and `pagedeck sync --incremental` on an empty store stops with "no cursor to
sync since — run a full sync first".

On the first production run there is no snapshot to pull and no cursor for
`--incremental` to start from: run `pagedeck sync` and `pagedeck store push`
once first, the same as that section describes for any CI runner.

## Vercel

[Vercel](https://vercel.com/docs) builds from a connected git repository. Set
these in the project's Build and Deployment settings
(https://vercel.com/docs/project-configuration/general-settings):

| Setting | Value |
| --- | --- |
| Framework Preset | Other |
| Build Command | `npx pagedeck sync && npx pagedeck build` |
| Output Directory | `site` |
| Node.js Version | `22.x` or `24.x`, not `20.x`, which predates `@pagedeck/core`'s `engines.node` floor |

Install `@pagedeck/adapter-vercel` and name its factory in `build.adapter`:
`adapter: vercel()`, imported with
`import { vercel } from "@pagedeck/adapter-vercel"`.

`vercel()` writes `vercel.json` at the root of each output tree —
`site/vercel.json` for a site with one tree — a tree file, so `pagedeck diff`
uploads it with the rest of the site like any other. Vercel's own docs
describe `vercel.json` as living at the project's root, which for a pagedeck
site is where `pagedeck.config.ts` is, not where the build writes `site/`;
setting Output Directory to `site` (above) is what makes Vercel read the one
`pagedeck build` wrote instead. Check this on a staging deploy before relying
on it, by requesting a path the routing document redirects and reading the
response.

### Full builds, or keeping the content store

Vercel's build runs in a fresh container on every deploy: it holds no
`content.db` and no `.pagedeck/` from any earlier build. A build that starts
with no `content.db` syncs every entry, so a plain
`npx pagedeck sync && npx pagedeck build`, as the Build Command above runs, is
the normal case for this host, and it is always a full build —
`pagedeck build --incremental` needs `site/` from the previous run too (see
"Keep the content store and `.pagedeck/` between CI runs" above), which
Vercel's build container does not carry over.

If a full sync is too slow for your content source, keep `content.db` between
builds with `npx pagedeck store pull` and `npx pagedeck store push`.
`PAGEDECK_SNAPSHOT_URL` is a credential (see
[PAGEDECK_SNAPSHOT_URL](/reference/cli/#pagedecksnapshoturl)), and any build
that has it can overwrite the snapshot production builds start from. In the
project's Environment Variables settings, add it with the type **Secret**,
which Vercel describes as "write-only after saving" (it replaced the type
Vercel called Sensitive), and with Production as its only target environment
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

The build itself stays a full build — `site/` is not carried over — but a
production sync no longer re-fetches every entry from the content source. A
preview build gets no `PAGEDECK_SNAPSHOT_URL` and takes the `else` branch,
which syncs every entry and touches no snapshot, as on Cloudflare Pages above.
On the first production run there is no snapshot to pull and no cursor for
`--incremental` to start from: run `pagedeck sync` and `pagedeck store push`
once first, the same as that section describes for any CI runner.

## Netlify

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

`publish = "site"` is the directory `pagedeck build` writes. `netlify()`'s
`_redirects` and `_headers` are tree files, so they are already inside it by
the time the build command exits; Netlify uploads them with the rest of the
site, no separate step. `NODE_VERSION` must meet the adapter's own
`engines.node`, `^22.18.0 || >=23.7.0`.

[Pretty URLs](https://docs.netlify.com/build/post-processing/overview/) is a
Netlify post-processing option that rewrites `/about` to `/about/` on its own,
ahead of the site's own `trailingSlash` policy and the rows `netlify()`
compiles for it. Set `pretty_urls = false` so Netlify does not move a page
to its other spelling against the site's policy.

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

Each tree's 404 page is written at the tree's root as `404.html` too (see
[the 404 page](/reference/routing/#the-404-page)), and
[Netlify picks it up](https://docs.netlify.com/manage/routing/redirects/redirect-options/)
for any path `_redirects` does not already answer with its own 404 row.

A Netlify build starts from a clean checkout: nothing survives between builds
unless a [build plugin](https://docs.netlify.com/extend/install-and-use/build-plugins/)
restores it first, so `command` above runs a full `pagedeck sync`, not
`--incremental`, on every build. Keeping `content.db` and `.pagedeck/` between
builds, to sync and build incrementally instead, takes the same two pieces
this page's section on CI already covers — a snapshot for the store, a cache
for `.pagedeck/` — wired into that plugin or into `command` here, rather than
into a plain CI job's own steps.

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
the `else` branch: a full sync and build that touches no snapshot.
