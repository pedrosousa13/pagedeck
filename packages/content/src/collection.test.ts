import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  CollectionError,
  defineCollection,
  getEntry,
  getEntryCached,
  listDueEntries,
  listEntries,
  syncCollection,
  syncCollectionSince,
} from "./collection.js";
import type {
  Collection,
  CollectionWriter,
  EntryId,
  Loader,
  SyncResult,
} from "./collection.js";
import { openStore } from "./store.js";
import type { ComponentUsage, ContentStore, Entry } from "./store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-content-collection-"));
  tempDirs.push(dir);
  return join(dir, "content.db");
}

const openStores: ContentStore[] = [];

function openTempStore(): ContentStore {
  const store = openStore(tempDbPath());
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Doc {
  title: string;
}

function toyLoader(): Loader<Doc> & {
  put(locale: string, path: string, title: string): void;
  remove(locale: string, path: string): void;
} {
  const entries = new Map<string, { id: EntryId; data: Doc; rev: number }>();
  const removed: { id: EntryId; rev: number }[] = [];
  let rev = 0;
  const key = (id: EntryId) => `${id.locale}/${id.path}`;

  return {
    put(locale, path, title) {
      rev += 1;
      entries.set(key({ locale, path }), {
        id: { locale, path },
        data: { title },
        rev,
      });
    },
    remove(locale, path) {
      rev += 1;
      entries.delete(key({ locale, path }));
      removed.push({ id: { locale, path }, rev });
    },
    syncAll(writer: CollectionWriter<Doc>): SyncResult {
      const changed: EntryId[] = [];
      for (const entry of entries.values()) {
        writer.upsert({ ...entry.id, data: entry.data });
        changed.push(entry.id);
      }
      return { changed, deleted: [], cursor: rev };
    },
    syncSince(writer: CollectionWriter<Doc>, cursor: number): SyncResult {
      const changed: EntryId[] = [];
      for (const entry of entries.values()) {
        if (entry.rev > cursor) {
          writer.upsert({ ...entry.id, data: entry.data });
          changed.push(entry.id);
        }
      }
      const deleted: EntryId[] = [];
      for (const gone of removed) {
        if (gone.rev > cursor) {
          writer.delete(gone.id);
          deleted.push(gone.id);
        }
      }
      return { changed, deleted, cursor: rev };
    },
    fetchOne(id: EntryId): Doc | undefined {
      return entries.get(key(id))?.data;
    },
  };
}

function asyncToyLoader(): ReturnType<typeof toyLoader> {
  const inner = toyLoader();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    put: inner.put,
    remove: inner.remove,
    async syncAll(writer) {
      await tick();
      return inner.syncAll(writer);
    },
    async syncSince(writer, cursor) {
      await tick();
      return inner.syncSince(writer, cursor);
    },
    async fetchOne(id) {
      await tick();
      return inner.fetchOne?.(id);
    },
  };
}

// `Loader<never>` fits any entry type, so it never votes on one.
function emptyLoader(): Loader<never> {
  return {
    syncAll(): SyncResult {
      return { changed: [], deleted: [], cursor: 0 };
    },
    syncSince(): SyncResult {
      return { changed: [], deleted: [], cursor: 0 };
    },
  };
}

const orderedId = { locale: "en", path: "a" };

function orderedLoader(
  writes: (writer: CollectionWriter<Doc>) => void,
): Loader<Doc> {
  return {
    syncAll(writer) {
      const changed: EntryId[] = [];
      const deleted: EntryId[] = [];
      writes({
        upsert(entry) {
          writer.upsert(entry);
          changed.push({ locale: entry.locale, path: entry.path });
        },
        delete(id) {
          writer.delete(id);
          deleted.push(id);
        },
      });
      return { changed, deleted, cursor: 1 };
    },
    syncSince(): SyncResult {
      throw new Error("unused");
    },
  };
}

test("syncAll writes entries and persists the loader cursor", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  loader.put("en", "b", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const result = await syncCollection(store, pages);

  expect(result.changed).toEqual([
    { locale: "en", path: "a" },
    { locale: "en", path: "b" },
  ]);
  expect(result.deleted).toEqual([]);
  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({ title: "A" });
  expect(store.getEntry<Doc>("pages", "en", "b")?.data).toEqual({ title: "B" });
  expect(store.getCursor("pages")).toBe(result.cursor);
  store.close();
});

test("syncSince applies a delta from the stored cursor and advances it", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const first = await syncCollection(store, pages);

  loader.put("en", "b", "B");
  loader.put("en", "a", "A2");

  const delta = await syncCollectionSince(store, pages);

  expect(delta.changed).toEqual([
    { locale: "en", path: "a" },
    { locale: "en", path: "b" },
  ]);
  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({
    title: "A2",
  });
  expect(delta.cursor).toBeGreaterThan(first.cursor);
  expect(store.getCursor("pages")).toBe(delta.cursor);
  store.close();
});

test("a deletion removes the row and is reported in the sync result", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  loader.put("en", "b", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  await syncCollection(store, pages);

  loader.remove("en", "a");
  const delta = await syncCollectionSince(store, pages);

  expect(delta.deleted).toEqual([{ locale: "en", path: "a" }]);
  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  expect(store.getEntry("pages", "en", "b")).toBeDefined();
  store.close();
});

test("syncCollectionSince accepts an explicit cursor", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const result = await syncCollectionSince(store, pages, 0);

  expect(result.changed).toEqual([{ locale: "en", path: "a" }]);
  expect(store.getEntry("pages", "en", "a")).toBeDefined();
  store.close();
});

test("syncCollectionSince without a cursor anywhere throws, naming the collection", async () => {
  const store = openStore(tempDbPath());
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  await expect(syncCollectionSince(store, pages)).rejects.toThrow(/pages/);
  store.close();
});

test("getEntryCached serves a stored entry without calling fetchOne", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  await syncCollection(store, pages);
  const fetchOne = vi.spyOn(loader, "fetchOne");

  const entry = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "a",
  });

  expect(entry?.data).toEqual({ title: "A" });
  expect(fetchOne).not.toHaveBeenCalled();
  store.close();
});

test("getEntryCached falls back to fetchOne once on a miss and caches the result", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");
  const id = { locale: "en", path: "a" };

  const first = await getEntryCached<Doc>(store, pages, id);
  expect(first?.data).toEqual({ title: "A" });
  expect(first?.collection).toBe("pages");
  expect(fetchOne).toHaveBeenCalledTimes(1);

  const second = await getEntryCached<Doc>(store, pages, id);
  expect(second?.data).toEqual({ title: "A" });
  expect(fetchOne).toHaveBeenCalledTimes(1);
  store.close();
});

test("getEntryCached hands back the re-read row, so an accessor from fetchOne arrives as plain data", async () => {
  // Pins that the fetch path re-reads its write rather than returning the loader's own
  // object, accessors included (#135). `schema: false`, so no validator stands between.
  const store = openTempStore();
  let reads = 0;
  const loader: Loader<Doc> = {
    syncAll: () => ({ changed: [], deleted: [], cursor: 0 }),
    syncSince: () => ({ changed: [], deleted: [], cursor: 0 }),
    fetchOne: () => ({
      get title() {
        reads += 1;
        return "A";
      },
    }),
  };
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const entry = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "a",
  });

  const descriptor = Object.getOwnPropertyDescriptor(
    entry?.data ?? {},
    "title",
  );
  expect(descriptor?.get).toBeUndefined();
  expect(descriptor?.value).toBe("A");
  // Once, by the write's `JSON.stringify`.
  expect(reads).toBe(1);
});

test("getEntryCached returns undefined on a miss when the loader has no fetchOne", async () => {
  const store = openStore(tempDbPath());
  const loader = toyLoader();
  const bulkOnly: Loader<Doc> = {
    syncAll: loader.syncAll,
    syncSince: loader.syncSince,
  };
  const pages = defineCollection({
    name: "pages",
    loader: bulkOnly,
    schema: false,
  });

  const entry = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "a",
  });

  expect(entry).toBeUndefined();
  store.close();
});

test("getEntryCached returns undefined when fetchOne finds nothing", async () => {
  const store = openStore(tempDbPath());
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  expect(
    await getEntryCached<Doc>(store, pages, { locale: "en", path: "gone" }),
  ).toBeUndefined();
  store.close();
});

test("getEntryCached refuses an id whose path escapes its collection, naming the id", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  await expect(
    getEntryCached<Doc>(store, pages, {
      locale: "en",
      path: "../../etc/passwd",
    }),
  ).rejects.toThrow(
    new Error(
      'Collection "pages": entry id "/en/../../etc/passwd" is not a usable identifier — its path holds a ".." — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop',
    ),
  );
  expect(fetchOne).not.toHaveBeenCalled();
});

