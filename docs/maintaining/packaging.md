# Packaging

## The build step

`pnpm build` emits each package's JavaScript and `.d.ts` to its own `dist` in
one `tsc -b tsconfig.build.json` (#191). `packages/core/dist/bin.js` loads a
site's `pagedeck.config.ts` in Node, compiling the site's own `.tsx` and `.jsx`
outside `node_modules` through the hook `bin.ts` registers (#702); a program
calling `loadConfig` or `startDevServer` directly gets no hook. Every package a
config reaches must still be emitted: Node reaches it through its `exports`
`default`, the hook leaves an installed copy under `node_modules` alone, and
Node fails on a `.js` specifier with only a `.ts` beside it (#182).

**Every directory under `packages/` that has a `package.json` is emitted**,
except `packages/docs`, which holds markdown and no code (see "The published
tarball" below).
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
- **List every package in the root `tsconfig.build.json`**, `packages/docs`
  aside. Build order comes
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

## The published tarball

The release workflow publishes the public set to npm on a `v*` tag (#7; see
`releasing.md`), and `npm pack` must produce a tarball holding
the emitted `dist`, the manifest, and the README and LICENSE npm always packs,
and nothing else (#185). Every package declares the same three fields:

- **`"files": ["dist", "!dist/.tsbuildinfo"]`.** Without it, `src`, the tests
  and the cache are packed: npm reads no root `.gitignore` here.
- **`"scripts": { "prepack": "tsc -b tsconfig.build.json" }`**, so a tarball
  is never cut from a stale `dist`. Not `pnpm build`, which deletes every
  package's `dist`.
- **`"types": "./dist/index.d.ts"`**, for a resolver that ignores `exports`.

`packages/core/src/publishable-packages.test.ts` packs every package for real.
**`create-pagedeck` is one exception** (#691). It also packs `template/`,
the site it copies, and `template-app/`, the files `--app` writes over and
beside it, and its `files` names each of those files one by one
(#731). That one list decides three things: npm packs those files, `create()`
copies those files, and `packedBesideDist` in
`packages/core/src/public-packages.test-support.ts` admits those files and no
others, in this test and in the pack harness. A directory named in `files`
admits nothing under it. A file in `template/` or `template-app/` that the
list does not name is never packed or written, and fails `create-pagedeck`'s
own suite. Add a new template file to `files`. The template's
`.gitignore` is stored as `_gitignore`, because npm and pnpm leave every file
named `.gitignore` out of a tarball, and is renamed when the site is written.
**`@pagedeck/docs` is the other** (#108). It is the documentation as
markdown, which deck-cool's `sites/pagedeck` reads at build time and serves at
`https://page.deck.cool/docs`, and it emits no code: it has
no `tsconfig.build.json`, `dist`, `main`, `types` or `exports`, and is not in
the root `tsconfig.build.json`. Its `files` is
`["**/*.md", "nav.json", "assets"]`, and its `prepack` is
`node src/assemble.ts`, which copies in each page of the repository's `docs/`
that `nav.json` lists (the ADRs, `deploy-recipe.md` and `error-messages.md`),
writing only what differs and removing a copy `nav.json` no longer lists.
`src/nav-json.test.ts` holds those pages to `REPOSITORY_DOCS.published` in
`src/pages.test-support.ts` (see `documentation-tests.md`). `.gitignore` keeps those copies out of git, so
`docs/` stays the one copy, where the agent skills expect it. `DOCS_PACKAGE`,
`DOCS_PREPACK` and `packedAsDocs` in `public-packages.test-support.ts` are the
exception in `workspace-packages.test.ts`, `publishable-packages.test.ts` and
the pack harness, and admit nothing to any other package.
`packages/docs/src/contract.test.ts` runs `pnpm pack --dry-run`, which applies
`.pnpmfile.mjs` as a publish does, and holds what
it lists to deck-cool's docs contract (`docs/docs-contract.md` in
pedrosousa13/deck-cool): markdown, `nav.json`, `assets/`, `package.json` and
`LICENSE` only; a `title` and a `description` on every page; every page in
`nav.json` once; relative `.md` links that resolve; images under `assets/`;
and no HTML but a demo marker, `<!-- demo:<name> -->`, on a line of its own.
**`packages/brand`'s `brand.css` and
`favicon.ico` are not packed** (#547, #549); packing them needs a copy step or
an amendment to the "packs only `dist`" standing decision, a maintainer call.
**`satori`, `@resvg/resvg-js` and `subset-font` are pinned to exact
versions**, because a patch release may change the bytes they emit. Core pins
**`rolldown`** exactly for `transformSync`, which compiles a site's `.tsx` and
`.jsx` (#702): rolldown marks it experimental, and core reads a compile error's
position from a field its types do not declare. The pin also holds
`parseSync` from `rolldown/utils`, which `client-reference-loader.ts` uses to
read a `"use client"` module's exports without running it (#174), and the
way Rolldown rejects `this.resolve` when a plugin's `resolveId` throws: its
own error, with the plugin's as the `cause`, marked `code: "PLUGIN_ERROR"` and
`plugin`, which `resolve-faults.ts` reads to name the plugin (#189). The pin
must sit inside the rolldown range of the newest vite that core's `vite` range
admits on the npm registry. Otherwise a consumer installs two rolldowns, and the pin no longer
covers the one vite builds with. The pack harness fails on an install that
holds two (#216). `@pagedeck/script-worker`
pins **`@qwik.dev/partytown`** exactly (#275): the package inlines Partytown's
snippet into every page that keeps a `worker` script and writes Partytown's
files beside the pages, so a new Partytown changes a page's bytes, the
snippet's CSP hash and the runtime's directory. Core pins
**`oxc-transform-react`** exactly (#164): it is the React Compiler that
`compileIslands` runs over every island, it is `0.x`, it calls itself
experimental and publishes almost daily, and a release may change what a
component compiles to or segfault on a module the last one took.

**The public set** is eighteen packages: the sixteen a site author installs
(#690), the six edge adapters among them (#19) and `@pagedeck/script-worker`
(#275); `create-pagedeck`, which
writes a new site (#691); and `@pagedeck/docs`, Pagedeck's documentation as
markdown, which deck.cool's docs site reads at build time (#108). They are
listed in
`packages/core/src/public-packages.test-support.ts`. Each is `0.3.1`, MIT,
with `repository`, `engines.node` and `publishConfig.access`; every other
package stays `private` (#689).
`engines.node` is the lowest Node the package and its dependencies need:
`^22.18.0 || >=23.7.0` for core and every package depending on it: 22.18 is
where Node loads `pagedeck.config.ts` with types stripped and no flag, and
23.7 is the first Node 23 with `module.setSourceMapsSupport`, which `bin.ts`
calls at startup through `installJsxLoader` (#702);
`^22.13.0 || >=23.4.0` for content and the markdown loader, for an unflagged
`node:sqlite`; `>=22.0.0` for islands, which uses no Node API, and for docs,
which holds no code. The scaffolder
`create-pagedeck` itself needs less, but it takes core's range because the site
it writes needs core's. Raise a floor when new code needs a newer API, and say
which.

`packages/docs/reference/support.md` is the support policy (#161): Node.js 22
from 22.18 and 24, React `^19.2.0`, and the browser floor.
`packages/docs/src/support.test.ts` holds it to every public `engines.node`,
every public `react` and `react-dom` range, and `ci.yml`'s `node` matrix, so a
change to any of them changes the page too.
