# Sites

Three packages are also sites, each with a `pagedeck.config.ts` at the package
root, built in place:

```sh
cd packages/<site>
node ../core/dist/bin.js sync
node ../core/dist/bin.js build
```

Each writes `site/`, `content.db` and `.pagedeck/`, all gitignored. The
landing page and the docs are not among them: they are one site in
pedrosousa13/deck-cool, `sites/pagedeck`, served at `https://page.deck.cool`
(#124).

No checked-in site declares `build.budget` or `build.islandPropsBudget`, and
no test holds a site or a module to a byte limit: budgets are a feature a site
opts into (maintainer ruling 2026-11-02, #230).

Each site sets a `Content-Security-Policy` on its `/` header rule (#557, #577),
in its `src/csp.ts`. The CMS example is the exception: it is never deployed and
declares no header rule (#694). A site that is deployed follows the rule. The
hash of an inline loader core composes is pinned, copied from the manifest:
when core changes a loader, copy the new hash. No site here declares a script
runtime. One that declares `@pagedeck/script-worker` pins its snippet's hash
from `runtime.inlineScriptHash`, not from the manifest, which records only the
inline scripts core writes, and copies it again when the runtime's options or
the package's version change (#275).
`site.build.test.ts` fails on a page hash the policy lacks or a policy hash no
page carries.

**A new search engine test belongs in `packages/search`**, not in a site: a
test riding on a site's content is retired by the next change to that content.
## The site port

`packages/site` is the dogfood site (#56). `pagedeck sync` reads its entries,
`src/content.ts`, through a loader on the public `Loader` contract,
`src/loader.ts` (#745), so no build of it reaches a network. `/en/legal/terms`
is the nested slug of #161, which is why routes are written as segments. Its
subpaths `@pagedeck/site/props` (the field-to-prop step, #213), `/images`,
`/content`, `/loader` and the parity pair are what other packages reach; the
step lives here because its answers depend on this site's locale map and
catalog (#56).

Its fonts (#45) are static `ofl/firasans/` files from `google/fonts` at
`e345593da2a4d596212542edbd28f2ed08fe6cbe`; a variable binary would serve one
weight.

**Deploy** (#57, #652), which lives here and not in core (spec decision #10):

```sh
cd packages/site
node dist/deploy.bin.js --origin ../../.origin                    # prints the plan
node dist/deploy.bin.js --origin ../../.origin --apply            # writes it
node dist/deploy.bin.js --origin ../../.origin --apply --prune    # and deletes
```

A dry run is the default and `--apply` is the only way out (`GLOSSARY.md`).
`docs/deploy-recipe.md` covers presigned origins (`PAGEDECK_DEPLOY_URLS`), the
refusals, `--edge` and `.github/workflows/deploy.yml`. `dist/presign.bin.js`
is the R2 signing step the origin harness proves (#665); no workflow runs it.

**Parity** (#58):

```sh
cd packages/site
node dist/parity.bin.js compare --build ./site
node dist/parity.bin.js capture --origin https://… --out baseline.json
```

`pageFacts` (`src/parity.ts`) is the only code that turns a document into
comparable facts; do not write a second reader. `parity.build.test.ts` builds
into a scratch directory, because `site.build.test.ts` builds `packages/site`
itself and Vitest runs files in parallel. `docs/dogfood-parity.md` holds the
rules and the procedure.

## The CMS example

`packages/cms-example` builds a site from a local headless CMS it ships, a
`node:http` server on `127.0.0.1`, through a loader written against the loader
contract (#694). Its sync needs the CMS running: `node dist/serve.js` first,
or set `PAGEDECK_CMS_EXAMPLE_URL` to where it serves. It names no CMS vendor:
it is the model a site author copies for their own CMS. Its `README.md` holds
the wire shape and the loader's choices.

## The app example

`packages/app-example` is a site with a Hono app beside it on Cloudflare
Workers Static Assets (#141, ADR-0010). Its config declares the app in
`build.routing.upstreams`, which the build checks against every path it
writes, `pagedeck dev` forwards to `wrangler dev`, and the client build uses to
refuse an island's value import of `src/app.ts`. `wrangler.jsonc` sends
`/api`, `/api/*`, `/account` and `/account/*` to the app and every other
request to `site/`. `cloudflarePages()` reads it and fails the build when its
`run_worker_first` and the config's prefixes disagree (#145);
`src/run-worker-first.build.test.ts` builds a copy without `/api/*`. The island on `/signup/` imports the app's type only.
Every adapter routes upstreams under a policy `defineAdapter` enforces: it
requires, refuses or allows `url`, and an adapter that declares no policy
refuses every upstream. `docs/deploy-recipe.md`, "An app beside the site",
holds each host's steps and the host facts a first deploy still has to check. `src/site.build.test.ts` builds the site in place, serves it
with `wrangler dev`, and requests both halves; it also fails if any file the
build writes holds the app's error message.

## The shared brand

`packages/brand` holds the look of the dogfood site and the design system
(#547). **Changing a token in `brand.css` changes both.** A site takes it
with `"@pagedeck/brand": "workspace:*"` in its `dependencies` and one line
after the `@layer` statement in its `styles/global.css`, relative because a
`node_modules` path exists only after an install:

```css
@import "../../brand/brand.css";
```

Every token is a `--pagedeck-*` custom property: the `fg`, `bg`, `ring` and
`rule` colours, and the `font`, `text`, `leading`, `space`, `radius` and
`ring-width`/`ring-offset` families (#125).
`packages/brand/src/brand.test.ts` holds every text/surface pair to WCAG AA in
both themes, picking pairs by token name, so a new `--pagedeck-fg-*` or
`--pagedeck-bg-*` is checked the day it lands. A site checks its own sheet with `colourFaults`
and `pairFaults`.