test("getEntryCached refuses an id whose locale escapes its collection, naming the id", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "../../tmp", path: "secret" }),
  ).rejects.toThrow(
    /Collection "pages": entry id "\/\.\.\/\.\.\/tmp\/secret" is not a usable identifier — its locale holds a "\.\."/,
  );
  expect(fetchOne).not.toHaveBeenCalled();
});

test("getEntryCached reports every fault in both fields of an id at once", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "../x", path: "a\\b/../c" }),
  ).rejects.toThrow(
    new Error(
      'Collection "pages": entry id "/../x/a\\\\b/../c" is not a usable identifier — its locale holds a "..", its path holds a backslash and a ".." — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop',
    ),
  );
});

test("getEntryCached refuses a two-dot run that is not a whole segment", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  // No dot segment under any splitting, refused anyway: a loader may join the fields with
  // a separator of its own.
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "a..b" }),
  ).rejects.toThrow(/entry id "\/en\/a\.\.b" .* its path holds a "\.\."/);
  expect(fetchOne).not.toHaveBeenCalled();
});

test("getEntryCached refuses a leading slash, a backslash and a NUL in an id", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "/etc/passwd" }),
  ).rejects.toThrow(/its path holds a leading "\/"/);
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "a\\b" }),
  ).rejects.toThrow(/its path holds a backslash/);
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en\0", path: "a" }),
  ).rejects.toThrow(/its locale holds a NUL/);
});

test("getEntryCached refuses the percent-encoded spelling of a traversal id", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  await expect(
    getEntryCached<Doc>(store, pages, {
      locale: "en",
      path: "%2e%2e/%2e%2e/etc/passwd",
    }),
  ).rejects.toThrow(
    new Error(
      'Collection "pages": entry id "/en/%2e%2e/%2e%2e/etc/passwd" is not a usable identifier — its path holds a ".." — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop',
    ),
  );
  expect(fetchOne).not.toHaveBeenCalled();
});

test("getEntryCached reads an escape's case the way a resolver does", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  for (const path of ["%2e%2e/secret", "%2E%2E/secret", "%2e%2E/secret"]) {
    await expect(
      getEntryCached<Doc>(store, pages, { locale: "en", path }),
    ).rejects.toThrow(/its path holds a "\.\."/);
  }
});

test("getEntryCached refuses the encoded spelling of a slash, backslash and NUL", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "%2Fetc/passwd" }),
  ).rejects.toThrow(/its path holds a leading "\/"/);
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "a%5cb" }),
  ).rejects.toThrow(/its path holds a backslash/);
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en%00", path: "a" }),
  ).rejects.toThrow(/its locale holds a NUL/);
});

test("getEntryCached refuses a traversal the URL parser strips its way into", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  for (const path of [
    ".%09./secret",
    ".%0a./secret",
    ".%0d./secret",
    "%2e%09%2e/x",
    ".\t./secret",
  ]) {
    await expect(
      getEntryCached<Doc>(store, pages, { locale: "en", path }),
    ).rejects.toThrow(/its path holds a "\.\."/);
  }
  for (const path of ["%09/etc/passwd", "%20/etc/passwd", " /etc/passwd"]) {
    await expect(
      getEntryCached<Doc>(store, pages, { locale: "en", path }),
    ).rejects.toThrow(/its path holds a leading "\/"/);
  }
  expect(fetchOne).not.toHaveBeenCalled();
});

test("getEntryCached takes an id holding a literal percent or a space", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "sale-50%-off", "A");
  loader.put("en", "my page", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const percent = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "sale-50%-off",
  });
  expect(percent?.data).toEqual({ title: "A" });
  const spaced = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "my page",
  });
  expect(spaced?.data).toEqual({ title: "B" });
});

test("getEntryCached reads around an escape that will not decode", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "../a%zz" }),
  ).rejects.toThrow(/its path holds a "\.\." — an entry id names/);
});

test("getEntryCached takes an id holding a percent-escape that decodes to nothing refused", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "caf%C3%A9", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const entry = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "caf%C3%A9",
  });
  expect(entry?.data).toEqual({ title: "A" });
  expect(store.getEntry("pages", "en", "caf%C3%A9")).toBeDefined();
});

test("getEntryCached refuses a traversal id the store already holds", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "../secret",
    data: { title: "leaked" },
  });

  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "../secret" }),
  ).rejects.toThrow(
    /Collection "pages": entry id "\/en\/\.\.\/secret" is not a usable identifier/,
  );
});

test("a sync cannot store the id getEntryCached refuses", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  loader.put("en", "../secret", "leaked");

  await expect(syncCollection(store, pages)).rejects.toThrow(
    /1 entry does not have a usable entry id/,
  );
  expect(store.listEntries("pages")).toEqual([]);
  await expect(
    getEntryCached<Doc>(store, pages, { locale: "en", path: "../secret" }),
  ).rejects.toThrow(
    /Collection "pages": entry id "\/en\/\.\.\/secret" is not a usable identifier/,
  );
});

test("a sync refuses an entry whose id is a path fragment, naming the id", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  loader.put("en", "../../etc/passwd", "leaked");

  await expect(syncCollection(store, pages)).rejects.toThrow(
    new Error(
      'Collection "pages": 1 entry does not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:\n  /en/../../etc/passwd: its path holds a ".."',
    ),
  );
});

test("a sync reports every unusable id in one run, storing none of the batch", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  loader.put("en", "ok", "A");
  loader.put("en", "../secret", "leaked");
  loader.put("../x", "a\\b", "leaked");

  await expect(syncCollection(store, pages)).rejects.toThrow(
    new Error(
      'Collection "pages": 2 entries do not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:\n  /en/../secret: its path holds a ".."\n  /../x/a\\b: its locale holds a "..", its path holds a backslash',
    ),
  );
  expect(store.listEntries("pages")).toEqual([]);
  expect(store.getCursor("pages")).toBeUndefined();
});

test("a sync refuses a percent-encoded traversal id without a second check", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  loader.put("en", "%2E%2E/secret", "leaked");
  loader.put("de", ".%09./secret", "leaked");

  await expect(syncCollection(store, pages)).rejects.toThrow(
    new Error(
      'Collection "pages": 2 entries do not have a usable entry id — an entry id names an entry rather than a file path, so pass an id with no "..", leading "/", backslash or NUL, spelled literally or percent-encoded, and no tab, newline or leading space a URL parser would drop:\n  /en/%2E%2E/secret: its path holds a ".."\n  /de/.%09./secret: its path holds a ".."',
    ),
  );
  expect(store.listEntries("pages")).toEqual([]);
});

test("a sync refuses an unusable id before it runs the schema", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const validate = vi.fn(() => ({ value: { title: "leaked" } }));
  const pages = defineCollection({
    name: "pages",
    loader,
    schema: handSchema<Doc>(validate),
  });
  loader.put("en", "../secret", "leaked");

  await expect(syncCollection(store, pages)).rejects.toThrow(
    /1 entry does not have a usable entry id/,
  );
  expect(validate).not.toHaveBeenCalled();
});

test("a sync ignores an upsert the loader makes after it returns", async () => {
  const store = openTempStore();
  const late = { locale: "en", path: "../secret", data: { title: "leaked" } };
  let lateUpsert: (() => void) | undefined;
  const loader: Loader<Doc> = {
    syncAll(writer) {
      writer.upsert({ locale: "en", path: "ok", data: { title: "A" } });
      lateUpsert = () => {
        writer.upsert(late);
      };
      return { changed: [{ locale: "en", path: "ok" }], deleted: [], cursor: 1 };
    },
    syncSince(): SyncResult {
      throw new Error("unused");
    },
  };
  const validate = vi.fn(
    (value: unknown) =>
      new Promise<StandardSchemaV1.Result<Doc>>((resolve) => {
        lateUpsert?.();
        lateUpsert = undefined;
        setTimeout(() => {
          resolve({ value: value as Doc });
        }, 5);
      }),
  );
  const pages = defineCollection({
    name: "pages",
    loader,
    schema: handSchema<Doc>(validate),
  });

  await expect(syncCollection(store, pages)).resolves.toMatchObject({
    cursor: 1,
  });

  expect(store.listEntries("pages").map((entry) => entry.path)).toEqual(["ok"]);
  expect(validate).toHaveBeenCalledTimes(1);
});

