import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { openStore, openStoreReadOnly } from "./store.js";
import type { ContentStore, Entry } from "./store.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-content-store-"));
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

test("an entry round-trips: upsert then get by (collection, locale, path)", () => {
  const store = openStore(tempDbPath());
  const data = { title: "Hello", tags: ["a", "b"], nested: { n: 1 } };
  store.upsertEntry({ collection: "posts", locale: "en", path: "hello", data });

  const entry = store.getEntry<typeof data>("posts", "en", "hello");
  expect(entry).toBeDefined();
  expect(entry?.collection).toBe("posts");
  expect(entry?.locale).toBe("en");
  expect(entry?.path).toBe("hello");
  expect(entry?.data).toEqual(data);
  store.close();
});

const MEASURED_DOORS = [
  "getEntry",
  "listEntries",
  "changedSince",
  "listDue",
  "listInvertedWindows",
] as const;

test("no accessor survives the store, on any read path that hands out an entry", () => {
  // Every reader hands out a fresh parse, never the written object, so a getter cannot be
  // authored in a CMS; that bounds #135's accepted residual to code in this process.
  const store = openTempStore();
  const card = {
    dangerouslySetInnerHTML: { __html: "<img src=x onerror=alert(1)>" },
  };
  let reads = 0;
  const data = {
    publish_at: "2020-01-01T00:00:00Z",
    unpublish_at: "2019-01-01T00:00:00Z",
    get card() {
      reads += 1;
      return card;
    },
  };
  expect(Object.getOwnPropertyDescriptor(data, "card")?.get).toBeDefined();

  store.upsertEntry({ collection: "pages", locale: "en", path: "home", data });

  const doors: [
    (typeof MEASURED_DOORS)[number],
    Entry<typeof data> | undefined,
  ][] = [
    ["getEntry", store.getEntry<typeof data>("pages", "en", "home")],
    ["listEntries", store.listEntries<typeof data>("pages")[0]],
    ["changedSince", store.changedSince<typeof data>(0)[0]],
    [
      "listDue",
      store.listDue<typeof data>(
        "pages",
        { publishField: "publish_at" },
        "2026-01-01T00:00:00Z",
      )[0],
    ],
    [
      "listInvertedWindows",
      store.listInvertedWindows<typeof data>(
        "pages",
        "publish_at",
        "unpublish_at",
      )[0]?.entry,
    ],
  ];

  expect(doors.map(([door]) => door)).toEqual([...MEASURED_DOORS]);

  for (const [door, entry] of doors) {
    // `Object.is`, not `.not.toBe(data)`: vitest would read the getter to render a diff.
    expect(Object.is(entry?.data, data), door).toBe(false);
    const descriptor = Object.getOwnPropertyDescriptor(
      entry?.data ?? {},
      "card",
    );
    expect(descriptor?.get, door).toBeUndefined();
    expect(descriptor?.value, door).toEqual(card);
  }

  expect(reads).toBe(1);
});

const STORE_MODULE = join(import.meta.dirname, "store.ts");

const READER = "export interface ContentStoreReader {";

function readerMethods(source: string): [string, string][] {
  const opening = source.indexOf(READER);
  expect(opening, `${READER} is not in store.ts`).toBeGreaterThan(-1);
  // Comments go before the braces are counted: a `}` inside one would close the interface
  // early.
  const rest = source
    .slice(opening + READER.length)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  let depth = 0;
  let end = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "{") depth += 1;
    else if (rest[i] === "}") {
      if (depth === 0) {
        end = i;
        break;
      }
      depth -= 1;
    }
  }
  const methods: [string, string][] = [];
  // Parameters are found by scanning: a regex dropped a member with nested angle brackets.
  for (const statement of rest.slice(0, end).split(";")) {
    const name = /^\s*(\w+)/.exec(statement);
    if (name === null) continue;
    const open = parametersOpenAt(statement, name[0].length);
    const close = open === -1 ? -1 : statement.indexOf(")", open);
    const colon = close === -1 ? -1 : statement.indexOf(":", close);
    if (colon === -1) continue;
    methods.push([
      name[1] ?? "",
      statement.slice(colon + 1).replace(/\s+/g, " ").trim(),
    ]);
  }
  return methods;
}

