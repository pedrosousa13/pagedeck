# `@pagedeck/adapter-netlify`

Compiles a built site's routing document into Netlify's `_redirects` and
`_headers`, two tree files uploaded with the site. Its refusals name it
`netlify`.

```sh
npm install @pagedeck/adapter-netlify @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of netlify().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.

Upload both files after the site's own files, so no redirect goes live before
its target.

## What it refuses

Netlify reads `*` in a path pattern as a splat and a path segment beginning
`:` as a placeholder, and offers no escape for either, so a redirect, a header
prefix or a 404 page holding one is refused rather than emitted. An experiment
split is refused too, naming every page it was declared on:
`@pagedeck/adapter-cloudfront` is the only adapter that compiles one.

[Netlify's redirect options](https://docs.netlify.com/manage/routing/redirects/redirect-options/)
document only 301, 302, 200 and 404 for a redirect, and name 307 directly:
"Use this status code [302] instead of 307, which is currently unsupported."
An authored `status: 307` is refused. 308 is not named on that page at all —
neither supported nor refused there — and this adapter still emits it, because
`trailingSlash`'s own canonical-spelling redirect is 308 by default
(`@pagedeck/core`'s `DEFAULT_STATUS`) and refusing it would refuse the common
case. Community reports of 308 behaving inconsistently on Netlify exist; watch
a deploy's actual redirects if this matters to you.

## Reserved deploy keys

The first three rows of `_redirects` are forced with `404!`, so they
beat the files the origin holds. Whether Netlify matches a percent-escaped
spelling such as `/%2Epagedeck/…` against these rows is the host's behavior, which
CI cannot run.

## Trailing slashes

The rows that send a non-canonical spelling to the canonical one are forced
(`308!`), because an unforced rule loses to the file the origin holds, which
is the file being redirected away from.

[Netlify's Pretty URLs](https://docs.netlify.com/build/post-processing/overview/)
post-processing option forwards `/about` to `/about/` on its own, independent
of this adapter's rows and of the site's own `trailingSlash` policy. Set
`pretty_urls = false` under `[build.processing.html]` in `netlify.toml` so
Netlify serves exactly the paths the routing document names.
