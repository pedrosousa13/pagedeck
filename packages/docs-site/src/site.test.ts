import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, test } from "vitest";
import { openStore } from "@pagedeck/content";
import type { ContentStoreReader, Entry } from "@pagedeck/content";
import { collectPages } from "@pagedeck/core";
import { unescapedHtml } from "@pagedeck/core/tree";
import { createMarkdownRenderer, parseFrontmatter } from "@pagedeck/markdown-loader";
import {
  docsSiteConfig,
  documentSchema,
  isGuide,
  LANGUAGES,
  repositoryLoader,
  routedLinks,
} from "./site.js";
import type { DocumentEntry } from "./site.js";
import type { SectionName } from "./sections.js";
import { guideFiles, GUIDES } from "./guides.test-support.js";

// A hand-written store, so the document count can vary.
function collectAgainst(perCollection: number): {
  reads: number;
  pages: number;
} {
  const directory = mkdtempSync(join(tmpdir(), "pagedeck-docs-pages-"));
  const store = openStore(join(directory, "content.db"));
  try {
    for (const collection of ["guides", "repository"]) {
      for (let index = 0; index < perCollection; index += 1) {
        const path = `${collection}-${String(index)}`;
        store.upsertEntry({
          collection,
          locale: "en",
          path,
          data: { title: path, html: "", file: `${path}.md`, frontmatter: {} },
        });
      }
    }

    let reads = 0;
    const counted: ContentStoreReader = {
      ...store,
      listEntries<T>(collection: string, locale?: string): Entry<T>[] {
        reads += 1;
        return store.listEntries<T>(collection, locale);
      },
    };

    const pages = docsSiteConfig().build?.pages;
    if (pages === undefined) throw new Error("the site declares no pages");
    const collected = collectPages(counted, pages).length;
    return { reads, pages: collected };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the page sources enumerate the collections a fixed number of times", () => {
  // Each document source reads its own collection and both for the navigation,
  // and `/search` reads both once: eight, whatever the document count (#200).
  expect(collectAgainst(3)).toEqual({ reads: 8, pages: 7 });
  expect(collectAgainst(9)).toEqual({ reads: 8, pages: 19 });
});

test("the schema narrows section to the sections this site has", () => {
  expectTypeOf<DocumentEntry["frontmatter"]["section"]>().toEqualTypeOf<
    SectionName | undefined
  >();
});

test("a document declaring a section this site does not have is refused, with the fix", async () => {
  const verdict = await documentSchema()["~standard"].validate({
    title: "A document",
    html: "",
    file: "guide.md",
    frontmatter: { section: "nonsense", description: "A document." },
    toc: [],
  });

  expect(
    verdict.issues?.map(
      (issue) => `${issue.path?.join(".")} — ${issue.message}`,
    ),
  ).toEqual([
    "frontmatter.section — not a section of this site — use one of: about, tutorial, how-to, reference, explanation",
  ]);
});

async function issuesFor(
  frontmatter: Record<string, unknown>,
): Promise<string[] | undefined> {
  const verdict = await documentSchema()["~standard"].validate({
    title: "A document",
    html: "",
    file: "guide.md",
    frontmatter,
    toc: [],
  });
  return verdict.issues?.map(
    (issue) => `${issue.path?.join(".")} — ${issue.message}`,
  );
}

const MISSING_DESCRIPTION =
  'frontmatter.description — missing — give the page a "description" in its frontmatter: one sentence saying what the page covers, 150 characters at most, which the page emits as its meta description';

test("a document with no description is refused, with the fix", async () => {
  expect(await issuesFor({})).toEqual([MISSING_DESCRIPTION]);
});

test("an empty or blank description is refused as a missing one", async () => {
  expect(await issuesFor({ description: "" })).toEqual([MISSING_DESCRIPTION]);
  expect(await issuesFor({ description: "   " })).toEqual([
    MISSING_DESCRIPTION,
  ]);
});

test("a description written as a list is refused as a list, not as missing", async () => {
  expect(await issuesFor({ description: ["One", "Two"] })).toEqual([
    "frontmatter.description — is a list, not one line of text — write the description as a single sentence after the colon, with no brackets",
  ]);
});