test("a sync may delete an entry whose id is a path fragment", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  const pages = defineCollection({ name: "pages", loader, schema: false });
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "../secret",
    data: { title: "leaked" },
  });
  store.setCursor("pages", 0);
  loader.remove("en", "../secret");

  await expect(syncCollectionSince(store, pages)).resolves.toMatchObject({
    deleted: [{ locale: "en", path: "../secret" }],
  });
  expect(store.listEntries("pages")).toEqual([]);
});

test("an async loader syncs, deletes and fetches one", async () => {
  const store = openStore(tempDbPath());
  const loader = asyncToyLoader();
  loader.put("en", "a", "A");
  loader.put("en", "b", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const full = await syncCollection(store, pages);
  expect(full.changed).toHaveLength(2);
  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({ title: "A" });

  loader.remove("en", "a");
  loader.put("en", "c", "C");
  const delta = await syncCollectionSince(store, pages);
  expect(delta.deleted).toEqual([{ locale: "en", path: "a" }]);
  expect(delta.changed).toEqual([{ locale: "en", path: "c" }]);
  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  expect(store.getCursor("pages")).toBe(delta.cursor);

  const refetched = await getEntryCached<Doc>(store, pages, {
    locale: "en",
    path: "b",
  });
  expect(refetched?.data).toEqual({ title: "B" });
  store.close();
});

test("concurrent syncs of two collections both land", async () => {
  const store = openStore(tempDbPath());
  const slow = asyncToyLoader();
  const fast = toyLoader();
  slow.put("en", "a", "A");
  fast.put("en", "b", "B");
  const pages = defineCollection({
    name: "pages",
    loader: slow,
    schema: false,
  });
  const docs = defineCollection({ name: "docs", loader: fast, schema: false });

  const [pagesResult, docsResult] = await Promise.all([
    syncCollection(store, pages),
    syncCollection(store, docs),
  ]);

  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({ title: "A" });
  expect(store.getEntry<Doc>("docs", "en", "b")?.data).toEqual({ title: "B" });
  expect(store.getCursor("pages")).toBe(pagesResult.cursor);
  expect(store.getCursor("docs")).toBe(docsResult.cursor);
  store.close();
});

test("a failing sync does not discard a concurrent one's writes", async () => {
  const store = openStore(tempDbPath());
  const failing: Loader<Doc> = {
    async syncAll(writer) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      writer.upsert({ locale: "en", path: "x", data: { title: "X" } });
      throw new Error("upstream exploded");
    },
    syncSince() {
      throw new Error("unused");
    },
  };
  const good = toyLoader();
  good.put("en", "b", "B");
  const pages = defineCollection({
    name: "pages",
    loader: failing,
    schema: false,
  });
  const docs = defineCollection({ name: "docs", loader: good, schema: false });

  const [pagesOutcome] = await Promise.allSettled([
    syncCollection(store, pages),
    syncCollection(store, docs),
  ]);

  expect(pagesOutcome.status).toBe("rejected");
  expect(store.getEntry("pages", "en", "x")).toBeUndefined();
  expect(store.getCursor("pages")).toBeUndefined();
  expect(store.getEntry<Doc>("docs", "en", "b")?.data).toEqual({ title: "B" });
  expect(store.getCursor("docs")).toBeDefined();
  store.close();
});

test("a throwing loader fails the sync loudly and commits nothing", async () => {
  const store = openStore(tempDbPath());
  const failing: Loader<Doc> = {
    syncAll(writer) {
      writer.upsert({ locale: "en", path: "a", data: { title: "A" } });
      throw new Error("upstream exploded");
    },
    syncSince() {
      throw new Error("unused");
    },
  };
  const pages = defineCollection({
    name: "pages",
    loader: failing,
    schema: false,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    /pages.*syncAll|syncAll.*pages/,
  );
  await expect(syncCollection(store, pages)).rejects.toMatchObject({
    cause: expect.objectContaining({ message: "upstream exploded" }),
  });
  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  expect(store.getCursor("pages")).toBeUndefined();
  store.close();
});

test("a throwing syncSince fails loudly, naming the collection and operation", async () => {
  const store = openStore(tempDbPath());
  const failing: Loader<Doc> = {
    syncAll(): SyncResult {
      return { changed: [], deleted: [], cursor: 4 };
    },
    syncSince() {
      throw new Error("delta feed down");
    },
  };
  const pages = defineCollection({
    name: "pages",
    loader: failing,
    schema: false,
  });
  await syncCollection(store, pages);

  let failure: Error | undefined;
  try {
    await syncCollectionSince(store, pages);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toContain('Collection "pages"');
  expect(failure?.message).toContain("syncSince");
  expect(failure?.cause).toMatchObject({ message: "delta feed down" });
  expect(store.getCursor("pages")).toBe(4);
  store.close();
});

test("a replay that fails partway commits none of the buffer", async () => {
  const store = openStore(tempDbPath());
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const poisoned: Loader<Doc> = {
    syncAll(writer) {
      writer.upsert({ locale: "en", path: "a", data: { title: "A" } });
      writer.upsert({ locale: "en", path: "b", data: circular as Doc });
      return {
        changed: [
          { locale: "en", path: "a" },
          { locale: "en", path: "b" },
        ],
        deleted: [],
        cursor: 1,
      };
    },
    syncSince() {
      throw new Error("unused");
    },
  };
  const pages = defineCollection({
    name: "pages",
    loader: poisoned,
    schema: false,
  });

  let failure: Error | undefined;
  try {
    await syncCollection(store, pages);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure?.message).toContain('Collection "pages"');
  expect(failure?.message).toContain("syncAll");
  expect(failure?.message).toContain("en/b");
  expect(failure?.cause).toBeInstanceOf(Error);

  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  expect(store.getEntry("pages", "en", "b")).toBeUndefined();
  expect(store.getCursor("pages")).toBeUndefined();
  store.close();
});

test("replaying upsert-then-delete of one id leaves it deleted", async () => {
  const store = openStore(tempDbPath());
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ ...orderedId, data: { title: "A" } });
      writer.delete(orderedId);
    }),
    schema: false,
  });

  const result = await syncCollection(store, pages);

  expect(result.changed).toEqual([orderedId]);
  expect(result.deleted).toEqual([orderedId]);
  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  store.close();
});

test("replaying delete-then-upsert of one id leaves it present", async () => {
  const store = openStore(tempDbPath());
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.delete(orderedId);
      writer.upsert({ ...orderedId, data: { title: "A" } });
    }),
    schema: false,
  });

  const result = await syncCollection(store, pages);

  expect(result.changed).toEqual([orderedId]);
  expect(result.deleted).toEqual([orderedId]);
  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({ title: "A" });
  store.close();
});

type Page =
  | { mode: "tree"; components: string[] }
  | { mode: "template"; template: string };

interface PageFeed {
  entries: { locale: string; path: string; data: Page }[];
  deletions: EntryId[];
}

function feedLoader(feed: PageFeed): Loader<Page> {
  return {
    syncAll(writer: CollectionWriter<Page>): SyncResult {
      for (const entry of feed.entries) writer.upsert(entry);
      for (const id of feed.deletions) writer.delete(id);
      return {
        changed: feed.entries.map(({ locale, path }) => ({ locale, path })),
        deleted: feed.deletions,
        cursor: 1,
      };
    },
    syncSince(): SyncResult {
      throw new Error("unused");
    },
  };
}

function extractPageUsage(entry: { data: Page }): ComponentUsage[] {
  if (entry.data.mode !== "tree") return [];
  const usage = new Map<string, ComponentUsage>();
  entry.data.components.forEach((component, position) => {
    const seen = usage.get(component);
    if (seen === undefined) {
      usage.set(component, {
        component,
        count: 1,
        foldScore: position,
        depth: 0,
        isRoot: true,
      });
    } else {
      seen.count += 1;
    }
  });
  return [...usage.values()];
}

const PRICING_TEMPLATE: ComponentUsage[] = [
  {
    component: "PricingHeader",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  },
  { component: "PlanCard", count: 2, foldScore: 1, depth: 1, isRoot: false },
];

test("a sync records the usage its extractor finds, per entry and locale", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "home",
        data: { mode: "tree", components: ["Hero", "Card", "Card"] },
      },
      {
        locale: "de",
        path: "home",
        data: { mode: "tree", components: ["Card", "Hero"] },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    extractUsage: extractPageUsage,
    schema: false,
  });

  await syncCollection(store, pages);

  expect(store.listUsage("Card")).toEqual([
    {
      component: "Card",
      collection: "pages",
      locale: "de",
      path: "home",
      count: 1,
      foldScore: 0,
      depth: 0,
      isRoot: true,
    },
    {
      component: "Card",
      collection: "pages",
      locale: "en",
      path: "home",
      count: 2,
      foldScore: 1,
      depth: 0,
      isRoot: true,
    },
  ]);
  expect(store.rankUsage()).toEqual([
    {
      component: "Card",
      totalUsages: 3,
      storyCount: 2,
      avgPerStory: 1.5,
      avgFoldScore: 0.5,
    },
    {
      component: "Hero",
      totalUsages: 2,
      storyCount: 2,
      avgPerStory: 1,
      avgFoldScore: 0.5,
    },
  ]);
});

