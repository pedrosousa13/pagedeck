---
description: The store refuses an unusable entry id when a sync writes it, so every read can trust the ids it gets back without checking them again.
---

# 4. The entry-id contract holds on write

Date: 2026-08-25

## Status

Accepted. Implemented by #142 for `syncCollection` and `syncCollectionSince`,
and by #141 for the percent-encoded and URL-parser spellings of the traits it
refuses. Binding
on any later loader-facing write surface.

## Context

An `EntryId` is a key, not a path. A loader is free to build a file path or a
URL out of its `locale` and `path` — that is what `fetchOne` is for — so an id
holding a `..`, a leading `/`, a backslash or a NUL is one that resolves away
structure and reads outside the loader's own content. #112 refused such an id at
`getEntryCached`, before the store is read, because that is the call that hands
an id to a loader.

Nothing else asked. A loader could sync an entry keyed `/en/../secret`, the
store filed it, `getEntry` and `listEntries` returned it, `EntryOrigin.entry`
carried it into the route table, and `getEntryCached` refused the same id. So
the framework held two answers to one question and picked between them by call
site. That is worse than either answer on its own: a site reading through the
store-first path watches an entry vanish that a direct read still returns, and
no message explains why, because neither door is wrong about anything it can
see.

## Decision

**An entry id is refused where it enters the store, not where it is read
back.** `runSync` reads every buffered upsert's id before the replay
transaction opens, and a sync that carries an unusable one writes nothing.
The buffer it reads is closed first — `runSync` takes the rows out of the array
`CollectionWriter.upsert` appends to as soon as the loader returns. A loader
that kept the writer past its own return would otherwise grow that array while
the schema awaits, and the replay would apply a row the id pass never saw: the
same hole, one step further in. What a sync applies is what the loader had
buffered when it reported back, which is what `SyncResult.changed` already
claims.
Every read may then take a stored id as given: the guarantee is established
once, on the way in, so `getEntry`, `listEntries` and `EntryOrigin.entry` need
no check and gain none.

**One predicate, `unusableIdReason` in `packages/content/src/collection.ts`.**
It answers why an id is not an identifier, or undefined when it is. Both doors
read it and neither restates it, so they cannot drift about what "usable"
means — the same sharing ADR-0003 records for `MALFORMED_ESCAPE`, and the same
reason: a fault detected by one reading and admitted by another is a fault with
no report anywhere.

**A verdict, not a throw.** The refusal is not thrown from
`CollectionWriter.upsert`. `upsert` returns nothing and is handed one row at a
time, so a throw there reveals a batch's second bad id on the next run and its
third on the run after that. `refuseUnusableIds` sits where the whole buffer is
visible and names every offending row at once, under rule 5 of
`docs/error-messages.md`, in the shape the schema failure already uses:

```
Collection "pages": 2 entries do not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:
  /en/../secret: its path holds a ".."
  /../x/a\b: its locale holds a "..", its path holds a backslash
```

**One bad id fails the whole sync.** Not the bad rows alone. A sync commits its
entries and its cursor in one transaction so that a failed run leaves no
collection half-written, and storing the well-keyed rows would advance the
cursor past the refused ones — the loader would never offer them again, and the
collection would be quietly short of entries nobody was told about. `SyncResult`
therefore gains no per-row error channel: a sync that returns has applied
everything it buffered, which is what `changed` already claims.

**Ids are read before the schema, and `schema: false` does not waive them.**
That declaration waives what an entry *contains*; an id is not content, it is
the key the content is filed under. A schema report about a row the run is about
to refuse would send a reader to fix content stored under a key that will not
exist.

**A delete takes any id.** It files nothing under one, and a store written
before this contract existed may hold a row that only a delete can be rid of.
Refusing one would strand it.

**`getEntryCached` keeps its own check, and it is not redundant.** The two doors
read different ids. The write pass reads the id a *loader reports back*, on its
way into the store. `getEntryCached` reads the id a *caller hands in*, on its
way out to `fetchOne` — an id that was never in the store and that no write
pass has seen, because the call is what happens when the store does not hold
it. Deleting either check reopens the hole the other cannot see: without the
write pass, a loader files an unusable key and every read serves it; without
`getEntryCached`'s, a site deriving an id from CMS content walks it straight
into a loader's file open. That is #112, and it is the door #112 was about.