function parametersOpenAt(statement: string, from: number): number {
  let depth = 0;
  for (let i = from; i < statement.length; i += 1) {
    const char = statement[i];
    if (char === "<") depth += 1;
    else if (char === ">") depth -= 1;
    else if (char === "(" && depth === 0) return i;
  }
  return -1;
}

function doorsReport(declared: readonly string[]): string {
  const measured = new Set<string>(MEASURED_DOORS);
  const unmeasured = declared.filter((name) => !measured.has(name));
  const gone = [...measured].filter((name) => !declared.includes(name));
  const preamble =
    unmeasured.length > 0
      ? `Store doors: ContentStoreReader hands out an entry from ${unmeasured.join(", ")}, which "no accessor survives the store" does not walk`
      : `Store doors: "no accessor survives the store" walks ${gone.join(", ")}, which ContentStoreReader no longer declares as handing out an entry`;
  return `${preamble} — that test is what holds issue #135's accepted residual, that a getter cannot be authored in a CMS because every read is a fresh JSON.parse, and refusedNodeNames' docblock (@pagedeck/core's tree.tsx) rests on it. An unmeasured read path is a door onto that premise which can start answering with the pre-write object and take no test with it. Add the reader to MEASURED_DOORS and to the array that test walks, or remove it from both`;
}

// Classifies on the return type's name ending in `Entry`, deliberately over-broad.
test("every ContentStoreReader method handing out an entry is one that test walks", () => {
  const methods = readerMethods(readFileSync(STORE_MODULE, "utf8"));
  // A floor on the parse: `close` is the interface's last member.
  expect(methods.map(([name]) => name)).toContain("close");

  const declared = methods
    .filter(([, type]) => /Entry\b/.test(type))
    .map(([name]) => name);

  expect([...declared].sort(), doorsReport(declared)).toEqual(
    [...MEASURED_DOORS].sort(),
  );
});

test("listEntries returns a collection's entries, optionally filtered by locale", () => {
  const store = openStore(tempDbPath());
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  store.upsertEntry({ collection: "posts", locale: "pt", path: "a", data: 2 });
  store.upsertEntry({ collection: "docs", locale: "en", path: "a", data: 3 });

  const all = store.listEntries<number>("posts");
  expect(all.map((e) => [e.locale, e.path, e.data])).toEqual([
    ["en", "a", 1],
    ["pt", "a", 2],
  ]);

  const pt = store.listEntries<number>("posts", "pt");
  expect(pt.map((e) => e.data)).toEqual([2]);
  store.close();
});

test("changedSince returns exactly the entries written after the cursor", () => {
  const store = openStore(tempDbPath());
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  const cursor = store.getEntry("posts", "en", "a")?.seq;
  expect(cursor).toBeDefined();

  store.upsertEntry({ collection: "posts", locale: "en", path: "b", data: 2 });
  store.upsertEntry({ collection: "docs", locale: "en", path: "c", data: 3 });

  const changed = store.changedSince<number>(cursor ?? 0);
  expect(changed.map((e) => [e.collection, e.path])).toEqual([
    ["posts", "b"],
    ["docs", "c"],
  ]);
  expect(store.changedSince(0)).toHaveLength(3);
});

test("updating an entry moves it past an old cursor", () => {
  const store = openStore(tempDbPath());
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  store.upsertEntry({ collection: "posts", locale: "en", path: "b", data: 2 });
  const cursor = store.getEntry("posts", "en", "b")?.seq ?? 0;

  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 9 });
  const changed = store.changedSince<number>(cursor);
  expect(changed.map((e) => [e.path, e.data])).toEqual([["a", 9]]);
  store.close();
});

test("upserting identical data is a no-op: seq unchanged, not in changedSince", () => {
  const store = openStore(tempDbPath());
  const data = { title: "Hello", n: 1 };
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data });
  const seqBefore = store.getEntry("posts", "en", "a")?.seq ?? 0;

  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data });

  expect(store.getEntry("posts", "en", "a")?.seq).toBe(seqBefore);
  expect(store.changedSince(seqBefore)).toEqual([]);
  store.close();
});

