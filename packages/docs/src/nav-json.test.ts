import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseFrontmatter } from "@pagedeck/markdown-loader";
import { guides, listed, PACKAGE, published, REPOSITORY, REPOSITORY_DOCS, routeOf, top } from "./pages.test-support.js";

// Editorial order, not sorted: alphabetical would open on "Explanation".
const SECTIONS = [
  { name: "about", label: "Overview" },
  { name: "tutorial", label: "Tutorials" },
  { name: "how-to", label: "How-to guides" },
  { name: "reference", label: "Reference" },
  { name: "explanation", label: "Explanation" },
] as const;

const SECTION_OF_DIRECTORY: Readonly<Record<string, string>> = {
  "": "reference",
  adr: "explanation",
};

const SECTION_NAMES: readonly string[] = SECTIONS.map(({ name }) => name);

// A declared section that is not one of SECTIONS is refused, never read as the directory's.
function sectionOf(root: string, file: string): string | undefined {
  const { frontmatter } = parseFrontmatter(readFileSync(join(root, file), "utf8"), file);
  const declared = frontmatter["section"];
  if (declared !== undefined) return typeof declared === "string" && SECTION_NAMES.includes(declared) ? declared : undefined;
  return SECTION_OF_DIRECTORY[file.includes("/") ? top(file) : ""];
}

test("every entry directly under docs/ is either published in @pagedeck/docs or excluded from it", () => {
  const unclassified = readdirSync(REPOSITORY)
    .filter((name) => !listed(name, REPOSITORY_DOCS.published) && !listed(name, REPOSITORY_DOCS.excluded))
    .sort();
  expect(
    unclassified,
    "add each entry to REPOSITORY_DOCS.published in packages/docs/src/pages.test-support.ts to pack it in @pagedeck/docs, and list its pages in nav.json, or to REPOSITORY_DOCS.excluded to keep it in the repository only",
  ).toEqual([]);
});

test("nav.json lists every page under its section, sections in SECTIONS order and pages by route", () => {
  const pages = [
    ...guides().map((file) => ({ file, section: sectionOf(PACKAGE, file) })),
    ...published().map((file) => ({ file, section: sectionOf(REPOSITORY, file) })),
  ];
  expect(
    pages.filter(({ section }) => section === undefined).map(({ file }) => file),
    `each page is in no section, or declares one this list does not have — set "section" in its frontmatter to one of ${SECTION_NAMES.join(", ")}, or leave "section" out and add its directory to SECTION_OF_DIRECTORY`,
  ).toEqual([]);
  const expected = SECTIONS.map(({ name, label }) => ({
    label,
    pages: pages
      .filter(({ section }) => section === name)
      .map(({ file }) => file)
      .sort((left, right) => (routeOf(left) < routeOf(right) ? -1 : 1)),
  })).filter((group) => group.pages.length > 0);

  expect(
    JSON.parse(readFileSync(join(PACKAGE, "nav.json"), "utf8")),
    "nav.json is out of step with the pages — list each page under its section, sections in SECTIONS order and pages by route",
  ).toEqual(expected);
});
