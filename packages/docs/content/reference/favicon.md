---
section: reference
title: Favicon
description: Serve your own icon file at /favicon.ico in every output tree with build.favicon, and why the build adds no link tag for it.
---

# Favicon

`build.favicon` writes an icon file the site supplies to `/favicon.ico`, in
every output tree.

```ts
build: {
  outDir: "./site",
  favicon: { src: "./favicon.ico" },
  // ...
}
```

`src` is resolved against the config file, not against whatever directory `pagedeck`
was run from. A path that names no file refuses the build before a page is
rendered, naming the config and the path it resolved to.

**A site that declares no `favicon` gets exactly the build it got before the
field existed.** No file is written and no manifest row appears.

## Why the field exists at all

A browser asks for `/favicon.ico` on its own, on the first page of a session,
whether or not anything on the page mentions it. A site that answers with a 404
logs a console error on that page — which is a real entry in a user's console
and a failed `errors-in-console` audit in Lighthouse's best-practices category.
This is the field that answers.

## No `<link>` is added

Nothing goes into any page's `<head>`. The address is the one a browser requests
unasked, so writing the file is the whole of the fix, and an element pointing at
it would be a second spelling of the same address.

That also fixes the address: it is `/favicon.ico` and is not configurable. A
path a browser does not request would need a `<link>` to find, which is the
element this field exists without.

## The bytes are yours

The build writes the file you named, byte for byte. Nothing decodes it, resizes
it or converts it, so the format is your choice and what a browser draws is
exactly the file you exported. An `.ico` is what the address implies and what
every browser reads there.

Additional sizes, an SVG icon, an Apple touch icon and a web app manifest are
not emitted. One file at one address is the whole of what this field does.

## One copy per output tree

A browser asks the host that served the page, so a site whose locales sit on
[domains of their own](./canonicals-and-hreflang.md) gets the icon in each of
those trees rather than one copy somewhere. That is the opposite of a
[feed](./feeds.md), which is one file at your `origin`'s own address because a
`<link>` on every page points at it.

`origin` is **not** required, which is where this differs from a
[sitemap](./sitemaps.md) and a feed. Those hold absolute URLs and are refused
without one; an icon holds no URL at all.

A page of your own cannot be published at `/favicon.ico`: the build refuses the
collision rather than overwrite one file with the other, and the fix is to move
the page.

## Incremental builds

`pagedeck build --incremental` writes the icon on every run. The bytes are a file's,
so the run has already paid for reading them by the time it could have decided
to keep the old copy instead.
