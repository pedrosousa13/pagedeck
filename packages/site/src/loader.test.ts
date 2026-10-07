import { expect, test } from "vitest";
import type { Entry } from "@pagedeck/content";
import { DRAFT_ENTRIES, PUBLISHED_ENTRIES } from "./content.js";
import type { PageData, PageEntry } from "./content.js";
import { blockUsage, componentNames, defineEntriesLoader } from "./loader.js";

function recordingWriter(): {
  upserted: PageEntry[];
  writer: {
    upsert: (entry: PageEntry) => void;
    delete: () => void;
  };
} {
  const upserted: PageEntry[] = [];
  return {
    upserted,
    writer: {
      upsert: (entry) => upserted.push(entry),
      delete: () => {
        throw new Error("the entries loader deletes nothing");
      },
    },
  };
}

function enHome(): PageEntry {
  const home = PUBLISHED_ENTRIES.find(
    (row) => row.locale === "en" && row.path === "home",
  );
  if (home === undefined) throw new Error("no en/home entry");
  return home;
}

function stored(row: PageEntry): Entry<PageData> {
  return { collection: "pages", seq: 1, ...row };
}

test("a full sync writes every entry it was given, in order, and owns the collection", async () => {
  const { upserted, writer } = recordingWriter();
  const result = await defineEntriesLoader(PUBLISHED_ENTRIES).syncAll(writer);
  expect(upserted).toEqual(PUBLISHED_ENTRIES);
  expect(result).toEqual({
    changed: PUBLISHED_ENTRIES.map(({ locale, path }) => ({ locale, path })),
    deleted: [],
    authoritative: true,
    cursor: 0,
  });
});

test("a sync since a cursor writes every entry again and claims no deletion", async () => {
  const { upserted, writer } = recordingWriter();
  const result = await defineEntriesLoader(PUBLISHED_ENTRIES).syncSince(
    writer,
    0,
  );
  expect(upserted).toEqual(PUBLISHED_ENTRIES);
  expect(result.authoritative).toBeUndefined();
  expect(result.deleted).toEqual([]);
});

test("the published set is the four public pages, and drafts add careers", () => {
  const ids = (rows: readonly PageEntry[]): string[] =>
    rows.map((row) => `${row.locale}/${row.path}`);
  expect(ids(PUBLISHED_ENTRIES)).toEqual([
    "en/home",
    "de/home",
    "en/pricing",
    "en/legal/terms",
  ]);
  expect(ids(DRAFT_ENTRIES)).toEqual([...ids(PUBLISHED_ENTRIES), "en/careers"]);
});

test("block usage numbers a tree in pre-order and keeps each component's shallowest depth", () => {
  const home = enHome();
  expect(blockUsage(stored(home))).toEqual([
    { component: "hero", count: 1, foldScore: 0, depth: 0, isRoot: true },
    { component: "button", count: 1, foldScore: 1, depth: 1, isRoot: false },
    { component: "feature_grid", count: 1, foldScore: 2, depth: 0, isRoot: true },
    { component: "feature_card", count: 2, foldScore: 3, depth: 1, isRoot: false },
  ]);
});

test("a template entry has no block usage, and names its template alone", () => {
  const pricing = PUBLISHED_ENTRIES.find((row) => row.path === "pricing");
  if (pricing === undefined) throw new Error("no en/pricing entry");
  expect(blockUsage(stored(pricing))).toEqual([]);
  expect(componentNames(pricing.data)).toEqual(["pricing_page"]);
});

test("a tree entry names each component it uses once, sorted", () => {
  const home = enHome();
  expect(componentNames(home.data)).toEqual([
    "button",
    "feature_card",
    "feature_grid",
    "hero",
  ]);
});
