import { DatabaseSync } from "node:sqlite";

export interface Entry<T = unknown> {
  collection: string;
  locale: string;
  path: string;
  data: T;
  /** Global monotonic write sequence; basis for changed-since cursors. */
  seq: number;
}

export interface ComponentUsage {
  component: string;
  count: number;
  /** Minimum pre-order position in the entry's tree; lower is higher on the page. */
  foldScore: number;
  depth: number;
  isRoot: boolean;
}

export interface UsageRecord extends ComponentUsage {
  collection: string;
  locale: string;
  path: string;
}

/** An entry is a "story" here: the ranking's unit is the page a component appears on. */
export interface ComponentRanking {
  component: string;
  totalUsages: number;
  storyCount: number;
  avgPerStory: number;
  avgFoldScore: number;
}

// A union, so a window with neither end is a type error.
export type PublishWindow =
  | { publishField: string; unpublishField?: string }
  | { publishField?: string; unpublishField: string };

export interface InvertedWindowEntry<T = unknown> {
  entry: Entry<T>;
  publishAt: string;
  unpublishAt: string;
}

export interface ContentStoreReader {
  getEntry<T = unknown>(
    collection: string,
    locale: string,
    path: string,
  ): Entry<T> | undefined;
  listEntries<T = unknown>(collection: string, locale?: string): Entry<T>[];
  /** Entries written after `cursor` (a previous `seq` or `getLastSeq()`), oldest first. */
  changedSince<T = unknown>(cursor: number, collection?: string): Entry<T>[];
  getCursor(collection: string): number | undefined;
  /**
   * Never moves backwards: a delete leaves it, and every upsert, a no-op one included,
   * advances it.
   */
  getLastSeq(): number;
  /**
   * Half-open window: in at `publishField`, out at `unpublishField`; an absent or null end
   * is unbounded. Timestamps compare as text, so write ISO-8601 UTC.
   */
  listDue<T = unknown>(
    collection: string,
    window: PublishWindow,
    now: string,
  ): Entry<T>[];
  listInvertedWindows<T = unknown>(
    collection: string,
    publishField: string,
    unpublishField: string,
  ): InvertedWindowEntry<T>[];
  listUsage(component: string): UsageRecord[];
  /**
   * `undefined` both when unprobed and when probed with no color; `hasImageColor` tells
   * them apart.
   */
  getImageColor(src: string): string | undefined;
  hasImageColor(src: string): boolean;
  /** Most-used first, ties broken on `avgFoldScore` then name, so the order is total. */
  rankUsage(exclude?: ReadonlySet<string>): ComponentRanking[];
  close(): void;
}