test("seq stays monotonic after the max-seq row is deleted", () => {
  const path = tempDbPath();
  const store = openStore(path);
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  store.upsertEntry({ collection: "posts", locale: "en", path: "b", data: 2 });
  const deletedSeq = store.getEntry("posts", "en", "b")?.seq ?? 0;
  store.close();

  const raw = new DatabaseSync(path);
  raw.prepare("DELETE FROM entries WHERE path = ?").run("b");
  raw.close();

  const reopened = openStore(path);
  reopened.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "c",
    data: 3,
  });
  const newSeq = reopened.getEntry("posts", "en", "c")?.seq ?? 0;
  expect(newSeq).toBeGreaterThan(deletedSeq);
  reopened.close();
});

test("changedSince with a collection filter returns only that collection's later writes", () => {
  const store = openStore(tempDbPath());
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  store.upsertEntry({ collection: "docs", locale: "en", path: "a", data: 2 });
  const cursor = store.getEntry("docs", "en", "a")?.seq ?? 0;
  store.upsertEntry({ collection: "posts", locale: "en", path: "b", data: 3 });
  store.upsertEntry({ collection: "docs", locale: "en", path: "b", data: 4 });
  store.upsertEntry({ collection: "posts", locale: "en", path: "c", data: 5 });

  const changed = store.changedSince<number>(cursor, "posts");
  expect(changed.map((e) => [e.collection, e.path, e.data])).toEqual([
    ["posts", "b", 3],
    ["posts", "c", 5],
  ]);
  store.close();
});

test("per-collection cursors persist and read back", () => {
  const store = openStore(tempDbPath());
  expect(store.getCursor("posts")).toBeUndefined();
  store.setCursor("posts", 7);
  store.setCursor("docs", 3);
  expect(store.getCursor("posts")).toBe(7);
  store.setCursor("posts", 12);
  expect(store.getCursor("posts")).toBe(12);
  expect(store.getCursor("docs")).toBe(3);
  store.close();
});

test("usage records round-trip per component per entry", () => {
  const store = openStore(tempDbPath());
  const record = {
    component: "Hero",
    collection: "posts",
    locale: "en",
    path: "a",
    count: 2,
    foldScore: 1,
    depth: 3,
    isRoot: true,
  };
  store.upsertUsage(record);
  store.upsertUsage({ ...record, path: "b", isRoot: false });
  store.upsertUsage({ ...record, component: "Card" });

  expect(store.listUsage("Hero")).toEqual([
    record,
    { ...record, path: "b", isRoot: false },
  ]);
  store.upsertUsage({ ...record, count: 5 });
  expect(store.listUsage("Hero")).toHaveLength(2);
  expect(store.listUsage("Hero")[0]?.count).toBe(5);
  store.close();
});

test("getLastSeq does not move back when the newest entry is deleted, and a read-only copy reads it too", () => {
  const path = tempDbPath();
  const store = openStore(path);
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });
  store.upsertEntry({ collection: "posts", locale: "en", path: "b", data: 2 });
  const newest = store.getEntry("posts", "en", "b")?.seq ?? 0;
  expect(store.getLastSeq()).toBe(newest);

  expect(store.deleteEntry("posts", "en", "b")).toBe(true);
  expect(store.changedSince(0).at(-1)?.seq).toBeLessThan(newest);
  expect(store.getLastSeq()).toBe(newest);
  store.close();

  const copy = tempDbPath();
  copyFileSync(path, copy);
  const snapshot = openStoreReadOnly(copy);
  expect(snapshot.getLastSeq()).toBe(newest);
  snapshot.close();
});

test("a copied store file opens read-only and serves queries", () => {
  const original = tempDbPath();
  const store = openStore(original);
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "a",
    data: { title: "Hello" },
  });
  store.setCursor("posts", 1);
  store.close();

  const copy = tempDbPath();
  copyFileSync(original, copy);

  const snapshot = openStoreReadOnly(copy);
  expect(snapshot.getEntry("posts", "en", "a")?.data).toEqual({
    title: "Hello",
  });
  expect(snapshot.listEntries("posts")).toHaveLength(1);
  expect(snapshot.getCursor("posts")).toBe(1);
  snapshot.close();
});

test("getEntry returns undefined for a missing entry", () => {
  const store = openStore(tempDbPath());
  expect(store.getEntry("posts", "en", "missing")).toBeUndefined();
  store.close();
});

