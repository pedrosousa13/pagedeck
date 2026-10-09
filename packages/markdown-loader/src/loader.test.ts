import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import {
  defineCollection,
  getEntry,
  listEntries,
  openStore,
  syncCollection,
  syncCollectionSince,
} from "@pagedeck/content";
import type { Collection, ContentStore } from "@pagedeck/content";
import { defineMarkdownLoader } from "./loader.js";
import type { MarkdownEntry, MarkdownLoaderOptions } from "./loader.js";

const stores: ContentStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function siteWith(files: Readonly<Record<string, string>>): {
  root: string;
  store: ContentStore;
} {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-markdown-loader-"));
  tempDirs.push(dir);
  const root = join(dir, "content");
  mkdirSync(root, { recursive: true });
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  const store = openStore(join(dir, "content.db"));
  stores.push(store);
  return { root, store };
}

function write(root: string, file: string, text: string): string {
  const path = join(root, file);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// `runSync` wraps a loader's throw and keeps it as `cause` (rule 4).
async function causeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("Expected the sync to fail, and it did not");
}

function docs(root: string): Collection<MarkdownEntry> {
  return defineCollection<MarkdownEntry>({
    name: "docs",
    loader: defineMarkdownLoader({ root, locale: "en", languages: ["ts"] }),
    schema: false,
  });
}

test("a full sync files one entry per markdown file, keyed by its path", async () => {
  const { root, store } = siteWith({
    "guide.md": "# Guide\n",
    "adr/0001-a-decision.md": "# A decision\n",
    "notes.txt": "not markdown",
  });
  const collection = docs(root);

  const result = await syncCollection(store, collection);

  expect(result.changed.map((id) => `${id.locale}/${id.path}`)).toEqual([
    "en/adr/0001-a-decision",
    "en/guide",
  ]);
  expect(listEntries(store, collection).map((entry) => entry.path)).toEqual([
    "adr/0001-a-decision",
    "guide",
  ]);
});

test("an entry carries its frontmatter, its title and its rendered body", async () => {
  const { root, store } = siteWith({
    "guide.md": "---\nsection: how-to\n---\n# Guide\n\nText.\n",
  });
  const collection = docs(root);
  await syncCollection(store, collection);

  const entry = getEntry(store, collection, { locale: "en", path: "guide" });
  expect(entry?.data.frontmatter).toEqual({ section: "how-to" });
  expect(entry?.data.title).toBe("Guide");
  expect(entry?.data.file).toBe("guide.md");
  expect(entry?.data.html).toContain("<p>Text.</p>");
});

test("a frontmatter title wins over the body's first heading", async () => {
  const { root, store } = siteWith({
    "guide.md": "---\ntitle: The written title\n---\n# The heading\n",
  });
  const collection = docs(root);
  await syncCollection(store, collection);

  expect(
    getEntry(store, collection, { locale: "en", path: "guide" })?.data.title,
  ).toBe("The written title");
});

test("every file with no title at all is named in one report", async () => {
  const { root, store } = siteWith({
    "a.md": "Just a paragraph.\n",
    "b.md": "## Only a subheading\n",
    "c.md": "# Fine\n",
    "d.md": "# ![logo](x.png)\n\n# Later\n",
  });

  expect(await causeOf(syncCollection(store, docs(root)))).toBe(
    `Markdown root "${root}": 3 documents could not be read, and each failure below carries its own fix:\n` +
      `  Markdown "a.md": has no title — give it a "title" in its frontmatter, or open it with a level-1 heading that has text\n` +
      `  Markdown "b.md": has no title — give it a "title" in its frontmatter, or open it with a level-1 heading that has text\n` +
      `  Markdown "d.md": has no title — give it a "title" in its frontmatter, or open it with a level-1 heading that has text`,
  );
});

test("documents that fail for different reasons are reported in one run", async () => {
  const { root, store } = siteWith({
    "a.md": "---\ntitle: x\n# Never closed\n",
    "b.md": "# Fine\n\n```rust\nfn a() {}\n```\n",
    "c.md": "Untitled.\n",
    "d.md": "# Fine too\n",
  });

  expect(await causeOf(syncCollection(store, docs(root)))).toBe(
    `Markdown root "${root}": 3 documents could not be read, and each failure below carries its own fix:\n` +
      `  Markdown "a.md": opens a frontmatter block that is never closed — end the block with a line holding only "---", or remove the opening one\n` +
      `  Markdown "b.md": 1 code language is not loaded, so its fences cannot be highlighted — add each to the loader's languages, or drop the language from the fence:\n` +
      `    rust\n` +
      `  Markdown "c.md": has no title — give it a "title" in its frontmatter, or open it with a level-1 heading that has text`,
  );
});

