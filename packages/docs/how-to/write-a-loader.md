---
section: how-to
title: Write a loader
description: Write a loader that fills a collection from your own content source, with full and incremental syncs, deletions, entry ids and a schema.
---

# Write a loader

A loader is the framework's whole interface to wherever your content lives. If
you can list your content and detect what changed in it, you can write one.

## The contract

A loader implements two methods, and may implement a third.

```ts
interface Loader<T> {
  syncAll(writer: CollectionWriter<T>): SyncResult | Promise<SyncResult>;
  syncSince(
    writer: CollectionWriter<T>,
    cursor: number,
  ): SyncResult | Promise<SyncResult>;
  fetchOne?(id: EntryId): T | undefined | Promise<T | undefined>;
}
```

The writer is collection-scoped, so a loader cannot write outside its own
namespace:

```ts
interface CollectionWriter<T> {
  upsert(entry: { locale: string; path: string; data: T }): void;
  delete(id: { locale: string; path: string }): void;
}
```

Nothing you write through the writer is applied while your method runs. The
framework buffers the calls, validates every upsert against the collection's
schema once you return, and then replays the whole batch in a single
transaction together with the cursor. A loader that throws leaves nothing
behind, because no transaction was ever opened.

## Write `syncAll`

Fetch everything, upsert it, report what you wrote.

```ts
async syncAll(writer) {
  const changed = [];
  for (const item of await fetchEverything()) {
    const id = { locale: item.language, path: item.slug };
    writer.upsert({ ...id, data: item });
    changed.push(id);
  }
  return { changed, deleted: [], cursor: Date.now() };
}
```

`cursor` is yours. The framework stores the number and hands it back to
`syncSince`; it never interprets it. A revision number, an epoch millisecond
and a page offset are all fine.

## Write `syncSince`

The same shape, filtered by the watermark you were given.

```ts
async syncSince(writer, cursor) {
  const changed = [];
  for (const item of await fetchChangedSince(cursor)) {
    const id = { locale: item.language, path: item.slug };
    writer.upsert({ ...id, data: item });
    changed.push(id);
  }
  return { changed, deleted: [], cursor: Date.now() };
}
```

Bias the watermark towards syncing too much rather than too little. A cursor
that is slightly stale costs one delta that re-reads a few unchanged entries; a
cursor that is slightly ahead costs an entry that is never synced again.

## Report deletions

`deleted` names the entries your source says are gone. A source that remembers
its own removals — a delivery API with a removals endpoint — fills it from
there.

A source that remembers nothing cannot. A directory, a static export or a JSON
dump leaves no trace of what it no longer holds, so walking all of it is the
only removal report there is. Say so, and the framework removes every entry of
the collection your sync did not report as changed:

```ts
return { changed, deleted: [], authoritative: true, cursor: Date.now() };
```

Only from `syncAll`. A `syncSince` reports a delta, so it never mentions the
entries that did not change — returning `authoritative` from one is refused,
because pruning against it would delete the unchanged remainder of the
collection.

## Entry ids are identifiers, not paths

`EntryId` is `{ locale, path }`, and both fields are identifiers. A sync refuses
every upsert whose id holds a `..`, a leading `/`, a backslash or a NUL —
spelled literally or percent-encoded — because a loader is free to build a file
path or a URL out of an id, and one that resolves away structure would let
whoever supplies it read outside your content.

The whole sync fails when one id is bad, and every offending id is named in the
report. Deletes are exempt: a delete files nothing under an id, and a store
written before this rule existed may hold a row only a delete can remove.

## Declare a schema

A collection's `schema` field is required. Give it a Standard Schema — any
implementation — and every entry your loader writes is validated before it is
stored, with failures named by locale, path and field. Give it `false` and
nothing is checked. There is no way to skip the decision.

The schema's output type and your loader's entry type are two types, and they
do not have to agree. A collection is `Collection<TOut, TIn>`: `TOut` is the
entry as it is stored and read, `TIn` is what your loader produces, and `TIn`
defaults to `TOut` for the loader that already produces what the site reads. So
a schema may narrow what a loader hands over — turning an open record of
frontmatter into a closed one — and every page, query and extractor sees the
narrowed shape. Your loader is written against its own type and never learns
about the site's.

One exception, and the types enforce it: a collection that declares
`schema: false` stores what the loader hands over unchecked, so there is nothing
to narrow through and the two types are one. Such a collection cannot claim a
read type its loader does not produce.
