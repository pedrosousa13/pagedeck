import { expect, test } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

test("a document with no frontmatter block is all body", () => {
  const parsed = parseFrontmatter("# Title\n\nText.\n", "docs/a.md");
  expect(parsed.frontmatter).toEqual({});
  expect(parsed.body).toBe("# Title\n\nText.\n");
});

test("a leading block is read as fields and taken off the body", () => {
  const parsed = parseFrontmatter(
    "---\ntitle: Getting started\nsection: tutorial\n---\n# Heading\n",
    "docs/a.md",
  );
  expect(parsed.frontmatter).toEqual({
    title: "Getting started",
    section: "tutorial",
  });
  expect(parsed.body).toBe("# Heading\n");
});

test("a bracketed value is a list of its comma-separated items", () => {
  const parsed = parseFrontmatter("---\ntags: [loader, sync]\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ tags: ["loader", "sync"] });
});

test("an empty bracketed value is an empty list, not a list of one", () => {
  const parsed = parseFrontmatter("---\ntags: []\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ tags: [] });
});

test("a quoted value keeps whatever the quotes hold, colons included", () => {
  const parsed = parseFrontmatter(
    '---\nsummary: "Loaders: what they are"\n---\n',
    "d.md",
  );
  expect(parsed.frontmatter).toEqual({ summary: "Loaders: what they are" });
});

test("a number is left as the text it was written as", () => {
  const parsed = parseFrontmatter("---\norder: 2\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ order: "2" });
});

test("blank lines inside a block are skipped rather than refused", () => {
  const parsed = parseFrontmatter("---\na: 1\n\nb: 2\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ a: "1", b: "2" });
});

test("an unterminated block names the file and says how to close it", () => {
  expect(() => parseFrontmatter("---\ntitle: x\n# Heading\n", "docs/a.md")).toThrow(
    'Markdown "docs/a.md": opens a frontmatter block that is never closed — end the block with a line holding only "---", or remove the opening one',
  );
});

test("every unreadable line of one block is reported, not the first", () => {
  expect(() =>
    parseFrontmatter("---\ntitle x\nsection: how-to\nbogus\n---\n", "docs/a.md"),
  ).toThrow(
    'Markdown "docs/a.md": 2 frontmatter lines are not fields — write each as "name: value", or move the text into the body:\n  line 2: title x\n  line 4: bogus',
  );
});

test("a repeated field names both lines rather than keeping one silently", () => {
  expect(() =>
    parseFrontmatter("---\ntitle: a\ntitle: b\n---\n", "docs/a.md"),
  ).toThrow(
    'Markdown "docs/a.md": 1 frontmatter field is declared twice — delete the line that is not wanted:\n  "title" on lines 2 and 3',
  );
});

test("a field with indented dash lines under it is a list of them", () => {
  const parsed = parseFrontmatter(
    "---\ntags:\n  - routing\n  - content-store\ntitle: x\n---\n",
    "d.md",
  );
  expect(parsed.frontmatter).toEqual({
    tags: ["routing", "content-store"],
    title: "x",
  });
});

test("a dash line needs no indentation, which is what YAML allows", () => {
  const parsed = parseFrontmatter("---\ntags:\n- a\n- b\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ tags: ["a", "b"] });
});

test("a quoted item keeps whatever the quotes hold", () => {
  const parsed = parseFrontmatter(
    '---\ntags:\n  - "one, two"\n---\n',
    "d.md",
  );
  expect(parsed.frontmatter).toEqual({ tags: ["one, two"] });
});

test("a colon inside an item is part of the item, not a field of its own", () => {
  // Pinned: the item rule wins, so `- a: 1` is an item, not a field named `- a`.
  const parsed = parseFrontmatter("---\ntags:\n- a: 1\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ tags: ["a: 1"] });
});

test("a blank line between items leaves the open list open", () => {
  const parsed = parseFrontmatter(
    "---\ntags:\n  - a\n\n  - b\ntitle: x\n---\n",
    "d.md",
  );
  expect(parsed.frontmatter).toEqual({ tags: ["a", "b"], title: "x" });
});

test("a field written with no value and no items under it stays empty text", () => {
  const parsed = parseFrontmatter("---\ntags:\ntitle: x\n---\n", "d.md");
  expect(parsed.frontmatter).toEqual({ tags: "", title: "x" });
});

test("a dash line under a field that already has a value is not an item", () => {
  expect(() =>
    parseFrontmatter("---\ntags: [a]\n  - b\n---\n", "docs/a.md"),
  ).toThrow(
    'Markdown "docs/a.md": 1 frontmatter line is not a field — write each as "name: value", or move the text into the body:\n  line 3:   - b',
  );
});

test("a dash line before any field at all is not an item", () => {
  expect(() => parseFrontmatter("---\n  - b\ntitle: x\n---\n", "docs/a.md")).toThrow(
    'Markdown "docs/a.md": 1 frontmatter line is not a field — write each as "name: value", or move the text into the body:\n  line 2:   - b',
  );
});

test("a bare dash with nothing after it is not an item", () => {
  expect(() => parseFrontmatter("---\ntags:\n  -\n---\n", "docs/a.md")).toThrow(
    'Markdown "docs/a.md": 1 frontmatter line is not a field — write each as "name: value", or move the text into the body:\n  line 3:   -',
  );
});

test("a repeated field is still refused when the second is a list", () => {
  expect(() =>
    parseFrontmatter("---\ntags: [a]\ntags:\n  - b\n---\n", "docs/a.md"),
  ).toThrow(
    'Markdown "docs/a.md": 1 frontmatter field is declared twice — delete the line that is not wanted:\n  "tags" on lines 2 and 3',
  );
});
