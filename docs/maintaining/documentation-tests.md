# The documentation tests

The pages are `packages/docs` (`@pagedeck/docs`, #108) and the published part
of the repository's `docs/`. deck-cool's `sites/pagedeck` builds them and
serves them at `https://page.deck.cool/docs` (#124); its build test checks
the figures the pages quote about that site. A page links another by its
relative `.md` path, as the docs contract requires. The tests of what the
pages say about Pagedeck's own starter, examples, CLI and repository live in
this repository:

- **In `packages/docs/src`**, with the workspace packages a sample imports as
  `devDependencies`, which `.pnpmfile.mjs` drops from the tarball:
  - `nav-json.test.ts` fails on an entry added directly under `docs/` until
    it is in `published` or `excluded` in `REPOSITORY_DOCS`
    (`pages.test-support.ts`), and holds `nav.json` to the pages: sections in
    `SECTIONS` order, pages by route, each page in its frontmatter `section`
    or its directory's row in `SECTION_OF_DIRECTORY`. A `section` that
    `SECTIONS` lacks fails. Add, move or re-section a page, and change
    `nav.json` with it.
  - `pages.test.ts` holds every packed page (the guides, and the ADRs,
    `deploy-recipe.md` and `error-messages.md`) to a `description` that is
    one line of 150 characters or fewer (#565), to fence languages in
    `LANGUAGES` (`render.test-support.ts`), and to in-page links that
    resolve. `LANGUAGES` is the list deck-cool's
    `sites/pagedeck/pagedeck.config.ts` passes `defineDocs`: change both
    together.
  - `tutorial.test.ts` holds the tutorial's fences to the starter template
    (see `harnesses.md`, "The pack harness").
  - `connect-a-cms.test.ts` requires each fence's lead in
    `how-to/connect-a-cms.md` to name a file of `packages/cms-example` and the
    fence to be a run of that file's lines, every line moved by one indent,
    and compiles the one file the page has the reader write, `src/token.ts`,
    whose `fetch` must pass `redirect: "manual"` (#697, #729). A fence naming
    no file fails. `run-an-app-beside-the-site.test.ts` does the same for
    `how-to/run-an-app-beside-the-site.md` and `packages/app-example` (#141).
    Edit an example, and copy the changed lines into its page.
  - `deploy-a-site.test.ts` runs each `pagedeck` line in the deploy pages'
    fences through `runCli` in an empty directory, so each verb's own parser
    takes or refuses the flags and the run stops at loading the config (#698).
    Each inline `pagedeck` mention runs the same way, failing only on an
    unknown option or command. Every verb and flag the pages name must be in
    the usage text `pagedeck` prints for `--help`. It compiles each `ts` fence
    inside `packages/docs`. A new verb or flag needs no edit there; a renamed
    one fails it.
  - `preview.test.ts` requires the `preview:` notice `reference/preview.md`
    quotes to name the page's `title` and one of its `##` headings, and
    compiles the `src/preview-bridge.ts` fence against the real
    `PreviewBridge` (#713). Rename the page or the heading, and change the
    notice in `packages/core/src/cli.ts` with it. `favicon.test.ts` and
    `page-head.test.ts` hold the warnings those pages quote to the catalogue.
  - `link-checking.test.ts` compiles `reference/link-checking.md`'s
    `src/probe.ts` fence against the real `LinkProbe` and runs it with `fetch`
    stubbed: each literal internal host throws with no request, and a public
    one is asked with `redirect: "manual"` (#205). It also requires
    `EXTERNAL_SHAPE_FIX` and `PROBE_FIX` in `packages/core/src/links.ts` to
    cite the page's `title` and the `##` heading the probe sits under, and
    the page and the catalogue to quote them. Change a covered host, and change
    the test's lists and the page's with it.
  - `react-compiler.test.ts` holds `reference/react-compiler.md`'s output
    fences to what `compileIslands` prints.
  - `reserved-names.test.ts` renders every page and fails on a reserved name
    core's strip would rename.
  - `samples.test.ts` holds the fonts page's second sample to
    `packages/site`. The fonts page's first sample and every sample on the
    site-search page are unchecked: they quoted the landing and docs sites,
    which #124 moved to deck-cool, and now read as what a site might write.
  - `readme-links.test.ts` holds every README's docs link, and those
    `create-pagedeck` prints, to a page `nav.json` lists at `DOCS_ORIGIN`,
    and a fragment to a heading on it. It assumes deck-cool's addressing:
    `routeOf` follows `docsHref` in deck-cool's `packages/docs/src/loader.ts`
    (the base `/docs`, the file without `.md`, a last `index` dropped, a
    trailing slash), and heading ids are the slugs
    `@pagedeck/markdown-loader`'s renderer writes, which that loader renders
    with. Checked against `https://page.deck.cool` on 2026-10-27. If deck-cool
    changes either, change `routeOf` or the renderer here.
  - `support.test.ts` holds `reference/support.md` to what it describes
    (#161): each public package's `engines.node`, `react` and `react-dom`
    ranges, `create-pagedeck`'s `SITE_DEPENDENCIES` (the React range a new
    site gets), `ci.yml`'s Node matrix, and the short Node.js sentence in the root
    README, core's and `create-pagedeck`'s READMEs and the tutorial. Change
    a range, the matrix or the policy, and change the page and each copy
    with it.
- **`packages/script-worker/src/partytown.build.test.ts`** writes the first
  `ts` fence under `reference/third-party-scripts.md`'s "Run worker scripts on
  Partytown" heading into a fixture site as `src/scripts.ts`, builds it with
  the spawned `pagedeck`, and requires each page to carry the snippet in its
  `<head>` and a `text/partytown` element in its `<body>` (#283), Partytown's
  files under the snippet's `lib`, no worker fallback warning, and
  `runtime.inlineScriptHash` to match the page (#275). Rename the heading or
  move the fence, and change the test with it.
- **`packages/create-pagedeck/src/add-an-island.build.test.ts`** follows
  `how-to/add-an-island.md` from a copy of the starter template (#696): it
  writes each file the page names, splices each `build` key it shows into the
  config, runs each `npx pagedeck` line, and requires the first build to put
  a `<script>` on `/greet` and none on `/` or `/about`. It lives beside the
  starter's dependencies; under `packages/docs`, its copy's markdown would be
  packed.
