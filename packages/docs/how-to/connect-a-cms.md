---
section: how-to
title: Connect a CMS
description: Read pages from a headless CMS through a loader, map its block types to components, and keep its token out of the repo and the logs.
---

# Connect a CMS

Pagedeck ships no integration for any CMS. You connect yours by writing a
loader: one file that asks your CMS for its content and hands each entry to the
framework. This page walks through a working one.

The example is `packages/cms-example` in the Pagedeck repository. It is a site
whose three pages come from a small headless CMS that runs on `127.0.0.1`, so it
needs no account and no token. Every code sample below is copied from it, and
every file path is relative to it.

To run it, build the workspace once with `pnpm build` from the repository root.
Then, in `packages/cms-example`, from the example's `README.md`:

```sh
node dist/serve.js &                # CMS serving at http://127.0.0.1:4310/
node ../core/dist/bin.js sync
node ../core/dist/bin.js build      # writes site/
```

## The loader is the only seam

Core names no CMS. It reads a collection's entries from its store, and the only
code that writes them there is the collection's loader, during
`pagedeck sync`. `pagedeck build` never calls your CMS. So the loader is the one
file that knows your CMS's address, its API and its token, and the rest of the
site reads entries.

The example declares one collection, `pages`, in `pagedeck.config.ts`:

```ts
const pages = defineCollection({
  name: "pages",
  loader: defineExampleCmsLoader({
    endpoint: process.env["PAGEDECK_CMS_EXAMPLE_URL"] ?? "http://127.0.0.1:4310/",
    locale: "en",
  }),
  schema: z.object({ title: z.string(), blocks: z.array(block) }),
});
```

The loader lives in `src/loader.ts`. [Write a loader](./write-a-loader.md)
gives the contract it implements: `syncAll`, `syncSince`, and the writer each
one is handed. The sections below show how the example fills it in.

The example's CMS answers two requests. `GET /pages?page=N` lists every page,
two to a response, as in the example's `README.md`:

```json
{
  "pages": [{ "id": "faq", "revision": 1, "title": "Questions", "blocks": [] }],
  "nextPage": 2,
  "revision": 3
}
```

`GET /changes?since=R` lists the pages edited after revision `R` and the ids of
the pages removed since. `revision` counts every edit and removal in the whole
CMS. Your CMS answers different requests. Keep the shape of the two methods
below, and change the requests and the fields they read.

## Fetch everything with `syncAll`

