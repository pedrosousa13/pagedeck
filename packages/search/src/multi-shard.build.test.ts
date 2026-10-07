import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER } from "@pagedeck/core";
import { createSearchClient } from "./query.js";
import { QUERY_CAP } from "./shards.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-multi-shard-test");
const OUT = join(SITE, "dist");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// 3,840 crossed terms split into three shards, so a query can leave the middle one
// unfetched. Crossed words share prefixes across a boundary.
const VERBS = [
  "parse",
  "render",
  "resolve",
  "collect",
  "emit",
  "cache",
  "hydrate",
  "serialize",
  "normalize",
  "validate",
  "compile",
  "stream",
] as const;

const NOUNS = [
  "Manifest",
  "Route",
  "Locale",
  "Shard",
  "Posting",
  "Bundle",
  "Fragment",
  "Header",
  "Sitemap",
  "Entry",
  "Asset",
  "Island",
  "Token",
  "Digest",
  "Config",
  "Store",
  "Cursor",
  "Region",
  "Beacon",
  "Ledger",
] as const;

const QUALIFIERS = [
  "Eager",
  "Lazy",
  "Once",
  "Deep",
  "Flat",
  "Safe",
  "Strict",
  "Raw",
  "Async",
  "Sync",
  "Batch",
  "Stable",
  "Fresh",
  "Inline",
  "Scoped",
  "Plain",
] as const;

const IDENTIFIERS: readonly string[] = VERBS.flatMap((verb) =>
  NOUNS.flatMap((noun) =>
    QUALIFIERS.map((qualifier) => `${verb}${noun}${qualifier}`),
  ),
);

// `benchmark` and `workspace` sort outside every identifier, so they land in the first and
// last shards.
const EARLY = "benchmark";
const LATE = "workspace";

interface Fixture {
  readonly path: string;
  readonly title: string;
  readonly prose: string;
}

// Round-robin, so the terms around a boundary belong to several pages.
const POSTS: readonly Fixture[] = [
  {
    path: "reading-a-manifest",
    title: "Reading a manifest",
    prose: "A build writes one manifest and every later run reads it.",
  },
  {
    path: "measuring-a-build",
    title: "Measuring a build",
    prose: `A ${EARLY} answers one question, and the honest ones name it.`,
  },
  {
    path: "islands-one-at-a-time",
    title: "Islands, one at a time",
    prose: "An island hydrates when the reader can see it, and not before.",
  },
  {
    path: "cursors-and-syncs",
    title: "Cursors and syncs",
    prose: "A cursor is the promise that the next sync can be a short one.",
  },
  {
    path: "the-whole-pipeline",
    title: "The whole pipeline, end to end",
    prose: `Running the ${EARLY} across the ${LATE} found the slow half.`,
  },
  {
    path: "notes-from-a-repository",
    title: "Notes from a repository",
    prose: `Every package of this ${LATE} is built before anything is tested.`,
  },
];

function bodyOf(index: number): string {
  const listing = IDENTIFIERS.filter(
    (_, position) => position % POSTS.length === index,
  );
  return `${(POSTS[index] as Fixture).prose} ${listing.join(" ")}`;
}

interface IndexFile {
  readonly format: number;
  readonly locale: string;
  readonly documents: string;
  readonly shards: readonly { file: string; first: string; last: string }[];
}

interface DocumentRow {
  readonly path: string;
  readonly output: string;
  readonly title?: string;
}

interface Posting {
  readonly d: number;
  readonly f: number;
  readonly w: number;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

const searchDir = (): string => join(OUT, "search", "en");

function indexFile(): IndexFile {
  return readJson<IndexFile>(join(searchDir(), "index.json"));
}

function shard(file: string): [string, Posting[]][] {
  return readJson<[string, Posting[]][]>(join(searchDir(), file));
}

function documents(): DocumentRow[] {
  return readJson<DocumentRow[]>(join(searchDir(), "documents.json"));
}

function documentsOf(entries: readonly [string, Posting[]][]): Set<number> {
  return new Set(entries.flatMap(([, postings]) => postings.map(({ d }) => d)));
}

const requests: string[] = [];

const treeFetch = (
  url: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
  requests.push(url);
  const file = join(OUT, url.slice(1));
  if (!existsSync(file)) {
    return Promise.resolve({
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error(`no ${url} in the built tree`)),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(readJson<unknown>(file)),
  });
};

const shardUrls = (): string[] =>
  indexFile().shards.map(({ file }) => `/search/en/${file}`);

// The corpus is spliced into the config as JSON: no object crosses into the `pagedeck` process.
function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });

  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );

  const corpus = POSTS.map(({ path, title }, index) => ({
    path,
    title,
    body: bodyOf(index),
  }));

  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";
