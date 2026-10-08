# `@pagedeck/adapter-cloudflare-pages`

Compiles a built site's routing document into
[Cloudflare Pages](https://developers.cloudflare.com/pages/)'
[`_redirects`](https://developers.cloudflare.com/pages/configuration/redirects/)
and
[`_headers`](https://developers.cloudflare.com/pages/configuration/headers/),
two tree files uploaded with the site. Its refusals name it `cloudflare-pages`.

```sh
npm install @pagedeck/adapter-cloudflare-pages @pagedeck/core
```

```ts
import { defineConfig } from "@pagedeck/core";
import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages";

export default defineConfig({
  // ...
  build: {
    // ...
    adapter: cloudflarePages(),
  },
});
```

`pagedeck build` then writes `_redirects` and `_headers` into `site/` itself
([Deploy a site](https://pagedeck-docs.pedrodsousa.workers.dev/how-to/deploy-a-site/)).
Called directly, after `npx pagedeck build`:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of cloudflarePages().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.

## Build settings

Cloudflare Pages reads build settings from its dashboard, not from a file in
the repository:

| Setting | Value |
| --- | --- |
| Build command | `npx pagedeck sync && npx pagedeck build` |
| Build output directory | `site` |
| `NODE_VERSION` | a version meeting `@pagedeck/core`'s `engines.node`, currently `22.18.0` or later |

Set `NODE_VERSION` as an environment variable on the Pages project: Cloudflare's
build image otherwise runs an older Node that cannot load `pagedeck.config.ts`
([the build configuration
page](https://developers.cloudflare.com/pages/configuration/build-configuration/)).

**A build on Cloudflare's CI runner starts with no `content.db` and no
`.pagedeck/`**, so it syncs every entry and `pagedeck diff` would refuse a
manifest-driven deploy. Cloudflare Pages is a directory-sync host — it reads no
manifest and republishes whatever `site/` holds — so that refusal never
applies here; a full `pagedeck sync && pagedeck build` on every push is the
normal case. Keep `content.db` out of the deploy entirely by running
`pagedeck store pull` and `pagedeck store push` around the build (see the
how-to above, "Keep the content store and `.pagedeck/` between CI runs") only
if a full sync is too slow for your content source.

## Direct upload

To publish a build without connecting a git repository, build locally or in
your own CI and upload the output directory with
[`wrangler`](https://developers.cloudflare.com/pages/configuration/build-configuration/):

```sh
npx pagedeck sync
npx pagedeck build
npx wrangler pages deploy site
```

## What it refuses

Cloudflare Pages reads `*` in a path pattern as a splat and a path segment
beginning `:` as a placeholder, and offers no escape for either, so a
redirect or a header prefix holding one is refused rather than emitted. A
nested header rule that sets the same name as an enclosing one is refused too:
Cloudflare joins a header set twice with a comma rather than letting a nested
rule replace it, and replacing one would need detaching and setting the same
name in one block, which is undocumented. An experiment split is refused,
naming every page it was declared on: `@pagedeck/adapter-cloudfront` is the
only adapter that compiles one.

**`trailingSlash: "never"` is refused.** Cloudflare Pages redirects a
directory's `index.html` to its slashed address on its own
([serving pages, "Route
matching"](https://developers.cloudflare.com/pages/configuration/serving-pages/#route-matching)),
which this adapter cannot override. Set `trailingSlash: "always"` — the
default since pagedeck 0.1 — and a default site passes.

**Cloudflare's documented limits are refused by name**
([redirects, "Per
file"](https://developers.cloudflare.com/pages/configuration/redirects/#per-file),
[headers, "Attach a
header"](https://developers.cloudflare.com/pages/configuration/headers/#attach-a-header)):
2,000 redirects (this adapter writes no dynamic row of its own besides its
fixed deny of `/.pagedeck/*`, so the 100-dynamic-redirect cap is never the one
a real site reaches), 1,000 characters per redirect line, 100 header rules and
2,000 characters per header line.

## Reserved deploy keys

Cloudflare Pages cannot rewrite a path with a status other than 200
([redirects, "Advanced
redirects"](https://developers.cloudflare.com/pages/configuration/redirects/#advanced-redirects)),
so `_redirects` proxies (`200`, in place) `/manifest.json`, `/.pagedeck` and
everything under `/.pagedeck/` to the tree's 404 page. A proxied response
always wins over the real file at that key
([redirects, "Per
line"](https://developers.cloudflare.com/pages/configuration/redirects/#per-line):
"Redirects are always followed, regardless of whether or not an asset matches
the incoming request"), so the key's own bytes never serve. When the tree
declares no 404 page, the target is a minimal page this adapter writes itself
at the tree's root (`404.html`), so the key still resolves to a bare 404
rather than Cloudflare's single-page-application fallback for a missing
top-level `404.html`
([serving pages, "Single-page application (SPA)
rendering"](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering)).

**Two host facts this rests on are not verified** (see `@pagedeck/edge`'s
README, "Headers on the 404 page and on redirects", and
`docs/deploy-recipe.md`): which path `_headers` matches a proxied response
against — this adapter assumes the original request's path, not the 404
page's — and whether a redirect response carries `_headers` at all. A missing
page that is not a reserved deploy key is outside this adapter's `_redirects`
and `_headers` entirely: Cloudflare's own nearest-`404.html` lookup serves it,
and whether that carries the 404 page's own headers or none is a third
unverified fact.

## The `_headers` detach encoding

A request on Cloudflare Pages inherits the headers of every matching rule,
joining a repeated name with a comma
([headers, "Attach a
header"](https://developers.cloudflare.com/pages/configuration/headers/#attach-a-header)),
unlike the routing document's one-rule-wins model every other adapter
compiles directly. So a longer (more specific) prefix's block detaches
(`! Name`, [headers, "Detach a
header"](https://developers.cloudflare.com/pages/configuration/headers/#detach-a-header))
every header a shorter, enclosing prefix sets that it does not itself set.
Detaching also removes Cloudflare's own default `X-Content-Type-Options` and
`Referrer-Policy` on that path
([serving pages,
"Headers"](https://developers.cloudflare.com/pages/configuration/serving-pages/#headers)).
`_headers` is written with the shortest (least specific) prefix first and the
longest last, the order the detach section's own example uses, and the
opposite of `_redirects`' and the routing document's longest-first order.

## Trailing slashes

The rows that send a non-canonical spelling to the canonical one are plain
redirects, with no force marker: unlike Netlify, Cloudflare Pages always
follows a `_redirects` row ahead of a real file, so there is nothing to force.
