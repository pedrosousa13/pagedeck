---
section: tutorial
title: Your first site
description: Create a site with npm create pagedeck, edit and add pages under pagedeck dev, then build it into static files.
---

# Your first site

This page takes you from an empty directory to a built static site. You create
the site with `npm create pagedeck`, change a page while the dev server runs,
add a page of your own, and build the result. At the end, three of the four
pages ship no JavaScript, and one ships a single island.

Pagedeck needs Node 22.18 or later. On Node 23, it needs 23.7 or later.

## 1. Create the site

```sh
npm create pagedeck@latest my-site
```

This writes a new site into `my-site`, which must not exist yet or must be
empty. The site has a config, three markdown pages in `content/`, a layout
component and a counter component in `components/`, an icon, `favicon.ico`,
and a `package.json` that depends on the Pagedeck packages and React.
`npm create pagedeck` then prints the next steps, which the rest of this page
follows.

Pass `--host vercel`, `--host cloudflare-pages` or `--host netlify` to also set
the site up to deploy there — [Deploy a site](../how-to/deploy-a-site.md) covers
each host's build settings. This tutorial leaves it at the default,
`--host none`. On a terminal, leaving out the directory or the host prompts
for it instead of failing or defaulting silently.

## 2. Install and sync

```sh
cd my-site
npm install
npx pagedeck sync
```

`pagedeck sync` reads every page in `content/` and writes it into the content
store, `content.db`. It prints one line per collection,
`pages: 3 changed, 0 deleted, cursor <n>`. Every other verb reads the store and never reads
`content/` directly, so run a sync before anything else.

## 3. Read the config

The starter's config is `pagedeck.config.ts`:

```ts
import { defineCollection } from "@pagedeck/content";
import { defineMarkdownLoader } from "@pagedeck/markdown-loader";
import { defineConfig, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";

const pages = defineCollection({
  name: "pages",
  loader: defineMarkdownLoader({ root: "./content", locale: "en", languages: ["ts"] }),
  schema: false,
});

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "layout" })],
    components: {
      layout: "./components/layout.tsx",
      counter: "./components/counter.tsx",
    },
    favicon: { src: "./favicon.ico" },
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
  },
});
```

A collection names a set of entries and the loader that fills it. The loader
is the only code that reads your content source, and everything after a sync
reads the store it wrote. Here it is the markdown loader, which reads one entry per `.md` file under `./content`. A CMS
or an API you already have would take a loader of its own.

`schema` has no default, and that is deliberate. It is either a schema that
every entry must satisfy or the literal `false`, which means "store what the
loader hands over, unchecked". No third option skips validation because nobody
thought about it.

A collection in the store is not yet a site. `fromCollection` makes each entry
a page. It has no `route` here, so each entry routes at its own path, and
`content/about.md` becomes `/about/`. An entry named `index` routes at its
directory, so `content/index.md` is the home page at `/`. Write a `route` when
the URL is not the path, such as a date prefix.

The config leaves four settings at their defaults. The store is `./content.db`
and the build writes to `./site`, both beside the config file. The site has one
locale, `en`, written left to right, and its routes carry a trailing slash. The
[site config reference](../reference/site-config.md) lists each default and how to
override it.

`layout: "layout"` renders every entry into the component registered as
`layout`. The config names each component by its whole file name, `.tsx`
included, because Pagedeck does not guess extensions. It compiles `.tsx` and
`.jsx` as it loads them, so a component needs no build step of its own. The
layout is `components/layout.tsx`:

```tsx
import type { ReactNode } from "react";

interface Props {
  title: string;
  html: string;
  children?: ReactNode;
}

export default function Layout({ title, html, children }: Props) {
  return (
    <>
      <title>{title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <article>
        <h1>{title}</h1>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {children}
      </article>
    </>
  );
}
```

The markdown loader takes each page's title from a `title` in its frontmatter,
or else from its first `#` heading. It renders the rest of the body as `html`.
The layout gets both as props. `children` holds the components a page names in
its frontmatter, which the last section comes back to.

