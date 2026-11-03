# Releasing

`.github/workflows/release.yml` publishes the public set to npm when a tag
`v<version>` is pushed (#7). It has three jobs (#58, #108):

- **`verify`** holds `contents: read` only. It installs with
  `--frozen-lockfile`, checks the tag with `pnpm check:release-tag`, and runs
  `pnpm test:pack-harness`.
- **`publish`** `needs: verify` and is the only job with `id-token: write`.
  It checks out again, installs with `--frozen-lockfile --ignore-scripts`, and
  runs `pnpm -r publish --access public --provenance --no-git-checks` and
  nothing else.
- **`notify`** `needs: publish` and holds `contents: read`. It gets a token
  from the deck-cool-releases App (`vars.DECK_APP_ID`,
  `secrets.DECK_APP_PRIVATE_KEY`) and sends pedrosousa13/deck-cool a
  `repository_dispatch` of type `deck-released` with
  `{"deck": "pagedeck", "version": "<tag without v>"}`, the steps deck-cool's
  `AGENTS.md` gives under "Releasing a deck". deck-cool then bumps
  `@pagedeck/*`, `@pagedeck/docs` among them. The App's key stays out of
  `publish`, beside `id-token: write`.

Any step in a job with `id-token: write` can mint an OIDC token, and npm's
trusted publisher exchanges that token for publish rights to every public
package. So the token reaches only the job that runs the publish, and never
the install scripts, the registry install or the site builds of the pack
harness. `cleanEnv` in `pack.harness.ts` also strips
`ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` from what
the harness spawns. `--ignore-scripts` is safe because `prepack`, which
`pnpm publish` runs in each package, is `tsc -b`, or `@pagedeck/docs`' copy
step, and needs no install script.
`packages/core/src/release-permissions.test.ts` holds the split and the
`notify` job. pnpm skips
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
publisher to each of the eighteen packages on npmjs.com: GitHub Actions, repository
`pedrosousa13/pagedeck`, workflow `release.yml`. npm matches the workflow
filename exactly, so renaming the file breaks every publish until each package
is updated. Then delete the token on npm and the `NPM_TOKEN` secret.

A package new to the public set, such as `@pagedeck/docs` (#108) or
`@pagedeck/script-worker` (#275), is not on
npm until its first publish, and npm sets up trusted publishing only for a
package that exists. So its first publish needs the token, and its trusted
publisher is added after.

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
