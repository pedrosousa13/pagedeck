# AGENTS.md

## Working in this repo

```sh
pnpm install
pnpm build       # every package's dist, each deleted first
pnpm typecheck   # tsc --noEmit over the working tree, then the starter template
pnpm test        # pnpm build, then vitest run
```

- `npx vitest run <file>` runs one file. A test that spawns `pagedeck` runs
  `packages/core/dist/bin.js`, so `pnpm build` first.
- Node 24, as in CI.
- The root `package.json` holds every runnable; a package has only `prepack`.
- The root `tsconfig.json` typechecks each `src` tree plus the files it names
  one by one, each Vitest config and site config. Add a new one there.
- `pnpm typecheck` then checks `packages/create-pagedeck/template` through the
  template's own `tsconfig.json`, against the emitted `.d.ts` a site installs,
  as a user's editor reads it. It first runs `tsc -b` on the packages the
  template imports, so it needs no `pnpm build`.
- Every environment variable this repo reads starts `PAGEDECK_`.
- `pnpm test` runs no harness, though it runs each `*.harness.test.ts`,
  which tests a harness's logic (see "Harnesses").

## Agent skills

### Issue tracker

Issues live in the repo itself — GitHub issues on pedrosousa13/pagedeck, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label names, as repo labels on pedrosousa13/pagedeck — plus `in-progress` and `P0`–`P3`, labels that stand in for a missing field. See `docs/agents/triage-labels.md`.

### Error messages

Build failures are documentation: name the collection, entry and field, state
the fix, attach the cause, report every failure, redact credentials. The rules
and real before/after examples are in `docs/error-messages.md`. Follow them in
any code that throws.

### Comments