**A plain `Error`, exit 1, at both doors.** Rule 7 classifies by whose fault it
is. A `route` callback holding a dot segment is a `ConfigError` at exit 2
because it is the site's own wiring, authored once and identical on every retry.
An entry id need be authored nowhere: it is whatever a CMS export put in the
row, or whatever the caller had in hand, and the next one may be fine. There is
nothing in the site to edit, so exit 2 would be a lie to CI.

**Refused, not normalized.** #112 settled it and this does not reopen it: an id
is a key, and rewriting one stores the entry under a key nobody asked for, then
renders it as if somebody had.

## Consequences

`packages/content/src/collection.test.ts` no longer pins the read/write
asymmetry as deliberate. It gains a test that syncs `/en/../secret`, watches the
sync refuse it, and finds the store empty afterwards.

The test that stores `/en/../secret` through `store.upsertEntry` and watches
`getEntryCached` refuse it stays, and it is not about the asymmetry. It is the
only thing pinning that the refusal comes *before* the store read: a store hit
returns early, so a check moved after it would exempt exactly the ids a store
written before this contract already holds — the rows the delete ruling above
says exist. Both tests are needed, because they cover the two sides of the store
read.

A loader that keys entries the way a filesystem does now fails its sync rather
than filling a store. That is the intended cost, and it surfaces at the first
sync rather than at whichever read happened to go through `getEntryCached`.

#141 added the percent-encoded spellings — `%2E%2E` and the rest — to
`refusedFieldReasons`, the one function `unusableIdReason` is built from. Both
doors took them without being touched, which is what the sharing above is for.
A field is read in every spelling, because no reading covers another: a loader
that builds a URL decodes before it joins, one that does not is handed the
literal `%2e%2e` to open a file by, and the URL parser drops characters out of
either before it resolves anything — every ASCII tab, LF and CR wherever they
sit, and the leading and trailing C0 controls and spaces. So `.%09./secret`
holds a `..` for a URL-building loader and `%09/etc/passwd` a leading `/`,
neither of which the raw or decoded spelling can see; `urlParserReading` is that
third spelling, and it is a spelling rather than a trait because a tab is not
what a reader has to fix — the path that climbs is.

**A `%` that no two hex digits follow is not a fault.** It was one briefly, and
that refused every id named with a literal percent — `sale-50%-off`,
`50%-off.md` — which a loader keying entries by slug or by filename hands over
as a matter of course, and which never decodes for it at all. Decoding is
escape by escape, so an escape that will not decode is left as written and the
field around it is still read: the traversals are refused with none of the
collateral, and no id is required to be valid percent-encoding. `URIError` is
still not let out of this depth — nothing throws it any more.

The store's own methods (`packages/content/src/store.ts`) still take bare
strings and check nothing. The contract is stated at the collection API, which
is the surface a loader and a site are given; the store is the layer underneath
it, and a test that writes a row through `store.upsertEntry` directly is writing
below the contract on purpose.

## Alternatives considered

**Validate on every read** — `getEntry` and `listEntries` refuse an id too.
Rejected. It leaves rows in the store that nothing can read: the id is already
filed, the sync that filed it reported success, and every read now fails on a
row no operation can remove or correct. It also puts the check on the hot path,
once per read, to re-derive a fact one pass on the way in establishes for good.

**Keep the asymmetry and document it.** Rejected. Documenting a contract that
disagrees with itself by call site does not make it one contract; it writes down
which door a reader has to guess at. The failure it produces — an entry present
to one read and absent from another — is not one a docblock rescues anybody
from at 2am.

**Refuse per row and store the rest.** Rejected, above: the cursor advances past
what was dropped, so the loss is silent and permanent.

**Throw from `CollectionWriter.upsert`.** Rejected. It is the level that sees
one row, so it reports one fault per run — rule 5's "put the collection at the
level that can see the whole set".
