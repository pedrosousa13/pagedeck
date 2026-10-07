# `@pagedeck/edge`

The base every edge adapter is built on. A site declares its redirects, 404
page, response headers and experiment splits once, in `build.routing`.
`pagedeck build` writes them into the site's `manifest.json` as one document
that names no host, and an adapter compiles that document into the files one
host serves:

| Package | Factory | Compiles to |
| --- | --- | --- |
| [`@pagedeck/adapter-cloudfront`](../adapter-cloudfront) | `cloudfront()` | CloudFront Functions and their configuration fragments |
| [`@pagedeck/adapter-netlify`](../adapter-netlify) | `netlify()` | Netlify's `_redirects` and `_headers` |
| [`@pagedeck/adapter-nginx`](../adapter-nginx) | `nginx()` | an nginx config fragment |
| [`@pagedeck/adapter-cloudflare-worker`](../adapter-cloudflare-worker) | `cloudflareWorker()` | a Cloudflare Worker |
| [`@pagedeck/adapter-cloudflare-pages`](../adapter-cloudflare-pages) | `cloudflarePages()` | Cloudflare Pages' `_redirects` and `_headers` |
| [`@pagedeck/adapter-vercel`](../adapter-vercel) | `vercel()` | `vercel.json` |

This package holds what the adapters share and names no host: the adapter
contract, the routing normalisation every adapter compiles from, the
JavaScript string encoder, the faults and the refusal they are reported in,
the host-free artifact type and the reserved keys.

```sh
npm install @pagedeck/adapter-nginx @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { nginx } from "@pagedeck/adapter-nginx";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
const { artifacts } = nginx().compile(manifest.routing);
for (const artifact of artifacts) console.log(artifact.role, artifact.path);
```

