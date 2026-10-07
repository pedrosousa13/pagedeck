import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { defineCollection, openStoreReadOnly } from "@pagedeck/content";
import type { Entry, Loader } from "@pagedeck/content";
import { SITE_FIXTURES, createFixtureLoader } from "@pagedeck/fixtures";
import type { FixturePage } from "@pagedeck/fixtures";
import { defineConfig } from "./config.js";
import type { LoadedConfig, SiteConfig } from "./config.js";
import { syncSite } from "./sync.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

function loaded(config: SiteConfig): LoadedConfig {
  const dir = tempDir("pagedeck-core-sync-");
  return {
    configPath: join(dir, "pagedeck.config.ts"),
    storePath: join(dir, "content.db"),
    collections: config.collections,
  };
}

function readEntries(config: LoadedConfig, collection: string): Entry<Doc>[] {
  const store = openStoreReadOnly(config.storePath);
  try {
    return store.listEntries<Doc>(collection);
  } finally {
    store.close();
  }
}

function seqOf(entries: readonly Entry<Doc>[], path: string): number {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no entry at path "${path}"`);
  return entry.seq;
}

const failingLoader: Loader<Doc> = {
  syncAll() {
    throw new Error("the CMS is down");
  },
  syncSince() {
    throw new Error("the CMS is down");
  },
};

test("a full sync reports per-collection counts and the new cursor", async () => {
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<FixturePage>({
          name: "pages",
          loader: createFixtureLoader<FixturePage>(SITE_FIXTURES),
          schema: false,
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: false });

  expect(report.failed).toEqual([]);
  expect(report.synced).toEqual([
    { collection: "pages", changed: 4, deleted: 0, cursor: 4 },
  ]);
});

test("every configured collection is synced, in config order", async () => {
  const fixtures = tempDir("pagedeck-core-sync-fixtures-");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<FixturePage>({
          name: "pages",
          loader: createFixtureLoader<FixturePage>(SITE_FIXTURES),
          schema: false,
        }),
        defineCollection<Doc>({
          name: "legal",
          loader: createFixtureLoader<Doc>(fixtures),
          schema: false,
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: false });

  expect(report.synced.map((r) => r.collection)).toEqual(["pages", "legal"]);
  expect(readEntries(config, "legal")).toHaveLength(1);
});

test("an incremental sync after a fixture edit touches only the changed entry", async () => {
  const fixtures = tempDir("pagedeck-core-sync-fixtures-");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(fixtures, "en/about.json", { rev: 2, data: { title: "About" } });
  writeFixture(fixtures, "en/terms.json", { rev: 3, data: { title: "Terms" } });
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<Doc>({
          name: "pages",
          loader: createFixtureLoader<Doc>(fixtures),
          schema: false,
        }),
      ],
    }),
  );
  await syncSite(config, { incremental: false });
  const before = readEntries(config, "pages");

  writeFixture(fixtures, "en/about.json", {
    rev: 4,
    data: { title: "About v2" },
  });
  const report = await syncSite(config, { incremental: true });

  expect(report.synced).toEqual([
    { collection: "pages", changed: 1, deleted: 0, cursor: 4 },
  ]);
  const after = readEntries(config, "pages");
  expect(seqOf(after, "home")).toBe(seqOf(before, "home"));
  expect(seqOf(after, "terms")).toBe(seqOf(before, "terms"));
  expect(seqOf(after, "about")).toBeGreaterThan(seqOf(before, "about"));
  expect(after.find((entry) => entry.path === "about")?.data.title).toBe(
    "About v2",
  );
});

test("an incremental sync of a collection that was never synced fails, naming it", async () => {
  const fixtures = tempDir("pagedeck-core-sync-fixtures-");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<Doc>({
          name: "pages",
          loader: createFixtureLoader<Doc>(fixtures),
          schema: false,
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: true });

  expect(report.synced).toEqual([]);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0].collection).toBe("pages");
  expect(report.failed[0].error.message).toMatch(
    /Collection "pages": no cursor to sync since/,
  );
});

test("a failing collection is reported by name and does not stop the others", async () => {
  const fixtures = tempDir("pagedeck-core-sync-fixtures-");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<Doc>({
          name: "broken",
          loader: failingLoader,
          schema: false,
        }),
        defineCollection<Doc>({
          name: "pages",
          loader: createFixtureLoader<Doc>(fixtures),
          schema: false,
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: false });

  expect(report.failed).toHaveLength(1);
  expect(report.failed[0].collection).toBe("broken");
  expect(report.failed[0].error.message).toContain(
    'Collection "broken": loader syncAll failed',
  );
  expect((report.failed[0].error.cause as Error).message).toBe(
    "the CMS is down",
  );
  expect(report.synced.map((r) => r.collection)).toEqual(["pages"]);
  expect(readEntries(config, "pages")).toHaveLength(1);
});

test("a dominant color the probe could not fetch is reported on the run's own channel", async () => {
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<Doc>({
          name: "pages",
          loader: {
            syncAll(writer) {
              writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
              return {
                changed: [{ locale: "en", path: "home" }],
                deleted: [],
                cursor: 1,
              };
            },
            syncSince() {
              throw new Error("unused");
            },
          },
          schema: false,
          imageColors: {
            extractSources: () => ["/hero.jpg"],
            probe: () => {
              throw new Error("502 Bad Gateway");
            },
          },
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: false });

  expect(report.failed).toEqual([]);
  expect(report.synced).toEqual([
    { collection: "pages", changed: 1, deleted: 0, cursor: 1 },
  ]);
  expect(report.warnings).toEqual([
    'Collection "pages": 1 image source could not be probed for a dominant color, so it renders with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "/hero.jpg" — 502 Bad Gateway',
  ]);
});

test("a color probe that answers wrongly fails the run without claiming the entries were lost", async () => {
  const config = loaded(
    defineConfig({
      store: "content.db",
      collections: [
        defineCollection<Doc>({
          name: "pages",
          loader: {
            syncAll(writer) {
              writer.upsert({ locale: "en", path: "home", data: { title: "Home" } });
              return {
                changed: [{ locale: "en", path: "home" }],
                deleted: [],
                cursor: 1,
              };
            },
            syncSince() {
              throw new Error("unused");
            },
          },
          schema: false,
          imageColors: {
            extractSources: () => ["/hero.jpg"],
            probe: () => 17 as unknown as string,
          },
        }),
      ],
    }),
  );

  const report = await syncSite(config, { incremental: false });

  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]?.error.message).toBe(
    'Collection "pages": syncAll stored every entry it was given, then failed fetching dominant colors',
  );
  expect(readEntries(config, "pages")).toHaveLength(1);
});
