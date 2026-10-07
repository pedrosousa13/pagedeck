import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import type { EmittedFile } from "./manifest.js";
import type { Page } from "./pages.js";
import {
  searchDocuments,
  searchFaultReport,
  searchFiles,
  searchPatchFaults,
  searchPatchFiles,
} from "./search.js";
import type { SearchAdapter, SearchDocument, SearchPatch } from "./search.js";

const WHERE = 'Config "/site/pagedeck.config.ts"';

function page(locale: string, path: `/${string}`, domain?: string): Page {
  return {
    locale,
    path,
    ...(domain === undefined ? {} : { domain }),
    output: `/${locale}${path === "/" ? "" : path}`,
    dependencies: [],
  };
}

function adapter(
  files: readonly EmittedFile[],
  seen?: SearchDocument[][],
): SearchAdapter {
  return {
    name: "lunr",
    index: (documents) => {
      seen?.push([...documents]);
      return Promise.resolve(files);
    },
  };
}

const INDEX_FILE: EmittedFile = {
  path: "/search-index.json",
  kind: "asset",
  contents: "{}",
};

test("a search adapter that is not an object is refused with the shape it takes", () => {
  expect(searchFaultReport("./lunr.js", WHERE)).toBe(
    `${WHERE}: "build.search" must be an object with a name and an index function — search: { name: "lunr", index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }] }`,
  );
});

test("a search adapter with no name and no index names both fields on their own lines", () => {
  expect(searchFaultReport({}, WHERE)).toBe(
    `${WHERE}: "build.search" declares 2 fields this build cannot index through — declare each as the type its own line names:
  "name" — undefined — not an adapter name — write the name this adapter is reported by, such as "lunr"
  "index" — undefined — not an index function — write the function this build hands its rendered pages to, as index: (documents) => [{ path: "/search-index.json", kind: "asset", contents }]`,
  );
});

test("a search adapter whose name is whitespace is refused, since no report could name it", () => {
  expect(searchFaultReport({ name: "  ", index: () => [] }, WHERE)).toBe(
    `${WHERE}: "build.search" declares 1 field this build cannot index through — declare each as the type its own line names:
  "name" — "  " — not an adapter name — write the name this adapter is reported by, such as "lunr"`,
  );
});

test("a search adapter with a name and an index function is accepted", () => {
  expect(searchFaultReport({ name: "lunr", index: () => [] }, WHERE)).toBe(
    undefined,
  );
});

test("a search adapter whose patch is not a function is refused on a line of its own", () => {
  expect(
    searchFaultReport({ name: "lunr", index: () => [], patch: true }, WHERE),
  ).toBe(
    `${WHERE}: "build.search" declares 1 field this build cannot index through — declare each as the type its own line names:
  "patch" — true — not a patch function — write the function this build hands the previous index and the pages that moved to, as patch: ({ previous, documents, removed }) => ({ written, pruned }), or remove "patch" so an incremental build renders every page for the index`,
  );
});

test("a search adapter with a patch function is accepted", () => {
  expect(
    searchFaultReport(
      {
        name: "lunr",
        index: () => [],
        patch: () => ({ written: [], pruned: [] }),
      },
      WHERE,
    ),
  ).toBe(undefined);
});

test("a search adapter carrying fields of its own is accepted", () => {
  expect(
    searchFaultReport(
      { name: "lunr", index: () => [], tokenizer: "trigram" },
      WHERE,
    ),
  ).toBe(undefined);
});

test("documents are ordered by locale then path, whatever order the pages rendered in", () => {
  const documents = searchDocuments([
    { page: page("en", "/pricing"), html: "<p>b</p>" },
    { page: page("de", "/about"), html: "<p>c</p>" },
    { page: page("en", "/about"), html: "<p>a</p>", title: "About" },
  ]);

  expect(documents.map((one) => `${one.locale} ${one.path}`)).toEqual([
    "de /about",
    "en /about",
    "en /pricing",
  ]);
});

