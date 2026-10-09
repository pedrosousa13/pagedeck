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