test("re-syncing a changed entry replaces its usage instead of merging", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "home",
        data: { mode: "tree", components: ["Hero", "Card"] },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    extractUsage: extractPageUsage,
    schema: false,
  });
  await syncCollection(store, pages);

  feed.entries[0] = {
    locale: "en",
    path: "home",
    data: { mode: "tree", components: ["Hero"] },
  };
  await syncCollection(store, pages);

  expect(store.listUsage("Card")).toEqual([]);
  expect(store.listUsage("Hero")).toHaveLength(1);
});

test("syncing a deletion takes the entry's usage with it", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "home",
        data: { mode: "tree", components: ["Hero"] },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    extractUsage: extractPageUsage,
    schema: false,
  });
  await syncCollection(store, pages);

  feed.entries = [];
  feed.deletions = [{ locale: "en", path: "home" }];
  await syncCollection(store, pages);

  expect(store.getEntry("pages", "en", "home")).toBeUndefined();
  expect(store.listUsage("Hero")).toEqual([]);
});

test("a template-driven entry lands its declared usage with no extractor", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "pricing",
        data: { mode: "template", template: "PricingPage" },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { PricingPage: PRICING_TEMPLATE },
    },
    schema: false,
  });

  await syncCollection(store, pages);

  expect(store.listUsage("PlanCard")).toEqual([
    {
      component: "PlanCard",
      collection: "pages",
      locale: "en",
      path: "pricing",
      count: 2,
      foldScore: 1,
      depth: 1,
      isRoot: false,
    },
  ]);
});

test("both page modes feed one ranking within a collection", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "home",
        data: { mode: "tree", components: ["PlanCard"] },
      },
      {
        locale: "en",
        path: "pricing",
        data: { mode: "template", template: "PricingPage" },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    extractUsage: extractPageUsage,
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: { PricingPage: PRICING_TEMPLATE },
    },
    schema: false,
  });

  await syncCollection(store, pages);

  expect(store.rankUsage().find((row) => row.component === "PlanCard")).toEqual(
    {
      component: "PlanCard",
      totalUsages: 3,
      storyCount: 2,
      avgPerStory: 1.5,
      avgFoldScore: 0.5,
    },
  );
});

test("an entry naming an undeclared template fails the sync, naming both", async () => {
  const store = openTempStore();
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "pricing",
        data: { mode: "template", template: "MissingPage" },
      },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: {},
    },
    schema: false,
  });

  let failure: Error | undefined;
  try {
    await syncCollection(store, pages);
  } catch (error) {
    failure = error as Error;
  }
  expect(failure?.message).toContain("en/pricing");
  expect(failure).toBeInstanceOf(CollectionError);
  expect(failure?.cause).toBeInstanceOf(CollectionError);
  expect(failure?.cause).toMatchObject({
    message:
      'Collection "pages": template "MissingPage" declares no component usage — declare its components in the collection\'s byTemplate, or stop returning the name from templateOf',
  });
  expect(store.getEntry("pages", "en", "pricing")).toBeUndefined();
});

test.each(["constructor", "toString"])(
  'a template named "%s" fails the sync as an undeclared template',
  async (template) => {
    const store = openTempStore();
    const feed: PageFeed = {
      entries: [
        { locale: "en", path: "pricing", data: { mode: "template", template } },
      ],
      deletions: [],
    };
    const pages = defineCollection({
      name: "pages",
      loader: feedLoader(feed),
      templates: {
        templateOf: (entry) =>
          entry.data.mode === "template" ? entry.data.template : undefined,
        byTemplate: {},
      },
      schema: false,
    });

    let failure: Error | undefined;
    try {
      await syncCollection(store, pages);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(CollectionError);
    expect(failure?.cause).toBeInstanceOf(CollectionError);
    expect(failure?.cause).toMatchObject({
      message: `Collection "pages": template "${template}" declares no component usage — declare its components in the collection's byTemplate, or stop returning the name from templateOf`,
    });
  },
);

test("a replay that fails partway commits neither entries nor usage", async () => {
  const store = openTempStore();
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const feed: PageFeed = {
    entries: [
      {
        locale: "en",
        path: "home",
        data: { mode: "tree", components: ["Hero"] },
      },
      { locale: "en", path: "broken", data: circular as unknown as Page },
    ],
    deletions: [],
  };
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader(feed),
    extractUsage: extractPageUsage,
    schema: false,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(/en\/broken/);

  expect(store.getEntry("pages", "en", "home")).toBeUndefined();
  expect(store.listUsage("Hero")).toEqual([]);
});

// Hand-written, so the suite proves the interface rather than one library's quirks.
function handSchema<T>(
  validate: (
    value: unknown,
  ) => StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>,
): StandardSchemaV1<unknown, T> {
  return { "~standard": { version: 1, vendor: "hand", validate } };
}

const MISSING_TITLE = "expected a string, got nothing";

const titledSchema = handSchema<Doc>((value) => {
  const { title } = value as { title?: unknown };
  return typeof title === "string"
    ? { value: { title } }
    : { issues: [{ path: ["title"], message: MISSING_TITLE }] };
});

test("an entry missing a required field fails the sync and writes nothing", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
      // The cast is the point: a loader's payload is whatever the source handed it.
      writer.upsert({
        locale: "de",
        path: "pricing",
        data: {} as unknown as Doc,
      });
    }),
    schema: titledSchema,
  });

  let failure: Error | undefined;
  try {
    await syncCollection(store, pages);
  } catch (error) {
    failure = error as Error;
  }

  expect(failure?.message).toBe(
    'Collection "pages": 1 entry does not match the collection schema — fix the content, or relax the schema:\n' +
      `  /de/pricing: title — ${MISSING_TITLE}`,
  );
  expect(store.getEntry("pages", "en", "home")).toBeUndefined();
  expect(store.getEntry("pages", "de", "pricing")).toBeUndefined();
  expect(store.getCursor("pages")).toBeUndefined();
});

test("every issue on one failing entry is reported in a single sync", async () => {
  const store = openTempStore();
  const strict = handSchema<Doc>(() => ({
    issues: [
      { path: [{ key: "hero" }, { key: "title" }], message: "missing" },
      {
        path: [{ key: "plans" }, { key: 0 }, { key: "price" }],
        message: "missing",
      },
    ],
  }));
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "de", path: "pricing", data: { title: "P" } });
    }),
    schema: strict,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    'Collection "pages": 1 entry does not match the collection schema — fix the content, or relax the schema:\n' +
      "  /de/pricing: hero.title — missing\n" +
      "  /de/pricing: plans.0.price — missing",
  );
});

test("every failing entry is reported in a single sync", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: {} as unknown as Doc });
      writer.upsert({ locale: "de", path: "home", data: { title: "S" } });
      writer.upsert({
        locale: "de",
        path: "pricing",
        data: {} as unknown as Doc,
      });
    }),
    schema: titledSchema,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    'Collection "pages": 2 entries do not match the collection schema — fix the content, or relax the schema:\n' +
      `  /en/home: title — ${MISSING_TITLE}\n` +
      `  /de/pricing: title — ${MISSING_TITLE}`,
  );
});

test("the schema's output value is what lands in the store", async () => {
  const store = openTempStore();
  const trimmed = handSchema<Doc>((value) => {
    const { title } = value as { title: string };
    return { value: { title: title.trim() } };
  });
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({
        locale: "en",
        path: "home",
        data: { title: "  Home  " },
      });
    }),
    schema: trimmed,
  });

  await syncCollection(store, pages);

  expect(store.getEntry<Doc>("pages", "en", "home")?.data).toEqual({
    title: "Home",
  });
});

test("a validator that returns a promise is awaited before anything is written", async () => {
  const store = openTempStore();
  const asyncSchema = handSchema<Doc>(async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { title } = value as { title?: unknown };
    return typeof title === "string"
      ? { value: { title: title.toUpperCase() } }
      : { issues: [{ path: ["title"], message: MISSING_TITLE }] };
  });
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
    }),
    schema: asyncSchema,
  });

  await syncCollection(store, pages);

  expect(store.getEntry<Doc>("pages", "en", "home")?.data).toEqual({
    title: "HOME",
  });
});

