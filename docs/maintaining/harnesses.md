# Harnesses

`pnpm test` runs none of these, though it runs each `*.harness.test.ts`,
which tests a harness's logic without running the harness. A measurement harness records a fact a decision
rests on: when it fails, argue the decision again, do not edit the assertion.
Every other harness fails only on a real defect. A harness that launches a
browser needs `npx playwright install chromium` once.

## The release tag check

```
pnpm check:release-tag v<version>
```

`packages/core/src/release-tag.harness.ts` checks that a tag names the version
every public package carries, so a release never publishes a mixed set. It
reads the manifests and nothing else, so it needs no build.
`.github/workflows/release.yml` runs it on the pushed tag before the pack
harness, and a maintainer runs it before pushing one (see `releasing.md`).
`release-tag.harness.test.ts` holds its messages in the suite.

## The pack harness

```
pnpm test:pack-harness
```

`packages/core/src/pack.harness.ts` packs the public set with `pnpm pack`,
installs the tarballs in a temporary directory outside the repository, imports
every subpath from there, and follows
`packages/docs/tutorials/your-first-site.md` from `create-pagedeck`'s
tarball to a built site. `ci.yml` runs it on every push, on Node 22.18.0 and
24 in the `consumer` job's matrix (#161), and `release.yml` before
publishing. It fails on a tarball file outside `package.json`, `README*`,
`LICENSE`, `dist`, for `create-pagedeck` alone the `template/` and
`template-app/` files its `files` names one by one, and for `@pagedeck/docs`
alone its markdown, `nav.json` and `assets/`, or a test, harness, source map
or build cache inside `dist`, on a tarball with no `README.md` or `LICENSE`,
on a packed manifest that still says
`workspace:`, names a private package, or exports a file the tarball lacks,
on an install that holds more than one `rolldown` version, and on a core
`rolldown` pin outside the rolldown range of the newest vite that core's `vite`
range admits on the npm registry (#216).
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

It runs the bin once more with `--app` and installs that site the same way, so
`hono` and `@hono/node-server` come from the npm registry. Then it syncs and
builds it, and requires the manifest to declare `/api/` as the one upstream,
and no chunk to hold a string that only `app/index.ts` has.

Last, it copies `packages/app-example` out of the repository with the
dependencies its manifest declares, `workspace:` ranges pinned to the public
version and only `react-dom` and `wrangler` of its dev dependencies, and
installs, syncs, builds and runs `node src/release.ts prepare` there, then
`wrangler deploy --dry-run` in the release (#160). `cleanEnv` strips
`NODE_PATH`, which pnpm's bin shims set to this workspace's store, so a
`require` in a spawned process finds only what the site installed.

## Measurement harnesses

| Command | Runs | Re-run on |
| --- | --- | --- |
| `pnpm test:slot-harness`, then with `PAGEDECK_REACT_COMPILER=1` | `packages/islands/src/slot-rerender.harness.tsx`, the evidence for ADR-0005 and for ADR-0011's prop-slot holding | a React or React Compiler upgrade, or a change to the prop-slot stand-in |
| `pnpm test:aria-harness` (needs `npx playwright install chromium firefox webkit`) | `packages/islands/src/aria-engine.harness.ts`, the evidence in `docs/research/2026-08-28-aria-snapshot-engine-blindness.md`; a failure reopens #92 | a Playwright release |
| `pnpm test:compiler-crash-harness` | `packages/core/src/react-compiler.harness.ts`, what a build reports when React Compiler's process dies or runs past its time limit (#106, #164) | a Node, Rolldown or `oxc-transform-react` upgrade |

The compiler crash harness provokes the crash with a property chain that
segfaults `oxc-transform-react` (oxc-project/oxc#27995) from a depth that moves
with the host's stack (4929 on the dev box), which is why it is out of
`pnpm test`, whose `react-compiler.test.ts` kills the process with SIGSEGV
itself: a depth of 7000 crashed on the dev box and compiled on a CI runner.
Rolldown has its own edge: it prints a chain up to 5500 and drops an unused
one up to 11000, so the crashing function is imported and never exported. The
harness also times a slow chain out under a 100 ms limit, and holds it under the
shipped `MODULE_TIME_LIMIT_MS` (5 s, against 5 ms for the slowest real module).
On a failure, measure each edge again and set `CRASH_DEPTH` and `SLOW_DEPTH`
from them.

## Browser harnesses

| Command | Runs | Claim |
| --- | --- | --- |
| `pnpm build && pnpm test:singleton-harness` | `packages/core/src/singleton.harness.ts` | two islands in two tier groups share one store module (#64) |
| `pnpm build && pnpm test:lazy-runtime-harness` | `packages/core/src/lazy-runtime.harness.ts` | an all-`idle` page requests no `pagedeck-core` chunk before the idle trigger fires, and its island hydrates after it (#95) |
| `pnpm build && pnpm test:hydrated-harness` | `packages/core/src/hydrated.harness.ts` | a `load` island's marker carries `data-pagedeck-hydrated` once it commits, an `idle` island's only after its trigger, and an island whose module fails to load never does (#139) |
| `pnpm build && pnpm test:hydration-task-harness` | `packages/core/src/hydration-task.harness.ts` | at 4x CPU slowdown, a 5000-row `load` island hydrates in tasks each shorter than half the hydration, because the runtime hydrates in a transition (#97) |
| `pnpm test:consent-facade-harness` | `packages/core/src/consent-facade.harness.ts` | consent moves a facade's `data-pagedeck-consent` without a reload, and a denied press loads nothing (#460) |
| `pnpm test:view-transitions-harness` | `packages/core/src/view-transitions.harness.ts` | with `viewTransitions: true`, following a link runs a cross-document view transition with no motion preference and none under `prefers-reduced-motion: reduce` (#121) |
| `pnpm build && pnpm test:island-browsers-harness` (needs `npx playwright install chromium firefox webkit`) | `packages/create-pagedeck/src/island-browsers.harness.ts` | the starter's counter island hydrates and counts clicks in Chromium, Firefox and WebKit (#161) |
| `pnpm build && pnpm test:app-form-harness` | `packages/app-example/src/app-form.harness.ts` | the companion-app form, served by `wrangler dev`, announces success, refusal, a held request, a dropped request and a non-JSON failure, sends one request for a double submit, keeps the address for a retry, and posts without JavaScript or before hydration to a page whose URL holds no address (#159) |

The singleton, lazy runtime, hydrated and hydration task harnesses run emitted chunks
from `packages/islands/dist`, because jsdom ignores `<script type="module">`,
so build first; none can detect a stale `dist`. The consent facade and view
transitions harnesses drive `runCli` in process and need no build. The island
browsers harness spawns `pagedeck` over a copy of the starter template, so
build first; `ci.yml`'s `browsers` job runs it on every push. The app
form harness spawns `pagedeck` and `wrangler dev` in `packages/app-example`,
so build first, and do not run it beside that package's `site.build.test.ts`:
both build in the package directory. Under a
CSP, poll with `page.evaluate`: `page.waitForFunction` runs its predicate
through `eval`, which the policy refuses (#586).

The hydration task harness backs a measurement (#97): at 4x CPU throttle, the
longest main-thread task during a 5000-row `load` island's hydration fell from
138.3 ms to 45.3 ms (median of 3), "before" being main's runtime rebuilt into
`packages/islands/dist`. The hydration span grew from about 150 ms to 270 to
350 ms; paint is unchanged, because the server HTML is already there. Re-run it
on a React or Chromium upgrade.

## The site audit harnesses

```
pnpm build && pnpm test:a11y-harness
pnpm build && pnpm test:lighthouse-harness
```

`packages/site/src/a11y.harness.ts` and `packages/site/src/lighthouse.harness.ts`
build the dogfood site and audit it in Chromium (#59); Lighthouse costs an
order of magnitude more, hence two commands. A failure is a real defect. **It
never fails on timing** (`GLOSSARY.md`, #59): the performance metrics go to
`packages/site/.pagedeck-site-audit/lighthouse-report.json`, asserted against
nothing.

The Lighthouse harness asserts the score floors in
`packages/site/src/audit-site.ts`, and records each page's script bytes and
requests without a limit (#230). Its scratch build declares one catch-all
budget no page comes near, only so the build writes the budget report the
payload figures read, as the pack harness does.

## The third-party loadout measurement

```
pnpm bench:loadout-lighthouse
```

`packages/site/src/loadout-lighthouse.harness.ts` (built first by the script)
measures criterion 5 of `docs/success-criteria.md` (#277). It serves a synthetic
loadout from `http://localhost:<port>`: a tag manager that injects two tags, an
analytics script that beacons, a pixel and a chat widget, each spinning its
thread for a declared number of milliseconds. It builds one fixture site per
strategy mix under `packages/site/.pagedeck-loadout/`, serves each from
`http://127.0.0.1:<port>`, and runs Lighthouse mobile three times over each mix,
one run at a time. It prints score, TBT, LCP and CLS per run and writes
`loadout-report.json` beside the sites.

It asserts nothing about timing (`GLOSSARY.md`, #57). It fails on two things:
a request in Lighthouse's `network-requests` audit to any origin but those two,
and a run in which the loadout's own reports differ from what the mix calls for.
Each script ends by requesting its origin with its name and the thread it ran on,
so a script that did not run, or a `worker` script that ran on the main thread,
fails the run instead of scoring well. Re-run it when the script layer, the
Partytown runtime, Lighthouse or Chromium changes.

## The origin harness

```
pnpm test:origin-harness
```

`packages/site/src/origin.harness.ts` deploys, pushes and pulls against
SeaweedFS's S3 gateway in Docker, over TLS, with SigV4 URLs signed by a
throwaway credential (#302, #652), and once through the shipped signing step in
region `auto`, serving the result through the compiled Worker (#665). It also
prunes a presigned origin through its history index and checks that the same
files go as from a directory origin given the same history (#659). It
round-trips the content store through `PAGEDECK_SNAPSHOT_PULL_URL` and
`PAGEDECK_SNAPSHOT_PUSH_URL`, and checks that a URL signed for one method is
refused (HTTP 403) for the other (#63). The script
runs `pnpm build` first, because the deploys spawn `deploy.bin.js`.

**It needs a Docker daemon, `openssl` on `PATH`, and Node 24.5 or later**,
and skips with the reason in the suite's title without one. The origin runs on
an `--internal` bridge network at a fixed private address, never `localhost`,
because the snapshot host refusal takes no override (`GLOSSARY.md`); Linux
routes to the bridge, Docker Desktop does not. `ORIGIN_SUBNET` and
`ORIGIN_IMAGE` (pinned by digest) are in
`packages/site/src/s3-origin.test-support.ts`. A subnet that overlaps an
existing network fails `docker network create` loudly rather than skipping.
Bumping the image is a deliberate edit and a re-run. A killed run leaves containers
and networks for `docker ps -a --filter label=pagedeck.harness=origin` and
`docker network ls` with the same filter. It proves nothing about a CDN;
`docs/deploy-recipe.md` lists what is proven.

## The proxied-instance census

A build with `PAGEDECK_PROXY_CENSUS` set to a path appends a JSON Lines row
per proxied client-component instance it renders
(`packages/core/src/proxy-census.ts`). Clear `site` and `.pagedeck` first,
because an incremental build skips renders:

```sh
cd packages/site
rm -rf site .pagedeck
node ../core/dist/bin.js sync
PAGEDECK_PROXY_CENSUS="$PWD/census.jsonl" node ../core/dist/bin.js build
```

Another site takes the same three commands. `census.jsonl` is not gitignored: write it somewhere that is, or remove it
after reading.

**Take it again when a page renders a `"use client"` component from another
component's code.** A row's `propSlots` counts the elements the instance was
handed as prop slots (`docs/adr/0011-prop-slots-are-identified-by-prop-path.md`).

## The build-twice check

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

## The scaling ladder

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

## The island-scan measurement

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