import { defineSearch } from "@pagedeck/search";

const CORPUS = ${JSON.stringify(corpus)};

const upsertAll = (writer) => {
  for (const entry of CORPUS) {
    writer.upsert({
      locale: "en",
      path: entry.path,
      data: { title: entry.title, body: entry.body },
    });
  }
  return {
    changed: CORPUS.map(({ path }) => ({ locale: "en", path })),
    deleted: [],
    cursor: 1,
  };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: (writer) => upsertAll(writer),
    syncSince: (writer, cursor) =>
      cursor >= 1 ? { changed: [], deleted: [], cursor: 1 } : upsertAll(writer),
    fetchOne: (id) => {
      const found = CORPUS.find((entry) => entry.path === id.path);
      return found === undefined
        ? undefined
        : { title: found.title, body: found.body };
    },
  },
};

const entryOf = (page, store) =>
  store.getEntry("pages", page.entry.locale, page.entry.path);

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    // A header set, so the build writes nothing of its own on stderr (#318).
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
    search: defineSearch(),
    head: (page, store) => ({ title: entryOf(page, store).data.title }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: { Prose: "./components/Prose.js" },
    content: (page, store) => ({
      tree: [{ component: "Prose", props: { text: entryOf(page, store).data.body } }],
    }),
  },
});
`,
  );
}

// Checks whether the framework wrote anything, not whether stderr is empty (#184).
async function run(verb: string): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  expect(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  ).toBe("");
}

beforeAll(async () => {
  writeSite();
  await run("sync");
  await run("build");
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
});

test("this corpus splits across shards, each declaring the range it holds", () => {
  const metadata = indexFile();
  expect(metadata.format).toBe(1);
  // Three, so a query can leave one shard unfetched; the fixture has no clock or randomness.
  expect(metadata.shards.length).toBe(3);

  const covered: string[] = [];
  let previous: string | undefined;
  for (const { file, first, last } of metadata.shards) {
    const held = shard(file).map(([term]) => term);
    expect(held.length).toBeGreaterThan(0);
    expect([...held].sort(byCodeUnit)).toEqual(held);
    expect(held[0]).toBe(first);
    expect(held.at(-1)).toBe(last);
    if (previous !== undefined) expect(byCodeUnit(previous, first)).toBe(-1);
    previous = last;
    covered.push(...held);
  }

  expect(covered).toEqual([...covered].sort(byCodeUnit));
  const vocabulary = new Set(covered);
  expect(
    [...IDENTIFIERS, EARLY, LATE].filter(
      (term) => !vocabulary.has(term.toLowerCase()),
    ),
  ).toEqual([]);
});

function boundary(): {
  readonly prefix: string;
  readonly before: string;
  readonly after: string;
} {
  const { shards } = indexFile();
  for (const [position, range] of shards.entries()) {
    const next = shards[position + 1];
    if (next === undefined) break;
    let prefix = "";
    for (let at = 0; at < Math.min(range.last.length, next.first.length); at += 1) {
      if (range.last[at] !== next.first[at]) break;
      prefix += range.last[at];
    }
    if (prefix !== "") {
      return { prefix, before: range.file, after: next.file };
    }
  }
  throw new Error(
    "no shard boundary in this fixture's index has terms sharing a prefix",
  );
}

test("a prefix straddling a shard boundary is answered from both sides, and from no other shard", async () => {
  const { prefix, before, after } = boundary();
  const starting = (file: string): [string, Posting[]][] =>
    shard(file).filter(([term]) => term.startsWith(prefix));

  const [earlier, later] = [starting(before), starting(after)];
  expect(earlier.length).toBeGreaterThan(0);
  expect(later.length).toBeGreaterThan(0);
  const [pagesBefore, pagesAfter] = [documentsOf(earlier), documentsOf(later)];
  expect([...pagesAfter].some((id) => !pagesBefore.has(id))).toBe(true);
  expect([...pagesBefore].some((id) => !pagesAfter.has(id))).toBe(true);
  // `boundary()` returns the first shared-prefix boundary, not the longest, so this pins that
  // the prefix spans only two shards.
  expect(
    indexFile()
      .shards.filter(({ file }) => starting(file).length > 0)
      .map(({ file }) => file),
  ).toEqual([before, after]);

  const client = createSearchClient({ locale: "en", fetch: treeFetch });
  const hits = await client.search(prefix);

  const rows = documents();
  const expected = [...new Set([...pagesBefore, ...pagesAfter])]
    .map((id) => (rows[id] as DocumentRow).output)
    .sort(byCodeUnit);
  expect(hits.map(({ output }) => output).sort(byCodeUnit)).toEqual(expected);

  expect([...requests].sort(byCodeUnit)).toEqual(
    [
      "/search/en/index.json",
      `/search/en/${before}`,
      `/search/en/${after}`,
      "/search/en/documents.json",
    ].sort(byCodeUnit),
  );
  const asked = new Set(requests);
  for (const url of shardUrls()) {
    if (url.endsWith(before) || url.endsWith(after)) continue;
    expect(asked.has(url)).toBe(false);
  }
});

test("two words in different shards answer with the page that holds both, merged across them", async () => {
  const { shards } = indexFile();
  const holder = (term: string): string => {
    const found = shards.find(({ first, last }) => first <= term && term <= last);
    expect(found).toBeDefined();
    return (found as { file: string }).file;
  };
  const [early, late] = [holder(EARLY), holder(LATE)];
  expect(early).toBe((shards[0] as { file: string }).file);
  expect(late).toBe((shards.at(-1) as { file: string }).file);
  expect(shards.length).toBeGreaterThan(2);

  const rows = documents();
  const pagesOf = (term: string, file: string): string[] =>
    (shard(file).find(([held]) => held === term) as [string, Posting[]])[1]
      .map(({ d }) => (rows[d] as DocumentRow).output)
      .sort(byCodeUnit);
  expect(pagesOf(EARLY, early)).toEqual(
    ["/measuring-a-build", "/the-whole-pipeline"].sort(byCodeUnit),
  );
  expect(pagesOf(LATE, late)).toEqual(
    ["/notes-from-a-repository", "/the-whole-pipeline"].sort(byCodeUnit),
  );

  const client = createSearchClient({ locale: "en", fetch: treeFetch });
  const hits = await client.search(`${EARLY} ${LATE}`);

  expect(hits.map(({ path, output, title }) => ({ path, output, title }))).toEqual([
    {
      path: "/the-whole-pipeline",
      output: "/the-whole-pipeline",
      title: "The whole pipeline, end to end",
    },
  ]);

  expect([...requests].sort(byCodeUnit)).toEqual(
    [
      "/search/en/index.json",
      `/search/en/${early}`,
      `/search/en/${late}`,
      "/search/en/documents.json",
    ].sort(byCodeUnit),
  );
});

test("the costliest keystroke into this index stays inside what a query may cost", async () => {
  const weigh = (url: string): number => statSync(join(OUT, url.slice(1))).size;
  const letters = new Set(
    indexFile().shards.flatMap(({ file }) =>
      shard(file).map(([term]) => term.slice(0, 1)),
    ),
  );

  let worst = { letter: "", bytes: 0, files: [] as string[] };
  for (const letter of [...letters].sort(byCodeUnit)) {
    requests.length = 0;
    // A client per letter: a client holds what it fetched for its whole life.
    await createSearchClient({ locale: "en", fetch: treeFetch }).search(letter);
    const bytes = requests.reduce((sum, url) => sum + weigh(url), 0);
    if (bytes > worst.bytes) worst = { letter, bytes, files: [...requests] };
  }

  const pulled = [...worst.files].sort(byCodeUnit).join(", ");
  expect(
    worst.bytes,
    `the costliest keystroke is "${worst.letter}", which pulls ${pulled}`,
  ).toBeLessThanOrEqual(QUERY_CAP);

  expect(worst.files.filter((url) => shardUrls().includes(url))).toHaveLength(2);

  const metadata = indexFile();
  const whole = [
    "index.json",
    metadata.documents,
    ...metadata.shards.map(({ file }) => file),
  ].reduce((sum, file) => sum + weigh(`/search/en/${file}`), 0);
  expect(worst.bytes).toBeLessThan(whole);
});
