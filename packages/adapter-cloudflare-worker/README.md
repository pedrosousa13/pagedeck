# `@pagedeck/adapter-cloudflare-worker`

Compiles a built site's routing document into a Cloudflare Worker that serves
the tree from an R2 bucket. Its refusals name it `cloudflare-worker`. It has
not yet served a site in production: test it on a staging deploy before you
rely on it.

```sh
npm install @pagedeck/adapter-cloudflare-worker @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { cloudflareWorker } from "@pagedeck/adapter-cloudflare-worker";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of cloudflareWorker().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.

`cloudflareWorker()` takes `limits`, whose `edge-module` defaults to
`CLOUDFLARE_WORKER_LIMIT`.

## The Worker

This adapter compiles each tree to one `worker.js`, an ES module Worker
that serves the tree from the R2 bucket bound to it as `PAGEDECK_ORIGIN`, the
name the artifact's `binding` records. The redirect table and the header table
are in the script. There is no dataset
form: the Workers script limit (`CLOUDFLARE_WORKER_LIMIT`, 3 MB, measured over
the text) holds a redirect table CloudFront has to move out of its function.

**The live manifest decides what is served.** On each request the Worker reads
`manifest.json` from the bucket and serves a path only when a row of that
manifest names it, as the path itself or as `<path>/index.html`. A deploy puts
`manifest.json` last, so a build's pages are served once it is live, and a
rollback, which puts the restored build's manifest, is served without
publishing the Worker again. A change to the routing is not: the redirects and
the header sets are compiled into the script, so the Worker is published again
whenever `worker.js` changes.

**An R2 key is the deploy key without its leading `/`.** `/en/about/index.html`
is stored as `en/about/index.html`, and a domain tree's `//shop.example/x` as
`/shop.example/x`. The signing step in `docs/deploy-recipe.md` writes the same
keys.

**Refused before any object is read**, with the site's 404:

- a reserved deploy key, matched on the decoded path with empty segments
  dropped, whether or not the manifest names it;
- a path whose decoded form holds a `.` or `..` segment or a control
  character, a path holding `\`, `%2F` or `%5C`, and a path that does not
  decode. The Worker takes the path from `request.url` as the runtime hands it
  over and does not parse it, so a dot segment the runtime passed through is
  still seen.

A method other than `GET` and `HEAD` is answered `405` and reads nothing. The
`405`, and the bare 404 of a tree with no 404 page, carry the set of the path
requested, so a site's security headers reach every response the Worker writes.

**A page carries the object's `ETag`, and a conditional request gets a `304`.**
A `200` carries the R2 object's `httpEtag`. A `GET` or `HEAD` whose
`If-None-Match` holds that etag, compared weakly (RFC 9110 §13.1.2, so
`W/"x"` matches `"x"`), or is `*`, is answered `304` with no body and every
header the `200` would carry. Without `If-None-Match`, an `If-Modified-Since`
at or after the object's `uploaded` time is answered `304` too. The Worker
sends no `Last-Modified`. A 404, a redirect and a `405` ignore both fields.

**A redirect sends only what the table holds.** The request path is never
written into a `Location`, and a redirect target that is not a tree-relative
path is refused at compile time by core's own `offsiteReason`, which
`planRouting` applies to the config.

A served object carries the `Content-Type` and `Cache-Control` the deploy
stored it with, and the routing set is written over them: a header rule that
sets `Cache-Control` wins.

An experiment split is refused, naming every page it was declared on:
`@pagedeck/adapter-cloudfront` is the only adapter that compiles one.

## Known gaps

- **The Worker reads and parses `manifest.json` on every request**, a `304`
  included.
