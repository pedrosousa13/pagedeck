# Pagedeck site

```sh
npm install
npx pagedeck sync    # read content/ into content.db
npx pagedeck dev     # serve the site while you edit it
npx pagedeck build   # write the finished site to site/
```

- `pagedeck.config.ts` declares the content, the pages and the components.
- `content/` holds one Markdown file per page.
- `components/layout.tsx` renders every page. `components/counter.tsx` is an
  island: it starts with `"use client"`, so its JavaScript ships to `/counter`
  and to no other page. `content/counter.md` puts it on that page with
  `components: [counter]` in its frontmatter.
- `build.routing` spreads `SECURITY_HEADERS` into a rule over `/`, so every
  page ships those three headers.
- `favicon.ico` is the site's icon. `build.favicon` writes it to
  `/favicon.ico`; replace the file with your own icon.

## The app beside the site

`app/index.ts` is a [Hono](https://hono.dev) app that answers every request
under `/api/`. Pagedeck never imports or runs it: `build.routing.upstreams` in
`pagedeck.config.ts` names the prefix, and `pagedeck dev` forwards it to the
app. Run the app in a second terminal while you develop:

```sh
npm run dev:app      # serve app/ on http://127.0.0.1:8787
npx pagedeck dev     # serve the site, with /api/ forwarded to the app
```

`components/hello.tsx` is the island on `/hello`. It calls `/api/hello` and
imports only the app's type, with `import type`, so none of the app's code
reaches the browser. `pagedeck build` refuses an island that imports a value
from `app/`.

The app deploys beside the pages, on the same origin, and each host runs it
its own way.
[Run an app beside the site](https://pagedeck-docs.pedrodsousa.workers.dev/how-to/run-an-app-beside-the-site/)
covers deploying it with each host's adapter.
