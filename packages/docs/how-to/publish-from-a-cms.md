---
section: how-to
title: Publish from a CMS
description: Turn a CMS webhook or a schedule into sync, build and deploy, one run at a time, and recover from a failed run without --force.
---

# Publish from a CMS

A static site changes when it is built again. This page connects your CMS to
that: an edit in the CMS, or a schedule, starts a job that syncs, builds and
deploys the site. Pagedeck runs no server and no scheduler for this. The
webhook receiver lives in an app beside your site, and the job runs in your CI.

The example is `packages/cms-example` in the Pagedeck repository, the same
site as [Connect a CMS](./connect-a-cms.md). Its `src/publish.build.test.ts`
runs the whole workflow on one machine: the example's CMS sends signed
webhooks, `src/webhook.ts` receives them, `src/publish.ts` stands in for the CI
job and its concurrency rule, and the deploy writes to a local directory as the
origin. No step needs a network or a cloud account.

## The workflow

```
CMS edit ──signed webhook──▶ receiver ──dispatch, empty payload──▶ CI job
schedule ─────────────────────────────────────────────────────────▶ CI job

CI job, one at a time:
  restore state ▶ pagedeck sync ▶ pagedeck build ▶ deploy --apply --prune ▶ save state
```

Every run does the same thing, whatever started it. The job does not read
which page changed from the webhook. It asks the CMS, so a forged or replayed
delivery can at most start a run that publishes what the CMS holds.

## Receive the webhook

`createWebhookReceiver` in `src/webhook.ts` is a function from a `Request` to
a `Response`, so it mounts in any app that speaks the fetch API, such as the
one in [Run an app beside the site](./run-an-app-beside-the-site.md). For each
delivery it checks:

- **The signature.** The CMS signs `<webhook-id>.<webhook-timestamp>.<body>`
  with HMAC-SHA256 and a secret only the CMS and the receiver hold, and sends
  it in `webhook-signature`. The receiver compares it in constant time, with
  `crypto.subtle.verify`, against at most the first four `v1,` values in the
  header. A wrong secret or a changed body gets a 401.
- **The time.** A `webhook-timestamp` more than 300 seconds from the
  receiver's clock gets a 401. A delivery captured and sent again later is
  refused this way.
- **Duplicates.** A CMS retries a delivery it thinks failed. The receiver
  remembers the last 1000 `webhook-id` values that passed the signature check,
  and answers a repeat with 200 and no run. An id evicted from that list is
  still inside the time window, so at worst it starts one more run, which
  publishes the same content.
- **Size.** It stops reading a body past 64 KiB and answers 413. A delivery
  names what changed; it does not carry the content.

No answer quotes the secret, a signature, or a `webhook-id` the signature has
not yet vouched for. A secret under 32 bytes, and a limit that is not a whole
number above zero, are refused when the receiver is made. The tests are
`src/webhook.test.ts`.

## Dispatch the CI job

The receiver's `dispatch` asks CI for one run and passes nothing from the
delivery. On GitHub Actions that is a `repository_dispatch` with
`{"event_type": "content-published"}` and no `client_payload`, sent with a
token that may dispatch on the one repository.

The trust boundary has three parts, and each credential stays in one of them:

| Part | Holds | Never holds |
| --- | --- | --- |
| The CMS | the webhook secret | the dispatch token, any deploy credential |
| The receiver | the webhook secret, the dispatch token | any deploy credential |
| The CI job | a CMS read token if the loader needs one, the deploy credential | the webhook secret |

Nothing in this workflow runs in a browser, and no credential is in a webhook
body or a dispatch payload. Give the deploy credential only to the steps that
write, as [Deploy recipe](../deploy-recipe.md) does under "The secret": a
job-level `env:` reaches every action and install script in the job.

## The job

The job keeps three things between runs: the store (`content.db`), the
retention store (`.pagedeck/`) and the output tree (`site/`). It restores the
ones the last successful run saved, and saves its own only after the deploy
succeeded.

```
name: Publish
on:
  repository_dispatch:
    types: [content-published]
  schedule:
    - cron: "*/15 * * * *"
permissions:
  contents: read
concurrency:
  group: publish-site
  cancel-in-progress: false
jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@<commit sha>
      - uses: actions/setup-node@<commit sha>
        with:
          node-version: 24
      - run: npm ci
      - id: state
        uses: actions/cache/restore@<commit sha>
        with:
          path: |
            content.db
            .pagedeck
            site
          key: publish-state-${{ github.run_id }}
          restore-keys: publish-state-
      - name: Sync
        env:
          RESTORED: ${{ steps.state.outputs.cache-matched-key }}
        run: |
          if [ -n "$RESTORED" ]; then npx pagedeck sync --incremental; else npx pagedeck sync; fi
      - name: Build
        env:
          RESTORED: ${{ steps.state.outputs.cache-matched-key }}
        run: |
          if [ -n "$RESTORED" ]; then npx pagedeck build --incremental; else npx pagedeck build; fi
      - name: Deploy
        run: ./deploy.sh --apply --prune
      - uses: actions/cache/save@<commit sha>
        with:
          path: |
            content.db
            .pagedeck
            site
          key: publish-state-${{ github.run_id }}
```

Pin each action to a commit, and replace `./deploy.sh` with your host's
deploy. The example's CMS and its directory origin take no credential, so the
workflow shows none. If your loader reads a CMS token, or your host's deploy
takes a credential, set each in the `env:` of the one step that uses it, from a
secret, and nowhere else. The example deploys with the repository's `deploy.bin.js`, which
reads the live build off the origin and refuses a raced deploy. The save step
runs only when every step before it passed, which is what keeps a failed run's
state out of the next run.

