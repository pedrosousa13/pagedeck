---
section: reference
title: Support and compatibility
description: The Node.js lines, React versions and browsers Pagedeck supports, how versions move before 1.0, and where to ask for help or report a vulnerability.
---

# Support and compatibility

This page is the support contract. It says which environments Pagedeck
supports, what each release may change, and what nothing tests. A version that
a package's `engines` or dependency range lets you install is not supported
for that reason alone: only what this page names is supported.

To move a site to a new release, follow
[Upgrade Pagedeck](../how-to/upgrade-pagedeck.md).

## Node.js

**Supported:** Node.js 22 from `22.18.0`, and Node.js 24.

These are the maintained even-numbered lines that the packages' floors admit.
A new even line is supported when a release says so.

**Node.js 23 is not supported.** It is an odd-numbered line and has reached
its end of life. `@pagedeck/core` installs on 23.7 and later, because its
`engines.node` admits it, but that is not support.

**Node.js 20 and earlier are not supported.** Every package's `engines.node`
excludes them, and npm and pnpm warn when they install there.

CI runs the install, scaffold and build checks on Node.js `22.18.0` and `24`.
The floor is tested at its exact version, and Node.js 24 at the latest 24.x
release that `actions/setup-node` resolves.

### What each package declares

`engines.node` in each package is the lowest Node.js that its code and
dependencies need. Some packages need less than the supported floor, but a
site always installs `@pagedeck/core`, so a site needs the floor.

- `^22.18.0 || >=23.7.0`: `@pagedeck/core` and every package that depends on
  it: `@pagedeck/adapter-cloudflare-pages`,
  `@pagedeck/adapter-cloudflare-worker`, `@pagedeck/adapter-cloudfront`,
  `@pagedeck/adapter-netlify`, `@pagedeck/adapter-nginx`,
  `@pagedeck/adapter-vercel`, `@pagedeck/edge`, `@pagedeck/font-subset`,
  `@pagedeck/preview`, `@pagedeck/search`, `@pagedeck/social-image` and
  `create-pagedeck`. Node.js 22.18 loads
  `pagedeck.config.ts` with its types stripped and no flag. Node.js 23.7 is the
  first 23 release with `module.setSourceMapsSupport`, which the `pagedeck`
  command calls when it starts.
- `^22.13.0 || >=23.4.0`: `@pagedeck/content` and `@pagedeck/markdown-loader`,
  for `node:sqlite` with no flag.
- `>=22.0.0`: `@pagedeck/islands`, which uses no Node.js API, and
  `@pagedeck/docs`, which holds no code.

## React

**Supported:** React 19.2 and every later 19.x release. Every public package
that depends on React declares `react` and `react-dom` as `^19.2.0`, and
`npm create pagedeck` writes the same range into a new site.

**React 20 is not supported** until a Pagedeck release says otherwise. The
range refuses it, and a site that forces it with an override is on its own.

Pagedeck compiles every island with the React Compiler, through
`oxc-transform-react`, which core pins to an exact version. See
[React Compiler](./react-compiler.md).

## Browsers

A page with no island ships no JavaScript, so it works in any browser that
renders its HTML and CSS. The floor below is for a page with an island.

**Supported:** Chrome 111, Edge 111, Firefox 114 and Safari 16.4 (macOS and
iOS), and every later release of each.