test("deleteEntry removes a row and reports whether one was there", () => {
  const store = openStore(tempDbPath());
  store.upsertEntry({ collection: "posts", locale: "en", path: "a", data: 1 });

  expect(store.deleteEntry("posts", "en", "a")).toBe(true);
  expect(store.getEntry("posts", "en", "a")).toBeUndefined();
  expect(store.deleteEntry("posts", "en", "a")).toBe(false);
  store.close();
});

test("clearUsage removes one entry's usage records and leaves the others", () => {
  const store = openTempStore();
  const record = {
    component: "Hero",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  };
  store.upsertUsage(record);
  store.upsertUsage({ ...record, component: "Card", foldScore: 1 });
  store.upsertUsage({ ...record, path: "about" });
  store.upsertUsage({ ...record, locale: "de" });

  store.clearUsage("pages", "en", "home");

  expect(store.listUsage("Hero")).toEqual([
    { ...record, locale: "de" },
    { ...record, path: "about" },
  ]);
  expect(store.listUsage("Card")).toEqual([]);
});

test("clearUsage's delete is served by an index, not a table scan", () => {
  // Asserts only that some index serves the delete, which is quadratic per sync without
  // one; today that is `usage_by_entry`.
  const path = tempDbPath();
  const store = openStore(path);
  store.close();

  const raw = new DatabaseSync(path);
  const plan = raw
    .prepare(
      "EXPLAIN QUERY PLAN DELETE FROM usage_records WHERE collection = ? AND locale = ? AND path = ?",
    )
    .all() as unknown as { detail: string }[];
  raw.close();

  const details = plan.map((row) => row.detail).join("\n");
  expect(details).toMatch(/SEARCH usage_records USING .*INDEX/);
  expect(details).not.toMatch(/SCAN usage_records/);
});

test("deleting an entry drops its usage records with it", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "home",
    data: 1,
  });
  store.upsertUsage({
    component: "Hero",
    collection: "pages",
    locale: "en",
    path: "home",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  });

  expect(store.deleteEntry("pages", "en", "home")).toBe(true);

  expect(store.listUsage("Hero")).toEqual([]);
});

test("rankUsage aggregates a component across entries and locales", () => {
  const store = openTempStore();
  const base = {
    collection: "pages",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  };
  store.upsertUsage({
    ...base,
    component: "Hero",
    locale: "en",
    path: "home",
    count: 2,
    foldScore: 0,
  });
  store.upsertUsage({
    ...base,
    component: "Hero",
    locale: "de",
    path: "home",
    count: 1,
    foldScore: 4,
  });

  expect(store.rankUsage()).toEqual([
    {
      component: "Hero",
      totalUsages: 3,
      storyCount: 2,
      avgPerStory: 1.5,
      avgFoldScore: 2,
    },
  ]);
});

test("rankUsage orders by total usages, then fold score, then name", () => {
  const store = openTempStore();
  const base = {
    collection: "pages",
    locale: "en",
    count: 1,
    depth: 0,
    isRoot: true,
  };
  store.upsertUsage({ ...base, component: "Rare", path: "a", foldScore: 0 });
  store.upsertUsage({ ...base, component: "Deep", path: "a", foldScore: 9 });
  store.upsertUsage({ ...base, component: "Deep", path: "b", foldScore: 9 });
  store.upsertUsage({ ...base, component: "High", path: "a", foldScore: 1 });
  store.upsertUsage({ ...base, component: "High", path: "b", foldScore: 1 });
  store.upsertUsage({ ...base, component: "Alike", path: "a", foldScore: 1 });
  store.upsertUsage({ ...base, component: "Alike", path: "b", foldScore: 1 });

  expect(store.rankUsage().map((row) => row.component)).toEqual([
    "Alike",
    "High",
    "Deep",
    "Rare",
  ]);
});

test("rankUsage drops excluded components from the ranking", () => {
  const store = openTempStore();
  const base = {
    collection: "pages",
    locale: "en",
    path: "home",
    count: 1,
    foldScore: 0,
    depth: 0,
    isRoot: true,
  };
  store.upsertUsage({ ...base, component: "Hero" });
  store.upsertUsage({ ...base, component: "DebugGrid" });

  expect(
    store.rankUsage(new Set(["DebugGrid"])).map((row) => row.component),
  ).toEqual(["Hero"]);
});

