---
section: reference
title: Global CSS
description: Stylesheets listed in build.css share one core-tier sheet every page links, though a site that hydrates no island gets a warning and no sheet.
---

# Global CSS

A global stylesheet is one every page of the site links. Declare them in the
`build` section of `pagedeck.config.ts`, as paths relative to the config file:

```ts
build: {
  outDir: "./site",
  css: ["./styles/global.css"],
  // ...
}
```

`pagedeck build` puts every declared stylesheet in the **core tier** — the one
stylesheet the whole site shares and caches under one URL — and links that sheet
from every page, including a page that renders no components at all.

The field is optional. A site that declares no `css` behaves as it did before:
every rule reaches a page through a component's own `import`, and a page that
mounts no component links no stylesheet.

## One limit: a site with no islands at all

A declared stylesheet is compiled by the same bundler run that builds the
site's JavaScript, and that run is started by the page entries the build
generates. A site where **no page hydrates a single component** has no entry, so
nothing compiles the stylesheet and no page links it.

The build says so rather than emitting the pages silently:

```
Global CSS: 1 declared stylesheet is not in this build, so no page links it — a declared stylesheet reaches the bundler through a page's generated entry module, and this site hydrates no island on any page, so there is no entry module to import it from; this is a warning and not a refusal because every page this build emitted is otherwise correct, and the sheets compile as soon as one page mounts one interactive component — island a component anywhere on the site, or drop the declaration until the site has one:
  "./styles/global.css"
```

It is a warning and not an error: the pages are correct HTML, and one
interactive component anywhere on the site is enough to make the sheet arrive
everywhere. A site with at least one island is unaffected, and a page of it that
renders no component still links the sheet — which is the ordinary case above.

## Why global means core-tier

Those are one claim, not two. A page's stylesheets are ranked by how many pages
share them — see "CSS tiers" below — and "shared by every page" is
what the core tier is. A stylesheet the site calls global and the build then left
in a narrower tier would be a sheet one page downloads while the rest of the site
renders class names with no rules behind them.

So the declaration is the whole of the mechanism. `pagedeck build` never opens these
files: it does not care whether they hold rules somebody typed, a preprocessor's
output, or a utility layer a plugin generated. It pins the path.

## The framework has no opinion about your CSS

There is no built-in support for any CSS toolkit, and no toolkit is named
anywhere in the framework. A toolkit is a Vite plugin, and a site passes its own
Vite plugins through `build.vite.plugins`:

```ts
import someToolkit from "some-css-toolkit/vite";

export default defineConfig({
  // ...
  build: {
    outDir: "./site",
    css: ["./styles/global.css"],
    vite: { plugins: [someToolkit()] },
    // ...
  },
});
```

The toolkit is the site's dependency, at the version the site chose. Its plugin
compiles `./styles/global.css`; the framework pins the result to the core tier
because the site said the sheet is global. Nothing about the arrangement is
specific to any one toolkit — the plain-CSS example above uses the same key and
gets the same treatment.

### What `vite.plugins` accepts

Anything Vite's own `plugins` array accepts: a plugin, an array of plugins (which
is what most factories return, so the plain call works), `false` to switch one
off, or a promise of any of those.

`build.vite` is scoped to `plugins` and is not a general Vite config merge. The
build pins its own `mode`, `define`, JSX transform and output filenames, and each
of those pins closes a real defect — a config merge would hand them all back.

**Determinism becomes your responsibility inside this array.** Two builds of one
site must emit byte-identical output. A plugin that writes a timestamp, a random
id or a build-machine path into its output breaks that, and no type can stop it.
Check it with:

```
pnpm check:build-twice
```

which builds the site as two separate processes and compares the trees.

## CSS tiers

Every page links its stylesheets widest-shared first:

1. the core sheet — the whole site's shared rules, and every declared global
   stylesheet,
2. the mid sheet, for components several pages share,
3. the page's own sheet, for components only it renders.

A narrower sheet comes later, so it can override a wider one at equal
specificity. A page links only the tiers it actually reaches — plus the global
sheet, which every page reaches by definition.

## What is refused

A `css` entry that is not a usable path, and a `vite.plugins` entry that is not a
plugin, are refused when the config loads, before anything is rendered:

```
Config "/site/pagedeck.config.ts": "build.css" declares 1 entry that is not a stylesheet path — write each as a path to a stylesheet, relative to this config file:
  css[1] — not a string
```

```
Config "/site/pagedeck.config.ts": "build.vite.plugins" declares 1 entry that is not a Vite plugin — pass what a plugin factory returns, not the factory itself — call the factory, as plugins: [somePlugin()]:
  plugins[0] — not a plugin object
```

The second is the mistake worth naming: `plugins: [someToolkit]` reads fine and
passes the factory itself. Call it.