// Mirrors `MarkdownEntry` rather than narrowing it: this tests the loader's own report.
function docsSchema() {
  const sections = ["how-to", "reference"];
  return z.object({
    title: z.string().min(1),
    html: z.string(),
    file: z.string(),
    frontmatter: z
      .record(z.string(), z.union([z.string(), z.array(z.string()).readonly()]))
      .superRefine((frontmatter, ctx) => {
        const section = frontmatter["section"];
        if (section === undefined || sections.includes(String(section))) return;
        ctx.addIssue({
          code: "custom",
          path: ["section"],
          message: `not a section — use one of: ${sections.join(", ")}`,
        });
      }),
  });
}

test("an entry whose frontmatter fails the collection schema is refused", async () => {
  const { root, store } = siteWith({
    "guide.md": "---\nsection: nonsense\n---\n# Guide\n",
  });
  const collection = defineCollection({
    name: "docs",
    loader: defineMarkdownLoader({ root, locale: "en", languages: ["ts"] }),
    schema: docsSchema(),
  });

  await expect(syncCollection(store, collection)).rejects.toThrow(
    'Collection "docs": 1 entry does not match the collection schema — fix the content, or relax the schema:\n  /en/guide: frontmatter.section — not a section — use one of: how-to, reference',
  );
});

test("an entry whose frontmatter satisfies the schema is stored", async () => {
  const { root, store } = siteWith({
    "guide.md": "---\nsection: how-to\n---\n# Guide\n",
  });
  const collection = defineCollection({
    name: "docs",
    loader: defineMarkdownLoader({ root, locale: "en", languages: ["ts"] }),
    schema: docsSchema(),
  });

  await syncCollection(store, collection);

  expect(
    getEntry(store, collection, { locale: "en", path: "guide" })?.data
      .frontmatter,
  ).toEqual({ section: "how-to" });
});

test("an incremental sync writes the files that changed and no others", async () => {
  const { root, store } = siteWith({
    "a.md": "# A\n",
    "b.md": "# B\n",
  });
  const collection = docs(root);
  const full = await syncCollection(store, collection);
  const untouched = getEntry(store, collection, { locale: "en", path: "b" });

  // A whole second later, for filesystems with coarse timestamps.
  const changed = write(root, "a.md", "# A, revised\n");
  const later = new Date(Date.now() + 1000);
  utimesSync(changed, later, later);

  const delta = await syncCollectionSince(store, collection, full.cursor);

  expect(delta.changed.map((id) => id.path)).toEqual(["a"]);
  expect(
    getEntry(store, collection, { locale: "en", path: "a" })?.data.title,
  ).toBe("A, revised");
  // `seq` is the store's write sequence, so an equal one means the row was not rewritten.
  expect(getEntry(store, collection, { locale: "en", path: "b" })?.seq).toBe(
    untouched?.seq,
  );
});

test("an incremental sync that finds nothing changed writes nothing", async () => {
  const { root, store } = siteWith({ "a.md": "# A\n" });
  const collection = docs(root);
  const full = await syncCollection(store, collection);

  const delta = await syncCollectionSince(store, collection, full.cursor);

  expect(delta.changed).toEqual([]);
  expect(delta.cursor).toBeGreaterThanOrEqual(full.cursor);
});

test("a file added after the last sync arrives on the next incremental one", async () => {
  const { root, store } = siteWith({ "a.md": "# A\n" });
  const collection = docs(root);
  const full = await syncCollection(store, collection);

  const added = write(root, "b.md", "# B\n");
  const later = new Date(Date.now() + 1000);
  utimesSync(added, later, later);

  const delta = await syncCollectionSince(store, collection, full.cursor);

  expect(delta.changed.map((id) => id.path)).toEqual(["b"]);
});

test("a root that is not there is refused by name, not walked as empty", async () => {
  const { root, store } = siteWith({});
  const missing = join(root, "nowhere");

  const run = syncCollection(
    store,
    defineCollection<MarkdownEntry>({
      name: "docs",
      loader: defineMarkdownLoader({
        root: missing,
        locale: "en",
        languages: ["ts"],
      }),
      schema: false,
    }),
  );

  expect(await causeOf(run)).toBe(
    `Markdown root "${missing}": is not a directory, so the collection would sync as empty — point the loader at the directory the markdown lives in`,
  );
});

test("a document deleted from the tree stops being an entry on the next full sync", async () => {
  const { root, store } = siteWith({ "a.md": "# A\n", "b.md": "# B\n" });
  const collection = docs(root);
  await syncCollection(store, collection);

  rmSync(join(root, "b.md"));
  await syncCollection(store, collection);

  expect(getEntry(store, collection, { locale: "en", path: "b" })).toBeUndefined();
});

