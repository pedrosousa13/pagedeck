import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  CollectionWriter,
  EntryId,
  Loader,
  SyncResult,
} from "@pagedeck/content";

// The revision lives in the file because a checkout rewrites mtimes, and a deletion
// is a tombstone file because a loader's writer is write-only.
export interface FixtureFile<T> {
  rev: number;
  deleted?: boolean;
  data?: T;
}

type FixtureEntry<T> =
  | { id: EntryId; rev: number; deleted: true }
  | { id: EntryId; rev: number; deleted: false; data: T };

function invalidFixture(file: string, problem: string, cause?: unknown): Error {
  return new Error(`Fixture "${file}": ${problem}`, { cause });
}

function readFixture<T>(file: string, id: EntryId): FixtureEntry<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw invalidFixture(file, "is not valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidFixture(file, "must contain a JSON object");
  }

  const fixture = parsed as FixtureFile<T>;
  if (!Number.isInteger(fixture.rev) || fixture.rev < 1) {
    throw invalidFixture(file, 'needs a positive integer "rev"');
  }
  if (fixture.deleted === true) {
    return { id, rev: fixture.rev, deleted: true };
  }
  if (fixture.data === undefined) {
    throw invalidFixture(file, 'needs "data", or "deleted": true');
  }
  return { id, rev: fixture.rev, deleted: false, data: fixture.data };
}

// Sorted: golden tests downstream depend on a stable write order.
function readAll<T>(directory: string): FixtureEntry<T>[] {
  const entries: FixtureEntry<T>[] = [];

  function walk(locale: string, dir: string, prefix: string): void {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, child.name);
      if (child.isDirectory()) {
        walk(locale, full, `${prefix}${child.name}/`);
      } else if (child.name.endsWith(".json")) {
        const path = `${prefix}${child.name.slice(0, -".json".length)}`;
        entries.push(readFixture<T>(full, { locale, path }));
      }
    }
  }

  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (child.isDirectory()) {
      walk(child.name, join(directory, child.name), "");
    }
  }

  entries.sort(
    (a, b) =>
      a.id.locale.localeCompare(b.id.locale) ||
      a.id.path.localeCompare(b.id.path),
  );
  return entries;
}

export function createFixtureLoader<T>(directory: string): Loader<T> {
  return {
    // Replays tombstones too, so a store synced before a deletion converges.
    syncAll(writer: CollectionWriter<T>): SyncResult {
      const changed: EntryId[] = [];
      const deleted: EntryId[] = [];
      let cursor = 0;
      for (const entry of readAll<T>(directory)) {
        cursor = Math.max(cursor, entry.rev);
        if (entry.deleted) {
          writer.delete(entry.id);
          deleted.push(entry.id);
        } else {
          writer.upsert({ ...entry.id, data: entry.data });
          changed.push(entry.id);
        }
      }
      return { changed, deleted, cursor };
    },
    syncSince(writer: CollectionWriter<T>, cursor: number): SyncResult {
      const changed: EntryId[] = [];
      const deleted: EntryId[] = [];
      let next = cursor;
      for (const entry of readAll<T>(directory)) {
        next = Math.max(next, entry.rev);
        if (entry.rev <= cursor) continue;
        if (entry.deleted) {
          writer.delete(entry.id);
          deleted.push(entry.id);
        } else {
          writer.upsert({ ...entry.id, data: entry.data });
          changed.push(entry.id);
        }
      }
      return { changed, deleted, cursor: next };
    },
    fetchOne(id: EntryId): T | undefined {
      const file = join(directory, id.locale, `${id.path}.json`);
      if (!existsSync(file)) return undefined;
      const entry = readFixture<T>(file, id);
      return entry.deleted ? undefined : entry.data;
    },
  };
}
