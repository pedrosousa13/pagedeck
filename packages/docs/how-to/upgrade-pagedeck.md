---
section: how-to
title: Upgrade Pagedeck
description: Move a site to a new Pagedeck release, with every @pagedeck package at one version, a fresh sync and build, and a way back across a manifest version.
---

# Upgrade Pagedeck

Every public package is released at one version, and a site installs all of
its `@pagedeck/*` packages at that version. This guide moves a site from one
release to the next. The worked example at the end moves the starter site
that `npm create pagedeck` writes from `0.3.1` to `0.4.0`.

What a patch or a minor release may change is in
[Support and compatibility](../reference/support.md#versions-before-1-0). In
short: a patch release never breaks a site, and a minor release may, with each
break and its migration in the release notes.

## 1. Read the release notes

Read the notes of each release between the version you have and the version
you want, at
`https://github.com/pedrosousa13/pagedeck/releases/tag/v<version>`. To move
from `0.3.1` to `0.5.0`, read `v0.4.0`, `v0.5.0` and each patch between them.
Note four things:

- **Breaking changes.** Each one has the steps that migrate a site.
- **Supported environments.** A change to the Node.js lines, the React range
  or the browser floor. Change your CI image and your host's Node.js version
  first.
- **Manifest and routing versions.** Whether `MANIFEST_VERSION` or
  `ROUTING_VERSION` moved. Steps 5 and 6 depend on it.
- **Content store.** Whether the store's tables changed. Step 4 depends on it.

## 2. Keep a way back

Before you change anything, keep the output tree that is live now, and the
`.pagedeck/` directory beside your config. If the new release moved the
manifest version, the new `pagedeck` cannot read the manifests the old one
wrote, so it cannot roll back to them (step 6). The output tree you kept is
then the way back.

## 3. Bump every `@pagedeck/*` package together

Install every `@pagedeck/*` package your site depends on at the new version,
in one command. Include the edge adapter if you have one.

Do not move one package alone. `@pagedeck/core` depends on
`@pagedeck/content` and `@pagedeck/islands` at its own exact version, so a
site with `@pagedeck/islands` at a different version installs two versions of
it side by side. No release is tested with that, and none supports it.

Then apply each migration the release notes list, in the order they list them.

## 4. Sync the content store again

Run a full `pagedeck sync`, not `pagedeck sync --incremental`. A full sync
reads every entry through the new version's loaders.

The store, `content.db` in the starter, carries no version number. If the
release notes say the store's tables changed, delete `content.db` before you
sync. A store snapshot that `pagedeck store push` wrote before the upgrade is
an old store too: sync after you pull it.

## 5. Build the whole site

Run `pagedeck build`, not `pagedeck build --incremental`. An incremental build
reads the manifest in `outDir`. If the manifest version moved, it refuses that
manifest, because another version of `pagedeck` wrote it. For a move from
version 11 to 12, the refusal reads:

```
Manifest "<outDir>/manifest.json": is version 11, and this build reads version 12 — upgrade pagedeck, or read a manifest this version wrote
```

That refusal is the rule of
[ADR-0008](../adr/0008-when-the-manifest-version-moves.md): the version moves
only when an old and a new document could be read as two different facts, and
a reader refuses rather than guesses. When the version did not move, every
manifest the old release wrote is still readable, and nothing in steps 5 and 6
changes.

When the version moved, the first full build after the upgrade does two
things that it says on stderr:

- **It prunes the retention store.** It deletes each document in
  `.pagedeck/manifests` that it cannot read, and says so. See
  [`build.retention.keep`](../reference/deploy-serialization.md#build-retention-keep).
- **It prunes nothing from `outDir`.** It cannot trust the old
  `manifest.json`, so it deletes no file the old build wrote, and writes a
  warning that starts `Output "<outDir>":`. Before a directory-sync deploy,
  remove the stale pages yourself, or point `build.outDir` at an empty
  directory. See
  [what the build writes outside the output tree](../deploy-recipe.md#what-pagedeck-build-writes-outside-the-output-tree).

## 6. Deploy, and know what you can roll back to

When the manifest version did not move, deploy as you always do.
`pagedeck diff` compares the live manifest with the new one, and
`pagedeck rollback` can restore any retained build, from before the upgrade
too.

When it moved:

- **`pagedeck diff` cannot read the live manifest.** Deploy the whole output
  tree, as you did on the site's first deploy
  ([Deploy a site](./deploy-a-site.md)). The deploy publishes the new
  `manifest.json`, and from then on `pagedeck diff` works again.
- **`pagedeck rollback` cannot reach a build from before the upgrade.** The
  new `pagedeck` cannot read that build's manifest, and the first build
  pruned it from the store. To go back past the upgrade, install the old
  versions again and deploy the output tree you kept in step 2. A site with
  an app beside it restores a kept release, which needs no manifest: see
  [across a manifest version](../deploy-recipe.md#across-a-manifest-version).

A move of `ROUTING_VERSION` also moves `MANIFEST_VERSION`, and the build
compiles new edge artifacts. Deploy the edge artifact from the same build as
the site.

## Worked example: the starter from 0.3.1 to 0.4.0

`npm create pagedeck` at `0.3.1` writes these dependencies into the site's
`package.json`: each `@pagedeck/*` package at the exact version `0.3.1`, and
React at `^19.2.0`.

`package.json`:

```json
{
  "dependencies": {
    "@pagedeck/content": "0.3.1",
    "@pagedeck/core": "0.3.1",
    "@pagedeck/islands": "0.3.1",
    "@pagedeck/markdown-loader": "0.3.1",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  }
}
```

The site uses no edge adapter. A site written with `--host` also has
`@pagedeck/adapter-vercel`, `@pagedeck/adapter-cloudflare-pages` or
`@pagedeck/adapter-netlify` at `0.3.1`, and moves it in the same command.

Read the `v0.4.0` notes. Apply each break they list that touches the site's
`pagedeck.config.ts`, its components or its content. Then move all four
packages in one command:

```sh
npm install --save-exact @pagedeck/content@0.4.0 @pagedeck/core@0.4.0 @pagedeck/islands@0.4.0 @pagedeck/markdown-loader@0.4.0
```

Check that only one version of each is installed. Each line that `npm ls`
prints names `0.4.0`, and none names `0.3.1`:

```sh
npm ls @pagedeck/content @pagedeck/core @pagedeck/islands @pagedeck/markdown-loader
```

Read the manifest version the live build carries. The starter builds into
`site/`, and a `0.3.1` build writes version `11`:

```sh
node -p "require('./site/manifest.json').version"
```

Sync and build again, in full. If the `v0.4.0` notes say the store's tables
changed, delete `content.db` first:

```sh
npx pagedeck sync
npx pagedeck build
node -p "require('./site/manifest.json').version"
```

If the second number is the first, the manifest version did not move: deploy
as before, and `pagedeck rollback` still reaches the `0.3.1` builds. If it is
higher, follow step 6: deploy the whole of `site/`, and keep the `0.3.1`
output tree until you no longer want to go back to it.
