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
[PAGEDECK_SNAPSHOT_URL](/reference/cli/#pagedeck-snapshot-url) explains:

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
before a deploy. The build writes them into `site/manifest.json` in a form that
names no host.

An adapter compiles them into edge artifacts, the files one host reads. Each
host has its own adapter package. Install the one for your host, here Netlify:

```sh
npm install @pagedeck/adapter-netlify
```

Save this as `compile-edge.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifest } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of netlify().compile(manifest.routing).artifacts) {
  const tree = artifact.domain ?? "";
  const file =
    artifact.role === "tree-file" ? join("site", tree, artifact.path) : join("edge", tree, artifact.path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, artifact.contents);
  console.log(`${artifact.role} ${file}`);
}
```

Run it after each build:

```sh
node compile-edge.ts
```

Each edge artifact has a `role`, and the role says where it goes. The script
writes a `tree-file` into `site/`, to be uploaded to the origin with the site,
and every other edge artifact into `edge/`, which you install on the host
yourself. For another host, install its adapter and call its function in place
of `netlify()`:

- `netlify()` from `@pagedeck/adapter-netlify` writes `_redirects`, and
  `_headers` when the site declares header rules. Both are tree files. Upload
  them after the site's own files, so no redirect goes live before its target.
  If you upload only what changed, upload them too: they are not in the plan.
- `nginx()` from `@pagedeck/adapter-nginx` writes `routing.conf`. `include` it
  in the `server` block that serves `site/`.
- `cloudfront()` from `@pagedeck/adapter-cloudfront` writes a viewer-request
  and a viewer-response CloudFront Function, and configuration fragments when
  the routing needs them. Publish each function and associate it with the
  distribution. A function uploaded to the bucket does nothing.
- `cloudflareWorker()` from `@pagedeck/adapter-cloudflare-worker` writes
  `worker.js`, published as a Worker with the site's R2 bucket bound to it.
  This adapter has not yet served a site in production: test it on a staging
  deploy before you rely on it.

Every adapter's edge artifacts answer `/manifest.json` and `/.pagedeck/` with a
404, even for a site that declares no routing. Install them, and the manifest
you uploaded to the origin stays private.
