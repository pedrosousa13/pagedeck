import { expect, test } from "vitest";
import { neighbours, refuseUnplaced, sectionOf } from "./sections.js";
import type { NavSection } from "./sections.js";
import type { MarkdownEntry } from "@pagedeck/markdown-loader";

function document(
  file: string,
  frontmatter: MarkdownEntry["frontmatter"] = {},
): MarkdownEntry {
  return { file, frontmatter, title: "A document", html: "", toc: [] };
}

test("a document takes the section its frontmatter declares", () => {
  expect(sectionOf(document("anywhere/x.md", { section: "tutorial" }))).toBe(
    "tutorial",
  );
});

test("frontmatter wins over the directory it is filed in", () => {
  expect(sectionOf(document("adr/x.md", { section: "reference" }))).toBe(
    "reference",
  );
});

test("a document with no frontmatter takes its directory's section", () => {
  expect(sectionOf(document("adr/0001-a.md"))).toBe("explanation");
  expect(sectionOf(document("error-messages.md"))).toBe("reference");
});

test("a section this site does not have does not place a document", () => {
  expect(sectionOf(document("adr/x.md", { section: "nonsense" }))).toBe(
    "explanation",
  );
  expect(sectionOf(document("newthing/x.md"))).toBeUndefined();
});

test("a list-valued section places nothing, rather than being joined", () => {
  expect(
    sectionOf(document("newthing/x.md", { section: ["tutorial"] })),
  ).toBeUndefined();
});

test("nothing unplaced is not a failure", () => {
  expect(() => refuseUnplaced([])).not.toThrow();
});

test("every unplaced document is named, with both ways to place it", () => {
  expect(() => refuseUnplaced(["newthing/a.md", "newthing/b.md"])).toThrow(
    'Docs site: 2 documents are in no section, so the navigation would not list them — declare "section" in the document\'s frontmatter as one of about, tutorial, how-to, reference, explanation, or add its directory to SECTION_OF_DIRECTORY:\n  newthing/a.md\n  newthing/b.md',
  );
});

test("one unplaced document reads as one, not as a plural with a count", () => {
  expect(() => refuseUnplaced(["newthing/a.md"])).toThrow(
    'Docs site: 1 document is in no section, so the navigation would not list it — declare "section" in the document\'s frontmatter as one of about, tutorial, how-to, reference, explanation, or add its directory to SECTION_OF_DIRECTORY:\n  newthing/a.md',
  );
});

function navAt(current: string): NavSection[] {
  const link = (href: string) => ({ href, label: href, current: href === current });
  return [
    { label: "Overview", links: [link("/")] },
    { label: "Reference", links: [link("/a"), link("/b")] },
  ];
}

test("a page's neighbours are the links before and after it in reading order, across sections", () => {
  expect(neighbours(navAt("/"))).toEqual({
    previous: undefined,
    next: { href: "/a", label: "/a", current: false },
  });
  expect(neighbours(navAt("/a"))).toEqual({
    previous: { href: "/", label: "/", current: false },
    next: { href: "/b", label: "/b", current: false },
  });
  expect(neighbours(navAt("/b")).next).toBeUndefined();
});

test("a page the navigation does not list has no neighbours", () => {
  expect(neighbours(navAt("/search"))).toEqual({
    previous: undefined,
    next: undefined,
  });
});