test("a transaction commits on return and rolls back on throw", () => {
  const store = openStore(tempDbPath());
  const written = store.transaction(() => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path: "a",
      data: 1,
    });
    return "ok";
  });
  expect(written).toBe("ok");
  expect(store.getEntry("posts", "en", "a")?.data).toBe(1);

  expect(() =>
    store.transaction(() => {
      store.upsertEntry({
        collection: "posts",
        locale: "en",
        path: "b",
        data: 2,
      });
      store.deleteEntry("posts", "en", "a");
      throw new Error("boom");
    }),
  ).toThrow("boom");

  expect(store.getEntry("posts", "en", "b")).toBeUndefined();
  expect(store.getEntry("posts", "en", "a")?.data).toBe(1);
  store.close();
});

test("an async transaction body is rejected, not silently committed", () => {
  const store = openStore(tempDbPath());

  expect(() =>
    store.transaction(async () => {
      store.upsertEntry({
        collection: "posts",
        locale: "en",
        path: "a",
        data: 1,
      });
    }),
  ).toThrow(/synchronous/);

  expect(store.getEntry("posts", "en", "a")).toBeUndefined();
  store.close();
});

test("an async body's post-await writes escape the transaction it lost", async () => {
  const store = openStore(tempDbPath());
  let finished: Promise<void> | undefined;

  expect(() =>
    store.transaction(() => {
      finished = (async () => {
        store.upsertEntry({
          collection: "posts",
          locale: "en",
          path: "before",
          data: 1,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        store.upsertEntry({
          collection: "posts",
          locale: "en",
          path: "after",
          data: 2,
        });
      })();
      return finished;
    }),
  ).toThrow(/synchronous/);

  await finished;

  expect(store.getEntry("posts", "en", "before")).toBeUndefined();
  expect(store.getEntry<number>("posts", "en", "after")?.data).toBe(2);
  store.close();
});

test("transactions nest: an inner rollback leaves the outer free to commit", () => {
  const store = openStore(tempDbPath());
  store.transaction(() => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path: "a",
      data: 1,
    });
    expect(() =>
      store.transaction(() => {
        store.upsertEntry({
          collection: "posts",
          locale: "en",
          path: "b",
          data: 2,
        });
        throw new Error("inner");
      }),
    ).toThrow("inner");
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path: "c",
      data: 3,
    });
  });

  expect(store.getEntry("posts", "en", "a")?.data).toBe(1);
  expect(store.getEntry("posts", "en", "b")).toBeUndefined();
  expect(store.getEntry("posts", "en", "c")?.data).toBe(3);
  store.close();
});

test("listDue returns entries whose publish field is at or before the given instant", () => {
  const store = openTempStore();
  const write = (path: string, publish_at?: string): void => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { title: path, publish_at },
    });
  };
  write("past", "2026-01-01T00:00:00Z");
  write("now", "2026-06-01T12:00:00Z");
  write("future", "2026-12-01T00:00:00Z");

  const due = store.listDue(
    "posts",
    { publishField: "publish_at" },
    "2026-06-01T12:00:00Z",
  );

  expect(due.map((entry) => entry.path)).toEqual(["now", "past"]);
});

test("listDue treats an entry with no publish field as unscheduled, so always due", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "evergreen",
    data: { title: "Evergreen" },
  });
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "explicitly-null",
    data: { title: "Null", publish_at: null },
  });

  expect(
    store
      .listDue("posts", { publishField: "publish_at" }, "1970-01-01T00:00:00Z")
      .map((e) => e.path),
  ).toEqual(["evergreen", "explicitly-null"]);
});

test("listDue is scoped to one collection", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "a",
    data: { publish_at: "2026-01-01T00:00:00Z" },
  });
  store.upsertEntry({
    collection: "pages",
    locale: "en",
    path: "b",
    data: { publish_at: "2026-01-01T00:00:00Z" },
  });

  expect(
    store
      .listDue("posts", { publishField: "publish_at" }, "2026-02-01T00:00:00Z")
      .map((e) => e.path),
  ).toEqual(["a"]);
});

