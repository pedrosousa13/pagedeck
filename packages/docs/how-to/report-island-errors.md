---
section: how-to
title: Report island errors from production
description: Declare build.islandErrors to send each island's hydration, render and module-load failures to your own reporter, with page, component and release.
---

# Report island errors from production

An island that fails in a reader's browser logs to that browser's console, and
nobody sees it. `build.islandErrors` names a module of yours that receives each
island failure as a report, so you can send it wherever you collect errors.
Pagedeck names no vendor: the module is yours, and it decides where a report
goes.

## Declare a reporter

Write a module whose default export takes one `IslandErrorReport`:

`src/report-island-errors.ts`:

```ts
import type { IslandErrorReport } from "@pagedeck/core";

export default function report(report: IslandErrorReport): void {
  const error = report.error instanceof Error ? report.error : new Error(String(report.error));
  navigator.sendBeacon(
    "/api/island-errors",
    JSON.stringify({
      kind: report.kind,
      page: report.page,
      component: report.component,
      release: report.release,
      message: error.message,
      stack: error.stack,
    }),
  );
}
```

Name it in the `build` section of `pagedeck.config.ts`, as a path from the
config's directory or a package specifier:

```ts
build: {
  outDir: "./site",
  islandErrors: "./src/report-island-errors.ts",
  // ...
}
```

The module runs in the browser, as a chunk of its own that the islands runtime
imports when it loads. If it sends reports to another origin, add that origin
to the `connect-src` of your `Content-Security-Policy`.

`pagedeck build` wires the reporter in. `pagedeck dev` does not: there, React's
own development messages are in the console.

## What a report holds

