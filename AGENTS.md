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
- Node 24, as in CI. CI also runs the pack harness on Node 22.18.0, the
  supported floor (#161).
- The root `package.json` holds every runnable; a package has only `prepack`.
- The root `tsconfig.json` typechecks each `src` tree plus the files it names
  one by one, each Vitest config and site config. Add a new one there.
- `pnpm typecheck` then checks `packages/create-pagedeck/template` through the
  template's own `tsconfig.json`, against the emitted `.d.ts` a site installs,
  as a user's editor reads it. It first runs `tsc -b` on the packages the
  template imports, so it needs no `pnpm build`.
- Every environment variable this repo reads starts `PAGEDECK_`.
- `pnpm test` runs no harness, though it runs each `*.harness.test.ts`,
  which tests a harness's logic (see `docs/maintaining/harnesses.md`).

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
`GLOSSARY.md`'s standing decision **Comments say only what the code cannot**
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

`pnpm build` emits each package's JavaScript and `.d.ts` to its own `dist`,
deleting each `dist` first (#191). **Every directory under `packages/` that has
a `package.json` is emitted**, except `packages/docs`. List every package in
the root `tsconfig.build.json`, and name in a package's own
`tsconfig.build.json` `references` every workspace package its emitted source
imports, written from the imports. A test-only edge stays out of `references`.

- **`exports` carries three conditions per subpath, `source` first**: `source`
  at the TypeScript, `types` at the emitted `.d.ts`, `default` at the emitted
  `.js`. **The order is load-bearing and its failure is silent**: with
  `types` first the typecheck reads whatever `dist` is on disk. A new subpath,
  wildcards included, needs all three.

The reasons, and what checks each, are in `docs/maintaining/packaging.md`.

### The published tarball

A tarball holds the emitted `dist`, the manifest, the README and the LICENSE,
and nothing else (#185). Every package declares
`"files": ["dist", "!dist/.tsbuildinfo"]`,
`"scripts": { "prepack": "tsc -b tsconfig.build.json" }` and
`"types": "./dist/index.d.ts"`. `create-pagedeck` and `@pagedeck/docs` are the
two exceptions; add a new template file to `create-pagedeck`'s `files`. The
public set is listed in `packages/core/src/public-packages.test-support.ts`, and
every other package stays `private`. An exact pin stays exact, and core's
`rolldown` pin sits inside the rolldown range of the newest vite that core's
`vite` range admits.
Raise an `engines.node` floor when new code needs a newer API, and say which.
The exceptions, pins and floors are in `docs/maintaining/packaging.md`.

### Releasing

A pushed `v<version>` tag publishes the public set (#7), and only the
`publish` job holds `id-token: write`. Never bump the version over a
half-published set to get past a failure. The steps, the first publish and the
recovery are in `docs/maintaining/releasing.md`.

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
no employer, design system or CMS vendor (`GLOSSARY.md`, **A recorded corpus
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

## Runnable examples

`packages/examples/src/examples.test.ts` compiles and runs the examples in
`packages/examples`. **Change a contract that has an example, and change its
example with it.** `defining-pages.ts` gives `dependsOn` and `relatesTo` no ref
in common on purpose (#42): overlapping lists would let a join over the
dependencies pass. A new public contract gets an example or joins the list in
`packages/examples/README.md`.

## Maintainer docs

Read the doc before the work it covers:

- **Packaging**, before touching a manifest, `exports`, a `tsconfig.build.json`,
  a pin or an `engines.node` range: `docs/maintaining/packaging.md`.
- **Releasing**, before cutting a release or editing `release.yml`:
  `docs/maintaining/releasing.md`.
- **Sites**, before changing one of the three sites, a site's CSP, the shared
  brand or a search test: `docs/maintaining/sites.md`.
- **Documentation tests**, before editing a page, or an example, starter file,
  CLI flag or message a page quotes: `docs/maintaining/documentation-tests.md`.
- **Harnesses**, before running or changing a harness, or when one fails:
  `docs/maintaining/harnesses.md`.

## Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. `GLOSSARY.md` holds the project's vocabulary and the standing decisions that bind work beyond the issue that produced them; `docs/adr/` holds the architectural decisions with their alternatives and consequences. See `docs/agents/domain.md`.