test("a document carries the page's route, its deployed location and its rendered body", () => {
  const [document] = searchDocuments([
    {
      page: page("en", "/about", "shop.example"),
      html: "<p>a</p>",
      title: "About",
    },
  ]);

  expect(document).toEqual({
    locale: "en",
    path: "/about",
    domain: "shop.example",
    output: "/en/about",
    html: "<p>a</p>",
    title: "About",
  });
});

test("a page with no head title produces a document with no title", () => {
  const [document] = searchDocuments([
    { page: page("en", "/about"), html: "<p>a</p>" },
  ]);

  expect(document !== undefined && "title" in document).toBe(false);
});

test("the files an adapter returns come back to be emitted", async () => {
  const files = await searchFiles({
    adapter: adapter([INDEX_FILE]),
    documents: searchDocuments([{ page: page("en", "/"), html: "<p>a</p>" }]),
    emitted: [],
  });

  expect(files).toEqual([INDEX_FILE]);
});

test("a synchronous adapter's files come back, awaited like any other", async () => {
  const sync: SearchAdapter = {
    name: "lunr",
    index: (documents) => [
      {
        path: "/search-index.json",
        kind: "asset",
        contents: String(documents.length),
      },
    ],
  };

  const files = await searchFiles({
    adapter: sync,
    documents: searchDocuments([{ page: page("en", "/"), html: "<p>a</p>" }]),
    emitted: [],
  });

  expect(files).toEqual([
    { path: "/search-index.json", kind: "asset", contents: "1" },
  ]);
});

test("the adapter is handed the documents in the order they were composed", async () => {
  const seen: SearchDocument[][] = [];
  const documents = searchDocuments([
    { page: page("en", "/pricing"), html: "<p>b</p>" },
    { page: page("de", "/about"), html: "<p>c</p>" },
  ]);

  await searchFiles({ adapter: adapter([], seen), documents, emitted: [] });

  expect(seen).toEqual([documents]);
});