| Field | Value |
| --- | --- |
| `kind` | `"recoverable"`, `"caught"`, `"uncaught"` or `"module-load"` |
| `page.locale` | the page's locale, as its `<html lang>` carries it |
| `page.path` | the URL path the browser loaded, such as `/en/pricing/` |
| `component` | the island's name in `build.components` |
| `release` | the `build.id` in the `/manifest.json` the host serves when the error is reported, or absent (see [The release](#the-release)) |
| `error` | the value that was thrown or rejected, as React or the browser handed it over |

A report holds no props, no content entry, no cookie and no storage. The
`error` is passed on unchanged, so its message holds whatever the code that
threw put in it. In production, React's own messages are short codes with a
link to `react.dev`.

## What it observes

| Kind | When |
| --- | --- |
| `recoverable` | React recovered from an error during hydration, most often a mismatch between the server HTML and the first client render. React discards the island's server HTML and renders it on the client. |
| `caught` | An error boundary inside the island caught an error thrown while rendering, or in an effect. |
| `uncaught` | An error thrown while rendering, or in an effect, that no boundary inside the island caught. React unmounts the island. |
| `module-load` | The island's own module failed to load: a chunk that is not on the origin any more, a network failure, or an error thrown while the module evaluates. |

Each island is its own React root, so one island's failure does not stop
another island from hydrating.

## What it does not observe

- **Errors outside islands.** A content page, a third-party script and an
  inline script are not reported. Neither is an island's event handler, a
  `setTimeout` callback or a rejected promise inside an island, because React
  does not see those errors. The browser reports them to `window`'s `error`
  and `unhandledrejection` events.
- **Failures before the runtime loads.** The reporter loads when the islands
  runtime loads. If the page's entry chunk, the runtime chunk or the reporter
  itself fails to load, no reporter exists to call. For a page whose islands
  are all `idle` or `visible`, the runtime loads on the first trigger, so the
  same is true before that trigger fires.
- **A marker the runtime cannot read.** A hand-written or damaged
  `<pagedeck-island>` is reported to the console by the runtime and not to the
  reporter, because it names no island the build registered.
- **Pages that never ran.** A reader whose browser does not run JavaScript
  sends nothing.

## The release

The page does not carry its build id, so two builds of one commit write the
same chunks and pages. When an error is reported, the reporting code requests
`/manifest.json` from the page's origin, the file `pagedeck build` writes at
the root of its output, and takes `release` from its `build.id`. It requests
the file once per page, and only when an error is reported: a page with no
error makes no request. Errors reported at the same time share the request.

The report carries no `release` field when the host does not serve that file,
the request fails, or the answer is not the manifest:

- **The edge artifacts of every adapter Pagedeck ships answer
  `/manifest.json` with a 404**, because it is the deploy's own record of the
  site ([Deploy a site](deploy-a-site.md#1-upload-the-output-directory)). A
  site served through one gets reports with no `release`. A plain static host
  that serves the output directory as it is serves the file.
- **A `Content-Security-Policy` whose `connect-src`, or `default-src` when it
  has no `connect-src`, does not allow `'self'`** refuses the request.

`release` names the build the host serves when the error is reported. That is
the build that served the page, unless a deploy happened while the page was
open: then it names the new build. A `module-load` error for a chunk a deploy
removed while the page was open is that case. To match a
report without `release`, or to check one, use the chunk names in the stack,
as below.

## Console behaviour

Each error is logged first, as React logs it with no reporter: a
`recoverable` or `uncaught` error goes to `reportError`, which logs it as an
uncaught error, and a `caught` error goes to `console.error`. A
`module-load` error is rethrown, so the browser still logs the rejected
import.

The reporter is called after that, asynchronously: once its module has loaded
and `/manifest.json` has answered. A report that is still waiting when the
reader leaves the page is not sent. Send it with `navigator.sendBeacon` or
`fetch` with `keepalive: true`, so a report already sent is not lost when the
page closes.

If the reporter throws, or returns a promise that rejects, its error goes to
`console.error` and is not reported, so a broken reporter never calls itself. The island's own error is still
logged, and every other island still hydrates.

The reporter module is loaded with a dynamic import. If it throws at its top
level while it loads, or its chunk fails to load, that error goes to
`console.error` once, no report is sent from that page, and every island still
hydrates.

## Match a report to its build

`release` is the build id: the `build.id` in the `manifest.json` that
`pagedeck build` writes, the name of the build's manifest in
`.pagedeck/manifests/`, and the name of the release directory that
[the deploy recipe](../deploy-recipe.md) prepares for a site with an app.

The reporter above sends `error.stack`. Each frame in it names a chunk under
`/assets/`, with a line and a column. Chrome writes a frame as
`at Counter (https://example.com/assets/Counter-BrQs-g2S.js:1:60)`, and Firefox
as `Counter@https://example.com/assets/Counter-BrQs-g2S.js:1:60`. Run
`pagedeck trace` in the site's directory with one frame as the stack holds it,
in quotes, and the report's `release`:

```sh
npx pagedeck trace "at Counter (https://example.com/assets/Counter-BrQs-g2S.js:1:60)" a04807ad-00d9-4ba3-a8df-e48321a2b889
```

It prints the file, line and column in your source, from the site's root:

```
components/Counter.js:3:59
```

The frame can also be the URL alone,
`https://example.com/assets/Counter-BrQs-g2S.js:1:60`, or the path,
`/assets/Counter-BrQs-g2S.js:1:60` or `assets/Counter-BrQs-g2S.js:1:60`. When
`pagedeck trace` refuses a frame, it quotes the frame without its host,
userinfo or query string. Without a build id, `pagedeck trace` reads
the newest retained build that holds a map for the chunk. Use that for a
report with no `release`. A chunk's name is a hash of its code, so every build
that holds the chunk ran the same code. If an older build holds a different map
for it, because an edit such as a comment changed the source and not the code,
`pagedeck trace` says which builds those are; pass the build id to read one of
them.

### Where the maps are

A site that declares `build.islandErrors` keeps a sourcemap for each chunk that
holds your code, in `.pagedeck/sourcemaps/<build id>/`, beside the build's
manifest, with a copy of the chunk, which `pagedeck trace` uses to refuse a
line or column past the end of the code. A map names each source by its path
from the site's root, or a dependency as `node_modules/<package>/<path>`, and
never by a path of the machine that built it. No map is written to the output directory or the edge output, and no
chunk names a map, so a deploy publishes none
([ADR-0002](../adr/0002-no-production-sourcemaps.md)). `pagedeck build` keeps
the maps of the last `build.retention.keep` builds and deletes the rest with
their manifests. A page's entry chunk holds only the code the build generates
to load its islands, and has no map.

**A sourcemap holds the full source of every module it maps**, comments
included. Keep `.pagedeck/` private: do not deploy it, publish it or attach it
to anything that others can read.

If the build that served the chunk was pruned, build the same commit again with
`build.islandErrors` declared. The chunk's name is a hash of its code, so the
build writes the same chunk and a map for it.

## What it costs

A site that does not declare `build.islandErrors` ships the same bytes as
before the field existed: no chunk, page or loader changes.

A site that declares it ships about 540 bytes Brotli of reporting code with
the islands runtime, and its own reporter module as a separate chunk, which
the runtime requests when it loads. The sourcemaps it keeps are not shipped,
and they change no chunk or page. The
[JavaScript budget](../reference/javascript-budgets.md) of each page with an
island counts the reporting code. The request for `/manifest.json` happens
only when an error is reported.
