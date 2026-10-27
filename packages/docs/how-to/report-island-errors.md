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

The module runs in the browser, bundled with the islands runtime. If it sends
reports to another origin, add that origin to the `connect-src` of your
`Content-Security-Policy`.

`pagedeck build` wires the reporter in. `pagedeck dev` does not: there, React's
own development messages are in the console.

## What a report holds

| Field | Value |
| --- | --- |
| `kind` | `"recoverable"`, `"caught"`, `"uncaught"` or `"module-load"` |
| `page.locale` | the page's locale, as its `<html lang>` carries it |
| `page.path` | the URL path the browser loaded, such as `/en/pricing/` |
| `component` | the island's name in `build.components` |
| `release` | the build id of the build that wrote the page |
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
- **Failures before the runtime loads.** The reporter loads with the islands
  runtime. If the page's entry chunk, the runtime chunk or the reporter itself
  fails to load, no reporter exists to call. For a page whose islands are all
  `idle` or `visible`, the runtime loads on the first trigger, so the same is
  true before that trigger fires.
- **A marker the runtime cannot read.** A hand-written or damaged
  `<fw-island>` is reported to the console by the runtime and not to the
  reporter, because it names no island the build registered.
- **Pages that never ran.** A reader whose browser does not run JavaScript
  sends nothing.

## Console behaviour

The reporter is called first. Then each error is logged as React logs it with
no reporter: a `recoverable` or `uncaught` error goes to `reportError`, which
logs it as an uncaught error, and a `caught` error goes to `console.error`. A
`module-load` error is rethrown, so the browser still logs the rejected import.

If the reporter throws, its error goes to `console.error` and is not reported,
so a broken reporter never calls itself. The island's own error is still
logged, and every other island still hydrates.

The reporter module is imported with the runtime, so an error thrown at its top
level, while the module loads, stops the runtime and every island on the page.
Keep the module's top level to declarations, and do the work inside the
function it exports.

## Match a report to its build

`release` is the build id: the `build.id` in the `manifest.json` that
`pagedeck build` writes, the name of the build's manifest in
`.pagedeck/manifests/`, and the name of the release directory that
[the deploy recipe](../deploy-recipe.md) prepares for a site with an app. To
investigate a report:

1. Take `release` from the report, and find the build with that id: the
   release directory `releases/<release>/`, or
   `.pagedeck/manifests/<release>.json`, which lists every file that build
   wrote.
2. Read the file names in the error's stack: each frame names a chunk under
   `/assets/`, with a line and a column.
3. Open that chunk in the release's `site/assets/`, at that line and column.
   The chunk name holds a content hash, so the file in the release is the file
   the browser ran.

The frames point at minified chunks, not at your source. A production build
emits no sourcemap ([ADR-0002](../adr/0002-no-production-sourcemaps.md)),
because a sourcemap holds the full source of every component it maps. Use
`component` and `kind` to find the island, and the minified code at the frame
to find the statement.

## What it costs

A site that does not declare `build.islandErrors` ships the same bytes as
before the field existed: no chunk, page or loader changes.

A site that declares it ships about 430 bytes Brotli of reporting code, plus
its own reporter module, loaded with the islands runtime. The
[JavaScript budget](../reference/javascript-budgets.md) of each page with an
island counts it.

The release id is written into each page's entry chunk. A new build has a new
id, so every build renames the entry chunks and changes the HTML of each page
with an island. The chunks the entries share, the runtime and the components,
keep their names from build to build, so a browser keeps them in its cache.