test("a document nobody touched survives that same sync", async () => {
  const { root, store } = siteWith({ "a.md": "# A\n", "b.md": "# B\n" });
  const collection = docs(root);
  await syncCollection(store, collection);

  rmSync(join(root, "b.md"));
  await syncCollection(store, collection);

  expect(
    getEntry(store, collection, { locale: "en", path: "a" })?.data.title,
  ).toBe("A");
});

test("an incremental sync does not remove what its filter skipped", async () => {
  const { root, store } = siteWith({ "a.md": "# A\n", "b.md": "# B\n" });
  const collection = docs(root);
  const full = await syncCollection(store, collection);

  const delta = await syncCollectionSince(store, collection, full.cursor);

  expect(delta.changed).toEqual([]);
  expect(
    getEntry(store, collection, { locale: "en", path: "b" })?.data.title,
  ).toBe("B");
});

test("an entry carries the outline of the body it stored", async () => {
  const { root, store } = siteWith({
    "guide.md": "# Guide\n\n## Install\n\n## Install\n",
  });
  const collection = docs(root);
  await syncCollection(store, collection);

  const entry = getEntry(store, collection, { locale: "en", path: "guide" });
  expect(entry?.data.toc).toEqual([
    { depth: 2, slug: "install", text: "Install" },
    { depth: 2, slug: "install-1", text: "Install" },
  ]);
  for (const item of entry?.data.toc ?? []) {
    expect(entry?.data.html).toContain(`id="${item.slug}"`);
  }
});

test("a theme pair reaches the stored body through the loader's own option", async () => {
  const { root, store } = siteWith({
    "guide.md": "# Guide\n\n```ts\nconst x = 1;\n```\n",
  });
  const collection = defineCollection<MarkdownEntry>({
    name: "docs",
    loader: defineMarkdownLoader({
      root,
      locale: "en",
      languages: ["ts"],
      theme: { light: "github-light", dark: "github-dark" },
    }),
    schema: false,
  });
  await syncCollection(store, collection);

  const entry = getEntry(store, collection, { locale: "en", path: "guide" });
  expect(entry?.data.html).toMatch(
    /<span style="color:#[0-9A-Fa-f]+;--shiki-dark:#[0-9A-Fa-f]+">/,
  );
  expect(entry?.data.html).toContain("--shiki-dark-bg:");
});

test("smartQuotes reaches the stored body and outline through the loader's own option", async () => {
  const { root, store } = siteWith({ "guide.md": "# Guide\n\n## What's next\n\nIt's \"here\".\n" });
  const collection = defineCollection<MarkdownEntry>({
    name: "docs",
    loader: defineMarkdownLoader({ root, locale: "en", languages: ["ts"], smartQuotes: true }),
    schema: false,
  });
  await syncCollection(store, collection);

  const entry = getEntry(store, collection, { locale: "en", path: "guide" });
  expect(entry?.data.html).toContain("<p>It’s “here”.</p>");
  expect(entry?.data.toc).toEqual([{ depth: 2, text: "What’s next", slug: "whats-next" }]);
});

const LANGUAGES_FIX =
  "pass languages: [...] naming the code-fence languages the site uses, or [] for none";

test.each([
  [
    "omitted",
    undefined,
    `Markdown root "/site/content": the loader has no "languages" option — ${LANGUAGES_FIX}`,
  ],
  [
    "a string",
    "ts",
    `Markdown root "/site/content": the loader's "languages" option is "ts", not a list — ${LANGUAGES_FIX}`,
  ],
  [
    "a bigint",
    1n,
    `Markdown root "/site/content": the loader's "languages" option is 1n, not a list — ${LANGUAGES_FIX}`,
  ],
  [
    "a list holding a number and a boolean",
    ["ts", 1, true],
    `Markdown root "/site/content": 2 entries of the loader's "languages" option are not language names — ${LANGUAGES_FIX}:\n  languages[1] is 1, not a string\n  languages[2] is true, not a string`,
  ],
  [
    "a list holding a bigint",
    ["ts", 1n],
    `Markdown root "/site/content": 1 entry of the loader's "languages" option is not a language name — ${LANGUAGES_FIX}:\n  languages[1] is 1n, not a string`,
  ],
])("languages %s is refused when the loader is defined", (_, languages, message) => {
  const options = { root: "/site/content", locale: "en", languages } as unknown as MarkdownLoaderOptions;
  expect(() => defineMarkdownLoader(options)).toThrow(message);
});

test.each([[[]], [["ts"]]])("languages %j is accepted when the loader is defined", (languages) => {
  expect(() =>
    defineMarkdownLoader({ root: "/site/content", locale: "en", languages } as MarkdownLoaderOptions),
  ).not.toThrow();
});