test("an adapter returning a path the build already emitted is refused by name", async () => {
  const emitted: EmittedFile[] = [
    { path: "/search-index.json", kind: "html", contents: "<html></html>" },
  ];

  const thrown: unknown = await searchFiles({
    adapter: adapter([INDEX_FILE]),
    documents: [],
    emitted,
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter returned 1 file at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the adapter is called; return each derived file at a path of the adapter's own, such as "/search-index.json":
  "/search-index.json" — the build already emitted an html file there`,
  );
});

test("every colliding path is reported in one run, each in its own tree", async () => {
  const thrown: unknown = await searchFiles({
    adapter: adapter([
      { path: "/search-index.json", kind: "asset", contents: "{}" },
      {
        domain: "shop.example",
        path: "/search-index.json",
        kind: "asset",
        contents: "{}",
      },
    ]),
    documents: [],
    emitted: [
      { path: "/search-index.json", kind: "asset", contents: "{}" },
      {
        domain: "shop.example",
        path: "/search-index.json",
        kind: "js",
        contents: "0",
      },
    ],
  }).catch((error: unknown) => error);

  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter returned 2 files at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the adapter is called; return each derived file at a path of the adapter's own, such as "/search-index.json":
  "//shop.example/search-index.json" — the build already emitted a js file there
  "/search-index.json" — the build already emitted an asset file there`,
  );
});

test("an adapter returning a file tagged with a page is refused", async () => {
  const thrown: unknown = await searchFiles({
    adapter: adapter([
      { ...INDEX_FILE, page: { locale: "en", path: "/about" } },
    ]),
    documents: [],
    emitted: [],
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter returned 1 file claiming a page or a chunk of the client build — a "page" says a file is one page's own HTML and a "name" says which chunk of the client build it is, and the manifest answers a column of the document from each; return each derived file with neither field, and link it from the site's own pages:
  "/search-index.json" — sets "page"`,
  );
});

test("an adapter returning a file carrying a bundler name is refused on the same line", async () => {
  const thrown: unknown = await searchFiles({
    adapter: adapter([
      { ...INDEX_FILE, name: "en_about", page: { locale: "en", path: "/" } },
    ]),
    documents: [],
    emitted: [],
  }).catch((error: unknown) => error);

  expect((thrown as Error).message).toContain(
    `  "/search-index.json" — sets "page" and "name"`,
  );
});

test("an adapter that throws fails the build with its name and the throw as the cause", async () => {
  const boom = new Error("no stemmer");
  const thrown: unknown = await searchFiles({
    adapter: {
      name: "lunr",
      index: () => {
        throw boom;
      },
    },
    documents: searchDocuments([
      { page: page("en", "/"), html: "<p>a</p>" },
      { page: page("en", "/about"), html: "<p>b</p>" },
    ]),
    emitted: [],
  }).catch((error: unknown) => error);

  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter threw while indexing 2 documents — "build.search" is the site's own indexer and is handed every page this build rendered; fix the adapter, or remove "build.search" until it indexes this site`,
  );
  expect((thrown as Error).cause).toBe(boom);
});

function previousFile(path: string, contents: string, domain?: string): EmittedFile {
  return {
    ...(domain === undefined ? {} : { domain }),
    path,
    kind: "asset",
    contents: new TextEncoder().encode(contents),
  };
}

function patching(
  patch: SearchPatch,
  seen?: unknown[],
): SearchAdapter {
  return {
    name: "lunr",
    index: () => [],
    patch: (input) => {
      seen?.push(input);
      return Promise.resolve(patch);
    },
  };
}

test("a patch's written files replace the previous ones at their keys, and the rest are carried", async () => {
  const kept = previousFile("/search/de.json", "de");
  const replaced = previousFile("/search/en.json", "en");
  const dropped = previousFile("/search/fr.json", "fr");
  const written: EmittedFile = {
    path: "/search/en.json",
    kind: "asset",
    contents: "en, edited",
  };

  const result = await searchPatchFiles({
    adapter: patching({ written: [written], pruned: [{ path: "/search/fr.json" }] }),
    previous: [kept, replaced, dropped],
    documents: [],
    removed: [],
    emitted: [],
  });

  expect(result.written).toEqual([written]);
  expect(result.carried).toHaveLength(1);
  expect(result.carried[0]).toBe(kept);
});

test("the patch is handed the previous index, the moved pages' documents and the removals", async () => {
  const seen: unknown[] = [];
  const previous = [previousFile("/search/en.json", "en")];
  const documents = searchDocuments([
    { page: page("en", "/about"), html: "<p>a</p>" },
  ]);
  const removed = [{ locale: "en", path: "/gone" }];

  await searchPatchFiles({
    adapter: patching({ written: [], pruned: [] }, seen),
    previous,
    documents,
    removed,
    emitted: [],
  });

  expect(seen).toEqual([{ previous, documents, removed }]);
});

test("a patch returning a path the build already emitted is refused as index's answer is", async () => {
  const thrown: unknown = await searchPatchFiles({
    adapter: patching({ written: [INDEX_FILE], pruned: [] }),
    previous: [],
    documents: [],
    removed: [],
    emitted: [{ path: "/search-index.json", kind: "html", contents: "<html></html>" }],
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter returned 1 file at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the adapter is called; return each derived file at a path of the adapter's own, such as "/search-index.json":
  "/search-index.json" — the build already emitted an html file there`,
  );
});

test("a patch returning a file that claims a page is refused as index's answer is", async () => {
  const thrown: unknown = await searchPatchFiles({
    adapter: patching({
      written: [{ ...INDEX_FILE, page: { locale: "en", path: "/about" } }],
      pruned: [],
    }),
    previous: [],
    documents: [],
    removed: [],
    emitted: [],
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toContain(
    `  "/search-index.json" — sets "page"`,
  );
});

test("a patch that throws fails the build with the adapter's name and the throw as the cause", async () => {
  const boom = new Error("no stemmer");
  const thrown: unknown = await searchPatchFiles({
    adapter: {
      name: "lunr",
      index: () => [],
      patch: () => {
        throw boom;
      },
    },
    previous: [],
    documents: searchDocuments([{ page: page("en", "/"), html: "<p>a</p>" }]),
    removed: [{ locale: "en", path: "/gone" }],
    emitted: [],
  }).catch((error: unknown) => error);

  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter threw while patching the index over 1 document and 1 removal — "build.search" is the site's own indexer and is handed the previous build's index and the pages that moved since; fix the adapter's patch, or run pagedeck build to index every page`,
  );
  expect((thrown as Error).cause).toBe(boom);
});

test("a patch pruning a file the previous index does not hold is refused, every such key at once", async () => {
  const thrown: unknown = await searchPatchFiles({
    adapter: patching({
      written: [],
      pruned: [
        { path: "/index.html" },
        { domain: "shop.example", path: "/search/en.json" },
      ],
    }),
    previous: [previousFile("/search/en.json", "en")],
    documents: [],
    removed: [],
    emitted: [],
  }).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toBe(
    `Search index: the "lunr" adapter pruned 2 files the previous build's index does not hold — a patch prunes only files its own previous index wrote, which it is handed as "previous"; prune each file by the domain and path it was handed at:
  "/index.html"
  "//shop.example/search/en.json"`,
  );
});

function listing(documents: readonly SearchDocument[]): EmittedFile[] {
  const locales = [...new Set(documents.map((one) => one.locale))].sort();
  return locales.map((locale) => ({
    path: `/search/${locale}.json`,
    kind: "asset",
    contents: JSON.stringify(
      documents
        .filter((one) => one.locale === locale)
        .map((one) => [one.path, one.html]),
    ),
  }));
}

const BEFORE = searchDocuments([
  { page: page("en", "/"), html: "<p>home</p>" },
  { page: page("en", "/about"), html: "<p>about</p>" },
  { page: page("de", "/"), html: "<p>start</p>" },
]);

const AFTER = searchDocuments([
  { page: page("en", "/"), html: "<p>home, edited</p>" },
  { page: page("en", "/about"), html: "<p>about</p>" },
]);

test("a patch whose answer is not the index a full build writes fails the contract, by file", async () => {
  const careless: Required<SearchAdapter> = {
    name: "lunr",
    index: listing,
    patch: ({ documents }) => ({
      written: listing(documents),
      pruned: [],
    }),
  };

  expect(
    await searchPatchFaults(careless, { before: BEFORE, after: AFTER }),
  ).toEqual([
    `  "/search/de.json" — the patched index holds a file a full index does not`,
    `  "/search/en.json" — the patched index holds other bytes than a full index`,
  ]);
});

test("a patch that rebuilds each moved locale from the previous file passes the contract", async () => {
  const careful: Required<SearchAdapter> = {
    name: "lunr",
    index: listing,
    patch: ({ previous, documents, removed }) => {
      const locales = new Set([
        ...documents.map((one) => one.locale),
        ...removed.map((one) => one.locale),
      ]);
      const written: EmittedFile[] = [];
      const pruned: { path: string }[] = [];
      for (const locale of locales) {
        const path = `/search/${locale}.json`;
        const file = previous.find((one) => one.path === path);
        const rows = new Map<string, string>(
          file === undefined
            ? []
            : (JSON.parse(
                typeof file.contents === "string"
                  ? file.contents
                  : new TextDecoder().decode(file.contents),
              ) as [string, string][]),
        );
        for (const one of removed) {
          if (one.locale === locale) rows.delete(one.path);
        }
        for (const one of documents) {
          if (one.locale === locale) rows.set(one.path, one.html);
        }
        if (rows.size === 0) {
          if (file !== undefined) pruned.push({ path });
          continue;
        }
        written.push({
          path,
          kind: "asset",
          contents: JSON.stringify(
            [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        });
      }
      return { written, pruned };
    },
  };

  expect(
    await searchPatchFaults(careful, { before: BEFORE, after: AFTER }),
  ).toEqual([]);
});