test("a description over 150 characters is refused, naming its length", async () => {
  expect(await issuesFor({ description: "a".repeat(151) })).toEqual([
    "frontmatter.description — 151 characters, over the 150 a meta description is kept to — shorten it to 150 or fewer",
  ]);
  expect(await issuesFor({ description: "a".repeat(150) })).toBeUndefined();
});

test("the schema narrows description to a string every document has", () => {
  expectTypeOf<
    DocumentEntry["frontmatter"]["description"]
  >().toEqualTypeOf<string>();
});

test("no docs page loses a byte to the reserved-name strip", async () => {
  const renderer = await createMarkdownRenderer({ languages: [...LANGUAGES] });
  const losses: string[] = [];
  for (const file of guideFiles()) {
    const source = readFileSync(join(GUIDES, file), "utf8");
    const { body } = parseFrontmatter(source, file);
    const { html } = await renderer.render(body, file);
    const stripped = unescapedHtml(html).dangerouslySetInnerHTML.__html;
    if (stripped === html) continue;
    let start = 0;
    while (html[start] === stripped[start]) start += 1;
    let end = 0;
    while (
      end < stripped.length - start &&
      html[html.length - 1 - end] === stripped[stripped.length - 1 - end]
    ) {
      end += 1;
    }
    const removed = html.slice(start, html.length - end);
    losses.push(`${file}: the strip removes ${JSON.stringify(removed)}`);
  }

  expect(losses).toEqual([]);
});

test("a heading spelling a framework-reserved name still anchors after the strip", async () => {
  // Checked here, not in `@pagedeck/markdown-loader`, which must not depend on
  // `@pagedeck/core`.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## data-fw-slot\n\n## Data FW Props\n\n## fw\n\n## fw\n",
    "d.md",
  );
  const stripped = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...stripped.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  // The strip also removes reserved names from prose, so the heading's own text
  // goes; its anchor still lands.
  expect(stripped).toContain('<h2 id="slot"></h2>');
});

test("a heading spelling a reserved name after a non-ASCII letter still anchors", async () => {
  // A non-ASCII letter is the one character `slugify` admits that core's ASCII
  // name boundary cuts at, putting a reserved name mid-slug.
  const renderer = await createMarkdownRenderer({ languages: [] });
  const rendered = await renderer.render(
    "## エdata-fw-slot\n\n## 属性data-fw-props\n\n## édata-fw-mode\n\n## ページdata-fw-template\n\n## エdata-fw-slotédata-fw-props\n",
    "d.md",
  );
  const stripped = unescapedHtml(rendered.html).dangerouslySetInnerHTML.__html;

  expect(
    [...stripped.matchAll(/ id="([^"]*)"/g)].map((match) => match[1]),
  ).toEqual(rendered.toc.map((entry) => entry.slug));
  expect(rendered.toc.map((entry) => entry.slug)).toEqual([
    "エslot",
    "属性props",
    "émode",
    "ページtemplate",
    // Two in one slug, so a strip that stopped after one removal would fail here.
    "エslotéprops",
  ]);
});

test("the schema keeps the outline the loader produced", async () => {
  const verdict = await documentSchema()["~standard"].validate({
    title: "A document",
    html: '<h2 id="install">Install</h2>',
    file: "guide.md",
    frontmatter: { description: "A document." },
    toc: [{ depth: 2, slug: "install", text: "Install" }],
  });

  expect(verdict.issues).toBeUndefined();
  expect((verdict as { value: DocumentEntry }).value.toc).toEqual([
    { depth: 2, slug: "install", text: "Install" },
  ]);
});

async function syncRepository(files: readonly string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "pagedeck-docs-repository-"));
  try {
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "# A document\n");
    }
    const written: string[] = [];
    const result = await repositoryLoader(root).syncAll({
      upsert: (entry) => written.push(entry.path),
      delete: () => undefined,
    });
    expect(result.changed.map((id) => id.path).sort()).toEqual(
      [...written].sort(),
    );
    return written.sort();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the repository collection writes only the entries of docs/ the site shows", async () => {
  expect(
    await syncRepository([
      "adr/0001-a.md",
      "deploy-recipe.md",
      "error-messages.md",
      "agents/issue-tracker.md",
      "dogfood-parity.md",
      "research/a.md",
      "scaling-verification.md",
      "specs/a.md",
      "success-criteria.md",
    ]),
  ).toEqual(["adr/0001-a", "deploy-recipe", "error-messages"]);
});

