# `@pagedeck/adapter-vercel`

Compiles a built site's routing document into `vercel.json`, a tree file
uploaded with the site. Its refusals name it `vercel`.

```sh
npm install @pagedeck/adapter-vercel @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { vercel } from "@pagedeck/adapter-vercel";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of vercel().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.
[Deploy a site](https://pagedeck-docs.pedrodsousa.workers.dev/how-to/deploy-a-site/#vercel)
covers Vercel's own project settings and where `vercel.json` has to end up.

## What it writes, and why not only `redirects` and `headers`

Vercel's declarative `redirects` and `headers` fields
(https://vercel.com/docs/project-configuration/vercel-json) hold the site's
authored redirects and its response headers, matched against each request's
own path. `trailingSlash` (boolean) and `cleanUrls` (always `true`, since a
pagedeck page is never addressed by a `.html` name) answer the rest of a
page's other spelling natively, so this adapter writes no explicit row for it
the way Netlify's forced rows do — Vercel's own setting already runs ahead of
the real file the way a forced row has to.

`routes` (https://vercel.com/docs/project-configuration/vercel-json#routes),
the lower-level property the higher-level fields are documented to coexist
with, is what masks the three reserved deploy keys past the real file the
build wrote there, with `{"handle": "filesystem"}` ahead of the real site's
files so a page is never shadowed, and what carries the 404 page's own header
set onto every other miss in the tree: Vercel reads `headers`'s `source`
against the path a visitor asked for, never the page a miss serves, so the
declarative field alone cannot give a miss at an arbitrary path the 404 page's
headers the way `@pagedeck/edge`'s conformance suite claims every target does.
`routes` entries carry `dest`, `status` and `headers` together, so they can.

**This rests on a host fact nobody has checked: that a `routes` entry ahead of
`{"handle": "filesystem"}` still wins over a real file, and one declared after
it is reached only where no real file answers.** `docs/deploy-recipe.md` lists
it beside Netlify's and CloudFront's own unverified facts. Check it on a
staging deploy before relying on it.

## What it refuses

Vercel reads `redirects[].source`/`destination` and a header `source` as
path-to-regexp, where `:`, `(`, `)`, `*`, `+` and `?` are syntax, and documents
no escape for a literal one
(https://vercel.com/docs/project-configuration/vercel-json#redirects), so a
redirect or a header prefix holding one is refused rather than emitted. An
experiment split is refused too, naming every page it was declared on:
`@pagedeck/adapter-cloudfront` is the only adapter that compiles one.

Vercel documents a limit of 2,048 redirects per array and 4,096 characters per
`source`/`destination`
(https://vercel.com/docs/routing/redirects/configuration-redirects#limits); a
routing document over either is refused by name.

## Reserved deploy keys

`/manifest.json`, `/.pagedeck` and everything under `/.pagedeck/` are matched
by a `routes` entry ahead of `{"handle": "filesystem"}`, each carrying the
404 page's own `status`, `dest` and header set, so the key never serves the
real file the build wrote there.

## Trailing slashes

`trailingSlash` is Vercel's own setting, not a row this adapter writes: `true`
for `"always"`, `false` for `"never"`. It exempts a path whose last segment
holds a `.` from the redirect, which is also how `compiledTree` marks a file
target as having one spelling — the two line up for every file this build
emits, since a file target's own path is read off what the build actually
wrote. An authored redirect's address is a different matter: it is the path an
author chose, not a claim that it names a file, so every row `compiledTree`
derives for it — the redirect's own other spelling and its target's — is
written into `redirects` explicitly rather than left to the setting's
extension heuristic.
