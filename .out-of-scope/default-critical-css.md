# Inlining stylesheets by default

A build does not inline a page's stylesheets on its own, below a size
threshold or otherwise. `criticalCss` inlines a page's reachable CSS only for
the pages the site names.

## Why this is out of scope

A linked stylesheet is cached once for the whole site. The core tier's sheet in
particular is fetched on the first page and reused on every page after it. An
inlined sheet is sent again inside every page's HTML. Inlining by default would
spend that site-wide cache entry on every repeat visit, for every site, without
the site choosing it. The standing decision "A flagged page inlines its whole
reachable CSS, core tier included" (CONTEXT.md) keeps the feature opt-in per
page for this reason, and asks the next inlining feature whose cache it spends.

A default would also spread the island-CSS refetch in
`inlined-css-refetch.md` to every island page.

A site that wants every page inlined already can:

```ts
build: {
  criticalCss: { "/**": true },
}
```

That map removed every render-blocking request on the site that asked for this.

## Prior requests

- #78: "Inline small stylesheets to remove render-blocking requests"