test("a validator that throws fails the sync, naming collection and entry", async () => {
  const store = openTempStore();
  const exploding = handSchema<Doc>(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    throw new Error("coercion blew up");
  });
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
    }),
    schema: exploding,
  });

  let failure: Error | undefined;
  try {
    await syncCollection(store, pages);
  } catch (error) {
    failure = error as Error;
  }

  expect(failure?.message).toBe(
    'Collection "pages": schema threw validating entry "en/home"',
  );
  expect(failure?.cause).toMatchObject({ message: "coercion blew up" });
  expect(store.getEntry("pages", "en", "home")).toBeUndefined();
  expect(store.getCursor("pages")).toBeUndefined();
});

test("a synchronous validator that throws is wrapped the same way", async () => {
  const store = openTempStore();
  const exploding = handSchema<Doc>(() => {
    throw new Error("coercion blew up");
  });
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "de", path: "pricing", data: { title: "P" } });
    }),
    schema: exploding,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    'Collection "pages": schema threw validating entry "de/pricing"',
  );
});

test("a delete is not validated", async () => {
  const store = openTempStore();
  const rejectAll = handSchema<Doc>(() => ({
    issues: [{ message: "nothing is acceptable" }],
  }));
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.delete({ locale: "en", path: "gone" });
    }),
    schema: rejectAll,
  });

  const result = await syncCollection(store, pages);

  expect(result.deleted).toEqual([{ locale: "en", path: "gone" }]);
  expect(store.getCursor("pages")).toBe(result.cursor);
});

test("an issue with no path names the entry itself", async () => {
  const store = openTempStore();
  const rejectAll = handSchema<Doc>(() => ({
    issues: [{ message: "expected an object" }],
  }));
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
    }),
    schema: rejectAll,
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    "  /en/home: (whole entry) — expected an object",
  );
});

test("a collection with no schema stores whatever the loader wrote", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({ locale: "en", path: "home", data: {} as unknown as Doc });
    }),
    schema: false,
  });

  await syncCollection(store, pages);

  expect(store.getEntry<Doc>("pages", "en", "home")?.data).toEqual({});
});

test("schema: false syncs and reads back exactly what the loader wrote", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "a", "A");
  loader.put("de", "b", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });

  const result = await syncCollection(store, pages);

  expect(result.changed).toEqual([
    { locale: "en", path: "a" },
    { locale: "de", path: "b" },
  ]);
  expect(getEntry(store, pages, { locale: "en", path: "a" })?.data).toEqual({
    title: "A",
  });
  expect(listEntries(store, pages).map((entry) => entry.data)).toEqual([
    { title: "B" },
    { title: "A" },
  ]);
});

test("schema: false caches what fetchOne returned without validating it", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: fetchOnlyLoader(() => ({}) as unknown as Doc),
    schema: false,
  });

  const entry = await getEntryCached(store, pages, {
    locale: "en",
    path: "home",
  });

  expect(entry?.data).toEqual({});
  expect(store.getEntry<Doc>("pages", "en", "home")?.data).toEqual({});
});

test("defineCollection refuses a collection that declares no schema, naming it", () => {
  // The cast is the point: a plain-JavaScript caller gets past the required `schema`.
  const untyped = { name: "pages", loader: emptyLoader() } as never;

  expect(() => defineCollection(untyped)).toThrow(CollectionError);
  expect(() => defineCollection(untyped)).toThrow(
    'Collection "pages": declares no schema, so nothing checks what the loader hands over — declare a Standard Schema to validate its entries, or schema: false to store them unchecked',
  );
});

test("syncCollection refuses a collection built without defineCollection that declares no schema", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const raw = { name: "raw", loader } as unknown as Collection<Doc>;

  await expect(syncCollection(store, raw)).rejects.toThrow(CollectionError);
  await expect(syncCollection(store, raw)).rejects.toThrow(
    'Collection "raw": declares no schema, so nothing checks what the loader hands over — declare a Standard Schema to validate its entries, or schema: false to store them unchecked',
  );
});

function fetchOnlyLoader(answer: () => Doc | undefined): Loader<Doc> {
  return {
    syncAll(): SyncResult {
      return { changed: [], deleted: [], cursor: 0 };
    },
    syncSince(): SyncResult {
      return { changed: [], deleted: [], cursor: 0 };
    },
    fetchOne(): Doc | undefined {
      return answer();
    },
  };
}

test("getEntryCached runs the schema over what fetchOne returned, writing nothing on a failure", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: fetchOnlyLoader(() => ({}) as unknown as Doc),
    schema: titledSchema,
  });

  let failure: Error | undefined;
  try {
    await getEntryCached(store, pages, { locale: "de", path: "pricing" });
  } catch (error) {
    failure = error as Error;
  }

  expect(failure?.message).toBe(
    'Collection "pages": 1 entry does not match the collection schema — fix the content, or relax the schema:\n' +
      `  /de/pricing: title — ${MISSING_TITLE}`,
  );
  expect(store.getEntry("pages", "de", "pricing")).toBeUndefined();
});

test("every issue on one fetched entry is reported at once", async () => {
  const store = openTempStore();
  const strict = handSchema<Doc>(() => ({
    issues: [
      { path: [{ key: "hero" }, { key: "title" }], message: "missing" },
      { path: ["layout"], message: "missing" },
    ],
  }));
  const pages = defineCollection({
    name: "pages",
    loader: fetchOnlyLoader(() => ({ title: "P" })),
    schema: strict,
  });

  await expect(
    getEntryCached(store, pages, { locale: "de", path: "pricing" }),
  ).rejects.toThrow(
    'Collection "pages": 1 entry does not match the collection schema — fix the content, or relax the schema:\n' +
      "  /de/pricing: hero.title — missing\n" +
      "  /de/pricing: layout — missing",
  );
});

test("a schema that throws on a fetched entry is wrapped the same way sync wraps it", async () => {
  const store = openTempStore();
  const exploding = handSchema<Doc>(() => {
    throw new Error("coercion blew up");
  });
  const pages = defineCollection({
    name: "pages",
    loader: fetchOnlyLoader(() => ({ title: "Home" })),
    schema: exploding,
  });

  let failure: Error | undefined;
  try {
    await getEntryCached(store, pages, { locale: "en", path: "home" });
  } catch (error) {
    failure = error as Error;
  }

  expect(failure?.message).toBe(
    'Collection "pages": schema threw validating entry "en/home"',
  );
  expect(failure?.cause).toMatchObject({ message: "coercion blew up" });
  expect(store.getEntry("pages", "en", "home")).toBeUndefined();
});

test("the schema's output value is what getEntryCached caches", async () => {
  const store = openTempStore();
  const trimmed = handSchema<Doc>((value) => {
    const { title } = value as { title: string };
    return { value: { title: title.trim() } };
  });
  const pages = defineCollection({
    name: "pages",
    loader: fetchOnlyLoader(() => ({ title: "  Home  " })),
    schema: trimmed,
  });

  const entry = await getEntryCached(store, pages, {
    locale: "en",
    path: "home",
  });

  expect(entry?.data).toEqual({ title: "Home" });
  expect(store.getEntry<Doc>("pages", "en", "home")?.data).toEqual({
    title: "Home",
  });
});

test("a zod schema validates entries and names the offending field", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: orderedLoader((writer) => {
      writer.upsert({
        locale: "de",
        path: "pricing",
        data: {} as unknown as Doc,
      });
    }),
    schema: z.object({ title: z.string() }),
  });

  await expect(syncCollection(store, pages)).rejects.toThrow(
    /\/de\/pricing: title — /,
  );
});

test("a schema infers the collection's entry type", async () => {
  const store = openTempStore();
  const schema = z.object({ title: z.string(), views: z.number() });
  const pages = defineCollection({
    name: "pages",
    loader: emptyLoader(),
    schema,
  });

  expectTypeOf(pages).toEqualTypeOf<
    Collection<{ title: string; views: number }, never>
  >();
  expectTypeOf(
    getEntry(store, pages, { locale: "en", path: "home" }),
  ).toEqualTypeOf<Entry<{ title: string; views: number }> | undefined>();
  expectTypeOf(listEntries(store, pages)).toEqualTypeOf<
    Entry<{ title: string; views: number }>[]
  >();
  expectTypeOf(
    await getEntryCached(store, pages, { locale: "en", path: "home" }),
  ).toEqualTypeOf<Entry<{ title: string; views: number }> | undefined>();
});

type WideDoc = { frontmatter: Record<string, string> };

