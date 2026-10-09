import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fences } from "./tutorial.test-support.js";

const REFERENCE = join(import.meta.dirname, "..", "..", "docs", "reference", "page-head.md");
const CATALOGUE = join(import.meta.dirname, "..", "..", "..", "docs", "error-messages.md");

const warning = (markdown: string): string | undefined =>
  fences(markdown).find(({ code }) => code.startsWith("Social image: this site draws share cards"))
    ?.code;

test("the origin warning the page quotes is the one the catalogue holds to the code", () => {
  const catalogued = warning(readFileSync(CATALOGUE, "utf8"));
  expect(catalogued, `a "Social image: this site draws share cards" line fenced in ${CATALOGUE}`).toBeDefined();
  expect(warning(readFileSync(REFERENCE, "utf8"))).toBe(catalogued);
});

test("the origin warning the page quotes cites this page's title and one of its headings", () => {
  const text = readFileSync(REFERENCE, "utf8");
  const cited = /\(Pagedeck documentation: ([^,]+), ([^)]+)\)\n$/.exec(warning(text) ?? "");
  expect(cited, `a quoted warning ending "(Pagedeck documentation: <title>, <heading>)"`).not.toBeNull();
  expect(/^title: (.+)$/m.exec(text)?.[1]).toBe(cited?.[1]);
  expect(text.split("\n")).toContain(`## ${String(cited?.[2])}`);
});