export interface ContentStore extends ContentStoreReader {
  /**
   * Byte-identical data leaves the row and its `seq` alone; the write counter still
   * advances.
   */
  upsertEntry(entry: {
    collection: string;
    locale: string;
    path: string;
    data: unknown;
  }): void;
  /** Removes the entry's usage records too. Returns whether an entry row was there. */
  deleteEntry(collection: string, locale: string, path: string): boolean;
  setCursor(collection: string, cursor: number): void;
  upsertUsage(record: UsageRecord): void;
  /** `undefined` records a source with no color; a failed probe is not recorded. */
  setImageColor(src: string, color: string | undefined): void;
  clearUsage(collection: string, locale: string, path: string): void;
  /**
   * Nests as savepoints. `fn` must be synchronous: writes after an `await` in it land
   * outside any transaction, so treat that error as unrecoverable.
   */
  transaction<T>(fn: () => T): T;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  collection TEXT NOT NULL,
  locale TEXT NOT NULL,
  path TEXT NOT NULL,
  data TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (collection, locale, path)
);
CREATE INDEX IF NOT EXISTS entries_seq ON entries (seq);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT NOT NULL PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('last_seq', 0);
CREATE TABLE IF NOT EXISTS cursors (
  collection TEXT NOT NULL PRIMARY KEY,
  cursor INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS image_colors (
  src TEXT NOT NULL PRIMARY KEY,
  color TEXT
);
CREATE TABLE IF NOT EXISTS usage_records (
  component TEXT NOT NULL,
  collection TEXT NOT NULL,
  locale TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL,
  fold_score INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  is_root INTEGER NOT NULL,
  PRIMARY KEY (component, collection, locale, path)
);
-- clearUsage deletes by entry, and the primary key above leads with component,
-- which that predicate cannot name — so without this index every clear scans
-- the whole table, once per entry a sync extracts. The cost is real and worth
-- stating: it is a second structure to maintain on every usage write, and the
-- store file is a snapshot artifact that gets pushed and pulled (#76, #118), so
-- what this index adds travels with it.
CREATE INDEX IF NOT EXISTS usage_by_entry ON usage_records (collection, locale, path);
`;

interface UsageRow {
  component: string;
  collection: string;
  locale: string;
  path: string;
  count: number;
  fold_score: number;
  depth: number;
  is_root: number;
}

interface RankingRow {
  component: string;
  total_usages: number;
  story_count: number;
  avg_fold_score: number;
}

interface EntryRow {
  collection: string;
  locale: string;
  path: string;
  data: string;
  seq: number;
}

function rowToEntry<T>(row: EntryRow): Entry<T> {
  return {
    collection: row.collection,
    locale: row.locale,
    path: row.path,
    data: JSON.parse(row.data) as T,
    seq: row.seq,
  };
}

function makeReader(db: DatabaseSync): ContentStoreReader {
  // Store files from before #44 lack the table, and a read-only open cannot create it;
  // no table means no color was ever cached.
  const hasColorTable =
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'image_colors'",
      )
      .get() !== undefined;

  return {
    getEntry<T>(collection: string, locale: string, path: string) {
      const row = db
        .prepare(
          "SELECT collection, locale, path, data, seq FROM entries WHERE collection = ? AND locale = ? AND path = ?",
        )
        .get(collection, locale, path) as EntryRow | undefined;
      return row === undefined ? undefined : rowToEntry<T>(row);
    },
    listEntries<T>(collection: string, locale?: string) {
      const rows = (
        locale === undefined
          ? db
              .prepare(
                "SELECT collection, locale, path, data, seq FROM entries WHERE collection = ? ORDER BY locale, path",
              )
              .all(collection)
          : db
              .prepare(
                "SELECT collection, locale, path, data, seq FROM entries WHERE collection = ? AND locale = ? ORDER BY path",
              )
              .all(collection, locale)
      ) as unknown as EntryRow[];
      return rows.map((row) => rowToEntry<T>(row));
    },
    changedSince<T>(cursor: number, collection?: string) {
      const rows = (
        collection === undefined
          ? db
              .prepare(
                "SELECT collection, locale, path, data, seq FROM entries WHERE seq > ? ORDER BY seq",
              )
              .all(cursor)
          : db
              .prepare(
                "SELECT collection, locale, path, data, seq FROM entries WHERE seq > ? AND collection = ? ORDER BY seq",
              )
              .all(cursor, collection)
      ) as unknown as EntryRow[];
      return rows.map((row) => rowToEntry<T>(row));
    },
    getCursor(collection: string) {
      const row = db
        .prepare("SELECT cursor FROM cursors WHERE collection = ?")
        .get(collection) as { cursor: number } | undefined;
      return row?.cursor;
    },
    getLastSeq() {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'last_seq'")
        .get() as { value: number } | undefined;
      return row?.value ?? 0;
    },
    listDue<T>(collection: string, window: PublishWindow, now: string) {
      // Paths are bound, never spliced into the SQL: they come from a config file.
      const bindings: string[] = [collection, now];
      const clauses: string[] = [];
      // `push` returns the new length, which is the parameter's 1-based position.
      const bound = (path: string): number => bindings.push(`$.${path}`);
      if (window.publishField !== undefined) {
        const at = bound(window.publishField);
        clauses.push(
          `AND (json_extract(data, ?${String(at)}) IS NULL
                OR json_extract(data, ?${String(at)}) <= ?2)`,
        );
      }
      if (window.unpublishField !== undefined) {
        const at = bound(window.unpublishField);
        clauses.push(
          `AND (json_extract(data, ?${String(at)}) IS NULL
                OR json_extract(data, ?${String(at)}) > ?2)`,
        );
      }
      // With neither end declared no clause reads `?2`, and SQLite refuses an unused binding.
      const rows = db
        .prepare(
          `SELECT collection, locale, path, data, seq FROM entries
           WHERE collection = ?1
             ${clauses.join("\n             ")}
           ORDER BY locale, path`,
        )
        .all(
          ...(clauses.length === 0 ? [collection] : bindings),
        ) as unknown as EntryRow[];
      return rows.map((row) => rowToEntry<T>(row));
    },
    listInvertedWindows<T>(
      collection: string,
      publishField: string,
      unpublishField: string,
    ) {
      const rows = db
        .prepare(
          `SELECT collection, locale, path, data, seq,
                  json_extract(data, ?2) AS publish_at,
                  json_extract(data, ?3) AS unpublish_at
           FROM entries
           WHERE collection = ?1
             AND json_extract(data, ?2) IS NOT NULL
             AND json_extract(data, ?3) IS NOT NULL
             AND json_extract(data, ?3) <= json_extract(data, ?2)
           ORDER BY locale, path`,
        )
        .all(
          collection,
          `$.${publishField}`,
          `$.${unpublishField}`,
        ) as unknown as (EntryRow & {
          publish_at: string;
          unpublish_at: string;
        })[];
      return rows.map((row) => ({
        entry: rowToEntry<T>(row),
        publishAt: row.publish_at,
        unpublishAt: row.unpublish_at,
      }));
    },
    getImageColor(src: string) {
      if (!hasColorTable) return undefined;
      const row = db
        .prepare("SELECT color FROM image_colors WHERE src = ?")
        .get(src) as { color: string | null } | undefined;
      // A probed source with no color is SQL NULL, the same answer as no row.
      return row?.color ?? undefined;
    },
    hasImageColor(src: string) {
      if (!hasColorTable) return false;
      const row = db
        .prepare("SELECT 1 AS present FROM image_colors WHERE src = ?")
        .get(src) as { present: number } | undefined;
      return row !== undefined;
    },
    listUsage(component: string) {
      const rows = db
        .prepare(
          "SELECT component, collection, locale, path, count, fold_score, depth, is_root FROM usage_records WHERE component = ? ORDER BY collection, locale, path",
        )
        .all(component) as unknown as UsageRow[];
      return rows.map((row) => ({
        component: row.component,
        collection: row.collection,
        locale: row.locale,
        path: row.path,
        count: row.count,
        foldScore: row.fold_score,
        depth: row.depth,
        isRoot: row.is_root !== 0,
      }));
    },
    rankUsage(exclude?: ReadonlySet<string>) {
      const rows = db
        .prepare(
          `SELECT component,
                  SUM(count) AS total_usages,
                  COUNT(*) AS story_count,
                  AVG(fold_score) AS avg_fold_score
           FROM usage_records
           GROUP BY component
           ORDER BY total_usages DESC, avg_fold_score ASC, component ASC`,
        )
        .all() as unknown as RankingRow[];
      return rows
        .filter((row) => exclude?.has(row.component) !== true)
        .map((row) => ({
          component: row.component,
          totalUsages: row.total_usages,
          storyCount: row.story_count,
          avgPerStory: row.total_usages / row.story_count,
          avgFoldScore: row.avg_fold_score,
        }));
    },
    close() {
      db.close();
    },
  };
}

/** The file is self-contained (no WAL sidecars), so a copy of a closed store is a snapshot. */
export function openStoreReadOnly(path: string): ContentStoreReader {
  return makeReader(new DatabaseSync(path, { readOnly: true }));
}

export function openStore(path: string): ContentStore {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  // Inner transactions are savepoints: node:sqlite rejects a nested BEGIN.
  let depth = 0;

  function transaction<T>(fn: () => T): T {
    const savepoint = `sp_${depth}`;
    const enter = depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`;
    const commit = depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`;
    const rollback =
      depth === 0
        ? "ROLLBACK"
        : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`;

    function undo(error: unknown): never {
      depth -= 1;
      try {
        db.exec(rollback);
      } catch {
        // A failed rollback must not mask what actually went wrong.
      }
      throw error;
    }

    db.exec(enter);
    depth += 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      undo(error);
    }
    const thenable = result as PromiseLike<unknown> | undefined;
    if (typeof thenable?.then === "function") {
      // The body keeps writing after its awaits; rolling back only bounds the damage.
      void Promise.resolve(result).catch(() => {});
      undo(
        new Error(
          "Store transaction body must be synchronous, not a promise — writes after its awaits escaped the transaction",
        ),
      );
    }
    depth -= 1;
    db.exec(commit);
    return result;
  }

  function clearUsage(collection: string, locale: string, path: string): void {
    db.prepare(
      "DELETE FROM usage_records WHERE collection = ? AND locale = ? AND path = ?",
    ).run(collection, locale, path);
  }

  return {
    ...makeReader(db),
    upsertEntry(entry) {
      // From a persistent counter, never live rows, so it stays monotonic after deletes.
      transaction(() => {
        const { value: seq } = db
          .prepare(
            "UPDATE meta SET value = value + 1 WHERE key = 'last_seq' RETURNING value",
          )
          .get() as unknown as { value: number };
        db.prepare(
          `INSERT INTO entries (collection, locale, path, data, seq)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (collection, locale, path) DO UPDATE SET
             data = excluded.data,
             seq = excluded.seq
           WHERE entries.data IS NOT excluded.data`,
        ).run(
          entry.collection,
          entry.locale,
          entry.path,
          JSON.stringify(entry.data),
          seq,
        );
      });
    },
    deleteEntry(collection, locale, path) {
      return transaction(() => {
        const { changes } = db
          .prepare(
            "DELETE FROM entries WHERE collection = ? AND locale = ? AND path = ?",
          )
          .run(collection, locale, path);
        clearUsage(collection, locale, path);
        return changes > 0;
      });
    },
    setCursor(collection, cursor) {
      db.prepare(
        `INSERT INTO cursors (collection, cursor) VALUES (?, ?)
         ON CONFLICT (collection) DO UPDATE SET cursor = excluded.cursor`,
      ).run(collection, cursor);
    },
    upsertUsage(record) {
      db.prepare(
        `INSERT INTO usage_records (component, collection, locale, path, count, fold_score, depth, is_root)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (component, collection, locale, path) DO UPDATE SET
           count = excluded.count,
           fold_score = excluded.fold_score,
           depth = excluded.depth,
           is_root = excluded.is_root`,
      ).run(
        record.component,
        record.collection,
        record.locale,
        record.path,
        record.count,
        record.foldScore,
        record.depth,
        record.isRoot ? 1 : 0,
      );
    },
    clearUsage,
    setImageColor(src, color) {
      db.prepare(
        `INSERT INTO image_colors (src, color) VALUES (?, ?)
         ON CONFLICT (src) DO UPDATE SET color = excluded.color`,
      ).run(src, color ?? null);
    },
    transaction,
  };
}