type NarrowDoc = { frontmatter: { section: "how-to" | "reference" } };

function wideLoader(section: string): Loader<WideDoc> {
  const data: WideDoc = { frontmatter: { section } };
  const run = (writer: CollectionWriter<WideDoc>): SyncResult => {
    writer.upsert({ locale: "en", path: "guide", data });
    return {
      changed: [{ locale: "en", path: "guide" }],
      deleted: [],
      cursor: 1,
    };
  };
  return { syncAll: run, syncSince: run, fetchOne: () => data };
}

function narrowingSchema(): StandardSchemaV1<unknown, NarrowDoc> {
  return z.object({
    frontmatter: z.object({ section: z.enum(["how-to", "reference"]) }),
  });
}

test("a schema narrows the loader's entry type, and a read gives the narrow one", async () => {
  const store = openTempStore();
  const docs = defineCollection({
    name: "docs",
    loader: wideLoader("how-to"),
    schema: narrowingSchema(),
  });

  await syncCollection(store, docs);

  const entry = getEntry(store, docs, { locale: "en", path: "guide" });
  expect(entry?.data.frontmatter.section).toBe("how-to");
  expectTypeOf(entry).toEqualTypeOf<Entry<NarrowDoc> | undefined>();
  expectTypeOf(listEntries(store, docs)).toEqualTypeOf<Entry<NarrowDoc>[]>();
});

test("a fetchOne is validated into the narrow type the way a sync's writes are", async () => {
  const store = openTempStore();
  const docs = defineCollection({
    name: "docs",
    loader: wideLoader("how-to"),
    schema: narrowingSchema(),
  });

  const entry = await getEntryCached(store, docs, {
    locale: "en",
    path: "guide",
  });

  expect(entry?.data.frontmatter.section).toBe("how-to");
  expectTypeOf(entry).toEqualTypeOf<Entry<NarrowDoc> | undefined>();
});

test("a wide value the narrowing schema refuses is refused by name", async () => {
  const store = openTempStore();
  const docs = defineCollection({
    name: "docs",
    loader: wideLoader("nonsense"),
    schema: narrowingSchema(),
  });

  await expect(syncCollection(store, docs)).rejects.toThrow(
    /\/en\/guide: frontmatter\.section — /,
  );
});

test("a collection with no schema cannot claim a read type its loader does not produce", () => {
  const claiming: Collection<NarrowDoc, WideDoc> = {
    name: "docs",
    loader: wideLoader("how-to"),
    // @ts-expect-error `false` is only a schema when the two entry types agree.
    schema: false,
  };

  defineCollection<NarrowDoc>({
    name: "docs",
    // @ts-expect-error the loader does not produce the entry type claimed here.
    loader: wideLoader("how-to"),
    schema: false,
  });

  expect(claiming.name).toBe("docs");
});

test("getEntry and listEntries read a synced collection", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "a", "A");
  loader.put("de", "b", "B");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  await syncCollection(store, pages);

  expect(getEntry(store, pages, { locale: "en", path: "a" })?.data).toEqual({
    title: "A",
  });
  expect(getEntry(store, pages, { locale: "en", path: "gone" })).toBeUndefined();
  expect(listEntries(store, pages).map((entry) => entry.data)).toEqual([
    { title: "B" },
    { title: "A" },
  ]);
  expect(listEntries(store, pages, "en").map((entry) => entry.data)).toEqual([
    { title: "A" },
  ]);
});

test("getEntry does not fall back to the loader", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  const fetchOne = vi.spyOn(loader, "fetchOne");

  expect(getEntry(store, pages, { locale: "en", path: "a" })).toBeUndefined();
  expect(fetchOne).not.toHaveBeenCalled();
});

test("a collection with no schema infers its entry type from the loader", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: toyLoader(),
    schema: false,
  });

  expectTypeOf(
    await getEntryCached(store, pages, { locale: "en", path: "home" }),
  ).toEqualTypeOf<Entry<Doc> | undefined>();
});

function staticLoader<T>(
  entries: readonly { locale: string; path: string; data: T }[],
): Loader<T> {
  const run = (writer: CollectionWriter<T>): SyncResult => {
    for (const entry of entries) writer.upsert(entry);
    return {
      changed: entries.map(({ locale, path }) => ({ locale, path })),
      deleted: [],
      cursor: 1,
    };
  };
  return { syncAll: run, syncSince: run };
}

test("listDueEntries types a collection's due entries by the collection's schema", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({ title: z.string(), publish_at: z.string() }),
    publishField: "publish_at",
    loader: staticLoader([
      { locale: "en", path: "out", data: { title: "Out", publish_at: "2026-01-01T00:00:00Z" } },
      { locale: "en", path: "soon", data: { title: "Soon", publish_at: "2026-09-01T00:00:00Z" } },
    ]),
  });
  await syncCollection(store, collection);

  const due = listDueEntries(store, collection, "2026-06-01T00:00:00Z");

  expect(due.map((entry) => entry.data.title)).toEqual(["Out"]);
  expectTypeOf(due).toEqualTypeOf<Entry<{ title: string; publish_at: string }>[]>();
});

test("listDueEntries drops an entry past its unpublish field", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({ title: z.string(), unpublish_at: z.string() }),
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "expired",
        data: { title: "Expired", unpublish_at: "2026-01-01T00:00:00Z" },
      },
      {
        locale: "en",
        path: "live",
        data: { title: "Live", unpublish_at: "2026-09-01T00:00:00Z" },
      },
    ]),
  });
  await syncCollection(store, collection);

  const due = listDueEntries(store, collection, "2026-06-01T00:00:00Z");

  expect(due.map((entry) => entry.data.title)).toEqual(["Live"]);
});

test("listDueEntries refuses a collection that declares neither end of a window", async () => {
  const store = openTempStore();
  const collection = defineCollection<{ title: string }>({
    name: "posts",
    loader: staticLoader([{ locale: "en", path: "a", data: { title: "A" } }]),
    schema: false,
  });
  await syncCollection(store, collection);

  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(CollectionError);
  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(
    /Collection "posts": declares no publishField and no unpublishField/,
  );
});

test("listDueEntries refuses an entry whose unpublish field is before its publish field", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({
      title: z.string(),
      publish_at: z.string(),
      unpublish_at: z.string(),
    }),
    publishField: "publish_at",
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "transposed",
        data: {
          title: "Transposed",
          publish_at: "2030-01-01T00:00:00Z",
          unpublish_at: "2020-01-01T00:00:00Z",
        },
      },
    ]),
  });
  await syncCollection(store, collection);

  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(CollectionError);
  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(
    'Collection "posts": 1 entry has an unpublishField instant at or before its publishField instant — fix the two instants, or declare only one end of the window:\n' +
      '  /en/transposed: unpublishField "unpublish_at" (2020-01-01T00:00:00Z) is at or before publishField "publish_at" (2030-01-01T00:00:00Z)',
  );
});

test("listDueEntries refuses an entry whose unpublish field equals its publish field", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({
      title: z.string(),
      publish_at: z.string(),
      unpublish_at: z.string(),
    }),
    publishField: "publish_at",
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "equal",
        data: {
          title: "Equal",
          publish_at: "2025-01-01T00:00:00Z",
          unpublish_at: "2025-01-01T00:00:00Z",
        },
      },
    ]),
  });
  await syncCollection(store, collection);

  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(CollectionError);
  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(
    'Collection "posts": 1 entry has an unpublishField instant at or before its publishField instant — fix the two instants, or declare only one end of the window:\n' +
      '  /en/equal: unpublishField "unpublish_at" (2025-01-01T00:00:00Z) is at or before publishField "publish_at" (2025-01-01T00:00:00Z)',
  );
});

test("listDueEntries names every offending entry in one report, not just the first", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({
      title: z.string(),
      publish_at: z.string(),
      unpublish_at: z.string(),
    }),
    publishField: "publish_at",
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "sane",
        data: {
          title: "Sane",
          publish_at: "2020-01-01T00:00:00Z",
          unpublish_at: "2030-01-01T00:00:00Z",
        },
      },
      {
        locale: "en",
        path: "transposed",
        data: {
          title: "Transposed",
          publish_at: "2030-01-01T00:00:00Z",
          unpublish_at: "2020-01-01T00:00:00Z",
        },
      },
      {
        locale: "en",
        path: "equal",
        data: {
          title: "Equal",
          publish_at: "2025-01-01T00:00:00Z",
          unpublish_at: "2025-01-01T00:00:00Z",
        },
      },
    ]),
  });
  await syncCollection(store, collection);

  expect(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  ).toThrow(
    'Collection "posts": 2 entries have an unpublishField instant at or before their publishField instant — fix the two instants, or declare only one end of the window:\n' +
      '  /en/equal: unpublishField "unpublish_at" (2025-01-01T00:00:00Z) is at or before publishField "publish_at" (2025-01-01T00:00:00Z)\n' +
      '  /en/transposed: unpublishField "unpublish_at" (2020-01-01T00:00:00Z) is at or before publishField "publish_at" (2030-01-01T00:00:00Z)',
  );
});