That floor is the syntax target of the island bundles. Pagedeck builds them
with Vite 8 and leaves `build.target` at Vite's default,
`baseline-widely-available`, which Vite documents as "Chrome 111+, Edge 111+,
Firefox 114+, Safari 16.4+"
([Vite build options](https://vite.dev/config/build-options#build-target)).
Vite only rewrites syntax and adds no polyfills. In an older browser, an
island script can fail to parse, and the island then stays as its
server-rendered HTML, with no interaction.

The islands runtime needs these platform features. Each one shipped before
the floor, so the floor covers all of them:

| Feature | What uses it | Chrome | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- | --- |
| `<script type="module">` | every island page's entry script | 61 | 16 | 60 | 11 |
| Dynamic `import()` | the runtime, components and slots, loaded on demand | 63 | 79 | 67 | 11.1 |
| `IntersectionObserver` | islands that hydrate when `visible` | 58 | 16 | 55 | 12.1 |
| `reportError` | the startup module, when the runtime fails to load | 95 | 95 | 93 | 15.4 |
| `<template>` | the stash a container island's slots come from | 26 | 13 | 22 | 8 |
| `display: contents` | the island marker, which has no box of its own | 65 | 79 | 37 | 11.1 |

The figures are from [caniuse](https://caniuse.com/) and MDN's
[browser compatibility data](https://github.com/mdn/browser-compat-data).
Caniuse marks `display: contents` as partial in every engine, because of
accessibility defects on some elements. Pagedeck uses it only for layout.

### Optional enhancements

These features make a page better where the browser has them. Where it does
not, the page still works:

- **`requestIdleCallback`** (Chrome 47, Edge 79, Firefox 55; not in Safari).
  Where it is missing, an `idle` island hydrates after a 200 ms timer, and
  the third-party script loader and the web vitals beacon start on the next
  task.
- **Cross-document view transitions** with `build.viewTransitions` (Chrome
  126, Edge 126, Safari 18.2; Firefox not yet). Without them, a link loads
  the next page with no animation. See
  [View Transitions](./view-transitions.md).
- **Speculation rules** (Chrome 109, Edge 109). Other browsers ignore the
  rules and fetch each page when a reader follows its link. See
  [Speculation rules](./speculation-rules.md).

A browser harness builds the starter site, then hydrates and clicks its
counter island in Chromium, Firefox and WebKit through Playwright, at the
versions the pinned Playwright release ships.

## What nothing tests

These are outside the tests, so they are not promises:

- **The browser floor itself.** The browser harness runs the engines one
  Playwright release ships, not Chrome 111, Firefox 114 or Safari 16.4. WebKit
  in Playwright is not Safari. The floor comes from Vite's target and the
  data above.
- **Node.js 22.18.0 beyond the consumer path.** On 22.18.0, CI installs the
  packed tarballs, follows the tutorial, scaffolds a site with
  `npm create pagedeck` and builds it, and builds the app example. The
  repository's own suite, its typecheck and its other harnesses run on
  Node.js 24 only.
- **Every 22.x and 24.x release between the floor and the latest.**
- **Operating systems other than Linux.** CI runs on Ubuntu. macOS and Windows
  are not tested.
- **React releases other than the one the lockfile resolves.**
- **Hosts.** What has been deployed to a real host and what has not is listed
  in the
  [deploy recipe](../deploy-recipe.md#what-has-been-proven-and-what-has-not).

## Versions before 1.0

Every public package is released together, at one version. A release tag
`v<version>` publishes all seventeen at that version, and the release refuses
a tag that one package does not carry. Install them at the same version: core
depends on `@pagedeck/content` and `@pagedeck/islands` at its own exact
version, so a site that mixes versions installs two copies.

- **A patch release never breaks a site.** Moving from `0.4.0` to `0.4.1`
  needs no change to config, code or content.
- **A minor release may break a site.** Moving from `0.3.x` to `0.4.0` can
  change a config field, an exported API, a manifest version or what a build
  writes. Its release notes list each break with the change that fixes it.

### Deprecation

A field, option or export that will go is deprecated for at least one minor
release before a release removes it, where that is practical. While it is
deprecated, it still works, and the release notes and, where Pagedeck can, a
build warning name what replaces it. A removal that could not wait a minor,
such as a fix for a security defect, says why in its release notes.

### Release notes

The maintainer writes each release's notes by hand, as the GitHub release for
its `v<version>` tag,
`https://github.com/pedrosousa13/pagedeck/releases/tag/v<version>`. The
release workflow publishes the packages and does not create that release. The
notes of a minor release have these parts, and leave out a part with nothing in
it:

- **Breaking changes**, one entry per break: what changed, who it affects,
  and the steps to migrate, with the config or code before and after.
- **Deprecations**: what is deprecated, what replaces it, and the earliest
  release that can remove it.
- **Manifest and routing versions**: whether `MANIFEST_VERSION` or
  `ROUTING_VERSION` moved, and to what. A move means the new `pagedeck`
  cannot read manifests an older one wrote
  ([ADR-0008](../adr/0008-when-the-manifest-version-moves.md)).
- **Content store**: whether the store's tables changed, so that a site must
  delete `content.db` before its next `pagedeck sync`.
- **Supported environments**: a change to the Node.js lines, the React range
  or the browser floor.
- **Features and fixes.**

A patch release has only fixes, and says so.

## Getting help

Support is community support, through
[GitHub issues](https://github.com/pedrosousa13/pagedeck/issues), on a
best-effort basis. There is no commercial support, no response time and no
service level agreement. Include the `@pagedeck/core` version, the Node.js
version, and the command and output that fail.

## Reporting a vulnerability

Do not open a public issue for a security defect. Report it privately through
GitHub's private vulnerability reporting, at
<https://github.com/pedrosousa13/pagedeck/security/advisories/new>.
`SECURITY.md` in the repository says the same. There is no email address for
reports and no promised response time.
