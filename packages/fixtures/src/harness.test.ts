import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { syncCollectionSince } from "@pagedeck/content";
import { loadFixtureStore } from "./harness.js";
import type { FixtureStore, FixtureStoreOptions } from "./harness.js";

const tempDirs: string[] = [];
const opened: FixtureStore<Doc>[] = [];

function tempFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-fixtures-harness-"));
  tempDirs.push(dir);
  return dir;
}

async function openFixtureStore(
  options: FixtureStoreOptions,
): Promise<FixtureStore<Doc>> {
  const fixture = await loadFixtureStore<Doc>(options);
  opened.push(fixture);
  return fixture;
}

// Closing twice throws, so the test whose subject is `close` hands its store back first.
function releaseFixtureStore(fixture: FixtureStore<Doc>): void {
  opened.splice(opened.indexOf(fixture), 1);
}

afterEach(() => {
  for (const fixture of opened.splice(0)) {
    fixture.close();
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

test("loadFixtureStore returns a store already synced from the fixture directory", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "de/home.json", { rev: 2, data: { title: "Startseite" } });

  const fixture = await openFixtureStore({ directory: dir });

  expect(fixture.store.getEntry<Doc>("pages", "de", "home")?.data.title).toBe(
    "Startseite",
  );
  expect(fixture.store.listEntries("pages")).toHaveLength(2);
  expect(fixture.store.getCursor("pages")).toBe(2);
});

test("close removes the store file the harness created", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });

  const fixture = await openFixtureStore({ directory: dir });
  expect(existsSync(fixture.storePath)).toBe(true);

  releaseFixtureStore(fixture);
  fixture.close();
  expect(existsSync(fixture.storePath)).toBe(false);
});

test("the returned collection drives an incremental sync over edited fixtures", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(dir, "en/about.json", { rev: 2, data: { title: "About" } });
  const fixture = await openFixtureStore({ directory: dir });
  const beforeEdits = fixture.store.getEntry("pages", "en", "home")?.seq ?? 0;

  writeFixture(dir, "en/home.json", { rev: 3, data: { title: "Home v2" } });
  writeFixture(dir, "en/about.json", { rev: 4, deleted: true });
  const result = await syncCollectionSince(fixture.store, fixture.collection);

  expect(result.changed).toEqual([{ locale: "en", path: "home" }]);
  expect(result.deleted).toEqual([{ locale: "en", path: "about" }]);
  expect(fixture.store.getEntry<Doc>("pages", "en", "home")?.data.title).toBe(
    "Home v2",
  );
  expect(fixture.store.getEntry("pages", "en", "about")).toBeUndefined();
  expect(fixture.store.getCursor("pages")).toBe(4);
  expect(
    fixture.store.changedSince(beforeEdits, "pages").map((e) => e.path),
  ).toEqual(["home"]);
});

test("a collection name can be given, so one store can hold several fixture sets", async () => {
  const dir = tempFixtureDir();
  writeFixture(dir, "en/terms.json", { rev: 1, data: { title: "Terms" } });

  const fixture = await openFixtureStore({
    directory: dir,
    collection: "legal",
  });

  expect(fixture.collection.name).toBe("legal");
  expect(fixture.store.listEntries("legal")).toHaveLength(1);
});
