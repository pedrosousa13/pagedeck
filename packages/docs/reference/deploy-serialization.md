---
section: reference
title: Deploy serialization and rollback
description: Every build records its parent build and keeps old manifests, so pagedeck diff can refuse racing deploys and pagedeck rollback can restore one.
---

# Deploy serialization and rollback

A static deploy is an upload, and an upload is not atomic. Two of them running
at once interleave: the second one's files land on top of the first one's, and
the first one's prune list deletes files the second one just uploaded and never
knew about. The site that comes out is a mixture of two builds, and neither
manifest describes it.

`pagedeck` does not own the upload — no host is named anywhere in core, and the S3,
CloudFront and GitHub Actions recipes are docs rather than code. What it owns is
the record that makes the race **visible**: every build says which build it was
based on, every build's manifest is kept for a while, and `pagedeck diff` refuses a
deploy whose two manifests are not a chain.

## What a build records

`pagedeck build` stamps three things on the manifest it writes:

```json
{
  "build": {
    "id": "9e1f4a02-7c1e-4f8a-9a6f-1b5c3d2e4f60",
    "createdAt": "2026-09-01T10:14:22.301Z",
    "parent": "3c77b1de-52a0-4e77-bb0e-8f0a1c2d3e40"
  }
}
```

`id` is this build's identity, minted per run. `parent` is the id of the newest
manifest the retention store held **when this build started** — the build this
one is an increment of. It is absent on the first build of a site, where the
store was empty and there was nothing to be based on.

**The build records it because nothing downstream can work it out.** A deployer
holds two documents and two timestamps, and two builds that started from the
same base and finished a minute apart look exactly like a chain by `createdAt`
alone. That pair is the whole case worth catching: two CI runs triggered by two
webhooks, each rendering the site as it was before the other one uploaded. The
ordering fact lives in the moment the build read the store, and the only process
present in that moment is the build.

So the deployer compares rather than infers. `pagedeck diff <from> <to>` refuses when
`to`'s parent is not `from`'s id, which is last-write-wins detection: the second
deploy is told that the first happened. See [`--force`](./cli.md) in the CLI
reference for the two messages and the one exemption.

## The retention store

`pagedeck build` writes its manifest twice: into `outDir` beside the site it
describes, and into a store beside your config.

```
site/
  pagedeck.config.ts
  .pagedeck/manifests/3c77b1de-….json
  .pagedeck/manifests/9e1f4a02-….json
  dist/
    manifest.json
    index.html
```

**The store is next to the output tree and never inside it.** The default output
tree *is* `outDir` — a deploy uploads that directory wholesale — and a store
under it would be published with the site to every bucket the deploy touches. It
is also the one part of the tree that grows with the site's *history* rather
than with its content, so every CDN would end up serving a growing pile of JSON
documents describing files it is already serving.

`.pagedeck/` is a dot-directory a `.gitignore` names once. Add it to yours:

```sh
echo '.pagedeck/' >> .gitignore
```

The documents are sorted by the `createdAt` inside them and never by the file's
mtime, because a store restored from a backup or copied between machines has
mtimes that say when the *files* arrived. The order has to be a property of the
builds.

**On CI, the store has to outlive the run.** A fresh runner has no `.pagedeck/`, so
the build finds an empty store, records no parent, and `pagedeck diff` refuses the
deploy for the second reason in the CLI reference — every time, on a pipeline
with nothing wrong with it. Restore the directory at the start of the job and
save it at the end, the way you would a build cache, or keep it on the machine
that deploys. A chain nothing carries between runs is not a chain.

## build.retention.keep

How many manifests the store keeps is a named config, and the default is twenty:

```ts
build: {
  outDir: "./dist",
  retention: { keep: 20 },
  // ...
}
```

Newest first by `build.createdAt`; everything past the count is deleted when a
build writes. Twenty is a guess rather than a measurement — it is meant to cover
the rollback a team actually performs, which is to the build before the one that
broke, with room for a site deploying several times a day to still reach last
week's. Being wrong high costs a few hundred kilobytes of JSON beside the site;
being wrong low costs a rollback target that is gone.

`keep: 0` retains nothing, and it turns rollback off. It is a value a site can
write on purpose — a preview environment nobody rolls back is entitled to say
so — and it is why the field is a count rather than a count plus a flag. The
build still writes its document and then prunes it, so lowering the count from
twenty to zero clears the twenty too.

A count of documents rather than an age in days, because a count is the number
the store can act on with nothing but the store. An age would make "how far back
can I roll?" depend on how often the site deploys, which is the one thing a site
cannot see from its own config.