`routing.headers` spreads `SECURITY_HEADERS` into a rule over `/`, so every
page this site builds ships those three headers.

`favicon` writes `favicon.ico` to `/favicon.ico` in the built site, the address
a browser requests for a site's icon. Replace the file with your own icon;
[Favicon](../reference/favicon.md) covers the setting.

## 4. Start the dev server

```sh
npx pagedeck dev
```

It prints the address it serves, `http://127.0.0.1:5173`. Open it. The home
page links to the other two, `/about/` and `/counter/`. The server renders each
page from the store when you request it, and runs until you stop it with
`Ctrl-C`.

## 5. Edit a page

The dev server reads the store, so an edit to `content/` shows only after a
sync. Leave the dev server running, open a second terminal in `my-site`, and
start a sync that runs again five seconds after each sync ends:

```sh
npx pagedeck sync --watch
```

Open `content/about.md`, change its first line from `# About` to
`# About this site`, and save it. `pagedeck sync --watch` reads the edit on its
next sync, five seconds after the last one ended. Reload `/about/` in the browser, and the new heading is there. The browser does
not reload by itself after a content edit.

## 6. Add a page

Every `.md` file under `content/` is a page. Save this as `content/hello.md`:

```
# Hello

This page was added by hand, and it ships no JavaScript either.

[Back home](/)
```

`pagedeck sync --watch` picks the file up on its next sync. Open `/hello/`. Its route comes
from its file name, as step 3 described, and the layout renders it like the
other pages.

## 7. Build

Stop `pagedeck sync --watch` and `pagedeck dev` with `Ctrl-C` in each
terminal, then build:

```sh
npx pagedeck build
```

`pagedeck build` reads the store, renders every page, bundles the JavaScript
the islands need, and writes the finished site to `site/`. It does not read
`content/`, so a build never depends on your content source being reachable. That is why sync and build are separate verbs.

## What you have

`site/` holds four pages. Three of them, `/`, `/about/` and `/hello/`, are plain
HTML with no `<script>` tag. Open `site/about/index.html` to check.

`/counter/` is the one page with a `<script>` tag. It loads the counter and the
React code that runs it. Its page is `content/counter.md`:

```
---
components: [counter]
---

# Counter

The `components` line at the top of this file puts `components/counter.tsx`
below this text. Its first line, `"use client"`, makes it an island: this page
loads its JavaScript, and no other page does.

[Back home](/)
```

Each name in the `components` list is a key of `build.components` in the
config, and the layout renders it as a child. The counter is an island because
`components/counter.tsx` starts with `"use client"`. The build bundles an
island's JavaScript for the pages that name it and for no other page, which is
why adding `/hello/` cost nothing. A
[JavaScript budget](../reference/javascript-budgets.md) keeps it that way, by
failing the build when a page ships more than you allow.
[Add an island and hold it to a budget](../how-to/add-an-island.md) sets one up.

## What happens next

- [Add an island and hold it to a budget](../how-to/add-an-island.md) writes an
  island of your own, chooses when it hydrates, and reads what each page ships.
- [Site config](../reference/site-config.md) covers layouts, frontmatter
  components, routes and every default this page relied on.
- [The pagedeck command](../reference/cli.md) lists each verb and its flags,
  including `pagedeck sync --incremental`, which reads only what changed.
- [Write a loader](../how-to/write-a-loader.md) points the framework at a content
  source of your own.
- [Connect a CMS](../how-to/connect-a-cms.md) walks through a site whose pages
  come from a headless CMS, from the loader to the JavaScript each page ships.
- [Deploy a site](../how-to/deploy-a-site.md) uploads `site/` to a host, then
  only what changed, and keeps the content store between CI runs.
- [Why this site ships no JavaScript](../explanation/why-this-site-ships-no-javascript.md)
  explains where a script tag comes from.
