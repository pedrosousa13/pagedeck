# Stopping an inlined page's refetch of island CSS

On a page whose stylesheets `criticalCss` inlines, a hydrating island can still
download a sheet the page already carries: the bundler's preload helper adds a
`<link rel="stylesheet">` for a dynamically imported chunk's CSS unless the
document already has a link with that `href`. An inlined page has `<style>`, not
a link. The critical-CSS reference page documents this as a trade-off, and it
stays one.

## Why this is out of scope

The one approach that needed nothing but markup was to give an inlined page a
`<link rel="stylesheet" href="…" disabled>` for each sheet it inlined. The
helper (Vite 8.2.2) skips a dependency when
`link.href === dep && (!isCss || link.rel === "stylesheet")`, so it never
checks `disabled`, and a disabled link with the same `href` would satisfy it.

It was tested in three browsers. The page carried the sheet inline plus the
disabled link, it ran the helper copied from a real build, its policy was
`style-src 'self'`, and requests were counted on the server:

| Browser | Request for the sheet | Helper skips it |
| --- | --- | --- |
| Chromium 151 | 1, at page load | yes |
| Firefox 153 | 0 | yes |
| WebKit 26.5 | 0 | yes |

Chromium's preload scanner fetches a disabled stylesheet link straight from the
HTML. It never applies the sheet, but the request is made, so the count is the
same as today's refetch.

The ways around Chromium cost more than the request they save. One is a script
that adds the links after parsing, which needs a pinned CSP hash on every site
that inlines CSS. Another is a hook on the helper's dependency list
(`build.modulePreload.resolveDependencies`), which runs per chunk, while
chunks are shared between pages that inline and pages that link. The saving is
one late request on pages that are mostly content, after first paint, with no
visual change.

## Prior requests

- #98: "Don't fetch a stylesheet again after its page inlined it"