**A document this `pagedeck` cannot read is pruned rather than kept**, and the build
says so on stderr. That is what makes a `pagedeck` upgrade survivable: the store a
previous version filled is aged out by the first build after the upgrade instead
of failing it. If you see that line on *every* build, two `pagedeck` versions are
building one site — a CI image that moved while a developer's did not — and
rollback there never reaches further back than the last build.

## Rolling back

A rollback re-syncs a previous manifest: it is the same upload the deploy does,
with the file lists computed in the other direction.

```sh
# 1. Find the build to go back to. The store is named after build ids.
ls .pagedeck/manifests

# 2. Get the upload order that restores it.
pagedeck rollback 3c77b1de-52a0-4e77-bb0e-8f0a1c2d3e40 > rollback.json

# 3. Feed it to whatever performs your deploys.
./deploy.sh rollback.json
```

`pagedeck rollback` compares the manifest in `outDir` — the build the host is
serving — against the retained one, so the document names what to add back, what
to replace and what to prune. It is the document `pagedeck diff` writes, in the same
order, so a pipeline that already deploys a diff deploys a rollback unchanged.

Two things follow from the direction:

- **There is no stale-parent check and no `--force`.** A rollback deploys a
  build that came *before* what is live, so it is out of order by definition.
  The refusal lives in `pagedeck diff`, which is the verb that means "deploy this",
  and not in the diff itself.
- **The restored build's own files have to still exist.** A rollback adds back
  what the newer build pruned, which the deploy can only do from a build output
  it still has. Keep the artifact, or re-run `pagedeck build` from the commit the
  retained manifest describes.

The output tree is not what makes the rollback correct — the manifest is. What
`pagedeck rollback` gives you is the ordering: uploads before prunes, with
`--grace-seconds` keeping a pruned file reachable while caches turn over.

## Recipe: debouncing a webhook storm

One editor pressing publish on eight entries sends eight webhooks. Eight builds
of the same site is waste; eight *deploys* of the same site is the race above.

**This is your scheduler's job and not `pagedeck`'s.** The debounce window belongs
where the trigger is — a CI concurrency group, a queue, a cron — because that is
the only place that can see a second webhook arrive while the first run is still
going. Core would have to hold state between runs to do it, and `pagedeck` is a
command that starts, builds and exits.

The shape to reach for is a window before the sync, and one run at a time after
it:

```
concurrency:
  group: deploy-${{ github.repository }}
  cancel-in-progress: false

on:
  repository_dispatch:
    types: [cms-publish]

jobs:
  deploy:
    steps:
      - run: sleep 60          # the debounce window
      - uses: actions/cache@v4  # the store, carried between runs
        with:
          path: .pagedeck
          key: pagedeck-manifests-${{ github.run_id }}
          restore-keys: pagedeck-manifests-
      - run: pagedeck sync --incremental
      - run: pagedeck build
      - run: pagedeck diff "$LIVE_MANIFEST" dist/manifest.json > plan.json
      - run: ./deploy.sh plan.json
```

`$LIVE_MANIFEST` is the manifest of the build the host is currently serving,
from wherever your pipeline keeps it — the previous run's artifact, or the
newest document in `.pagedeck/manifests` on a runner with a persistent checkout.

Two properties are what make this work, and they are worth stating separately
because only one of them is the sleep:

- **`cancel-in-progress: false` with a concurrency group serializes the
  deploys.** A second webhook waits for the first run rather than running beside
  it, so the second build reads a store the first build has already written to,
  and records that build as its parent.
- **The window before `pagedeck sync` absorbs the storm.** Eight webhooks within a
  minute collapse into one run that syncs every entry, instead of one run per
  entry each syncing a site that is still changing.

**A window that is too short produces exactly the deploy `pagedeck diff` refuses.**
Two runs starting inside each other's build time both read the store before
either uploads, so both record the same parent, and the second one is a stale
deploy — reported, not silently applied. That is the intended failure: the
detection is what makes a badly tuned window visible instead of leaving a mixed
site behind.

**Do not answer that refusal with `--force` in CI.** `--force` means "I know
another deploy landed and I want mine anyway", which is a judgement a person
makes about one deploy. A pipeline that passes it always has turned the
detection off. The fixes in order are: serialize the runs, lengthen the window,
or re-run `pagedeck build` so it is based on what is live.

Whether to debounce at all is a property of your CMS's webhook behaviour and
your deploy cost, which is why this is a recipe rather than a setting. What `pagedeck`
guarantees is that getting it wrong is loud.
