import { expect, test } from "vitest";
import { createSearchClient } from "./query.js";
import { indexDocuments } from "./shards.js";
import type { SearchDocument } from "@pagedeck/core";

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function fakeFetch(files: Readonly<Record<string, unknown>>): {
  fetch: (url: string) => Promise<FakeResponse>;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    fetch: (url: string) => {
      requested.push(url);
      const body = files[url];
      if (body === undefined) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.reject(new Error("no body")),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    },
  };
}

// Hand-written: `indexDocuments` puts a small site in one shard. The round-trip test keeps
// this shape honest.
const FILES: Readonly<Record<string, unknown>> = {
  "/search/en/index.json": {
    format: 1,
    locale: "en",
    documents: "documents.json",
    shards: [
      { file: "terms-0000.json", first: "alpha", last: "loader" },
      { file: "terms-0001.json", first: "moose", last: "zebra" },
    ],
  },
  "/search/en/documents.json": [
    { path: "/guide", output: "/en/guide", title: "Guide" },
    { path: "/loaders", output: "/loaders", title: "Loaders" },
  ],
  "/search/en/terms-0000.json": [
    ["alpha", [{ d: 0, f: 1, w: 4 }]],
    ["loader", [
      { d: 0, f: 3, w: 4 },
      { d: 1, f: 1, w: 1 },
    ]],
  ],
  "/search/en/terms-0001.json": [["zebra", [{ d: 1, f: 1, w: 4 }]]],
};

test("a query fetches the metadata, the documents and only the shard holding its term", async () => {
  const { fetch, requested } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  const hits = await client.search("zebra");

  expect(hits.map((hit) => hit.path)).toEqual(["/loaders"]);
  expect([...requested].sort()).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0001.json",
  ]);
});

test("a title match outranks a body match", async () => {
  const { fetch } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  const hits = await client.search("loader");

  expect(hits.map((hit) => hit.path)).toEqual(["/loaders", "/guide"]);
  expect(hits[0]?.title).toBe("Loaders");
});

test("a term outside every shard range fetches no shard and no documents", async () => {
  const { fetch, requested } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  expect(await client.search("aardvark")).toEqual([]);
  expect(requested).toEqual(["/search/en/index.json"]);
});

test("a second query re-fetches nothing it already holds", async () => {
  const { fetch, requested } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  await client.search("zebra");
  const afterFirst = [...requested];
  await client.search("zebra");
  expect(requested).toEqual(afterFirst);

  await client.search("alpha");
  expect(requested.slice(afterFirst.length)).toEqual([
    "/search/en/terms-0000.json",
  ]);
});

test("the reader's unfinished last word matches by prefix", async () => {
  const { fetch, requested } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  const hits = await client.search("load");

  expect(hits.map((hit) => hit.path)).toEqual(["/loaders", "/guide"]);
  expect(requested).not.toContain("/search/en/terms-0001.json");
});

test("a prefix spanning two shard ranges fetches both, and no third", async () => {
  const { fetch, requested } = fakeFetch({
    "/search/en/index.json": {
      format: 1,
      locale: "en",
      documents: "documents.json",
      shards: [
        { file: "terms-0000.json", first: "alpha", last: "moose" },
        { file: "terms-0001.json", first: "moss", last: "mule" },
        { file: "terms-0002.json", first: "narwhal", last: "zebra" },
      ],
    },
    "/search/en/documents.json": [
      { path: "/a", output: "/a", title: "A" },
      { path: "/b", output: "/b", title: "B" },
    ],
    "/search/en/terms-0000.json": [["moose", [{ d: 0, f: 1, w: 4 }]]],
    "/search/en/terms-0001.json": [["mule", [{ d: 1, f: 1, w: 4 }]]],
    "/search/en/terms-0002.json": [["zebra", [{ d: 1, f: 1, w: 4 }]]],
  });
  const client = createSearchClient({ locale: "en", fetch });

  const hits = await client.search("mo");

  expect(hits.map((hit) => hit.path)).toEqual(["/a"]);
  expect(requested).toContain("/search/en/terms-0000.json");
  expect(requested).toContain("/search/en/terms-0001.json");
  expect(requested).not.toContain("/search/en/terms-0002.json");
});

test("every word of a query has to be in the document", async () => {
  const { fetch } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  expect(await client.search("alpha zebra")).toEqual([]);
  expect((await client.search("loader zebra")).map((hit) => hit.path)).toEqual([
    "/loaders",
  ]);
});

test("warming fetches the metadata and no shard, and a query then reuses it", async () => {
  const { fetch, requested } = fakeFetch(FILES);
  const client = createSearchClient({ locale: "en", fetch });

  await client.warm();
  expect(requested).toEqual(["/search/en/index.json"]);

  await client.search("zebra");
  expect(requested.filter((url) => url.endsWith("index.json"))).toHaveLength(1);
});

const metadataOfFormat = (format: number): Record<string, unknown> => ({
  "/search/en/index.json": {
    format,
    locale: "en",
    documents: "documents.json",
    shards: [],
  },
});

test("an index written by a newer format is refused rather than guessed at", async () => {
  const { fetch } = fakeFetch(metadataOfFormat(2));
  const client = createSearchClient({ locale: "en", fetch });

  await expect(client.search("zebra")).rejects.toThrow(
    'Search index "/search/en/index.json": format 2 is newer than this query runtime reads (1) — the index was written by a newer @pagedeck/search than the page querying it, so the page is the stale half; rebuild and redeploy the site so the page ships the @pagedeck/search that wrote this index',
  );
});

test("an index written by an older format is refused with the other fix", async () => {
  const { fetch } = fakeFetch(metadataOfFormat(0));
  const client = createSearchClient({ locale: "en", fetch });

  await expect(client.search("zebra")).rejects.toThrow(
    'Search index "/search/en/index.json": format 0 is older than this query runtime reads (1) — the index was written by an older @pagedeck/search than the page querying it, so the index is the stale half; rebuild the site so the index is written by the @pagedeck/search this page ships',
  );
});

test("a file the site did not publish is named, with the status", async () => {
  const { fetch } = fakeFetch({ "/search/en/index.json": FILES["/search/en/index.json"] });
  const client = createSearchClient({ locale: "en", fetch });

  await expect(client.search("zebra")).rejects.toThrow(
    'Search index "/search/en/terms-0001.json": the request failed with status 404, so this query cannot be answered — check that the build wrote a search index for locale "en" and that it was deployed with the pages',
  );
});

test("the runtime reads what the indexer really writes", async () => {
  const documents: SearchDocument[] = [
    {
      locale: "en",
      path: "/guide",
      output: "/en/guide",
      title: "Loader guide",
      html: "<h2>Sync</h2><p>The loader runs at sync time.</p>",
    },
    {
      locale: "en",
      path: "/about",
      output: "/en/about",
      title: "About",
      html: "<p>Nothing to see.</p>",
    },
  ];
  const files: Record<string, unknown> = {};
  for (const file of indexDocuments(documents)) {
    if (typeof file.contents !== "string") {
      throw new Error(`the indexer wrote "${file.path}" as bytes, not JSON`);
    }
    files[file.path] = JSON.parse(file.contents);
  }
  const { fetch } = fakeFetch(files);
  const client = createSearchClient({ locale: "en", fetch });

  const hits = await client.search("Loader");
  expect(hits.map((hit) => hit.path)).toEqual(["/guide"]);
  expect(hits.map((hit) => hit.output)).toEqual(["/en/guide"]);
  expect(await client.search("nothing")).toEqual([
    expect.objectContaining({ path: "/about", output: "/en/about" }),
  ]);
});
