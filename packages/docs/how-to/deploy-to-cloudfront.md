---
section: how-to
title: Deploy to CloudFront
description: Serve a site from S3 behind CloudFront, publish the functions the build compiles, and send a path prefix to an app on AWS Lambda.
---

# Deploy to CloudFront

This page serves a site from an [Amazon S3](https://docs.aws.amazon.com/s3/)
bucket behind a [CloudFront](https://docs.aws.amazon.com/cloudfront/)
distribution. `cloudfront()` from `@pagedeck/adapter-cloudfront` compiles the
site's routing into two CloudFront Functions and the configuration fragments
they need. Nothing here creates AWS resources for you: the build writes files,
and you install them. [Deploy a site](./deploy-a-site.md) covers what every
host shares: what to upload, the plan `pagedeck diff` writes, and rolling
back.

No deploy has run this setup end to end yet. Try it on a staging distribution
before you rely on it, and see the last section for what to check.

## Name the adapter

```sh
npm install @pagedeck/adapter-cloudfront
```

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: cloudfront(),
  },
});
```

`pagedeck build` writes these into `edge/`, beside `site/`. None of them is
part of the upload:

| File | What it is |
| --- | --- |
| `routing.request.js` | the viewer-request function: the redirects, and the refusal of the reserved deploy keys |
| `routing.response.js` | the viewer-response function: the header rules |
| `error-responses.json` | the custom error response that serves the 404 page, when the site declares one |
| `upstreams.json` | an origin and cache behaviours per path prefix, when the site sends one to an app |
| `routing.kvs.json`, `routing.request.config.json` | the redirect table and its store association, when the redirects outgrow the function |

Every site gets the two functions, even one that declares no routing, because
the request function is what keeps `/manifest.json` and `/.pagedeck/` private.

## Upload the site to S3

Turn on [static website hosting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html)
for the bucket, with `index.html` as its index document. The functions do not
map a directory to its `index.html`, and the website endpoint does: it serves
`about/index.html` for `/about/`. AWS documents that a website endpoint is
public and answers over HTTP only, so the distribution reaches it as a custom
origin over HTTP.

Let the bucket policy allow `s3:ListBucket` as well as `s3:GetObject`. S3
answers a request for a missing key with 403 when the reader may not list the
bucket, and 404 when it may
([GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html#API_GetObject_Permissions)).
The build's custom error response, and the refusal of the reserved deploy
keys, rely on the 404.

Upload `site/`, with `manifest.json` last:

```sh
npx pagedeck sync
npx pagedeck build
aws s3 sync site/ s3://my-bucket/ --exclude manifest.json
aws s3 cp site/manifest.json s3://my-bucket/manifest.json
```

`aws s3 sync` sets each file's `Content-Type` from its extension. It deletes
nothing: delete the files a new build no longer writes with the `prune` rows
of the plan `pagedeck diff` writes, after the time the plan gives, as
[Deploy a site](./deploy-a-site.md) describes.

## Publish the functions

Create and publish each function. A CloudFront Function has to be published
before a distribution can run it:

```sh
aws cloudfront create-function --name my-site-request \
  --function-config '{"Comment":"Pagedeck redirects","Runtime":"cloudfront-js-1.0"}' \
  --function-code fileb://edge/routing.request.js
aws cloudfront publish-function --name my-site-request --if-match "$ETAG"
```

`$ETAG` is the `ETag` that `create-function` printed. Do the same for
`routing.response.js` under another name. On a later deploy, replace each
function's code with `aws cloudfront update-function` and publish it again,
whenever the build changed the file.

Then associate the two with the distribution's default cache behaviour: the
request function on the viewer-request event, the response function on the
viewer-response event
([associating functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/associate-function.html)).
A cache behaviour runs one function per event. If your distribution already
runs a viewer-request function of its own, combine the two into one function:
Pagedeck's stages first, then yours.

If the site declares a 404 page, merge the entries of `error-responses.json`
into the distribution's custom error responses. A request for a reserved
deploy key, or for a path with no file, then gets the site's 404 page.

**Many redirects.** A CloudFront Function's code is limited to 10 KB. Past
that, the build moves the redirect table into `routing.kvs.json`, a
[KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html)
dataset, and the request function reads it on the `cloudfront-js-2.0`
runtime. Create a KeyValueStore, import `routing.kvs.json` into it, put its
ARN in place of `${PAGEDECK_ROUTING_KVS_ARN}` in
`routing.request.config.json`, and create the request function with that file
as its function config, in place of the JSON above.

## Send a path prefix to an app on Lambda

A site that declares `build.routing.upstreams` sends each prefix to an app you
deploy yourself, as [Run an app beside the site](./run-an-app-beside-the-site.md)
describes. Behind CloudFront, the app can run on
[AWS Lambda](https://docs.aws.amazon.com/lambda/) with a
[function URL](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html).
A Hono app runs there through the `handle` function from `hono/aws-lambda`
([Hono on AWS Lambda](https://hono.dev/docs/getting-started/aws-lambda)), and
answers the same paths it answers on any other host.

Deploy the function first, then give its URL's origin as the upstream's
`url`, which `cloudfront()` requires:

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: cloudfront(),
    routing: {
      upstreams: [{ prefix: "/api/", url: "https://abc123.lambda-url.eu-west-1.on.aws" }],
    },
  },
});
```

The build writes `edge/upstreams.json`, a fragment of a distribution config.
For each prefix it holds one custom origin, HTTPS only, and two cache
behaviours, `/api` and `/api/*`. Each behaviour allows all seven methods,
uses the managed `CachingDisabled` cache policy, so no answer of the app is
cached, and the managed `AllViewerExceptHostHeader` origin request policy, so
the function URL gets its own host name. It runs no function, so the site's
header rules never reach the app's answers, and the app sets its own.

Merge it into the distribution:

```sh
aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" > distribution.json
```

Add the fragment's `Origins.Items` to the config's origins and its
`CacheBehaviors.Items` to its cache behaviours, ahead of any behaviour of
your own whose path pattern could also match under the prefix, since the
first match wins. Set both `Quantity` fields to the new counts, because an
update replaces the whole list. Then send the config back with `aws cloudfront update-distribution`, with
the `ETag` that `get-distribution-config` printed as its if-match value
([updating a distribution](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowToUpdateDistribution.html)).

Each prefix takes two of the distribution's cache behaviours, 75 by default,
so the build refuses more than 37 prefixes. An account whose quota AWS has
raised sets it with `cloudfront({ limits: { cacheBehaviors } })`.

The function URL still answers on its own address. CloudFront does not hide
it, so an app that must only be reached through the site checks for that
itself.

## Check it on a staging distribution

These rest on CloudFront and S3 behaviour that no deploy of this setup has
checked. Request each path on the staging distribution and read the status
and headers:

- A page and its other trailing-slash spelling, such as `/about/` and
  `/about`.
- `/manifest.json` and `/.pagedeck/x`, which should answer the site's 404
  page with a 404, not a 403.
- A path with no file, whose 404 page should carry the header rules: that
  rests on CloudFront running the viewer-response function over a custom error
  response.
- `/api` and a `POST` under `/api/`, which should reach the app with its
  method, body and query.

The "The edge artifacts" and "An app beside the site" sections of the
[deploy recipe](../deploy-recipe.md) list these facts beside every other
host's.