Each artifact carries its text in `contents`, and its `role` says where it
goes, as [What comes out](#what-comes-out) lists.
[Routing](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/routing.md) covers `build.routing`.

An adapter only compiles. `compile` takes the routing document from the
manifest and returns each file as text. It reads no file, opens no socket and
calls no cloud API. `pagedeck build` does not call it, and no `pagedeck`
command uploads its output. Putting the files on your host is your site's job.

## The adapter contract

An adapter is an `EdgeAdapter`: a `name`, and a `compile` function over the
routing document that returns an `EdgeOutput`, the artifacts in tree order
with `target` set to the adapter's name. `compile` throws one `ConfigError`
that names every fault the document holds for that host, never the first
alone. Each refusal starts `Edge target "<name>"`.

`defineAdapter` builds one from a per-tree compiler, and is what each adapter
package calls. An adapter whose artifacts carry more fields extends
`EdgeArtifact` and passes `describe`, which names an oversized artifact in the
refusal; `unsupportedFix` replaces the fix an `unsupported` fault names.

```ts
import { defineAdapter, treeOf } from "@pagedeck/edge";

// One `from to` line per redirect, for a host that reads such a file.
export const plain = defineAdapter({
  name: "plain",
  limits: { "tree-file": 64 * 1024 },
  compileTree: (tree, faults) => {
    for (const rule of tree.redirects) {
      if (rule.from.includes(" ")) {
        faults.push({
          kind: "unexpressible",
          line: `${treeOf(tree.domain)}'s redirect from "${rule.from}" — this format splits a line on spaces`,
        });
      }
    }
    return [
      {
        ...(tree.domain === undefined ? {} : { domain: tree.domain }),
        role: "tree-file",
        path: "/routes.txt",
        contents: tree.redirects.map((rule) => `${rule.from} ${rule.to}\n`).join(""),
      },
    ];
  },
});
```

Before any adapter's own grammar, `defineAdapter` refuses a routing document
of another version and every header name or value no host can send. It folds
the site's trailing-slash policy into each tree once (`CompiledTree`), so no
two adapters derive different normalizing rules. It measures every artifact
whose role has a limit over the real text, and reports each fault an adapter
pushed, grouped by kind, before the sizes.

## What comes out

Every artifact carries a `role`, which says what a deployer does with it — not
what kind of bytes it holds. A CloudFront Function is not an object in a
bucket, and uploading it as one would leave the redirects inert while the
deploy reported success.

| `role`                | Where it goes                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `tree-file`           | Into the output tree, uploaded with the site (`/_redirects`, `/_headers`)                             |
| `function`            | Published as a CloudFront Function, and associated with a cache behaviour; `@pagedeck/adapter-cloudfront`'s artifacts name the runtime and the event |
| `dataset`             | Imported into the CloudFront KeyValueStore the function reads                                         |
| `function-config`     | A `FunctionConfig` fragment applied to the function beside it, not to the distribution                 |
| `distribution-config` | A `DistributionConfig` fragment CI applies to the distribution                                        |
| `server-config`       | `include`d inside the nginx `server` block that serves the tree                                       |
| `edge-module`         | Published as a Cloudflare Worker, with the tree's R2 bucket bound to it under the name in `binding`    |

### Headers on the 404 page and on redirects

Every response the tree's config answers carries a header set (#559): a page
the set of the prefix its path matches, a redirect the set its `from` matches,
and the 404 page the set of the prefix *its own path* matches, whatever path
was asked for. The oracle the conformance suite holds every adapter to claims
exactly this.

The 404 rule is nginx's constraint, taken for every adapter. nginx never shares
`add_header` between sibling `location` blocks, so the lines in a `^~` prefix
block reach neither a redirect's exact location nor the 404 page's, which
`error_page` sends the request to. Each of those blocks carries the lines
itself, and one location's lines cannot vary with the request. The lines are
not at `server` level, because a location with an `add_header` of its own drops
every inherited one.

A host's own bare 404, on a tree with no 404 page, is outside the claim. On
nginx a missing path then carries the set of the prefix block that answered
it, and a reserved deploy key, refused before any location, carries none.

Some host facts this rests on are not verified, and `docs/deploy-recipe.md`
lists them: whether Netlify matches `_headers` against a `404` row's target,
whether CloudFront runs the viewer-response function over a custom error
response, which path Cloudflare Pages matches `_headers` against for a
proxied (200) response, and whether a redirect response carries `_headers` on
Cloudflare Pages at all. The same shape holds for Vercel: whether a `routes`
entry ahead of `{"handle": "filesystem"}` masks a real file the way
`@pagedeck/adapter-vercel`'s README assumes.

### Reserved deploy keys

A reserved deploy key is one of the few tree-relative keys the deploy writes
for itself rather than for the site; "deploy key" alone means any key a deploy
writes. A deploy publishes the build's manifest at `/manifest.json` and files a copy of
it, with its deploy instant, under `/.pagedeck/manifests/`. Nothing in a browser
reads either, and the deploy reads the origin directly, so every tree, whatever
the adapter, answers `/manifest.json`, `/.pagedeck` and everything under `/.pagedeck/` with the
site's 404 — the response a missing page gets — or a bare 404 where the tree
has no 404 page (#556). A site does not ask for this and cannot turn it off:
`planRouting` refuses a page or a redirect at these paths, and a header rule
that covers them sets headers on the 404 and serves no file.

Each adapter's README says how it denies them.

So every tree compiles to artifacts, even a tree that declares nothing, which a
host has to install like any other.

### Trailing slashes

The site's policy (`RoutingManifest.site.trailingSlash`) is not only a spelling
rule for emitted links. Spec §11 asks that it stop "S3/CloudFront resolution
quirks" creating duplicate-content URLs, and a request for the spelling the site
does not publish is exactly that quirk: S3 behind CloudFront will often resolve
`/pricing/` to the same object as `/pricing`, and the page is live at two
addresses.

So every address the document names — each redirect's source and each
redirect's target — also gets a rule on its other spelling, sending it to the
canonical one. A source's other spelling answers what the source answers, so
neither spelling costs an extra hop; a target's other spelling is a 308 to the
page. On Netlify these rows are forced (`301!`), because an unforced rule loses
to the file the origin holds — which is the file being redirected away from.

Not as a site-wide pattern, deliberately: `_redirects` cannot express "a path
ending in a slash" (a splat is only valid last), so a pattern rule would give
the other adapters a behavior Netlify's does not have. An exact row per address
is what every adapter spells identically.

The 404 page is excluded. It is not an address — nginx serves it `internal` —
so a rule pointing at it would publish the one page the adapters refuse to serve
directly.

## Known gaps

- **A split is compiled by one adapter only.** `@pagedeck/adapter-netlify`,
  `@pagedeck/adapter-nginx`, `@pagedeck/adapter-cloudflare-worker`,
  `@pagedeck/adapter-cloudflare-pages` and `@pagedeck/adapter-vercel` refuse
  one, so a site that wants an experiment compiles with
  `@pagedeck/adapter-cloudfront`; its README documents the pattern for the
  others, which is not implemented.
- **No default header set.** A site that declares no `build.routing.headers`
  compiles an empty header table on every adapter, and `pagedeck build` warns
  about it. `SECURITY_HEADERS` from `@pagedeck/core` holds three headers to
  spread into a rule over `/`.
- **No `pagedeck` command calls an adapter.** You call it yourself, as the
  example at the top does (#20).
- **No artifact hashes.** The manifest records no hash of a compiled artifact,
  so a deploy cannot tell an unchanged function from a changed one and skip
  publishing it.
- **Trailing-slash normalization covers the addresses the document names, and
  no others.** A page that is neither a redirect source nor a redirect target
  gets no normalizing rule, because the routing document is not a page
  inventory; its other spelling is still answered by the origin.