test("listDueEntries does not check ordering when a collection declares only one end of the window", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({ title: z.string(), publish_at: z.string() }),
    publishField: "publish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "a",
        data: { title: "A", publish_at: "2020-01-01T00:00:00Z" },
      },
    ]),
  });
  await syncCollection(store, collection);

  expect(
    listDueEntries(store, collection, "2026-06-01T00:00:00Z").map(
      (entry) => entry.data.title,
    ),
  ).toEqual(["A"]);
});

test("listDueEntries does not refuse an entry with either end of the window null or absent", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: z.object({
      title: z.string(),
      publish_at: z.string().nullable().optional(),
      unpublish_at: z.string().nullable().optional(),
    }),
    publishField: "publish_at",
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: "start-only",
        data: { title: "Start only", publish_at: "2020-01-01T00:00:00Z" },
      },
      {
        locale: "en",
        path: "null-end",
        data: {
          title: "Null end",
          publish_at: "2020-01-01T00:00:00Z",
          unpublish_at: null,
        },
      },
      {
        locale: "en",
        path: "end-only",
        data: { title: "End only", unpublish_at: "2030-01-01T00:00:00Z" },
      },
      {
        locale: "en",
        path: "null-start",
        data: {
          title: "Null start",
          publish_at: null,
          unpublish_at: "2030-01-01T00:00:00Z",
        },
      },
    ]),
  });
  await syncCollection(store, collection);

  expect(
    listDueEntries(store, collection, "2026-06-01T00:00:00Z").map(
      (entry) => entry.data.title,
    ),
  ).toEqual(["End only", "Null end", "Null start", "Start only"]);
});

function feedlessLoader(
  present: ReadonlySet<string>,
  authoritative?: boolean,
): Loader<Doc> {
  const walk = (writer: CollectionWriter<Doc>): SyncResult => {
    const changed: EntryId[] = [];
    for (const path of present) {
      writer.upsert({ locale: "en", path, data: { title: path } });
      changed.push({ locale: "en", path });
    }
    // Spread, so an omitted argument leaves no `authoritative` key, as older loaders return.
    return {
      changed,
      deleted: [],
      cursor: 1,
      ...(authoritative === undefined ? {} : { authoritative }),
    };
  };
  return { syncAll: walk, syncSince: walk };
}

test("an authoritative full sync removes every entry it did not report", async () => {
  const store = openTempStore();
  const present = new Set(["a", "b"]);
  const pages = defineCollection({
    name: "pages",
    loader: feedlessLoader(present, true),
    schema: false,
  });
  await syncCollection(store, pages);

  present.delete("b");
  const result = await syncCollection(store, pages);

  expect(result.changed.map((id) => id.path)).toEqual(["a"]);
  expect(store.getEntry("pages", "en", "b")).toBeUndefined();
  expect(store.getEntry<Doc>("pages", "en", "a")?.data).toEqual({ title: "a" });
});

test("a full sync that is not authoritative removes nothing", async () => {
  const store = openTempStore();
  const present = new Set(["a", "b"]);
  const pages = defineCollection({
    name: "pages",
    loader: feedlessLoader(present, false),
    schema: false,
  });
  await syncCollection(store, pages);

  present.delete("b");
  await syncCollection(store, pages);

  expect(store.getEntry<Doc>("pages", "en", "b")?.data).toEqual({ title: "b" });
});

test("a full sync that never mentions the flag removes nothing", async () => {
  const store = openTempStore();
  const present = new Set(["a", "b"]);
  const pages = defineCollection({
    name: "pages",
    loader: feedlessLoader(present),
    schema: false,
  });
  await syncCollection(store, pages);

  present.delete("b");
  await syncCollection(store, pages);

  expect(store.getEntry<Doc>("pages", "en", "b")?.data).toEqual({ title: "b" });
});

test("an authoritative sync prunes against what the loader wrote, not what it later says", async () => {
  const store = openTempStore();
  const reported: EntryId[] = [{ locale: "en", path: "a" }];
  const loader: Loader<Doc> = {
    syncAll(writer) {
      writer.upsert({ locale: "en", path: "a", data: { title: "A" } });
      // Fires while the schema validates: a loader that keeps its reported array can grow it.
      setTimeout(() => reported.push({ locale: "en", path: "b" }), 0);
      return {
        changed: reported,
        deleted: [],
        cursor: 1,
        authoritative: true,
      };
    },
    syncSince(): SyncResult {
      throw new Error("unused");
    },
  };
  const pages = defineCollection({
    name: "pages",
    loader,
    // Accepts a macrotask later, which puts the push above before the replay.
    schema: handSchema<Doc>(
      (value) =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ value: value as Doc });
          }, 0);
        }),
    ),
  });
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "b",
    data: { title: "B" },
  });

  await syncCollection(store, pages);

  expect(store.getEntry("pages", "en", "b")).toBeUndefined();
});

test("an authoritative syncSince is refused, and applies nothing", async () => {
  const store = openTempStore();
  const present = new Set(["a"]);
  const pages = defineCollection({
    name: "pages",
    loader: feedlessLoader(present, true),
    schema: false,
  });
  const full = await syncCollection(store, pages);

  present.add("b");
  const run = syncCollectionSince(store, pages, full.cursor);

  await expect(run).rejects.toThrow(
    /Collection "pages": loader syncSince reported an authoritative sync/,
  );
  await expect(run).rejects.toBeInstanceOf(CollectionError);
  expect(store.getEntry("pages", "en", "b")).toBeUndefined();
});

test("an authoritative sync prunes only the collection it synced", async () => {
  const store = openTempStore();
  const present = new Set(["a"]);
  const pages = defineCollection({
    name: "pages",
    loader: feedlessLoader(present, true),
    schema: false,
  });
  const docs = defineCollection({
    name: "docs",
    loader: staticLoader([{ locale: "en", path: "kept", data: { title: "K" } }]),
    schema: false,
  });
  await syncCollection(store, docs);
  await syncCollection(store, pages);

  present.delete("a");
  await syncCollection(store, pages);

  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
  expect(store.getEntry<Doc>("docs", "en", "kept")?.data).toEqual({
    title: "K",
  });
});

test("an authoritative sync still deletes what its result names", async () => {
  const store = openTempStore();
  const loader = toyLoader();
  loader.put("en", "a", "A");
  const pages = defineCollection({ name: "pages", loader, schema: false });
  await syncCollection(store, pages);

  const authoritative: Loader<Doc> = {
    syncAll(writer) {
      writer.delete({ locale: "en", path: "a" });
      return {
        changed: [],
        deleted: [{ locale: "en", path: "a" }],
        cursor: 2,
        authoritative: true,
      };
    },
    syncSince(): SyncResult {
      throw new Error("unused");
    },
  };
  const result = await syncCollection(
    store,
    defineCollection({ name: "pages", loader: authoritative, schema: false }),
  );

  expect(result.deleted).toEqual([{ locale: "en", path: "a" }]);
  expect(store.getEntry("pages", "en", "a")).toBeUndefined();
});

interface Illustrated {
  title: string;
  images: string[];
}

function illustratedLoader(
  entries: readonly { locale: string; path: string; data: Illustrated }[],
): Loader<Illustrated> {
  return {
    syncAll(writer) {
      for (const entry of entries) writer.upsert(entry);
      return {
        changed: entries.map(({ locale, path }) => ({ locale, path })),
        deleted: [],
        cursor: 1,
      };
    },
    syncSince(): SyncResult {
      return { changed: [], deleted: [], cursor: 1 };
    },
  };
}

test("a sync probes each unique image source once, and a repeat sync probes none", async () => {
  const store = openTempStore();
  const asked: string[] = [];
  const collection: Collection<Illustrated> = {
    name: "pages",
    schema: false,
    loader: illustratedLoader([
      { locale: "en", path: "home", data: { title: "Home", images: ["/hero.jpg", "/logo.svg"] } },
      { locale: "de", path: "home", data: { title: "Start", images: ["/hero.jpg"] } },
    ]),
    imageColors: {
      extractSources: (entry) => entry.data.images,
      probe: (src) => {
        asked.push(src);
        return src === "/hero.jpg" ? "#2f3a28" : undefined;
      },
    },
  };

  await syncCollection(store, collection);

  expect([...asked].sort()).toEqual(["/hero.jpg", "/logo.svg"]);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");

  asked.length = 0;
  await syncCollection(store, collection);

  expect(asked).toEqual([]);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
});