`syncAll` reads every page. [Write `syncAll`](./write-a-loader.md#write-syncall)
gives its contract. In `src/loader.ts`:

```ts
    async syncAll(writer): Promise<SyncResult> {
      const changed: EntryId[] = [];
      let cursor: number | undefined;
      let next: number | null = 1;
      for (let requests = 1; next !== null; requests += 1) {
        const url: URL = new URL(`pages?page=${String(next)}`, root);
        const body: ListBody = await read<ListBody>(url, listFaults, limits);
        // The revision the walk started at: a page edited after it is synced again next time.
        cursor ??= body.revision;
        if (body.revision !== cursor) {
          throw new Error(
            `${quote(url)}: the CMS moved from revision ${String(cursor)} to ${String(body.revision)} while the list was read, so a page could have shifted past the loader and been pruned as deleted — run the sync again`,
          );
        }
        for (const { id, title, blocks } of body.pages) {
          writer.upsert({ ...idOf(id), data: { title, blocks } });
          changed.push(idOf(id));
        }
        next = body.nextPage;
        if (next !== null && requests === MAXIMUM_PAGES) {
          throw new Error(
            `${quote(url)}: the list still names a next page after ${String(MAXIMUM_PAGES)} pages, so the loader stops rather than follow a list that may never end — check that the CMS answers nextPage null on its last page`,
          );
        }
      }
      // The list holds every page, so a page it did not name is gone.
      return { changed, deleted: [], authoritative: true, cursor: cursor ?? 0 };
    },
```

Five things in it carry over to any CMS:

- **It follows `nextPage`.** The loop asks for whatever page the last response
  named, until the CMS answers `null`. It never counts pages itself, so the same
  loop works for a CMS that pages by an opaque token.
- **It stops after `MAXIMUM_PAGES` requests**, 1000 in the example. A CMS that
  never answers `null` fails the sync instead of keeping it running.
- **It bounds each request in time and in bytes.** `read` gives a request 30
  seconds, from sending it to the body's last byte, and stops reading a body
  past 16 MiB. A CMS that never answers, trickles its body, or sends a body
  that never ends fails the sync instead of holding the job or its memory.
  Change either in the loader's options, as `timeoutMs` and `maximumBodyBytes`,
  if your CMS is slower or its responses are larger.
- **It returns `authoritative: true`.** The list names every page, so the
  framework removes each stored entry the sync did not report.
  [Report deletions](./write-a-loader.md#report-deletions) explains why only
  `syncAll` may say this.
- **It fails when the revision moves during the walk.** A removal between two
  requests can shift a page into a response the loader has already read. The
  page would then be missing from the list, and an authoritative sync would
  delete it. The loader keeps the `revision` of the first response as its
  cursor and refuses a later response that carries another one.

## Fetch changes with `syncSince`

`pagedeck sync --incremental` calls `syncSince` with the cursor the last sync
stored. [Write `syncSince`](./write-a-loader.md#write-syncsince) gives its
contract. In `src/loader.ts`:

```ts
    async syncSince(writer, cursor): Promise<SyncResult> {
      const url = new URL(`changes?since=${String(cursor)}`, root);
      const body = await read<ChangesBody>(url, changesFaults, limits);
      if (body.revision < cursor) {
        throw new Error(
          `${quote(url)}: the CMS is at revision ${String(body.revision)}, behind the cursor ${String(cursor)} the last sync stored, so it would report no edit until it passed ${String(cursor)} and the edits before then would never be synced — run pagedeck sync without --incremental to read every page again`,
        );
      }
      for (const { id, title, blocks } of body.pages) {
        writer.upsert({ ...idOf(id), data: { title, blocks } });
      }
      return {
        changed: body.pages.map(({ id }) => idOf(id)),
        deleted: body.deleted.map(idOf),
        cursor: body.revision,
      };
    },
```

It upserts the edited pages and reports the removed ids as `deleted`, because a
delta names only what changed and cannot be authoritative.

The `if` before the loop is the guard to copy. A CMS restored from a backup,
migrated or reset can come back at an earlier revision than the cursor you
stored. Asked for changes since that cursor, it answers nothing until it passes
it again, and the edits it took before then are never synced. The example
refuses a revision behind the cursor and asks for a full `pagedeck sync`. If
your CMS has no revision counter, compare whatever it gives you instead, such
as the time of its last change.

## Keep entry ids stable

Both methods file a page under the same id, in `src/loader.ts`:

```ts
  const idOf = (id: string): EntryId => ({ locale: options.locale, path: id });
```

An entry id is a `locale` and a `path`, and the store files an entry under it.
A sync that writes one page under a new id stores a second entry, and the old
one stays until a full sync prunes it. So build the id from the field your CMS
never changes, its own page id, and not from a slug an editor can rename.
[Entry ids are identifiers, not paths](./write-a-loader.md#entry-ids-are-identifiers-not-paths)
lists the ids a sync refuses.

The id is not the URL. The site decides the route from the entry, in
`pagedeck.config.ts`:

```ts
      fromCollection(pages, { route: (entry) => (entry.path === "home" ? "/" : entry.path) }),
```

A site whose CMS holds a slug reads it from the entry's data in `route`.
[The route of an entry](../reference/site-config.md#the-route-of-an-entry) covers
the default.

## Map block types to components

A page in the example's CMS is a title and a list of typed blocks. A block is
an object with a `type` and that type's fields, as in the example's
`README.md`:

```json
{ "type": "hero", "heading": "Sign up", "text": "Leave an address." }
```

The site registers one component per block type, under the type's name, in
`pagedeck.config.ts`:

```ts
    components: {
      hero: "./src/components/hero.tsx",
      rich_text: "./src/components/rich_text.tsx",
      feature_grid: "./src/components/feature_grid.tsx",
      faq: "./src/components/faq.tsx",
      signup_form: "./src/components/signup_form.tsx",
    },
```

The `content` callback turns each block into a node of the page's tree. The
block's `type` names the component, and the other fields are its props, in
`pagedeck.config.ts`:

```ts
    // A block's type is the name of the component that renders it, and the schema admits
    // only the five registered here.
    content: (page, store) => ({
      tree: pageOf(page, store).blocks.map(({ type, ...props }) => ({ component: type, props })),
    }),
```

The build looks a node's `component` up in `build.components` and nowhere
else, so CMS content can pick a registered component and cannot import a
module. The schema's `type` literals admit only the five registered names, so
a block of any other type fails `pagedeck sync`, before the build.

`faq` and `signup_form` are islands. Each starts with `"use client"`, as in
`src/components/faq.tsx`:

```tsx
"use client";

import { useId, useState } from "react";
```

The other three render to HTML and ship no JavaScript. The build bundles an
island's code for each page whose tree names it, and for no other page. The
example's three pages hold different blocks:

| Page | Route | Blocks |
| --- | --- | --- |
| `home` | `/` | `hero`, `feature_grid`, `rich_text` |
| `faq` | `/faq/` | `hero`, `faq` |
| `signup` | `/signup/` | `hero`, `signup_form` |

The example sets a budget for each page, so every build writes a report. These
are its three rows, trimmed to the route, the Brotli bytes the page transfers
for first render, and its chunks, from `.pagedeck/budget-report.json`:

```json
[
  { "path": "/", "actual": 0, "chunks": [] },
  {
    "path": "/faq/",
    "actual": 53612,
    "chunks": [
      { "path": "/assets/fw-core-B79YWVHM.js", "bytes": 52092 },
      { "path": "/assets/fw-startup-KVlNJYe3.js", "bytes": 882 },
      { "path": "/assets/faq-CbDEtw-I.js", "bytes": 412 },
      { "path": "/assets/entry-e6828f0c5dee6c77-CxNTsRXv.js", "bytes": 226 }
    ]
  },
  {
    "path": "/signup/",
    "actual": 53756,
    "chunks": [
      { "path": "/assets/fw-core-B79YWVHM.js", "bytes": 52092 },
      { "path": "/assets/fw-startup-KVlNJYe3.js", "bytes": 882 },
      { "path": "/assets/signup_form-MO8HIG2D.js", "bytes": 556 },
      { "path": "/assets/entry-ef03ce2801a978ad-CRTZ6pq1.js", "bytes": 226 }
    ]
  }
]
```

`/` holds no island and ships nothing. `/faq/` ships the `faq` chunk and not
`signup_form`'s, and `/signup/` ships the reverse. Both pay for `fw-core`, which
holds React and the island runtime, and for `fw-startup`, which waits for each
island's trigger. Change a page's blocks in the CMS, and the next build changes
that page's chunks to match.
[JavaScript budgets](../reference/javascript-budgets.md) covers the report and how
to set a limit per page.

## Declare a schema, or `false`

The loader reads only the fields it needs: the list, `nextPage`, `revision`,
each page's `id`, and `deleted`. It hands `title` and `blocks` over unread,
typed as `unknown`. The collection's `schema` checks them, in
`pagedeck.config.ts`:

```ts
  schema: z.object({ title: z.string(), blocks: z.array(block) }),
```

`block` is a union with one object per block type, keyed on `type`. A page with
a bad block fails the sync, and the failure names the page and the field.

`schema` is required. Give it any Standard Schema, as here, or the literal
`false` to store what the loader hands over unchecked. For content an editor
types into a CMS, declare a schema. With `false`, nothing checks a block before
a component renders it.
[Declare a schema](./write-a-loader.md#declare-a-schema) covers the types on
each side.

## Drafts and published content

Pagedeck has no draft state. The store holds what the loader wrote, and
`fromCollection` makes a page of every entry in the collection whose `route`
returns a route. An entry whose `route` returns `undefined` gets no page. So a
draft your loader writes is a page on the next build, unless your `route`
leaves it out.

Keep drafts out at the loader. Ask your CMS for published content only, and
write nothing else. Most headless CMSes tell the two apart by a request
parameter or by a token that reads only published content. The example's CMS has
no drafts, so its loader does not filter.

Two features of the framework touch drafts:

- **Publication window.** A collection can name the fields that hold when an
  entry is published and unpublished, which makes it a scheduled collection.
  A build then makes a page only of the entries inside that window. See
  [Publication window](../reference/publication-window.md).
- **Previewing a draft.** `build.preview` emits an app that renders a draft
  your CMS's editor posts to it, through the site's components. It
  authenticates nothing, so read [Preview app](../reference/preview.md) before you
  declare it.

## Keep credentials out of the repo and the logs

The example's CMS takes no token, but it reads its address from the
environment, `PAGEDECK_CMS_EXAMPLE_URL`, as the config sample above shows. Do
the same with a token. A real CMS wants one, so add a file like this to your
loader, as `src/token.ts`:

```ts
// Read when the loader fetches, so a pagedeck verb that never syncs needs no token.
export function fetchFromCms(url: URL, signal: AbortSignal): Promise<Response> {
  const token = process.env["CMS_TOKEN"];
  if (token === undefined || token === "") {
    throw new Error(
      `CMS request "GET ${url.origin}${url.pathname}": CMS_TOKEN is not set — set it in the environment that runs pagedeck sync`,
    );
  }
  return fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal,
  });
}
```

`CMS_TOKEN` is this page's name for the variable, and yours is your choice.
Then call `fetchFromCms(url, AbortSignal.timeout(limits.timeoutMs))` where
`read` calls `fetch`, so the time limit still covers the request. Send the token
the way your CMS documents; a bearer token in the `authorization` header is the
common case.

Keep `redirect: "manual"`. The loader builds every URL it asks for from the
endpoint, so it follows no redirect: `read` fails the sync on any `3xx` and
names where the redirect led. A redirect to another host would otherwise send
the sync, and every header you add, to a host the endpoint never named. With
`fetch`'s default, `read` never sees the redirect, because `fetch` has already
followed it.

The loader also refuses an `http:` endpoint when the config loads, unless its
host is `127.0.0.1`, `::1` or `localhost`. Over `http:` the token crosses the
network in clear text, so a remote CMS needs `https:`.

Every error the example's loader throws names its request through `quote`,
which keeps the scheme, host and path and drops the rest. That redacts the
loader's own sentence, as rule 6 of the error-message standard asks, in
`src/loader.ts`:

```ts
// docs/error-messages.md, rule 6: scheme, host and path, and nothing else.
function quote(url: URL): string {
  return `CMS request "GET ${url.origin}${url.pathname}"`;
}
```

`quote` does not reach the cause. When a request fails before the CMS answers,
the loader attaches the error `fetch` threw, and `pagedeck` prints every cause
in the chain as it was thrown. Two things keep the endpoint's credentials out of
that cause:

- The loader resolves each request against the endpoint, as `pages?page=1` or
  `changes?since=3`, which replaces the endpoint's query string and drops its
  fragment. No request carries either.
- The loader refuses an endpoint with a user name or password when the config
  loads, and `pagedeck` exits with code 2. `fetch` refuses such a URL with an
  error that quotes it whole, password included. The refusal names neither,
  in `src/loader.ts`:

```ts
// `fetch` refuses a URL with userinfo in an error that quotes it whole (#726).
if (url.username !== "" || url.password !== "") {
  throw new Error(
    "CMS endpoint: carries a user name or password before its host — pass the endpoint without them, and send the credential in a request header such as authorization",
  );
}
```

So a CMS behind HTTP basic auth gets its credential in a header too: send
`authorization: Basic <user:password in base64>` from `fetchFromCms`, never in
the URL.

The rules:

- **Never in the repo.** Set the variable from your CI's secret store, or from
  an untracked file in your shell. Your code names the variable, never the
  value.
- **Never in a message.** The error in `src/token.ts` names the variable, not
  its value. `quote` drops the query string from the loader's own sentence, but
  not from a cause. Send the token in a header: a query string also lands in
  your CMS's access logs and in any proxy between, and no message of yours can
  redact those.
- **Never on the command line.** A process's arguments are readable by other
  users on a shared machine, and CI echoes the line it runs. Read the variable
  inside the loader rather than passing its value as an argument.
  [Rule 6 of the error-message standard](../error-messages.md#6-redact-anything-that-could-be-a-credential)
  gives the reasoning.