test("an entry of docs/ on neither of the site's lists fails the sync, naming every one", async () => {
  await expect(
    syncRepository(["adr/0001-a.md", "notes.md", "drafts/a.md"]),
  ).rejects.toThrow(
    /^Docs site: 2 entries directly under "[^"]+" are on neither of the docs site's lists, so the site cannot tell whether to show them — add each entry to REPOSITORY_DOCS\.published to put it on the site, or to REPOSITORY_DOCS\.excluded to keep it off the site:\n {2}drafts\n {2}notes\.md$/,
  );
});

test("one unclassified entry reads as one", async () => {
  await expect(syncRepository(["notes.md"])).rejects.toThrow(
    /^Docs site: 1 entry directly under "[^"]+" is on neither of the docs site's lists, so the site cannot tell whether to show it — add each entry to REPOSITORY_DOCS\.published to put it on the site, or to REPOSITORY_DOCS\.excluded to keep it off the site:\n {2}notes\.md$/,
  );
});

const SEARCH_SAMPLES: readonly (readonly string[])[] = [
  ["packages/docs-site/src/site.ts"],
  [
    "packages/docs-site/src/components/shell.ts",
    "packages/docs-site/src/components/nav.tsx",
  ],
  ["packages/landing/src/catalog.ts"],
  ["packages/landing/src/features.ts"],
];

const FONTS_SAMPLES: readonly (readonly string[])[] = [
  ["packages/landing/src/features.ts", "packages/landing/src/site.ts"],
  ["packages/site/src/site.ts"],
];

// Fences are matched to `samples` by position, so a new sample needs a source.
function unsourcedSampleLines(
  name: string,
  samples: readonly (readonly string[])[],
): string[] {
  const repo = join(import.meta.dirname, "..", "..", "..");
  const page = join(import.meta.dirname, "..", "..", "docs", "reference", name);
  expect(existsSync(page), page).toBe(true);
  const fences = [
    ...readFileSync(page, "utf8").matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm),
  ].map((match) => match[1] as string);
  expect(fences).toHaveLength(samples.length);

  const missing: string[] = [];
  fences.forEach((fence, index) => {
    const files = samples[index] as readonly string[];
    const lines = new Set(
      files.flatMap((file) =>
        readFileSync(join(repo, file), "utf8")
          .split("\n")
          .map((line) => line.trim()),
      ),
    );
    for (const line of fence.split("\n").map((text) => text.trim())) {
      if (line === "" || line.startsWith("//")) continue;
      if (!lines.has(line))
        missing.push(`sample ${String(index + 1)}: ${line}`);
    }
  });
  return missing;
}

test("every code sample on the site search page is a line of a site that builds with it", () => {
  expect(unsourcedSampleLines("site-search.md", SEARCH_SAMPLES)).toEqual([]);
});

test("every code sample on the fonts page is a line of a site that builds with it", () => {
  expect(unsourcedSampleLines("fonts.md", FONTS_SAMPLES)).toEqual([]);
});

test("a relative link to a page renders as that page's route, fragment kept", () => {
  expect(
    routedLinks(
      '<a href="../reference/cli.md#flags">a</a> <a href="./write-a-loader.md">b</a> <a href="../index.md">c</a>',
      "how-to/deploy-a-site.md",
    ),
  ).toBe('<a href="/reference/cli/#flags">a</a> <a href="/how-to/write-a-loader/">b</a> <a href="/">c</a>');
  expect(routedLinks('<a href="adr/0001-a.md">x</a>', "deploy-recipe.md")).toBe(
    '<a href="/adr/0001-a/">x</a>',
  );
});

test("a link that is not a relative link to a page is left as written", () => {
  const html =
    '<a href="https://example.com/a.md">a</a><a href="#top">b</a><a href="/reference/cli/">c</a><a href="./logo.png">d</a><code>href="./x.md"</code>';
  expect(routedLinks(html, "reference/cli.md")).toBe(html);
});

test("a guide is a page of the docs package that is not its readme or a copy of docs/", () => {
  expect(
    [
      "index.md",
      "how-to/add-an-island.md",
      "README.md",
      "adr/0001-routing-without-a-router-package.md",
      "deploy-recipe.md",
      "error-messages.md",
      "node_modules/marked/README.md",
    ].filter(isGuide),
  ).toEqual(["index.md", "how-to/add-an-island.md"]);
});
