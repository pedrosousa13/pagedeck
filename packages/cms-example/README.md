# @pagedeck/cms-example

A site built from a headless CMS, with the CMS included. Use it as the worked
answer to "how do I connect my CMS?". The CMS is a small local HTTP server, so
the example needs no account, no token and no network beyond `127.0.0.1`.

The package is private. Nothing installs it; you read it and copy from it.

## Run it

Build the workspace once with `pnpm build` from the repository root. Then, in
`packages/cms-example`:

```sh
node dist/serve.js &                # CMS serving at http://127.0.0.1:4310/
node ../core/dist/bin.js sync
node ../core/dist/bin.js build      # writes site/
```

The config reads the CMS's address from `PAGEDECK_CMS_EXAMPLE_URL` and falls
back to `http://127.0.0.1:4310/`. To serve on another port, pass it to the
script, as in `node dist/serve.js 4400`, and set the variable to match.

## What is here

| File | What it is |
| --- | --- |
| `data/pages/*.json` | The CMS's content: one file per page, named by the page's id. |
| `src/server.ts` | The CMS: a `node:http` server with no dependencies. |
| `src/serve.ts` | Starts the CMS and prints its address. |
| `src/loader.ts` | The loader. This is the file to copy for your own CMS. |
| `src/components/*.tsx` | One React component per block type. |
| `pagedeck.config.ts` | The site: the collection, its schema, the pages and the block-to-component mapping. |

There are three pages, each with a different set of blocks:

| Page | Route | Blocks | JavaScript |
| --- | --- | --- | --- |
| `home` | `/` | `hero`, `feature_grid`, `rich_text` | none |
| `faq` | `/faq/` | `hero`, `faq` | the `faq` island |
| `signup` | `/signup/` | `hero`, `signup_form` | the `signup_form` island |

## The CMS's API

The CMS answers two requests. Both return JSON with a `content-length`.

`GET /pages?page=N` lists every page, two to a response, sorted by id. `page`
starts at 1 and defaults to 1.

```json
{
  "pages": [{ "id": "faq", "revision": 1, "title": "Questions", "blocks": [] }],
  "nextPage": 2,
  "revision": 3
}
```

`nextPage` is `null` on the last response. `revision` is a counter for the
whole CMS: every edit and every removal adds one to it, and each page carries
the revision of its last edit.

`GET /changes?since=R` lists what changed after revision `R`: the pages edited
since, and the ids of the pages removed since. It is not paged.

```json
{
  "pages": [{ "id": "faq", "revision": 4, "title": "Questions", "blocks": [] }],
  "deleted": ["home"],
  "revision": 5
}
```

A block is an object with a `type` and the fields of that type, side by side:

```json
{ "type": "hero", "heading": "Sign up", "text": "Leave an address." }
```

The five types are `hero` (`heading`, `text`), `rich_text` (`paragraphs`, a
list of strings), `feature_grid` (`features`, a list of `title` and `text`),
`faq` (`questions`, a list of `question` and `answer`) and `signup_form`
(`label`, `button`, `confirmation`).

The server keeps the pages in memory. It reads `data/pages` once at start, and
`startCms` returns `put` and `remove` so the tests can edit a page the way an
editor would. The files do not change.

## The loader

`defineExampleCmsLoader` (`packages/cms-example/src/loader.ts`) implements the
contract in the docs page "Write a loader". It takes the CMS's address as
`endpoint` and the locale every page belongs to as `locale`, and it uses the
platform `fetch`.

- **Entry ids.** A page's `id` is the entry's `path`. The id is an identifier,
  not a URL: the site's config decides that `home` is served at `/`.
- **Full sync.** `syncAll` asks for the first page, then asks for whatever
  `nextPage` names, until it is `null`. It never counts pages itself, so the
  same loop works for a CMS that pages by an opaque token. It upserts every
  page and returns `authoritative: true`. The list names every page, so the
  framework removes any entry the list did not name. The cursor is the
  `revision` of the first response.
- **A list that moves.** If a later response carries another `revision`, the
  CMS changed during the walk. A removal can shift a page from one response to
  the one already read, and an authoritative sync would then delete it. So the
  sync fails and asks for another run.
- **A list that does not end.** The walk stops with an error after 1000
  responses (`MAXIMUM_PAGES`), so a CMS that never answers `nextPage: null`
  cannot keep a sync running.
- **A request that does not end.** Each request has a time limit, from
  sending it to the body's last byte, and each body a size cap. Past either,
  the sync fails, names the request and the limit, and says which option to
  raise. Both are options of `defineExampleCmsLoader`:

  | Option | Default | Why |
  | --- | --- | --- |
  | `timeoutMs` | `30000` | This CMS answers in under 30 ms on `127.0.0.1`. Without a limit, Node waits 300 s for the headers and has no limit at all on a body that arrives a byte at a time. |
  | `maximumBodyBytes` | `16777216` (16 MiB) | The CMS picks how many pages a response holds, so the loader cannot know what a response costs. This CMS's largest is 1858 B, so 16 MiB leaves room for a CMS that sends many large pages at once. On #728 a sync held about five times the body it read (976 MB for a 200 MB page, as measured), so a 16 MiB body costs a CI runner about 80 MiB. |

  The loader counts the body's bytes as they arrive and stops reading at the
  cap, so a body that never ends costs at most the cap in memory. The limits
  are checked when the config loads. A limit that is not a whole number, or a
  time limit above 2147483647 ms, which Node's timers cannot hold, is refused
  there. If your CMS is slow or sends large pages, raise the limit in the
  config. Do not remove it.
