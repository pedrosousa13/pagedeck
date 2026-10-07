import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  defineCollection,
  getEntryCached,
  openStore,
  syncCollection,
} from "@pagedeck/content";
import type { CollectionWriter, ContentStore, EntryId } from "@pagedeck/content";
import { createFixtureLoader } from "./loader.js";

const tempDirs: string[] = [];

function tempFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-fixtures-"));
  tempDirs.push(dir);
  return dir;
}

const openStores: ContentStore[] = [];

function openTempStore(): ContentStore {
  const store = openStore(join(tempFixtureDir(), "content.db"));
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

function writeFixture(dir: string, relative: string, body: unknown): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

interface Doc {
  title: string;
}

const heroSchema = z.object({ hero: z.object({ title: z.string() }) });
type Hero = z.infer<typeof heroSchema>;

function recordingWriter(): CollectionWriter<Doc> & {
  upserts: { id: EntryId; data: Doc }[];
  deletes: EntryId[];
} {
  const upserts: { id: EntryId; data: Doc }[] = [];
  const deletes: EntryId[] = [];
  return {
    upserts,
    deletes,
    upsert({ locale, path, data }) {
      upserts.push({ id: { locale, path }, data });
    },
    delete(id) {
      deletes.push(id);
    },
  };
}

test("syncAll upserts every live fixture, keyed by locale directory and file path", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "en/legal/terms.json", { rev: 4, data: { title: "Terms" } });
  writeFixture(dir, "de/home.json", { rev: 2, data: { title: "Startseite" } });

  const writer = recordingWriter();
  const result = await createFixtureLoader<Doc>(dir).syncAll(writer);

  expect(writer.upserts).toEqual([
    { id: { locale: "de", path: "home" }, data: { title: "Startseite" } },
    { id: { locale: "en", path: "home" }, data: { title: "Home" } },
    { id: { locale: "en", path: "legal/terms" }, data: { title: "Terms" } },
  ]);
  expect(result.changed).toEqual(writer.upserts.map((u) => u.id));
  expect(result.cursor).toBe(4);
});

test("syncAll deletes tombstoned fixtures, so a full re-sync converges", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "en/gone.json", { rev: 7, deleted: true });

  const writer = recordingWriter();
  const result = await createFixtureLoader<Doc>(dir).syncAll(writer);

  expect(writer.upserts.map((u) => u.id.path)).toEqual(["home"]);
  expect(writer.deletes).toEqual([{ locale: "en", path: "gone" }]);
  expect(result.deleted).toEqual([{ locale: "en", path: "gone" }]);
  expect(result.cursor).toBe(7);
});

test("syncSince replays only fixtures revised after the cursor", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "en/about.json", { rev: 2, data: { title: "About" } });
  const loader = createFixtureLoader<Doc>(dir);
  const full = await loader.syncAll(recordingWriter());

  writeFixture(dir, "en/pricing.json", { rev: 3, data: { title: "Pricing" } });
  writeFixture(dir, "en/home.json", { rev: 4, data: { title: "Home v2" } });
  writeFixture(dir, "en/about.json", { rev: 5, deleted: true });

  const writer = recordingWriter();
  const result = await loader.syncSince(writer, full.cursor);

  expect(writer.upserts).toEqual([
    { id: { locale: "en", path: "home" }, data: { title: "Home v2" } },
    { id: { locale: "en", path: "pricing" }, data: { title: "Pricing" } },
  ]);
  expect(result.changed).toEqual(writer.upserts.map((u) => u.id));
  expect(writer.deletes).toEqual([{ locale: "en", path: "about" }]);
  expect(result.deleted).toEqual([{ locale: "en", path: "about" }]);
  expect(result.cursor).toBe(5);
});

test("syncSince at the current cursor is a no-op that keeps the cursor", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 3, data: { title: "Home" } });
  const loader = createFixtureLoader<Doc>(dir);

  const writer = recordingWriter();
  const result = await loader.syncSince(writer, 3);

  expect(writer.upserts).toEqual([]);
  expect(writer.deletes).toEqual([]);
  expect(result.cursor).toBe(3);
});

test("a malformed fixture fails the sync naming the offending file", () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  mkdirSync(join(dir, "de"), { recursive: true });
  writeFileSync(join(dir, "de/home.json"), "{ not json");

  expect(() => createFixtureLoader<Doc>(dir).syncAll(recordingWriter())).toThrow(
    `Fixture "${join(dir, "de/home.json")}": is not valid JSON`,
  );
});

test("a fixture without a revision fails the sync naming the offending file", () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { data: { title: "Home" } });

  expect(() => createFixtureLoader<Doc>(dir).syncAll(recordingWriter())).toThrow(
    `Fixture "${join(dir, "en/home.json")}": needs a positive integer "rev"`,
  );
});

test("fetchOne reads one fixture, and reports a tombstoned entry as absent", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "en/gone.json", { rev: 2, deleted: true });
  const loader = createFixtureLoader<Doc>(dir);

  expect(await loader.fetchOne?.({ locale: "en", path: "home" })).toEqual({
    title: "Home",
  });
  expect(
    await loader.fetchOne?.({ locale: "en", path: "gone" }),
  ).toBeUndefined();
  expect(
    await loader.fetchOne?.({ locale: "en", path: "never-existed" }),
  ).toBeUndefined();
});

test("a fixture missing a required field fails the sync, naming file, field and fix", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/pricing.json", {
    rev: 1,
    data: { hero: { title: "Pricing" } },
  });
  writeFixture(dir, "de/pricing.json", { rev: 2, data: { hero: {} } });
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: createFixtureLoader<Hero>(dir),
    schema: heroSchema,
  });

  let failure: Error | undefined;
  try {
    await syncCollection(store, pages);
  } catch (error) {
    failure = error as Error;
  }

  expect(failure?.message).toContain('Collection "pages"');
  expect(failure?.message).toContain("/de/pricing: hero.title");
  expect(failure?.message).toContain("fix the content, or relax the schema");
  expect(store.getEntry("pages", "en", "pricing")).toBeUndefined();
});

test("a fixture collection with a schema stores the validated payload", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/pricing.json", {
    rev: 1,
    data: { hero: { title: "Pricing" } },
  });
  const store = openTempStore();
  const pages = defineCollection({
    name: "pages",
    loader: createFixtureLoader<Hero>(dir),
    schema: heroSchema,
  });

  await syncCollection(store, pages);

  const entry = await getEntryCached(store, pages, {
    locale: "en",
    path: "pricing",
  });
  expectTypeOf(entry?.data).toEqualTypeOf<Hero | undefined>();
  expect(entry?.data).toEqual({ hero: { title: "Pricing" } });
});
