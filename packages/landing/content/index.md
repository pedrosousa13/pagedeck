---
title: Zero JavaScript until a page needs it
description: A React framework for CMS-driven sites. Each page ships only what it uses.
cta: Build your first site
ctaHref: https://docs.pagedeck.example/tutorials/your-first-site
islandCta: See what one island costs
rulerTitle: JavaScript on a page with nothing interactive
---

# Zero JavaScript until a page needs it

| Framework | JavaScript | Note |
| --- | --- | --- |
| Next.js App Router | 133.1 kB | |
| Astro | 0 B | |
| Pagedeck | 0 B | One byte more fails the build. |

## Same React. No floor.

| Compared on | Next.js App Router | Astro | Pagedeck |
| --- | --- | --- | --- |
| Page data in the HTML | 11.1 kB flight payload on 6.0 kB of markup | Island props only | Island props only |
| Marking a component interactive | `"use client"`, once per component | A `client:*` directive at every use | `"use client"`, once per component |
| Per-page JavaScript budgets | Bundle size reporting removed in 16.0 | Not built in | Enforced by the build |
| Rebuilding a static site after one edit | Every route, every time | Pages with a hand-written `cacheKey` skip rendering (experimental) | Only the pages the edit touched |
| Deploying only changed files | Every HTML file changes on each build | With an external diff tool: the output is byte-stable | Built in: `pagedeck diff` uploads only the files that changed |
| Rendering on request | Yes | Yes | No: static files only |

## Your CMS data stays on the server.

**67.1 kB** read → **2.3 kB** sent

[See it on /server-data](/server-data)

### `server_data_page.tsx`

```tsx
const product = PRODUCT;
// …the whole entry, rendered as HTML
<VariantPicker {...picker} />
```

### `variant_picker.tsx`

```tsx
"use client";
// …the one component on the page that ships JavaScript
const [cart, setCart] = useState<readonly string[]>([]);
```

## Early, not on npm yet.

Build it from a clone, or [see every feature running](/features).

[Build your first site](https://docs.pagedeck.example/tutorials/your-first-site)

## Sources

1. Pagedeck's 0 B: this page's `build.budget` in
   `packages/landing/src/site.ts`.
2. Next.js 16.3.2, as a static export: 133.1 kB gzip (452.5 kB before
   compression), 11.1 kB and 6.0 kB measured on a two-route project, which a
   real site adds to, and every route rebuilt measured on 5,003 routes.
   `docs/research/2026-08-23-app-router-static-export.md`.
3. Astro 7.2: `docs/research/2026-08-23-build-vs-adopt.md` and
   `docs/research/2026-08-23-astro-incremental-builds.md`.
4. Rendering on request: the research measured Next.js as a static export,
   with its server set aside; Next.js renders on request when it runs as a
   server. Astro's on-demand (SSR) routes are named in its research above.
5. Pagedeck's rebuilds and deploys: `pagedeck build --incremental` re-renders
   the pages an edit touched (`docs/specs/2026-08-23-framework-design.md`,
   section 11); a one-page edit's incremental deploy published 1 file
   (`docs/success-criteria.md`, criterion 4).
6. 67.1 kB and 2.3 kB: measured on [/server-data](/server-data), whose entry
   is generated in code in the shape of a CMS entry.