A fresh state, with nothing restored, runs `pagedeck sync` and `pagedeck build`
in full. After that each run is incremental: `pagedeck sync --incremental` asks
the CMS for what changed since the stored cursor, and
`pagedeck build --incremental` renders only the pages it affects.

## A burst of edits

An editor who presses publish on eight pages sends eight webhooks. The
`concurrency` group is what turns them into few runs. With
`cancel-in-progress: false`, GitHub runs one job in the group at a time and
keeps at most one waiting. A new run replaces the one waiting, as GitHub's
documentation for `concurrency` says. A run never starts while another
deploys, and the run left waiting starts after the newest webhook, so it syncs
the newest content.

The example's `coalesce` applies the same rule, and the test measures it. Eight
edits to one page produced two runs, the second started after the first ended,
and the origin served the eighth edit. In a second case, an edit lands after
the first run's sync has read the CMS: the first run deploys the edit before
it, and the run waiting behind it deploys the late one. Every build deployed in the test names
the build deployed before it as its parent, so no deploy raced another. That is
a measurement of the example's rule, not of GitHub's runner: GitHub's
behaviour is what its documentation states.

A `sleep` before the sync does not coalesce anything. It only makes each run
start later.

## Scheduled publication

A collection that names a [publication window](../reference/publication-window.md)
makes a page only of the entries inside it, at the build's instant. The build's
instant is the `createdAt` of its stamp, which `pagedeck build` reads from the
clock of the machine it runs on when it starts. Nothing can set it to another
instant, so keep the runner's clock synchronized.

So an entry is published by the first build that starts at or after its
`publishAt`, and retracted by the first build that starts at or after its
`unpublishAt`. Nothing about the CMS changes at that instant, so no webhook
fires: the schedule is what starts that build. The example's test puts a page
with both instants in the future, runs the job, and finds the page absent; then
runs the job after `publishAt` with no edit, and finds it served; then after
`unpublishAt`, and finds it gone from the origin.

The latest a scheduled change reaches the origin is:

```
schedule interval + time waiting in the concurrency group + one run's duration
```

With a 15-minute cron and a 3-minute job, a page is served at most about 18
minutes after its `publishAt`, more if a run is waiting behind another or the
CI provider starts the schedule late. Add the CDN's TTL for a page that is
retracted. A shorter interval lowers the bound and runs more jobs. A run takes
about 1.5 s for the example's four pages on the development machine; your
site's run time is the figure to use.

Write the instants with milliseconds, as `2026-11-01T09:00:00.000Z`. The window
compares them with the build's instant as text, and the build's instant has
milliseconds. An instant written as `2026-11-01T09:00:00Z` takes effect up to
one second late.

## When a run fails

A run that fails before its deploy leaves the deployed site as it was. The job
stops at the failed step, and the save step does not run, so the next run
starts from the last successful state.

| Failure | Where the run stops | What to do |
| --- | --- | --- |
| The CMS is down or times out | `pagedeck sync` | Nothing. The next webhook or scheduled run syncs every change since the saved cursor. Or re-run the job. |
| The CMS sends a page the schema refuses | `pagedeck sync`, naming the page and the field | Fix the page in the CMS. Its edit sends a webhook and starts the run. |
| The build fails, such as a budget breach | `pagedeck build` | Fix the content or the site, and run the job again. |
| The deploy fails | the deploy, exit 1 | Re-run the job once the origin takes writes again. The origin's `manifest.json` is written last, so the live build is still the old one. |

The test makes each of the four fail, the deploy by making the page it uploads
read-only at the origin. Each time it checks that the origin's files and the
saved state are byte for byte unchanged, and that the next run deploys the fix
without `--force`. The test's failed deploy had one page to upload, so nothing
landed. A deploy that fails partway can already have replaced some pages,
after the assets they load, and the live manifest still names the old build;
the re-run uploads the rest.

**Do not pass `--force` in this job.** A run built from the saved state records
the live build as its parent, so its deploy is not a raced deploy and needs no
override. A refused deploy means the state and the origin disagree, which
`--force` would hide. The one case to expect is a lost state: an expired cache
gives a fresh run whose build records no parent, and the deploy refuses it with
exit 2 and touches nothing. Put the live build's document back in the retention
store before the build, then run the job again:

```sh
# <build id> is build.id in the origin's manifest.json
mkdir -p .pagedeck/manifests
cp <origin>/.pagedeck/manifests/<build id>.json .pagedeck/manifests/
```

In CI, make this a step that runs only when a person asks for it, such as a
`workflow_dispatch` input, and not on every run with nothing restored. Done on
every fresh run, it would record whatever is live as the parent, including a
deploy made from outside this job, and the refusal would never fire. The test
removes the saved state and does this once. [Deploy serialization and
rollback](../reference/deploy-serialization.md) explains the parent check.

## Removing a page

A page removed in the CMS, or past its `unpublishAt`, leaves the next build's
manifest. That alone retracts nothing: the previous deploy put the page at the
origin, and it stays there until a prune deletes it. So the job deploys with
`--prune`, which deletes a dropped page in the same run, since a page has no
grace period. The test checks that the removed page's file is gone from the
origin, not only from `manifest.json`.

A CDN in front of the origin can serve its cached copy of the page until its
TTL runs out. Purge the page's URL on your CDN after the deploy, or keep the
TTL for HTML short. How to purge depends on the host; the example has no CDN,
and nothing here tests one.