test("listDue reads a nested publish field by its dotted name", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "a",
    data: { meta: { publish_at: "2026-01-01T00:00:00Z" } },
  });

  expect(
    store.listDue(
      "posts",
      { publishField: "meta.publish_at" },
      "2026-02-01T00:00:00Z",
    ),
  ).toHaveLength(1);
  expect(
    store.listDue(
      "posts",
      { publishField: "meta.publish_at" },
      "2025-02-01T00:00:00Z",
    ),
  ).toHaveLength(0);
});

test("listDue drops an entry whose unpublish field is at or before the given instant", () => {
  const store = openTempStore();
  const write = (path: string, unpublish_at: string): void => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { title: path, unpublish_at },
    });
  };
  write("expired", "2026-01-01T00:00:00Z");
  write("expiring-now", "2026-06-01T12:00:00Z");
  write("live", "2026-12-01T00:00:00Z");

  const due = store.listDue(
    "posts",
    { unpublishField: "unpublish_at" },
    "2026-06-01T12:00:00Z",
  );

  expect(due.map((entry) => entry.path)).toEqual(["live"]);
});

test("listDue treats an entry with no unpublish field as never expiring", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "evergreen",
    data: { title: "Evergreen" },
  });
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "explicitly-null",
    data: { title: "Null", unpublish_at: null },
  });

  expect(
    store
      .listDue(
        "posts",
        { unpublishField: "unpublish_at" },
        "2999-01-01T00:00:00Z",
      )
      .map((e) => e.path),
  ).toEqual(["evergreen", "explicitly-null"]);
});

test("listDue reads both ends of the window together", () => {
  const store = openTempStore();
  const write = (
    path: string,
    publish_at: string,
    unpublish_at: string,
  ): void => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { publish_at, unpublish_at },
    });
  };
  write("early", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
  write("open", "2026-01-01T00:00:00Z", "2026-12-01T00:00:00Z");
  write("late", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");

  expect(
    store
      .listDue(
        "posts",
        { publishField: "publish_at", unpublishField: "unpublish_at" },
        "2026-06-01T00:00:00Z",
      )
      .map((e) => e.path),
  ).toEqual(["open"]);
});

test("listInvertedWindows returns an entry whose unpublish field is before its publish field", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "transposed",
    data: {
      publish_at: "2030-01-01T00:00:00Z",
      unpublish_at: "2020-01-01T00:00:00Z",
    },
  });

  const inverted = store.listInvertedWindows(
    "posts",
    "publish_at",
    "unpublish_at",
  );

  expect(inverted).toEqual([
    {
      entry: expect.objectContaining({ path: "transposed" }),
      publishAt: "2030-01-01T00:00:00Z",
      unpublishAt: "2020-01-01T00:00:00Z",
    },
  ]);
});

test("listInvertedWindows returns an entry whose unpublish field equals its publish field", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "equal",
    data: {
      publish_at: "2025-01-01T00:00:00Z",
      unpublish_at: "2025-01-01T00:00:00Z",
    },
  });

  const inverted = store.listInvertedWindows(
    "posts",
    "publish_at",
    "unpublish_at",
  );

  expect(inverted.map((row) => row.entry.path)).toEqual(["equal"]);
});

test("listInvertedWindows returns every offending entry in the collection, not just the first", () => {
  const store = openTempStore();
  const write = (
    path: string,
    publish_at: string,
    unpublish_at: string,
  ): void => {
    store.upsertEntry({
      collection: "posts",
      locale: "en",
      path,
      data: { publish_at, unpublish_at },
    });
  };
  write("sane", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
  write("transposed", "2030-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
  write("equal", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");

  const inverted = store.listInvertedWindows(
    "posts",
    "publish_at",
    "unpublish_at",
  );

  expect(inverted.map((row) => row.entry.path)).toEqual([
    "equal",
    "transposed",
  ]);
});

test("listInvertedWindows ignores an entry with either end of the window null or absent", () => {
  const store = openTempStore();
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "start-only",
    data: { publish_at: "2020-01-01T00:00:00Z" },
  });
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "end-only",
    data: { unpublish_at: "2020-01-01T00:00:00Z" },
  });
  store.upsertEntry({
    collection: "posts",
    locale: "en",
    path: "null-end",
    data: {
      publish_at: "2020-01-01T00:00:00Z",
      unpublish_at: null,
    },
  });

  expect(
    store.listInvertedWindows("posts", "publish_at", "unpublish_at"),
  ).toEqual([]);
});

