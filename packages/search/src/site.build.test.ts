import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER } from "@pagedeck/core";
import { createSearchClient } from "./query.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-locale-index-test");
const OUT = join(SITE, "dist");

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const DOMAIN = "de.example.com";

interface Fixture {
  readonly locale: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

// `hi` is Devanagari (vowel marks, `\p{M}`) and `de` has diacritics (case folding).
const CORPUS: readonly Fixture[] = [
  { locale: "en", path: "otters", title: "Otters", body: "driftwood estuary lodge" },
  { locale: "en", path: "kelp", title: "Kelp", body: "seaweed canopy shallows" },
  {
    locale: "hi",
    path: "pustakalaya",
    title: "पुस्तकालय",
    body: "किताबें अलमारी शांति",
  },
  { locale: "hi", path: "samudra", title: "समुद्र", body: "लहरें नमक किनारा" },
  {
    locale: "de",
    path: "hoehlen",
    title: "Höhlenmalerei",
    body: "Fledermäuse Tropfsteine Dunkelheit",
  },
  {
    locale: "de",
    path: "fledermaus",
    title: "Flügel",
    body: "Dämmerung Insekten Schatten",
  },
];

// Written out, not tokenized here: deriving them would test the tokenizer against itself.
const TERMS: Readonly<Record<string, readonly string[]>> = {
  en: [
    "canopy",
    "driftwood",
    "estuary",
    "kelp",
    "lodge",
    "otters",
    "seaweed",
    "shallows",
  ],
  hi: [
    "अलमारी",
    "किताबें",
    "किनारा",
    "नमक",
    "पुस्तकालय",
    "लहरें",
    "शांति",
    "समुद्र",
  ],
  de: [
    "dämmerung",
    "dunkelheit",
    "fledermäuse",
    "flügel",
    "höhlenmalerei",
    "insekten",
    "schatten",
    "tropfsteine",
  ],
};

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

function searchDir(locale: string): string {
  return locale === "de"
    ? join(OUT, DOMAIN, "search", locale)
    : join(OUT, "search", locale);
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function indexFile(locale: string): IndexFile {
  return readJson<IndexFile>(join(searchDir(locale), "index.json"));
}

function shard(locale: string, file: string): [string, Posting[]][] {
  return readJson<[string, Posting[]][]>(join(searchDir(locale), file));
}

function terms(locale: string): string[] {
  return indexFile(locale).shards.flatMap(({ file }) =>
    shard(locale, file).map(([term]) => term),
  );
}

const treeFetch = (url: string): Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}> => {
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

function bytes(locale: string): string[] {
  const dir = searchDir(locale);
  return readdirSync(dir).map((name) => readFileSync(join(dir, name), "utf8"));
}

// The corpus is spliced into the config as JSON: no object crosses into the `pagedeck` process.
function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });

  writeFileSync(
    join(SITE, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );

  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";
import { defineSearch } from "@pagedeck/search";

const CORPUS = ${JSON.stringify(CORPUS)};

const upsertAll = (writer) => {
  for (const entry of CORPUS) {
    writer.upsert({
      locale: entry.locale,
      path: entry.path,
      data: { title: entry.title, body: entry.body },
    });
  }
  return {
    changed: CORPUS.map(({ locale, path }) => ({ locale, path })),
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
      const found = CORPUS.find(
        (entry) => entry.locale === id.locale && entry.path === id.path,
      );
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
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        hi: { label: "हिन्दी", direction: "ltr" },
        de: { label: "Deutsch", direction: "ltr", domain: ${JSON.stringify(DOMAIN)} },
      }),
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

test("each locale gets a search directory, in the tree its domain names", () => {
  expect(readdirSync(join(OUT, "search")).sort()).toEqual(["en", "hi"]);
  expect(readdirSync(join(OUT, DOMAIN, "search")).sort()).toEqual(["de"]);
  expect(existsSync(join(OUT, "search", "de"))).toBe(false);
  expect(existsSync(join(OUT, DOMAIN, "search", "en"))).toBe(false);

  for (const locale of ["en", "hi", "de"]) {
    expect(readdirSync(searchDir(locale)).sort()).toEqual([
      "documents.json",
      "index.json",
      "terms-0000.json",
    ]);
  }
});

test("a word from one locale's pages is in that locale's shards and in no other locale's files", () => {
  const owners: Readonly<Record<string, string>> = {
    en: "driftwood",
    hi: "पुस्तकालय",
    de: "höhlenmalerei",
  };

  for (const [owner, word] of Object.entries(owners)) {
    expect(terms(owner)).toContain(word);
    expect(bytes(owner).join("")).toContain(word);

    for (const other of ["en", "hi", "de"].filter((one) => one !== owner)) {
      expect(terms(other)).not.toContain(word);
      for (const file of bytes(other)) expect(file).not.toContain(word);
    }
  }
});

test("each locale's index.json names that locale and a shard holding the range it declares", () => {
  for (const locale of ["en", "hi", "de"]) {
    const metadata = indexFile(locale);
    expect(metadata.format).toBe(1);
    expect(metadata.locale).toBe(locale);
    expect(metadata.documents).toBe("documents.json");

    expect(metadata.shards).toHaveLength(1);
    let previous: string | undefined;
    for (const { file, first, last } of metadata.shards) {
      const held = shard(locale, file).map(([term]) => term);
      expect(held.length).toBeGreaterThan(0);
      expect([...held].sort(byCodeUnit)).toEqual(held);
      expect(held[0]).toBe(first);
      expect(held.at(-1)).toBe(last);
      if (previous !== undefined) expect(byCodeUnit(previous, first)).toBe(-1);
      previous = last;
    }
  }

  for (const [locale, expected] of Object.entries(TERMS)) {
    expect(terms(locale)).toEqual([...expected].sort(byCodeUnit));
  }
});

// Written out rather than read off the build: it is the rule being checked.
const prefixOf = (locale: string): string => (locale === "de" ? "" : `/${locale}`);

test("each locale's documents.json lists that locale's pages, with their titles and where they are served, and no others", () => {
  for (const locale of ["en", "hi", "de"]) {
    const rows = readJson<DocumentRow[]>(
      join(searchDir(locale), "documents.json"),
    );
    const expected = CORPUS.filter((page) => page.locale === locale)
      .map((page) => ({
        path: `/${page.path}`,
        title: page.title,
        output: `${prefixOf(locale)}/${page.path}`,
      }))
      .sort((a, b) => byCodeUnit(a.path, b.path));

    expect(rows.map(({ path, title, output }) => ({ path, title, output }))).toEqual(
      expected,
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["output", "path", "title"]);
    }
  }
});

test("a hit at a prefixed locale links to the URL that locale is served at", async () => {
  const client = createSearchClient({ locale: "hi", fetch: treeFetch });

  const hits = await client.search("पुस्तकालय");

  expect(hits.map(({ path, output, title }) => ({ path, output, title }))).toEqual(
    [{ path: "/pustakalaya", output: "/hi/pustakalaya", title: "पुस्तकालय" }],
  );
});

test("a Devanagari title survives the build as one term, posted against its own page", () => {
  const word = "पुस्तकालय";
  const metadata = indexFile("hi");
  const found = shard("hi", metadata.shards[0]?.file as string).find(
    ([term]) => term === word,
  );
  expect(found).toBeDefined();

  const rows = readJson<DocumentRow[]>(join(searchDir("hi"), "documents.json"));
  const [, postings] = found as [string, Posting[]];
  expect(postings).toHaveLength(1);
  const posting = postings[0] as Posting;
  expect(rows[posting.d]?.path).toBe("/pustakalaya");
  expect(rows[posting.d]?.title).toBe(word);
  expect(posting.w).toBe(1);
  expect(posting.f).toBe(1);
  expect(Object.keys(posting).sort()).toEqual(["d", "f", "w"]);
});
