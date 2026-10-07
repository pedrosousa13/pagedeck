// Example: implement a loader by hand. It never reads the store; it tells the writer what to
// upsert and delete, and the framework applies the batch in one transaction.
import {
  defineCollection,
  listEntries,
  openStore,
  syncCollection,
  syncCollectionSince,
} from "@pagedeck/content";
import type {
  CollectionWriter,
  ContentStore,
  EntryId,
  Loader,
  SyncResult,
} from "@pagedeck/content";

export interface Note {
  title: string;
}

interface NoteRecord extends EntryId {
  /** The CMS's own revision number. This is what the cursor tracks. */
  rev: number;
  title?: string;
  deleted?: boolean;
}

// The cursor is the loader's own watermark, handed back untouched; not the store's `seq`.
// Deletions are reported explicitly, so the CMS keeps tombstones.
function createNoteLoader(records: readonly NoteRecord[]): Loader<Note> {
  function replay(writer: CollectionWriter<Note>, since: number): SyncResult {
    const changed: EntryId[] = [];
    const deleted: EntryId[] = [];
    let cursor = since;
    for (const record of records) {
      cursor = Math.max(cursor, record.rev);
      if (record.rev <= since) continue;
      const id = { locale: record.locale, path: record.path };
      if (record.deleted === true || record.title === undefined) {
        writer.delete(id);
        deleted.push(id);
      } else {
        writer.upsert({ ...id, data: { title: record.title } });
        changed.push(id);
      }
    }
    return { changed, deleted, cursor };
  }

  return {
    // Every record: a full sync converges even after a missed deletion.
    syncAll: (writer) => replay(writer, 0),
    // Only what changed after the watermark the last sync returned.
    syncSince: (writer, cursor) => replay(writer, cursor),
    // Optional. Lets `getEntryCached` fall back to the CMS for a single entry
    // the store does not have.
    fetchOne: (id) => {
      const record = records.find(
        (candidate) =>
          candidate.locale === id.locale && candidate.path === id.path,
      );
      return record?.title === undefined ? undefined : { title: record.title };
    },
  };
}

export interface HandWrittenLoaderRun {
  /** Open — the caller closes it. */
  store: ContentStore;
  full: SyncResult;
  incremental: SyncResult;
  notes: Note[];
}

export async function syncHandWrittenLoader(
  storePath: string,
): Promise<HandWrittenLoaderRun> {
  const records: NoteRecord[] = [
    { locale: "en", path: "first", rev: 1, title: "First note" },
    { locale: "en", path: "second", rev: 2, title: "Second note" },
    { locale: "en", path: "third", rev: 1, title: "Third note" },
  ];
  const notes = defineCollection<Note>({
    name: "notes",
    loader: createNoteLoader(records),
    // No validation: `querying-with-a-schema.ts` is the schema-bearing case.
    schema: false,
  });

  const store = openStore(storePath);
  const full = await syncCollection(store, notes);

  // Both edits get a revision above the cursor the full sync returned.
  records[1] = {
    locale: "en",
    path: "second",
    rev: 3,
    title: "Second note, revised",
  };
  records[0] = { locale: "en", path: "first", rev: 4, deleted: true };

  // With no cursor argument, this resumes from the stored one; a never-synced collection fails
  // here.
  const incremental = await syncCollectionSince(store, notes);

  return {
    store,
    full,
    incremental,
    notes: listEntries(store, notes).map((entry) => entry.data),
  };
}
