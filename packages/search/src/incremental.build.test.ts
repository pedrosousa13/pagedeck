import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

/** The executable as it ships; `pnpm test` builds first (#177). */
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

const DOMAIN = "de.example.com";

interface Entry {
  readonly locale: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

const CORPUS: readonly Entry[] = [
  { locale: "en", path: "kelp", title: "Kelp", body: "kelp forest shallows otters" },
  { locale: "en", path: "otters", title: "Otters", body: "otters driftwood estuary" },
  { locale: "fr", path: "loutres", title: "Loutres", body: "loutres estuaire bois" },
  { locale: "fr", path: "varech", title: "Varech", body: "varech forêt loutres" },
  { locale: "de", path: "fledermaus", title: "Flügel", body: "Dämmerung Insekten Höhlen" },
  { locale: "de", path: "hoehlen", title: "Höhlenmalerei", body: "Höhlen Tropfsteine Dunkelheit" },
];

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeCorpus(
  root: string,
  entries: readonly Entry[],
  removed: readonly { locale: string; path: string }[] = [],
): void {
  writeFileSync(
    join(root, "corpus.json"),
    `${JSON.stringify({ entries, removed })}\n`,
  );
}

function writeSite(name: string): string {
  const root = join(import.meta.dirname, "..", `.pagedeck-incremental-index-${name}`);
  roots.push(root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );
  writeCorpus(root, CORPUS);
  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { appendFileSync, readFileSync } from "node:fs";
import { defineConfig, defineLocales, definePages, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";
import { defineSearch } from "@pagedeck/search";

const corpus = () =>
  JSON.parse(readFileSync(${JSON.stringify(join(root, "corpus.json"))}, "utf8"));

const sync = (writer) => {
  const { entries, removed } = corpus();
  for (const entry of entries) {
    writer.upsert({
      locale: entry.locale,
      path: entry.path,
      data: { title: entry.title, body: entry.body },
    });
  }
  for (const id of removed) writer.delete(id);
  return {
    changed: entries.map(({ locale, path }) => ({ locale, path })),
    deleted: removed,
    cursor: 1,
  };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: sync,
    syncSince: sync,
    fetchOne: (id) => {
      const found = corpus().entries.find(
        (entry) => entry.locale === id.locale && entry.path === id.path,
      );
      return found === undefined ? undefined : { title: found.title, body: found.body };
    },
  },
};

const entryOf = (page, store) =>
  store.getEntry("pages", page.entry.locale, page.entry.path);

const search = defineSearch();
const keyOf = (file) => (file.domain === undefined ? "" : "//" + file.domain) + file.path;

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
    search: {
      ...search,
      patch: async (input) => {
        const answer = await search.patch(input);
        appendFileSync(
          ${JSON.stringify(join(root, "patch.log"))},
          JSON.stringify({
            written: answer.written.map(keyOf),
            pruned: answer.pruned.map(keyOf),
          }) + "\\n",
        );
        return answer;
      },
    },
    head: (page, store) => ({ title: entryOf(page, store).data.title }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({
        en: { label: "English", direction: "ltr" },
        fr: { label: "Français", direction: "ltr" },
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
  return root;
}

async function pagedeck(root: string, ...argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...argv], {
    cwd: root,
  });
  return stdout;
}

function searchFiles(dist: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const search of [join(dist, "search"), join(dist, DOMAIN, "search")]) {
    if (!existsSync(search)) continue;
    for (const locale of readdirSync(search)) {
      for (const name of readdirSync(join(search, locale))) {
        const file = join(search, locale, name);
        files.set(relative(dist, file), readFileSync(file, "utf8"));
      }
    }
  }
  return files;
}

// Mtimes, because a file rewritten with the bytes it held compares equal to one left alone.
function writtenAt(dist: string): Map<string, number> {
  return new Map(
    [...searchFiles(dist).keys()].map((path) => [
      path,
      statSync(join(dist, path)).mtimeMs,
    ]),
  );
}

// The patch's own record: a tree comparison cannot tell an untouched directory from one
// rewritten with the same bytes.
function patchLog(root: string): { written: string[]; pruned: string[] }[] {
  const log = join(root, "patch.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { written: string[]; pruned: string[] });
}

interface Merged {
  root: string;
  full: Map<string, string>;
  incremental: Map<string, string>;
  out: string;
  before: Map<string, number>;
  after: Map<string, number>;
}

async function merge(
  name: string,
  move: (root: string) => void,
): Promise<Merged> {
  const root = writeSite(name);
  const dist = join(root, "dist");
  await pagedeck(root, "sync");
  await pagedeck(root, "build");
  const before = join(root, "dist-before");
  cpSync(dist, before, { recursive: true });

  move(root);
  await pagedeck(root, "sync");
  rmSync(dist, { recursive: true, force: true });
  await pagedeck(root, "build");
  const full = searchFiles(dist);

  rmSync(dist, { recursive: true, force: true });
  cpSync(before, dist, { recursive: true });
  rmSync(join(root, "patch.log"), { force: true });
  const sampled = writtenAt(dist);
  const out = await pagedeck(root, "build", "--incremental");
  return {
    root,
    full,
    incremental: searchFiles(dist),
    out,
    before: sampled,
    after: writtenAt(dist),
  };
}

let edited: Promise<Merged> | undefined;

function editedStore(): Promise<Merged> {
  edited ??= merge("edited", (root) => {
    writeCorpus(
      root,
      CORPUS.map((entry) =>
        entry.locale === "en" && entry.path === "otters"
          ? { ...entry, body: "otters seals harbour estuary" }
          : entry,
      ),
    );
  });
  return edited;
}

test("an index patched after one page's edit is byte for byte a full build's", async () => {
  const { full, incremental, out } = await editedStore();

  expect(out).toContain("incremental: 1 of 6 pages rendered, 5 reused, 0 removed");
  expect([...incremental.keys()].sort()).toEqual([...full.keys()].sort());
  for (const [path, bytes] of full) expect(incremental.get(path), path).toBe(bytes);
  expect(incremental.get(join("search", "en", "terms-0000.json"))).toContain(
    '"harbour"',
  );
}, 240_000);

test("the patch after one page's edit returns none of the other locales' files", async () => {
  const { root } = await editedStore();

  const [call, ...rest] = patchLog(root);
  expect(rest).toEqual([]);
  expect(call?.written.length).toBeGreaterThan(0);
  for (const key of [...(call?.written ?? []), ...(call?.pruned ?? [])]) {
    expect(key).toMatch(/^\/search\/en\//);
  }
}, 240_000);

test("the directories an edit did not reach are not rewritten on disk", async () => {
  const { before, after } = await editedStore();

  const untouched = [...before.keys()].filter(
    (path) => !path.startsWith(join("search", "en")),
  );
  expect(untouched.some((path) => path.includes(join("search", "fr")))).toBe(true);
  expect(untouched.some((path) => path.startsWith(DOMAIN))).toBe(true);
  for (const path of untouched) {
    expect(after.get(path), path).toBe(before.get(path));
  }
}, 240_000);

let shifted: Promise<Merged> | undefined;

function shiftedStore(): Promise<Merged> {
  shifted ??= merge("shifted", (root) => {
    writeCorpus(
      root,
      [
        { locale: "en", path: "alpha", title: "Alpha", body: "alpha otters kelp" },
        ...CORPUS.filter(
          (entry) => !(entry.locale === "de" && entry.path === "fledermaus"),
        ),
      ],
      [{ locale: "de", path: "fledermaus" }],
    );
  });
  return shifted;
}

test("an index patched after a page added and a page removed is byte for byte a full build's", async () => {
  const { full, incremental, out } = await shiftedStore();

  expect(out).toContain("incremental: 1 of 6 pages rendered, 5 reused, 1 removed");
  expect([...incremental.keys()].sort()).toEqual([...full.keys()].sort());
  for (const [path, bytes] of full) expect(incremental.get(path), path).toBe(bytes);
}, 240_000);

test("the patch after an addition and a removal rewrites the two directories they moved, and not the third", async () => {
  const { root } = await shiftedStore();

  const [call] = patchLog(root);
  const touched = [...(call?.written ?? []), ...(call?.pruned ?? [])];
  expect(touched.some((key) => key.startsWith("/search/en/"))).toBe(true);
  expect(
    touched.some((key) => key.startsWith(`//${DOMAIN}/search/de/`)),
  ).toBe(true);
  expect(touched.filter((key) => key.includes("/search/fr/"))).toEqual([]);
}, 240_000);
