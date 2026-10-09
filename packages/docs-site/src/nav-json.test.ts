import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Entry } from "@pagedeck/content";
import { parseFrontmatter } from "@pagedeck/markdown-loader";
import type { MarkdownEntry } from "@pagedeck/markdown-loader";
import { buildNav } from "./sections.js";
import type { NavDocument } from "./sections.js";
import { REPOSITORY_DOCS } from "./site.js";
import { guideFiles, GUIDES, markdownFiles } from "./guides.test-support.js";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..", "docs");

function document(root: string, file: string): NavDocument {
  const { frontmatter } = parseFrontmatter(readFileSync(join(root, file), "utf8"), file);
  const path = file.slice(0, -".md".length);
  const data: MarkdownEntry = {
    frontmatter,
    title: String(frontmatter["title"]),
    html: "",
    toc: [],
    file,
  };
  return {
    href: path === "index" ? "/" : `/${path}/`,
    entry: { data } as Entry<MarkdownEntry>,
  };
}

test("nav.json holds the docs site's sections and pages, in the order its navigation shows them", () => {
  const published: readonly string[] = REPOSITORY_DOCS.published;
  const documents = [
    ...guideFiles().map((file) => document(GUIDES, file)),
    ...markdownFiles(REPOSITORY)
      .filter((file) => published.includes(file.split("/")[0] ?? file))
      .map((file) => document(REPOSITORY, file)),
  ];
  const fileOf = new Map(documents.map(({ href, entry }) => [href, entry.data.file]));
  const expected = buildNav(documents, "").map(({ label, links }) => ({
    label,
    pages: links.map(({ href }) => fileOf.get(href)),
  }));

  expect(
    JSON.parse(readFileSync(join(GUIDES, "nav.json"), "utf8")),
    "nav.json is out of step with the docs site's navigation — list each page under its section, sections in SECTIONS order and pages by route",
  ).toEqual(expected);
});