A comment says only what the code cannot. The rule and its keep-list are
`CONTEXT.md`'s standing decision **Comments say only what the code cannot**
(#631). A reason a doc needs goes in the doc, or in the issue or ADR it names,
never in a source comment the doc points at.

## Rules

### One door onto the bundler

**Outside a `*.test.ts` file, `build` is imported from `vite` by
`packages/core/src/bundler.ts` and by nothing else.** Every build a verb runs,
and every `.test-support.ts` harness, goes through `runBundle` there, which
wraps each hook on the framework's own plugins so a throw is rethrown after
`build()` settles. Otherwise Rolldown flattens it to a plain `Error`, losing
the class rule 7 branches on and the `cause` rule 4 attaches. A suite that
builds its own fixture measures a plugin and may call `build()`.
`packages/core/src/bundler-invocations.test.ts` refuses a second non-suite
importer (#225). Neither the guard nor that test reaches:

- a plugin handed over as `sitePlugins`;
- one of the framework's own plugins put there by mistake
  (`react-compiler.test.ts` does it on purpose);
- the dev server's `createServer`, where a throwing hook loses class and cause
  and no exit code says so;
- a new module importing `createServer`;
- a `*.test.ts` calling `build()` directly.

### The build step

`pnpm build` emits each package's JavaScript and `.d.ts` to its own `dist` in
one `tsc -b tsconfig.build.json` (#191). `packages/core/dist/bin.js` loads a
site's `pagedeck.config.ts` in Node, compiling the site's own `.tsx` and `.jsx`
outside `node_modules` through the hook `bin.ts` registers (#702); a program
calling `loadConfig` or `startDevServer` directly gets no hook. Every package a
config reaches must still be emitted: Node reaches it through its `exports`
`default`, the hook leaves an installed copy under `node_modules` alone, and
Node fails on a `.js` specifier with only a `.ts` beside it (#182).

**Every directory under `packages/` that has a `package.json` is emitted.**
`packages/core/src/workspace-packages.test.ts` checks every manifest against
the rule and imports each package in a real Node process. Do not weaken an
assertion there to admit a package.

- **`exports` carries three conditions per subpath, `source` first**: `source`
  at the TypeScript, `types` at the emitted `.d.ts`, `default` at the emitted
  `.js`. The root `tsconfig.json` asks for `source` by `customConditions` and
  `vitest.config.ts` aliases from it, so the typecheck and the suite read the
  working tree. **The order is load-bearing and its failure is silent**: with
  `types` first the typecheck reads whatever `dist` is on disk. Keep `types`:
  a consumer's resolver may not find a sibling `.d.ts` (#185). A new subpath,
  wildcards included, needs all three.
- **`pnpm test` runs `pnpm build` first**, so a spawned `pagedeck` is the
  working tree. `vitest run` alone does not.
- **List every package in the root `tsconfig.build.json`.** Build order comes
  from each package's own `tsconfig.build.json` `references`, which must name
  every workspace package its emitted source imports. Write them from the
  imports, not from a green build: a missing one passes while another package
  happens to build the dependency first. Nothing checks the root listing
  directly: an unlisted package is caught only because
  `workspace-packages.test.ts` imports every concrete subpath and finds no
  `dist`, which misses a package that exports only a wildcard subpath.
- **A test-only edge stays out of `references`**, and every
  `tsconfig.build.json` excludes tests and `*.test-support.ts`. That keeps
  `tsc -b` acyclic where dependencies are not: `@pagedeck/core` and
  `@pagedeck/fixtures`, `@pagedeck/site` and `@pagedeck/design-system`.

`pnpm build` deletes each `dist` first, because a renamed or deleted source
otherwise leaves its old `dist/*.js` for Node to import. `tsBuildInfoFile` is
`dist/.tsbuildinfo` so the same delete wipes the incremental cache, which would
otherwise make `tsc -b` skip a package whose `dist` is gone.

### The published tarball

The release workflow publishes the public set to npm on a `v*` tag (#7; see
"Releasing"), and `npm pack` must produce a tarball holding
the emitted `dist`, the manifest, and the README and LICENSE npm always packs,
and nothing else (#185). Every package declares the same three fields:

- **`"files": ["dist", "!dist/.tsbuildinfo"]`.** Without it, `src`, the tests
  and the cache are packed: npm reads no root `.gitignore` here.
- **`"scripts": { "prepack": "tsc -b tsconfig.build.json" }`**, so a tarball
  is never cut from a stale `dist`. Not `pnpm build`, which deletes every
  package's `dist`.
- **`"types": "./dist/index.d.ts"`**, for a resolver that ignores `exports`.

`packages/core/src/publishable-packages.test.ts` packs every package for real.
**`create-pagedeck` is the one exception** (#691). It also packs `template/`,
the site it copies, and its `files` names each template file one by one
(#731). That one list decides three things: npm packs those files, `create()`
copies those files, and `packedBesideDist` in
`packages/core/src/public-packages.test-support.ts` admits those files and no
others, in this test and in the pack harness. A directory named in `files`
admits nothing under it. A file in `template/` that the list does not name is
never packed or written, and fails `create-pagedeck`'s own suite. Add a new
template file to `files`. The template's
`.gitignore` is stored as `_gitignore`, because npm and pnpm leave every file
named `.gitignore` out of a tarball, and is renamed when the site is written.
**`packages/docs` takes the uniform `files` by choice**: its config and content
stay out of a tarball nothing consumes; if it ever ships, argue its own
`files` here rather than widen the rule. **`packages/brand`'s `brand.css` and
`favicon.ico` are not packed** (#547, #549); packing them needs a copy step or
an amendment to the "packs only `dist`" standing decision, a maintainer call.
**`satori`, `@resvg/resvg-js` and `subset-font` are pinned to exact
versions**, because a patch release may change the bytes they emit. Core pins
**`rolldown`** exactly for `transformSync`, which compiles a site's `.tsx` and
`.jsx` (#702): rolldown marks it experimental, and core reads a compile error's
position from a field its types do not declare.

**The public set** is the fifteen packages a site author installs (#690),
the six edge adapters among them (#19), and `create-pagedeck`, which writes a
new site (#691), listed in
`packages/core/src/public-packages.test-support.ts`. Each is `0.2.2`, MIT,
with `repository`, `engines.node` and `publishConfig.access`; every other
package stays `private` (#689).
`engines.node` is the lowest Node the package and its dependencies need:
`^22.18.0 || >=23.7.0` for core and every package depending on it: 22.18 is
where Node loads `pagedeck.config.ts` with types stripped and no flag, and
23.7 is the first Node 23 with `module.setSourceMapsSupport`, which `bin.ts`
calls at startup through `installJsxLoader` (#702);
`^22.13.0 || >=23.4.0` for content and the markdown loader, for an unflagged
`node:sqlite`; `>=22.0.0` for islands, which uses no Node API. The scaffolder
`create-pagedeck` itself needs less, but it takes core's range because the site
it writes needs core's. Raise a floor when new code needs a newer API, and say
which.

### Releasing

`.github/workflows/release.yml` publishes the public set to npm when a tag
`v<version>` is pushed (#7). It has two jobs (#58):

- **`verify`** holds `contents: read` only. It installs with
  `--frozen-lockfile`, checks the tag with `pnpm check:release-tag`, and runs
  `pnpm test:pack-harness`.
- **`publish`** `needs: verify` and is the only job with `id-token: write`.
  It checks out again, installs with `--frozen-lockfile --ignore-scripts`, and
  runs `pnpm -r publish --access public --provenance --no-git-checks` and
  nothing else.

Any step in a job with `id-token: write` can mint an OIDC token, and npm's
trusted publisher exchanges that token for publish rights to every public
package. So the token reaches only the job that runs the publish, and never
the install scripts, the registry install or the site builds of the pack
harness. `cleanEnv` in `pack.harness.ts` also strips
`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` from what
the harness spawns. `--ignore-scripts` is safe because `prepack`, which
`pnpm publish` runs in each package, is `tsc -b` and needs no install script.
`packages/core/src/release-permissions.test.ts` holds the split. pnpm skips
every `private` package. `--no-git-checks` is there because a tag checkout is a
detached HEAD, and pnpm's branch check refuses one. `pnpm publish` applies
`.pnpmfile.mjs` the same way `pnpm pack` does, so the registry gets the
manifests the pack harness checked.

`releaseTagFault` (`packages/core/src/release-tag.harness.ts`) refuses a tag
that does not start with `v`, and a tag whose version is not the `version` of
every public package. The refusal names each package that differs, with its
manifest and the version it carries. To try a tag without publishing:

```sh
pnpm check:release-tag v0.2.0
```

To cut a release:

1. Set `version` in each public package's manifest and `PUBLIC_VERSION` in
   `packages/core/src/public-packages.test-support.ts`, and land the change on
   `main`.
2. On that commit, run `pnpm check:release-tag v<version>`.
3. Tag the commit and push the tag:
   `git tag v<version> && git push origin v<version>`.

**The first publish uses a token.** npm sets up trusted publishing in a
package's settings, so a package must exist before it can have one. For
0.1.0 the workflow authenticates with the repo secret `NPM_TOKEN`, a
short-lived granular token with publish rights on the `@pagedeck` scope and on
`create-pagedeck`. The publish step passes it as `NODE_AUTH_TOKEN`, which the
`.npmrc` that `setup-node` writes from `registry-url` reads.

**Then switch to trusted publishing.** After 0.1.0 is on npm, add a trusted
publisher to each of the sixteen packages on npmjs.com: GitHub Actions, repository
`pedrosousa13/pagedeck`, workflow `release.yml`. npm matches the workflow
filename exactly, so renaming the file breaks every publish until each package
is updated. Then delete the token on npm and the `NPM_TOKEN` secret.

The workflow needs no edit at the switch. Since pnpm 11.0.7, `pnpm publish`
tries OIDC first for each package of a recursive publish, and a token it gets
that way replaces any token the `.npmrc` names
(<https://github.com/pnpm/pnpm/releases/tag/v11.0.7>). Since 11.1.3 a
placeholder such as `${NODE_AUTH_TOKEN}` whose variable is unset counts as
empty, not as a literal token
(<https://github.com/pnpm/pnpm/releases/tag/v11.1.3>). With the secret deleted,
`NODE_AUTH_TOKEN` is empty, and OIDC does the authenticating. The `publish`
job already has `id-token: write`, which npm requires, and under trusted publishing npm
generates provenance by itself, so `--provenance` does no harm
(<https://docs.npmjs.com/trusted-publishers>).

**When a publish stops partway**, some packages are on npm at the new version
and the rest are not. A recursive pnpm command follows the workspace
dependency graph unless `--sort` is off (<https://pnpm.io/cli/recursive>), and
`pnpm -r publish` publishes only the packages whose version is not yet on the
registry (<https://pnpm.io/cli/publish>). So:

- If the cause is outside the code (an expired token, a trusted publisher
  set up wrong, an npm outage), fix it without a new commit and use "Re-run
  failed jobs" on the same tag's run. That re-runs `publish` alone, on the
  `verify` that already passed; "Re-run all jobs" runs `verify` and its pack
  harness again first. The re-run skips what is already published.
- Never bump the version over a half-published set to get past a failure.
- If the cause needs a code change, bump the whole public set to the next
  patch version, land it, and tag that. The half-published version stays as
  it is.

### Imports between packages

Anything emitted reaches another package through its `exports`. A test or a
harness may import another package's `src` by relative path only for a
`*.test-support.ts` module, which no export can name. The one exception is
`packages/islands/vitest.harness.config.ts` importing
`../core/src/react-compiler.js`, since `@pagedeck/core` depends on
`@pagedeck/islands`. A path that is not a JavaScript import (a worker's
`new URL`, a stylesheet's `@import`, Tailwind's `@source`) is outside the rule.

Do not install `@types/jsdom`: it pulls `lib.dom` into a workspace that
declares `"lib": ["ES2022"]`, and `pnpm build` fails on `RequestInit` (#289).
`packages/site/src/jsdom.d.ts` declares what is used.

### Clean room

Write only from publicly documented behaviour: no vendor source, SDK, private
documentation or production credentials (#53). This repo's own writing names
no employer, design system or CMS vendor (`CONTEXT.md`, **A recorded corpus
keeps the names it recorded**). `docs/dogfood-parity.md` says what the clean
room rules out for the dogfood site: there is no production origin to record.

### Every test that spawns a process declares its own timeout

**A test case that spawns a process (`pagedeck build`, another verb, a bin,
`git`, `docker`) states its own timeout, directly or through a helper.** The
timeout goes where the spawn happens. A file that builds once in a timed
`beforeAll(async () => {…}, 120_000)` leaves cases that only read artifacts
bare. A file that memoizes the build behind a lazy helper times **every** case
that can reach it, because the first case to run pays the cold build and which
one that is changes. `120_000` is usual, not uniform: size it to the case.

**The broken rule does not look like itself**: `Test timed out in 15000ms` in a
file the branch never touched, green alone, moving between files as spawned
builds contend for four cores, or `Error: disk I/O error` from SQLite under the
same load. Do not chase the named file (#183). The root `vitest.config.ts`
`testTimeout: 15_000` is a floor for worker starvation (#640), not the timeout
of a spawning case.

### Budgets

Each checked-in site except the docs site declares `build.budget`, so a
regression fails `pagedeck build`.

- **A limit that starts failing is re-measured and re-justified, never
  raised.** A page set that starts spending gets its own key.
- **Every figure is measured**: `pagedeck sync && pagedeck build` in the site,
  then `.pagedeck/budget-report.json`.
- **Headroom is room for drift, never for a regression.** `0b` has none.
  Landing and the site port size it for a `react-dom` patch release walking
  the shared `fw-core` chunk.
- **Each site's `site.build.test.ts` spells the limits again** instead of
  importing them, so a raised limit fails the suite, and holds the whole
  build's JavaScript to a ceiling, because no `build.budget` row charges a
  lazily loaded chunk.

## Sites

Four packages are also sites, each with a `pagedeck.config.ts` at the package
root, built in place:

```sh
cd packages/<site>
node ../core/dist/bin.js sync
node ../core/dist/bin.js build
```

Each writes `site/`, `content.db` and `.pagedeck/`, all gitignored. Do not run
the docs or landing axe harness beside that site's `site.build.test.ts`: both
build in the package directory.

Each site sets a `Content-Security-Policy` on its `/` header rule (#557, #577),
in its `src/csp.ts`. The CMS example is the exception: it is never deployed and
declares no header rule (#694). A site that is deployed follows the rule. The
hash of an inline loader core composes is pinned, copied from the manifest:
when core changes a loader, copy the new hash.
`site.build.test.ts` fails on a page hash the policy lacks or a policy hash no
page carries.

**A new search engine test belongs in `packages/search`**, not in a site: a
test riding on a site's content is retired by the next change to that content.

### The docs site

`packages/docs` writes to `site`, because `dist` is its emitted JavaScript. Its
content is `packages/docs/content` and the published part of the repo's
`docs/` (#576). `pagedeck sync` fails, with the fix in the message, on:

- **a file or directory added directly under `docs/`** until it is in
  `published` or `excluded` in `REPOSITORY_DOCS` (`packages/docs/src/site.ts`);
- **a published directory with no row** in `SECTION_OF_DIRECTORY`
  (`packages/docs/src/sections.ts`), unless the file's frontmatter has a
  `section`;
- **a new code-fence language** until it is in `LANGUAGES`
  (`packages/docs/src/site.ts`);
- **a `description` missing, blank, a list or over `DESCRIPTION_LIMIT`**
  (#565). It is the page's meta description: one sentence for that page.

`src/add-an-island.build.test.ts` follows `content/how-to/add-an-island.md`
from a copy of the starter template (#696): it writes each file the page
names, splices each `build` key it shows into the config, runs each
`npx pagedeck` line, and requires the quoted budget failure and report row to
be what the build printed and wrote, with chunk hashes and byte figures
normalised. Every word, page, pattern, limit and chunk name stays exact. Each
island page must stay under its `60kb`, and `/greet`'s real `actual` within 5%
of the figure the page quotes: past that, build the page's site again and copy
the new figures in.

`content/how-to/connect-a-cms.md` quotes `packages/cms-example` (#697).
`src/connect-a-cms.test.ts` requires each fence's lead to name an example file
and the fence to be a run of that file's lines, every line moved by one indent,
and compiles the one file the page has the reader write, `src/token.ts`, whose
`fetch` must pass `redirect: "manual"` (#729). A fence naming no file fails.
`src/connect-a-cms.build.test.ts` builds a copy of the example and holds the
quoted budget report rows to its report, with chunk hashes and byte figures
normalised and each `actual` within 5%. Edit the example, and copy the changed
lines and figures into the page.

`content/how-to/deploy-a-site.md` shows `pagedeck` commands (#698).
`src/deploy-a-site.test.ts` runs each `pagedeck` line in its fences through
`runCli` in an empty directory, so each verb's own parser takes or refuses the
flags and the run stops at loading the config. Each inline `pagedeck` mention
runs the same way, failing only on an unknown option or command, since it may
leave out the arguments. Every verb and flag the page names must also be in
the usage text `pagedeck` prints for `--help`. It compiles the page's one `ts` fence inside `packages/docs`. A
new verb or flag needs no edit there; a renamed one fails it.

`content/reference/preview.md` holds the preview app's security guidance, and
`pagedeck build`'s `preview:` notice cites it by page title and heading (#713).
`src/preview.test.ts` requires the notice the page quotes to name the page's
`title` and one of its `##` headings, and compiles the `src/preview-bridge.ts`
fence against the real `PreviewBridge` from `@pagedeck/preview`, with the DOM
lib a site's own tsconfig has. Rename the page or the heading, and change the
notice in `packages/core/src/cli.ts` with it.

It deploys as the Worker `pagedeck-docs` the way the landing page does (#6):
`cloudflarePages()`, `public/.assetsignore`, `wrangler.jsonc`,
`.github/workflows/deploy-docs.yml`, and the runbook "The docs site on
Cloudflare" in `docs/deploy-recipe.md`. The READMEs link its pages at
`https://pagedeck-docs.pedrodsousa.workers.dev` until #54, and
`site.build.test.ts` holds each linked route and heading to the build, from
`DOCS_ORIGIN`.

`/search` is the only page that ships JavaScript (#62). `site.build.test.ts`
excludes it from the zero-JavaScript assertions **by name**, never by dropping
it from the page set. The axe harness audits eight pages and a search,
and requires zero CSP violations under the headers the build wrote to
`_headers`:

```
pnpm build && pnpm test:docs-a11y-harness
```

### The landing site

`packages/landing` proves a claim (#189) in one build: `/` ships 0 B of
JavaScript; `/interactive` nests one island, in the same build because "an
island taxes only itself" is a claim about the other pages; `/features` is the
showcase (#551), each addition in `src/features.ts` scoped so `/` keeps `0b`;
`/server-data` (#625) hands a `"use client"` picker only the fields it needs
from a 67 kB entry, and `site.build.test.ts` keeps the entry's sentinel field
out of every emitted file.

- **Every file the showcase fetches is this build's own.** Its embed script and
  image candidates are same-origin stand-ins from `public/`, so `CONTEXT.md`'s
  placeholder decisions for script sources and image hosts do not apply. Links
  to other sites go to placeholder origins (#288).
- **`LANGUAGES` in `packages/landing/src/site.ts` is one entry, `tsx`**
  (#627). `src/front_page.test.ts` holds each fence in `content/index.md` to
  the file its `###` heading names.
- **The front page's figures are tested** (#548, #627): `site.build.test.ts`
  holds the ruler to the budget report, each comparison cell to its sentence in
  `docs/research`, and each byte figure to `src/bytes.ts`' format.
- **It deploys as Workers Static Assets with wrangler** (#52), not through
  `deploy.bin.js`. `build.adapter` is `cloudflarePages()`, so the build writes
  `_headers` and `_redirects` into `site/`, and `public/.assetsignore` keeps
  `manifest.json`, `.pagedeck` and the adapter's fallback `404.html` out of the
  upload. `wrangler.jsonc` declares the Worker; wrangler is pinned in this
  package's `devDependencies`, so run it as `pnpm exec wrangler`.
  `.github/workflows/deploy-landing.yml` dry-runs it, or publishes it with
  `apply`, through `deploy-worker.yml`, which `deploy-docs.yml` calls too.
  `docs/deploy-recipe.md`, "The landing page on Cloudflare", is the runbook.

**Budgets.** A limit is the measurement plus about 16%, rounded to a whole
kilobyte.

| Page | Limit | Basis | Latest | Made of (latest) |
| --- | --- | --- | --- | --- |
| `/` | `0b` | 0 B | 0 B | no chunks |
| `/interactive` | `60kb` (61440 B) | 52918 B (#189) | 52955 B (#694) | `fw-core` 52470 B, `counter` 270 B, entry 215 B |
| `/features` | `62kb` (63488 B) | 54326 B (#551) | 53744 B (#694) | `fw-core` 52470 B, `hydration_probe` 426 B, entry 346 B, `island_load` 136 B, the facade loader inlined 366 B |
| `/server-data` | `60kb` (61440 B) | 52762 B (#625) | 52697 B (#694) | `fw-core` 52470 B, entry 227 B |

The counter is charged because fold tuning (#24) promotes it to `load`. Since
#694, React's JSX and compiler runtimes are in `fw-core`. The
whole-build ceiling is 66 kB Brotli (67584 B) against 59457 B measured on
#625, counting the `slot` chunk and the lazy islands, each file compressed on
its own.

```
pnpm build && pnpm test:landing-a11y-harness
```

The axe harness runs both colour schemes at 390 px (`isMobile`, #604) and
1280 px, drives the demos, and requires zero requests to another origin and
zero CSP violations under the compiled CloudFront headers.

### The site port

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

**Budgets.** `0b` for each content page, `60kb` for `/en/pricing`, 14.9% over
its figure. Every locale is keyed: a page no pattern matches is unbudgeted, not
free.

| Page | Limit | Measured | Made of |
| --- | --- | --- | --- |
| `de /`, `en /`, `en /legal/terms` | `0b` | 0 B | no chunks |
| `en /pricing` | `60kb` (61440 B) | 53460 B | `fw-core` chunk 52888 B, entry chunk 207 B, the inline script loader 365 B |

The whole-build ceiling is 61 kB Brotli (62464 B) against 53998 B of `js`
measured, 15.7% over it, counting the 903 B `slot` chunk and not the inline
loader.

**Deploy** (#57, #652), which lives here and not in core (spec decision #10):

```sh
cd packages/site
node dist/deploy.bin.js --origin ../../.origin                    # prints the plan
node dist/deploy.bin.js --origin ../../.origin --apply            # writes it
node dist/deploy.bin.js --origin ../../.origin --apply --prune    # and deletes
```

A dry run is the default and `--apply` is the only way out (`CONTEXT.md`).
`docs/deploy-recipe.md` covers presigned origins (`PAGEDECK_DEPLOY_URLS`), the
refusals, `--edge` and `.github/workflows/deploy.yml`. `dist/presign.bin.js`
is the R2 signing step the origin harness proves (#665); no workflow runs it.
The landing page does not deploy through this CLI (see "The landing site").

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

### The CMS example

`packages/cms-example` builds a site from a local headless CMS it ships, a
`node:http` server on `127.0.0.1`, through a loader written against the loader
contract (#694). Its sync needs the CMS running: `node dist/serve.js` first,
or set `PAGEDECK_CMS_EXAMPLE_URL` to where it serves. It names no CMS vendor:
it is the model a site author copies for their own CMS. Its `README.md` holds
the wire shape, the loader's choices and the budget table.

### The shared brand

`packages/brand` holds the look of the landing, docs and dogfood sites (#547).
**Changing a token in `brand.css` changes all three sites.** A site takes it
with `"@pagedeck/brand": "workspace:*"` in its `dependencies` and one line
after the `@layer` statement in its `styles/global.css`, relative because a
`node_modules` path exists only after an install:

```css
@import "../../brand/brand.css";
```

`packages/brand/src/brand.test.ts` holds every text/surface pair to WCAG AA in
both themes, picking pairs by token name, so a new `--fw-fg-*` or `--fw-bg-*`
is checked the day it lands. A site checks its own sheet with `colourFaults`
and `pairFaults`.

## Runnable examples

`packages/examples/src/examples.test.ts` compiles and runs the examples in
`packages/examples`. **Change a contract that has an example, and change its
example with it.** `defining-pages.ts` gives `dependsOn` and `relatesTo` no ref
in common on purpose (#42): overlapping lists would let a join over the
dependencies pass. A new public contract gets an example or joins the list in
`packages/examples/README.md`.

## Module budgets

### The islands runtime budgets

`packages/islands/src/runtime.size.test.ts` holds `runtime.ts` to 2048 B and
`slot.size.test.ts` holds `slot.ts` to 1280 B, bundled with `react` and
`react-dom/client` external, Brotli at quality 11. The runtime's 2 kB is spec
§8's product decision; the slot ceiling is a ratchet.

| Module | Limit | Measured (#114) |
| --- | --- | --- |
| `runtime.js` | 2048 B | 1503 B |
| `slot.js` | 1280 B | 992 B |

Re-measure before editing either. A ratchet on one module cannot see bytes
moved into the other, and every page with an island pays `runtime.js`.

### The island props budget

`build.islandPropsBudget` limits one island's serialized props in UTF-8 bytes
before HTML escaping (#653). `DEFAULT_ISLAND_PROPS_BUDGET` in
`packages/core/src/budgets.ts` is `3kb`: the largest measurement below, rounded
up to a whole kilobyte, leaving room for content to grow. It catches a whole
entry passed as props.

| Site | Largest island props (#653) | Island and page |
| --- | --- | --- |
| `packages/landing` | 2296 B | `variant_picker` on `/server-data` (`variants` 2250 B) |
| `packages/site` | 163 B | `pricing_page` on `/en/pricing` |
| `packages/docs` | 94 B | `search` on `/search` |

If an island starts to fail the default, measure again and give a reason
before changing it; never raise it to make the failure go away.

## Harnesses

`pnpm test` runs none of these, though it runs each `*.harness.test.ts`,
which tests a harness's logic without running the harness. A measurement harness records a fact a decision
rests on: when it fails, argue the decision again, do not edit the assertion.
Every other harness fails only on a real defect. A harness that launches a
browser needs `npx playwright install chromium` once.

### The release tag check

```
pnpm check:release-tag v<version>
```

`packages/core/src/release-tag.harness.ts` checks that a tag names the version
every public package carries, so a release never publishes a mixed set. It
reads the manifests and nothing else, so it needs no build.
`.github/workflows/release.yml` runs it on the pushed tag before the pack
harness, and a maintainer runs it before pushing one (see "Releasing").
`release-tag.harness.test.ts` holds its messages in the suite.

### The pack harness

```
pnpm test:pack-harness
```

`packages/core/src/pack.harness.ts` packs the public set with `pnpm pack`,
installs the tarballs in a temporary directory outside the repository, imports
every subpath from there, and follows
`packages/docs/content/tutorials/your-first-site.md` from `create-pagedeck`'s
tarball to a built site. `ci.yml` runs it on every push, and `release.yml`
before publishing. It fails on a tarball file outside
`package.json`, `README*`, `LICENSE`, `dist` and, for `create-pagedeck` alone,
the `template/` files its `files` names one by one, or a test, harness, source map
or build cache inside `dist`, on a tarball with no `README.md` or `LICENSE`,
and on a packed manifest that still says
`workspace:`, names a private package, or exports a file the tarball lacks.
`.pnpmfile.mjs` drops `devDependencies` and every `source` condition from a
manifest as `pnpm pack` writes it, so pack with pnpm, not npm. The install is
`pnpm install --prefer-offline --no-frozen-lockfile` with `hoist: false`, so a
package that imports an undeclared dependency fails; it copies in this
repository's `pnpm-lock.yaml` so each range resolves to the version this
workspace locked. The copy is a seed the install rewrites, not the project's
lockfile, so the install says `--no-frozen-lockfile` rather than take pnpm's
frozen default where `CI` is set. It is not `--offline`: resolving the seed
needs registry metadata for entries this workspace's own install never
fetched, which a fresh runner's cache lacks, so pnpm reads its cache first and
fetches the rest from the npm registry.

The tutorial run reads the page in order. It runs each shell line it knows
(`npm create pagedeck`, `cd`, `npm install` and `npx pagedeck`) and refuses any
other. `pagedeck dev` starts on a free port and must serve `/`. A
`pagedeck sync --watch` line runs one sync, and from then on the harness syncs
once after each file it writes. Both stop before `pagedeck build`. Every fence
on the page except a shell command names its file in the line before it,
ending `` `path`: ``, and a fence that names none fails the run. A file the
site already holds must match the fence, and any other is written. While
`pagedeck dev` runs, each written `content/*.md` must be served at its route.
Every page under `content/` must be built.
`packages/docs/src/tutorial.test.ts` checks the same fences in the suite, with
no install: each starter file the page quotes matches
`packages/create-pagedeck/template` byte for byte, and every other file is a
new markdown page.

It then runs `create-pagedeck`'s bin from its tarball, and installs, syncs and
builds the site it writes the same way, with no edits. The template declares no
`build.budget`, and a build writes no budget report without one, so the harness
then adds `"/**": "1mb"` to the config, builds again, and reads
`.pagedeck/budget-report.json`: `/` and `/about` ship 0 B, and exactly one of
`/counter`'s chunks carries the counter's code.

### Measurement harnesses

| Command | Runs | Re-run on |
| --- | --- | --- |
| `pnpm test:slot-harness`, then with `PAGEDECK_REACT_COMPILER=1` | `packages/islands/src/slot-rerender.harness.tsx`, the evidence for ADR-0005 | a React or React Compiler upgrade |
| `pnpm test:aria-harness` (needs `npx playwright install chromium firefox webkit`) | `packages/islands/src/aria-engine.harness.ts`, the evidence in `docs/research/2026-08-28-aria-snapshot-engine-blindness.md`; a failure reopens #92 | a Playwright release |
| `pnpm test:compiler-crash-harness` | `packages/core/src/react-compiler.harness.ts`, what a build reports when React Compiler crashes (#106) | a Node, Babel or React Compiler upgrade |

The compiler crash harness provokes the crash with a property chain whose depth
must land in a window (500 to 2100 on the dev box) that moves with Node's stack
size, which is why it is out of `pnpm test`. On a failure, measure the window
again and set `CRASH_DEPTH` from it.

### Browser harnesses

| Command | Runs | Claim |
| --- | --- | --- |
| `pnpm build && pnpm test:singleton-harness` | `packages/core/src/singleton.harness.ts` | two islands in two tier groups share one store module (#64) |
| `pnpm test:consent-facade-harness` | `packages/core/src/consent-facade.harness.ts` | consent moves a facade's `data-fw-consent` without a reload, and a denied press loads nothing (#460) |

The singleton harness runs emitted chunks from `packages/islands/dist`, because
jsdom ignores `<script type="module">`, so build first; it cannot detect a
stale `dist`. The consent facade harness drives `runCli` in process and needs
no build. Under a CSP, poll with `page.evaluate`: `page.waitForFunction` runs
its predicate through `eval`, which the policy refuses (#586).

### The site audit harnesses

```
pnpm build && pnpm test:a11y-harness
pnpm build && pnpm test:lighthouse-harness
```

`packages/site/src/a11y.harness.ts` and `packages/site/src/lighthouse.harness.ts`
build the dogfood site and audit it in Chromium (#59); Lighthouse costs an
order of magnitude more, hence two commands. A failure is a real defect. **It
never fails on timing** (`CONTEXT.md`, #59): the performance metrics go to
`packages/site/.pagedeck-site-audit/lighthouse-report.json`, asserted against
nothing.

`BUDGETS` in `packages/site/src/audit-site.ts` are Lighthouse transfer figures
over the uncompressed local origin, not the Brotli of `build.budget`:

| Page | Bytes limit | Measured | Requests |
| --- | --- | --- | --- |
| `/de`, `/en`, `/en/legal/terms` | 0 | 0 | 0 |
| `/en/pricing` | 230400 | 196168 (195825 B of chunk on disk, `fw-core` 195495 B, plus 343 B of headers) | 3 |

Zeros and request counts take no headroom: a request is a decision.
`/en/pricing`'s 17.4% is for a `react-dom` patch release walking `fw-core`. Its
third request is the consent manager at `consent.example`, which resolves
nowhere; a real vendor there means re-measuring the row.

### The origin harness

```
pnpm test:origin-harness
```

`packages/site/src/origin.harness.ts` deploys, pushes and pulls against
SeaweedFS's S3 gateway in Docker, over TLS, with SigV4 URLs signed by a
throwaway credential (#302, #652), and once through the shipped signing step in
region `auto`, serving the result through the compiled Worker (#665). It also
prunes a presigned origin through its history index and checks that the same
files go as from a directory origin given the same history (#659). The script
runs `pnpm build` first, because the deploys spawn `deploy.bin.js`.

**It needs a Docker daemon, `openssl` on `PATH`, and Node 24.5 or later**,
and skips with the reason in the suite's title without one. The origin runs on
an `--internal` bridge network at a fixed private address, never `localhost`,
because the snapshot host refusal takes no override (`CONTEXT.md`); Linux
routes to the bridge, Docker Desktop does not. `ORIGIN_SUBNET` and
`ORIGIN_IMAGE` (pinned by digest) are in
`packages/site/src/s3-origin.test-support.ts`. A subnet that overlaps an
existing network fails `docker network create` loudly rather than skipping.
Bumping the image is a deliberate edit and a re-run. A killed run leaves containers
and networks for `docker ps -a --filter label=pagedeck.harness=origin` and
`docker network ls` with the same filter. It proves nothing about a CDN;
`docs/deploy-recipe.md` lists what is proven.

### The proxied-instance census

A build with `PAGEDECK_PROXY_CENSUS` set to a path appends a JSON Lines row
per proxied client-component instance it renders
(`packages/core/src/proxy-census.ts`). Clear `site` and `.pagedeck` first,
because an incremental build skips renders:

```sh
cd packages/docs
rm -rf site .pagedeck
node ../core/dist/bin.js sync
PAGEDECK_PROXY_CENSUS="$PWD/census.jsonl" node ../core/dist/bin.js build
```

`packages/landing` and `packages/site` take the same three commands.
`census.jsonl` is not gitignored: write it somewhere that is, or remove it
after reading.

**Take it again when a page renders a `"use client"` component from another
component's code**, and reopen #173 (`.out-of-scope/proxied-slots.md`) on a row
with `refusedChildren: true`. Landing's one `refusedChildren: false` row is a
demo and does not count (#625).

### The build-twice check

```
pnpm build && pnpm check:build-twice
```

`packages/design-system/src/site.build-twice.harness.ts` runs on every CI push:
two `pagedeck build` processes over one site, compared with `diffOutputTrees`
(`packages/core/src/determinism.ts`), the `build` stamp the only excused field
(spec §11). It refuses a pair from one process, an empty tree, and a tree
without the `assets/pricing_page-*.js` chunk, the `"use client"` path it is
cited for (#178). Its trees stay under
`packages/design-system/.pagedeck-build-twice-check` on a red run. A failure is
a build reading a clock, a random source or an unordered collection: file an
issue.

### The scaling ladder

```sh
pnpm bench:scaling
pnpm bench:scaling --pages 100,2000 --locales 4
pnpm bench:scaling --pages 50000
```

`packages/bench/src/scaling.harness.ts` (built first by the script) builds a
synthetic site per rung and records time, peak RSS (`VmHWM` from `/proc`),
store size and page count. Spec §16's figures are targets, not gates (decision
24): it **exits `0` whatever it reads**, and a large miss is a finding issue. A
red run of `.github/workflows/scaling.yml` means it did not finish (#380). The
default ladder stops at 32,000 pages. `docs/scaling-verification.md` holds the
measurements; do not compare figures across machines.

### The live landing measurements

```sh
pnpm bench:landing-publish               # prints the plan; edits and deploys nothing
pnpm bench:landing-publish --apply       # deploys; needs `wrangler login` in packages/landing
pnpm bench:landing-lighthouse
```

Both reach the live landing page on its `workers.dev` address, so they run by
hand only, never in CI (#2). `packages/landing/src/publish-to-live.harness.ts`
is a dry run unless given `--apply`. With it, it edits `content/index.md` in
place, deploys three times, times each deploy and the first response holding
the edit, then deploys the unedited build again and waits for `/` to serve it
byte for byte. That restore runs once, after an error or on `SIGINT` or
`SIGTERM`, and an interrupted run exits non-zero. A deploy is killed after
300 s. Run `--apply` only with the maintainer's approval of the deploys.
`publish-to-live.harness.test.ts` covers the dry run, the deploy timeout and
the redaction of wrangler's account email and ID from a failure message. `packages/landing/src/lighthouse-live.harness.ts`
runs Lighthouse twice per page, mobile and desktop, over the four pages, and
lists any request to another origin. `docs/success-criteria.md`, criteria 4
and 5, holds the figures.

### The island-scan measurement

```sh
pnpm bench:island-scan
pnpm bench:island-scan --pages 240 --locales 2 --runs 6
```

`packages/design-system/src/island-scan.harness.ts` (built first by the script)
times the island scan inside `pagedeck build --incremental` after a one-entry
edit, and exits `0` whatever it reads. Its timer,
`island-scan-probe.harness.ts`, replaces `packages/core/dist/island-facts.js`
through `module.registerHooks`; keep timing out of `build.ts`, where it would
be a field in a shipped verb's output. `.out-of-scope/island-scan-caching.md`
holds the figures and what #385 concluded.

## Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. `CONTEXT.md` holds the project's vocabulary and the standing decisions that bind work beyond the issue that produced them; `docs/adr/` holds the architectural decisions with their alternatives and consequences. See `docs/agents/domain.md`.