- **Where a request goes.** The loader builds every URL from the endpoint and
  follows no redirect, so every request stays on the host the endpoint names.
  A `3xx` fails the sync, and the error names the request and where the
  redirect led. A redirect on the same host fails too: it means the endpoint is
  not the API's root, so the fix is the endpoint, and refusing every redirect
  needs no hop count and no second pass of the time limit and size cap. An `http:` endpoint is refused when the config loads
  unless its host is `127.0.0.1`, `::1` or `localhost`, because a token sent
  over `http:` crosses the network in clear text. Use `https:` for a remote
  CMS.
- **Incremental sync.** `syncSince` sends the stored cursor as `since`, upserts
  the edited pages, reports the removed ids as `deleted`, and returns the new
  `revision` as the cursor.
- **A cursor ahead of the CMS.** This server counts revisions again from its
  files each time it starts, so after a restart the stored cursor can be ahead
  of the CMS. `changes?since=` would then answer nothing until the CMS passed
  the cursor, and the edits made before that would never be synced. So
  `syncSince` refuses a response whose `revision` is below the cursor and asks
  for a full `pagedeck sync`. Your CMS can do the same after a restore, a
  migration or a reset. Guard against it the same way.
- **What the loader checks.** The loader checks only the fields it uses: the
  list, `nextPage`, `revision`, each page's `id` and the `deleted` list. It
  passes `title` and `blocks` through unread, and the collection's schema in
  `pagedeck.config.ts` validates them. A bad block is then reported by page and
  field, as for any other schema failure.
- **Errors.** Each error about a request names it, as
  `CMS request "GET <url>"`, and says what to check. A refusal when the config
  loads names what it refuses instead: `CMS endpoint:` or
  `CMS loader options:`. The URL is printed as its scheme, host and path only,
  without a user name, password, query string or fragment, because any of them
  can carry a credential (`docs/error-messages.md`, rule 6). That covers the
  loader's own sentence only. `fetch` refuses a URL with a user name or
  password in an error that quotes the URL whole, and a cause is printed
  unredacted, so the loader refuses an endpoint with a user name or password
  when the config loads. Send the credential in a request header instead.

To connect your own CMS, keep the shape of `syncAll` and `syncSince` and change
the two requests and the fields they read.

## The site

`pagedeck.config.ts` declares one collection, `pages`. Its zod schema has one
object per block type, keyed on `type`. The `content` callback turns each block
into a tree node whose component is the block's `type` and whose props are the
other fields. A block type therefore names a registered component, and the
schema admits only the five that are registered.

`faq` and `signup_form` start with `"use client"`, so they are islands. A page
ships the code of the islands its blocks name, and no other. `signup_form`
sends nothing. Its button is disabled in the built HTML and enabled when the
island hydrates: the form has no `method`, so a submit before then would put
the address in the page URL as a query (#727). After hydration, a submit shows
the `confirmation` text and makes no request. A form backend is for each site
to choose.

Each component marks its root element with `data-block` and its type. The
build test looks for that attribute in a page's chunks to find out which
islands the page ships.

## Budgets

The limits in `pagedeck.config.ts` are measured. Each one is the measurement
plus about 16%, rounded to a whole kilobyte. If a limit starts to fail, measure
again and give the reason. Do not raise it to make the failure go away.

| Page | Limit | Measured | Made of |
| --- | --- | --- | --- |
| `/` | `0b` | 0 B (#694) | no chunks |
| `/faq/` | `60kb` (61440 B) | 53469 B (#95) | `fw-core` 52011 B, `fw-startup` 806 B, `faq` 417 B, entry 235 B |
| `/signup/` | `60kb` (61440 B) | 53602 B (#95) | `fw-core` 52011 B, `fw-startup` 806 B, `signup_form` 549 B, entry 236 B |

The whole build's JavaScript is held to 62 kB Brotli (63488 B), against 55160 B
measured on #95, each file compressed on its own.

## Tests

- `src/server.test.ts` and `src/loader.test.ts` run the CMS and the loader in
  the test process.
- `src/serve.test.ts` runs `dist/serve.js`.
- `src/site.build.test.ts` starts the CMS on a port the system picks, then runs
  `pagedeck sync` and `pagedeck build` in this directory. It checks the budget
  report for each page. It then edits the `faq` page in the CMS, runs an
  incremental sync and build, and checks that only `/faq` was written again.
  Last, it replaces the `faq` block with a `signup_form` block, runs an
  incremental sync and build again, and checks that `/faq` now ships the
  `signup_form` island and not the `faq` island, and that `/signup` was reused
  as it was.
