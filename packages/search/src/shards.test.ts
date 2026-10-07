import { expect, test } from "vitest";
import { fileKey } from "@pagedeck/core";
import type { SearchDocument } from "@pagedeck/core";
import { indexDocuments } from "./shards.js";

const page = (over: Partial<SearchDocument> = {}): SearchDocument => ({
  locale: "en",
  path: "/guide",
  output: "/en/guide",
  html: "<p>Body.</p>",
  ...over,
});

const read = (documents: readonly SearchDocument[]): Map<string, unknown> => {
  const files = new Map<string, unknown>();
  for (const file of indexDocuments(documents)) {
    files.set(file.path, JSON.parse(file.contents as string));
  }
  return files;
};

test("a locale's index is a metadata file, a document table and a shard", () => {
  const files = indexDocuments([page()]);
  expect(files.map((file) => file.path)).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0000.json",
  ]);
  expect(new Set(files.map((file) => file.kind))).toEqual(new Set(["asset"]));
});

test("the metadata file names each shard and the terms it covers", () => {
  const files = read([page({ html: "<p>alpha zulu</p>" })]);
  expect(files.get("/search/en/index.json")).toEqual({
    format: 1,
    locale: "en",
    documents: "documents.json",
    shards: [{ file: "terms-0000.json", first: "alpha", last: "zulu" }],
  });
});

test("the document table holds what a result is drawn with", () => {
  const files = read([
    page({
      title: "Guide",
      html: "<p>Lead.</p><h2>Install</h2><p>Run it.</p>",
    }),
  ]);
  expect(files.get("/search/en/documents.json")).toEqual([
    { path: "/guide", output: "/en/guide", title: "Guide" },
  ]);
});

test("a page with no title carries no title key", () => {
  const files = read([page()]);
  expect(files.get("/search/en/documents.json")).toEqual([
    { path: "/guide", output: "/en/guide" },
  ]);
});

test("a posting counts the term and names the fields it appeared in", () => {
  const files = read([
    page({
      title: "Loader",
      html: "<h2>Loader</h2><p>loader loader</p>",
    }),
  ]);
  // 1 title + 2 heading + 4 body.
  expect(files.get("/search/en/terms-0000.json")).toEqual([
    ["loader", [{ d: 0, f: 4, w: 7 }]],
  ]);
});

test("a term in the prose above the first heading is a body match, and one in a heading is not", () => {
  const files = read([page({ html: "<p>lead</p><h2>Install</h2>" })]);
  expect(files.get("/search/en/terms-0000.json")).toEqual([
    ["install", [{ d: 0, f: 1, w: 2 }]],
    ["lead", [{ d: 0, f: 1, w: 4 }]],
  ]);
});

test("a term in two sections of one page is one posting counting every occurrence", () => {
  const files = read([
    page({ html: "<p>sync</p><h2>Later</h2><p>sync sync</p>" }),
  ]);
  expect(files.get("/search/en/terms-0000.json")).toEqual([
    ["later", [{ d: 0, f: 1, w: 2 }]],
    ["sync", [{ d: 0, f: 3, w: 4 }]],
  ]);
});

test("postings of one term are ordered by document, and terms are sorted", () => {
  const files = read([
    page({ path: "/b", output: "/en/b", html: "<p>zulu alpha</p>" }),
    page({ path: "/a", output: "/en/a", html: "<p>alpha</p>" }),
  ]);
  expect(files.get("/search/en/terms-0000.json")).toEqual([
    [
      "alpha",
      [
        { d: 0, f: 1, w: 4 },
        { d: 1, f: 1, w: 4 },
      ],
    ],
    ["zulu", [{ d: 1, f: 1, w: 4 }]],
  ]);
  expect(files.get("/search/en/documents.json")).toEqual([
    { path: "/a", output: "/en/a" },
    { path: "/b", output: "/en/b" },
  ]);
});

test("no documents means no files, not an empty index", () => {
  expect(indexDocuments([])).toEqual([]);
});

test("a locale with no terms gets no shard, and its metadata says so", () => {
  const files = read([page({ html: "<script>hidden()</script>" })]);
  expect([...files.keys()]).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
  ]);
  expect(files.get("/search/en/documents.json")).toEqual([
    { path: "/guide", output: "/en/guide" },
  ]);
  expect(files.get("/search/en/index.json")).toEqual({
    format: 1,
    locale: "en",
    documents: "documents.json",
    shards: [],
  });
});

test("each locale gets its own files, and no locale's terms reach another's", () => {
  const files = read([
    page({ locale: "en", html: "<p>widget</p>" }),
    page({ locale: "pt-BR", html: "<p>engrenagem</p>" }),
  ]);
  expect([...files.keys()]).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0000.json",
    "/search/pt-BR/documents.json",
    "/search/pt-BR/index.json",
    "/search/pt-BR/terms-0000.json",
  ]);
  expect(files.get("/search/en/terms-0000.json")).toEqual([
    ["widget", [{ d: 0, f: 1, w: 4 }]],
  ]);
  expect(files.get("/search/pt-BR/terms-0000.json")).toEqual([
    ["engrenagem", [{ d: 0, f: 1, w: 4 }]],
  ]);
});