test("a dominant color round-trips per image source", () => {
  const store = openTempStore();

  store.setImageColor("/uploads/hero.jpg", "#2f3a28");

  expect(store.getImageColor("/uploads/hero.jpg")).toBe("#2f3a28");
  expect(store.hasImageColor("/uploads/hero.jpg")).toBe(true);
});

test("a source nobody has probed has no color and is not recorded as probed", () => {
  const store = openTempStore();

  expect(store.getImageColor("/uploads/hero.jpg")).toBeUndefined();
  expect(store.hasImageColor("/uploads/hero.jpg")).toBe(false);
});

test("a source probed with no color is recorded as probed and never asked again", () => {
  const store = openTempStore();

  store.setImageColor("/uploads/logo.svg", undefined);

  expect(store.getImageColor("/uploads/logo.svg")).toBeUndefined();
  expect(store.hasImageColor("/uploads/logo.svg")).toBe(true);
});

test("a later color for one source replaces the earlier one", () => {
  const store = openTempStore();

  store.setImageColor("/uploads/hero.jpg", "#2f3a28");
  store.setImageColor("/uploads/hero.jpg", "#101010");

  expect(store.getImageColor("/uploads/hero.jpg")).toBe("#101010");
});

test("a copied store file serves the colors it was closed holding", () => {
  const original = tempDbPath();
  const store = openStore(original);
  store.setImageColor("/uploads/hero.jpg", "#2f3a28");
  store.close();

  const copy = tempDbPath();
  copyFileSync(original, copy);

  const snapshot = openStoreReadOnly(copy);
  expect(snapshot.getImageColor("/uploads/hero.jpg")).toBe("#2f3a28");
  expect(snapshot.hasImageColor("/uploads/hero.jpg")).toBe(true);
  snapshot.close();
});

test("a store written before image colors existed reads as nothing cached", () => {
  const path = tempDbPath();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE entries (
    collection TEXT NOT NULL,
    locale TEXT NOT NULL,
    path TEXT NOT NULL,
    data TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (collection, locale, path)
  );`);
  old.close();

  const snapshot = openStoreReadOnly(path);
  try {
    expect(snapshot.getImageColor("/uploads/hero.jpg")).toBeUndefined();
    expect(snapshot.hasImageColor("/uploads/hero.jpg")).toBe(false);
  } finally {
    snapshot.close();
  }
});

test("a store opened for writing gains the color table and caches into it", () => {
  const path = tempDbPath();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE entries (collection TEXT, locale TEXT, path TEXT, data TEXT, seq INTEGER);");
  old.close();

  const store = openStore(path);
  openStores.push(store);
  store.setImageColor("/uploads/hero.jpg", "#2f3a28");

  expect(store.getImageColor("/uploads/hero.jpg")).toBe("#2f3a28");
});

test("a store written before the usage index gains it on the next writable open", () => {
  const path = tempDbPath();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE usage_records (
    component TEXT NOT NULL,
    collection TEXT NOT NULL,
    locale TEXT NOT NULL,
    path TEXT NOT NULL,
    count INTEGER NOT NULL,
    fold_score INTEGER NOT NULL,
    depth INTEGER NOT NULL,
    is_root INTEGER NOT NULL,
    PRIMARY KEY (component, collection, locale, path)
  );`);
  old.close();

  const explain =
    "EXPLAIN QUERY PLAN DELETE FROM usage_records WHERE collection = ? AND locale = ? AND path = ?";
  const before = new DatabaseSync(path);
  const beforePlan = (
    before.prepare(explain).all() as unknown as { detail: string }[]
  )
    .map((row) => row.detail)
    .join("\n");
  before.close();
  expect(beforePlan).toMatch(/SCAN usage_records/);

  const store = openStore(path);
  openStores.push(store);

  const after = new DatabaseSync(path);
  const afterPlan = (
    after.prepare(explain).all() as unknown as { detail: string }[]
  )
    .map((row) => row.detail)
    .join("\n");
  after.close();

  expect(afterPlan).toMatch(/SEARCH usage_records USING .*INDEX/);
  expect(afterPlan).not.toMatch(/SCAN usage_records/);
});
