# Contributing

This is a pnpm workspace. Every package is under `packages/`, and the root
`package.json` holds every script. CI runs on Node 24.

```sh
pnpm install
pnpm typecheck
pnpm test
```

`pnpm build` deletes every package's `dist` and emits it again with
`tsc -b tsconfig.build.json`. The emitted JavaScript is what the `pagedeck`
command runs: a test that spawns `pagedeck` runs `packages/core/dist/bin.js`,
and Node reaches every other package through the emitted `.js` its `exports`
name.

`pnpm test` runs `pnpm build` first, then the suite. `npx vitest run` alone
does not build, so run `pnpm build` before it when a test spawns `pagedeck`.
`pnpm typecheck` reads the source, then checks the starter template in
`packages/create-pagedeck/template` against the emitted types it builds itself,
so it needs no `pnpm build` either.

## Running the suite

On a four-core machine, run the suite with two workers, so the machine stays
usable while it runs, and write the output to a file. `.scratch/` is
gitignored:

```sh
pnpm build
npx vitest run --maxWorkers=2 > .scratch/suite.log 2>&1
```

If a test fails with `Test timed out in 15000ms` in a file you did not touch,
do not chase that file. `AGENTS.md`, under "Every test that spawns a process
declares its own timeout", gives the two causes: a test that spawns a process
without stating its own timeout, or a worker starved under load. The root
`vitest.config.ts` sets `testTimeout: 15_000` as a floor for that starvation
(#640), not as the timeout of a spawning test.

To run one file:

```sh
npx vitest run packages/core/src/config.test.ts
```

## Harnesses

`pnpm test` runs no harness, though it runs each `*.harness.test.ts`, which
tests a harness's logic. Each has its own script in the root
`package.json`, and `AGENTS.md`, under "Harnesses", says what each one proves
and when to run it. The pack harness is the one that checks the public
packages:

```sh
pnpm test:pack-harness
```

It packs the public packages, installs them outside the repository, builds the
tutorial's site and the site `create-pagedeck` writes, and fails on a tarball
that carries a file it should not or lacks its README or LICENSE.

## Error messages

If you write code that throws, read
[`docs/error-messages.md`](docs/error-messages.md) first. Build failures here
follow it.

## Examples

`packages/examples` holds runnable examples of the public contracts, and CI
runs them. If you change a contract that has an example, change its example
too.

## Where the rules are

`AGENTS.md` holds the rules for working in this repository. `CONTEXT.md` holds
the project's vocabulary and the decisions that bind later work. `docs/adr/`
holds the architectural decisions.