test("a source the probe cannot reach leaves the sync successful and the entry written", async () => {
  const store = openTempStore();
  const warnings: string[] = [];
  const collection: Collection<Illustrated> = {
    name: "pages",
    schema: false,
    loader: illustratedLoader([
      { locale: "en", path: "home", data: { title: "Home", images: ["/hero.jpg", "/gone.jpg"] } },
    ]),
    imageColors: {
      extractSources: (entry) => entry.data.images,
      probe: (src) => {
        if (src === "/gone.jpg") throw new Error("502 Bad Gateway");
        return "#2f3a28";
      },
    },
  };

  const result = await syncCollection(store, collection, {
    onWarning: (message) => warnings.push(message),
  });

  expect(result.changed).toEqual([{ locale: "en", path: "home" }]);
  expect(store.getEntry("pages", "en", "home")).toBeDefined();
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
  expect(store.getImageColor("/gone.jpg")).toBeUndefined();
  expect(warnings).toEqual([
    'Collection "pages": 1 image source could not be probed for a dominant color, so it renders with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "/gone.jpg" — 502 Bad Gateway',
  ]);
});

test("a collection that declares no image colors probes nothing and syncs as before", async () => {
  const store = openTempStore();
  const collection: Collection<Illustrated> = {
    name: "pages",
    schema: false,
    loader: illustratedLoader([
      { locale: "en", path: "home", data: { title: "Home", images: ["/hero.jpg"] } },
    ]),
  };

  await syncCollection(store, collection);

  expect(store.getEntry("pages", "en", "home")).toBeDefined();
  expect(store.hasImageColor("/hero.jpg")).toBe(false);
});

test("an incremental sync re-probes a failed source of an entry that did not change", async () => {
  const store = openTempStore();
  const asked: string[] = [];
  let reachable = false;
  const collection: Collection<Illustrated> = {
    name: "pages",
    schema: false,
    loader: illustratedLoader([
      { locale: "en", path: "home", data: { title: "Home", images: ["/hero.jpg"] } },
    ]),
    imageColors: {
      extractSources: (entry) => entry.data.images,
      probe: (src) => {
        asked.push(src);
        if (!reachable) throw new Error("502 Bad Gateway");
        return "#2f3a28";
      },
    },
  };

  await syncCollection(store, collection);
  expect(asked).toEqual(["/hero.jpg"]);

  reachable = true;
  asked.length = 0;
  await syncCollectionSince(store, collection);

  expect(asked).toEqual(["/hero.jpg"]);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
});

test("an entry stored before a collection declared image colors is probed on the next sync", async () => {
  const store = openTempStore();
  const asked: string[] = [];
  const entries = [
    { locale: "en", path: "home", data: { title: "Home", images: ["/hero.jpg"] } },
  ];
  const without: Collection<Illustrated> = {
    name: "pages",
    schema: false,
    loader: illustratedLoader(entries),
  };

  await syncCollection(store, without);

  await syncCollectionSince(store, {
    ...without,
    imageColors: {
      extractSources: (entry) => entry.data.images,
      probe: (src) => {
        asked.push(src);
        return "#2f3a28";
      },
    },
  });

  expect(asked).toEqual(["/hero.jpg"]);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
});

// Each byte can rewrite or forge a terminal line (#730).
const HOSTILE = 'x\u001b[2K\rpagedeck: sync complete\n"\u009b2K';
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const RAW_CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

async function failureOf(run: () => unknown): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure, and the call returned");
}

test("a sync's unusable-id refusal prints a hostile id with its controls replaced", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: staticLoader([
      { locale: "en", path: `${HOSTILE}\u0000/../y`, data: { title: "T" } },
    ]),
    schema: false,
  });

  const failure = await failureOf(() => syncCollection(store, pages));

  expect(failure.message).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(failure.message.split("\n").slice(1)).toEqual([
    '  /en/x\ufffd[2K\ufffdpagedeck: sync complete\ufffd"\ufffd2K\ufffd/../y: its path holds a NUL and a ".."',
  ]);
});

test("a schema failure prints a hostile id, field and validator text with their controls replaced", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: staticLoader([{ locale: "en", path: HOSTILE, data: { title: "T" } }]),
    schema: handSchema<Doc>(() => ({
      issues: [{ path: ["ti\u001btle"], message: "received '\u001b[2K'" }],
    })),
  });

  const failure = await failureOf(() => syncCollection(store, pages));

  expect(failure.message).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(failure.message.split("\n").slice(1)).toEqual([
    "  /en/x\ufffd[2K\ufffdpagedeck: sync complete\ufffd\"\ufffd2K: ti\ufffdtle — received '\ufffd[2K'",
  ]);
});

test("a validator that throws on a hostile id names it through quoteIdentifier", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: staticLoader([{ locale: "en", path: HOSTILE, data: { title: "T" } }]),
    schema: handSchema<Doc>(() => {
      throw new Error("coercion blew up");
    }),
  });

  const failure = await failureOf(() => syncCollection(store, pages));

  expect(failure.message).not.toMatch(RAW_CONTROL);
  expect(failure.message).toBe(
    'Collection "pages": schema threw validating entry "en/x\\u001b[2K\\rpagedeck: sync complete\\n\\"\\u009b2K"',
  );
});

test("a write that fails on a hostile id names it through quoteIdentifier", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: staticLoader([{ locale: "en", path: HOSTILE, data: { title: "T" } }]),
    extractUsage: () => {
      throw new Error("usage blew up");
    },
    schema: false,
  });

  const failure = await failureOf(() => syncCollection(store, pages));

  expect(failure.message).not.toMatch(RAW_CONTROL);
  expect(failure.message).toBe(
    'Collection "pages": syncAll failed writing entry "en/x\\u001b[2K\\rpagedeck: sync complete\\n\\"\\u009b2K"',
  );
});

test("an undeclared template named by entry data is quoted through quoteIdentifier", async () => {
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: feedLoader({
      entries: [
        { locale: "en", path: "home", data: { mode: "template", template: HOSTILE } },
      ],
      deletions: [],
    }),
    templates: {
      templateOf: (entry) =>
        entry.data.mode === "template" ? entry.data.template : undefined,
      byTemplate: {},
    },
    schema: false,
  });

  const failure = await failureOf(() => syncCollection(store, pages));

  expect((failure.cause as Error).message).not.toMatch(RAW_CONTROL);
  expect((failure.cause as Error).message).toContain(
    'template "x\\u001b[2K\\rpagedeck: sync complete\\n\\"\\u009b2K" declares no component usage',
  );
});

test("a cached fetch's refusal of a hostile id names it through quoteIdentifier", async () => {
  const store = openTempStore();
  const pages = defineCollection({ name: "pages", loader: toyLoader(), schema: false });

  const failure = await failureOf(() =>
    getEntryCached<Doc>(store, pages, { locale: "en", path: `${HOSTILE}\u0000` }),
  );

  expect(failure.message).not.toMatch(RAW_CONTROL);
  expect(failure.message).toContain(
    'entry id "/en/x\\u001b[2K\\rpagedeck: sync complete\\n\\"\\u009b2K\\u0000" is not a usable identifier — its path holds a NUL —',
  );
});

test("an inverted publication window prints a hostile id with its controls replaced", async () => {
  const store = openTempStore();
  const collection = defineCollection({
    name: "posts",
    schema: false,
    publishField: "publish_at",
    unpublishField: "unpublish_at",
    loader: staticLoader([
      {
        locale: "en",
        path: HOSTILE,
        data: {
          publish_at: "2030-01-01T00:00:00Z",
          unpublish_at: "2020-01-01T00:00:00Z",
        },
      },
    ]),
  });
  await syncCollection(store, collection);

  const failure = await failureOf(() =>
    listDueEntries(store, collection, "2026-06-01T00:00:00Z"),
  );

  expect(failure.message).not.toMatch(RAW_CONTROL_BUT_NEWLINE);
  expect(failure.message.split("\n").slice(1)).toEqual([
    '  /en/x\ufffd[2K\ufffdpagedeck: sync complete\ufffd"\ufffd2K: unpublishField "unpublish_at" (2020-01-01T00:00:00Z) is at or before publishField "publish_at" (2030-01-01T00:00:00Z)',
  ]);
});
