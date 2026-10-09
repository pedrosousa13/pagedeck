---
section: reference
title: Publication Window
description: Name the fields holding when an entry is published and unpublished, and how a build uses that half-open window to choose which entries are pages.
---

# Publication Window

A collection can name the fields of its entries that hold the instants an entry
starts and stops being a page. `publishField` names the first, `unpublishField`
the second, and a build collects only the entries inside the window they
describe.

```ts
defineCollection({
  name: "articles",
  loader: articleLoader,
  schema: articleSchema,
  // The fields of the entry's own data. Dotted for nesting: "meta.publish_at".
  publishField: "publishAt",
  unpublishField: "unpublishAt",
});
```

**A collection that declares neither field is untouched.** It is unscheduled,
every entry of it is a page, and it collects exactly as it did before either
field existed — no query changes, no bytes move, and nothing about the feature
is paid for. That is the whole of the opt-in: there is no site-level switch to
turn on beside it.

**Either field alone is a whole declaration.** A collection that schedules only
its starts declares `publishField`, one that schedules only its ends declares
`unpublishField`, and the query drops the clause it was not given. Both make
the collection scheduled.

## What the fields hold

An ISO-8601 timestamp in UTC, as text:

```json
{ "title": "Release notes", "publishAt": "2026-09-01T09:00:00Z" }
```

**UTC, and this matters.** The instants are compared as text, so they have to
be written in a format that sorts chronologically. `2026-09-01T09:00:00Z` does;
`2026-09-01T09:00:00+02:00` sorts wrong against it.

A field that is **absent or null is no bound at that end**, not a missing
value. An entry with no publish time is already published; an entry with no
unpublish time never expires. Most entries of a scheduled collection carry
neither, and they are all pages.

The field is a name and not a callback because the selection happens in SQL: an
entry outside its window is never loaded, let alone routed and then dropped.
Scheduling costs no extra column, no extra table and no migration — the
timestamps are read out of the JSON your loader already stored.

## The window is half-open

In at `publishField`, out at `unpublishField`. An entry publishing at exactly
the build's instant is in; an entry unpublishing at exactly the build's instant
is out.

That is what lets one entry hand over to the next at a **single written
instant**. Give an entry an `unpublishAt` and its successor the same value as
its `publishAt`, and there is no moment in which both are live and no moment in
which neither is:

```json
[
  { "path": "banner-summer", "unpublishAt": "2026-09-01T00:00:00Z" },
  { "path": "banner-autumn", "publishAt": "2026-09-01T00:00:00Z" }
]
```

Write the two ends the other way round — closed at both — and the changeover is
either a duplicate or a gap depending on which side you rounded.

## The build's instant

A build has one instant, and it is the `createdAt` of the build stamp it was
handed. Nothing in the collection pass reads a clock of its own.

So **two builds of one commit agree**: build the same site twice from the same
stamp and you get the same pages, which is what makes the output comparable at
all. The dev server passes the moment the request arrived instead, which is the
instant a preview is asking about.

A scheduled collection collected with **no** instant is refused rather than
published wholesale — the message names the collection and the field it is
scheduled by. Publishing everything would be a site shipping drafts because a
caller forgot an argument.

## What ships today

**The exclusion, and that is all of it.** A build collects the entries inside
their window and leaves the rest out. Deciding _when_ to run a build so that an
entry appears at the hour you scheduled it for is your scheduler's concern, not
the framework's — nothing here polls, wakes up, or triggers anything.

In practice that means an entry becomes a page on the first build that starts
after its `publishAt`, and stops being one on the first build that starts at or
after its `unpublishAt`. Between those builds the site says what the last build
said.