test("a domain's index is written into that domain's own tree", () => {
  const files = indexDocuments([
    page({ domain: "shop.example", html: "<p>widget</p>" }),
    page({ html: "<p>widget</p>" }),
  ]);
  expect(
    files.map((file) => [file.domain, file.path] as const),
  ).toEqual([
    [undefined, "/search/en/documents.json"],
    [undefined, "/search/en/index.json"],
    [undefined, "/search/en/terms-0000.json"],
    ["shop.example", "/search/en/documents.json"],
    ["shop.example", "/search/en/index.json"],
    ["shop.example", "/search/en/terms-0000.json"],
  ]);
});

test("a domain-tree file's deploy key keeps the host and the path apart", () => {
  const files = indexDocuments([
    page({ domain: "shop.example", html: "<p>widget</p>" }),
    page({ html: "<p>widget</p>" }),
  ]);
  expect(files.map((file) => fileKey(file.domain, file.path))).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0000.json",
    "//shop.example/search/en/documents.json",
    "//shop.example/search/en/index.json",
    "//shop.example/search/en/terms-0000.json",
  ]);
});

const manyTerms = (count: number): string =>
  `<p>${Array.from({ length: count }, (_, index) => `t${String(index).padStart(6, "0")}`).join(" ")}</p>`;

test("a locale over the size cap splits into shards with disjoint term ranges", () => {
  const files = read([page({ html: manyTerms(5000) })]);
  const metadata = files.get("/search/en/index.json") as {
    shards: { file: string; first: string; last: string }[];
  };
  expect(metadata.shards.length).toBeGreaterThan(1);

  const covered: string[] = [];
  let previous: string | undefined;
  for (const shard of metadata.shards) {
    const terms = (files.get(`/search/en/${shard.file}`) as [string][]).map(
      ([term]) => term,
    );
    expect(terms[0]).toBe(shard.first);
    expect(terms.at(-1)).toBe(shard.last);
    if (previous !== undefined) expect(shard.first > previous).toBe(true);
    previous = shard.last;
    covered.push(...terms);
  }
  expect(covered).toEqual([...covered].sort());
  expect(covered.length).toBe(5000);
});

test("a shard holding more than one term stays inside the size cap", () => {
  // One posting per term, so no term reaches the cap alone.
  const files = indexDocuments([page({ html: manyTerms(5000) })]);
  for (const file of files) {
    if (!file.path.includes("terms-")) continue;
    expect(JSON.parse(file.contents as string).length).toBeGreaterThan(1);
    const bytes = new TextEncoder().encode(file.contents as string).length;
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  }
});

const sharedTerm = (count: number): SearchDocument[] =>
  Array.from({ length: count }, (_, index) => {
    const slug = String(index).padStart(4, "0");
    return page({
      path: `/p${slug}`,
      output: `/en/p${slug}`,
      html: `<p>shared u${slug}</p>`,
    });
  });

test("a term whose own postings exceed the cap gets a shard to itself", () => {
  const files = indexDocuments(sharedTerm(3000));
  const contents = new Map(
    files.map((file) => [file.path, file.contents as string]),
  );
  const metadata = JSON.parse(
    contents.get("/search/en/index.json") as string,
  ) as { shards: { file: string; first: string; last: string }[] };

  const holder = metadata.shards.find(({ first, last }) => first === "shared" && last === "shared");
  expect(holder).toBeDefined();
  const bytes = new TextEncoder().encode(
    contents.get(`/search/en/${(holder as { file: string }).file}`) as string,
  ).length;
  expect(bytes).toBeGreaterThan(64 * 1024);

  const covered: string[] = [];
  let previous: string | undefined;
  for (const shard of metadata.shards) {
    const terms = (
      JSON.parse(contents.get(`/search/en/${shard.file}`) as string) as [
        string,
      ][]
    ).map(([term]) => term);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms[0]).toBe(shard.first);
    expect(terms.at(-1)).toBe(shard.last);
    if (previous !== undefined) expect(shard.first > previous).toBe(true);
    previous = shard.last;
    covered.push(...terms);
  }
  expect(covered).toEqual([...covered].sort());
  expect(covered.length).toBe(3001);
});

test("shard files are numbered in term order, zero-padded so they sort", () => {
  const files = indexDocuments([page({ html: manyTerms(5000) })]);
  const shards = files
    .map((file) => file.path)
    .filter((path) => path.includes("terms-"));
  expect(shards).toEqual([...shards].sort());
  expect(shards[0]).toBe("/search/en/terms-0000.json");
  expect(shards[1]).toBe("/search/en/terms-0001.json");
});

test("a locale that is not a path segment is refused, and every one is named", () => {
  expect(() =>
    indexDocuments([
      page({ locale: "en/us" }),
      page({ locale: ".." }),
      page({ locale: "" }),
    ]),
  ).toThrow(
    'Search index: 3 locales are not path segments, and each locale\'s shards are written under "/search/<locale>/" — declare each locale the way a path spells one, such as "pt-BR":\n' +
      '  "" — the locale is empty\n' +
      '  ".." — the locale is a dot segment, which resolves out of the search directory\n' +
      '  "en/us" — the locale holds "/", which would write the shards into another directory',
  );
});
