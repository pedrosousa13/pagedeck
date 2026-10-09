import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fences } from "./tutorial.test-support.js";

const REFERENCE = join(import.meta.dirname, "..", "content", "reference", "favicon.md");
// Its fence is held to the producer in `packages/core/src/favicon.ts` by `catalogued-messages.test.ts`.
const CATALOGUE = join(import.meta.dirname, "..", "..", "..", "docs", "error-messages.md");

const warning = (markdown: string): string | undefined =>
  fences(markdown).find(({ code }) => code.startsWith("Favicon: this site declares no build.favicon"))
    ?.code;

test("the build warning the page quotes is the one the catalogue holds to the code", () => {
  const catalogued = warning(readFileSync(CATALOGUE, "utf8"));
  expect(catalogued, `a "Favicon: this site declares no" line fenced in ${CATALOGUE}`).toBeDefined();
  expect(warning(readFileSync(REFERENCE, "utf8"))).toBe(catalogued);
});

test("the build warning the page quotes cites this page's title", () => {
  const text = readFileSync(REFERENCE, "utf8");
  const cited = /\(Pagedeck documentation: ([^)]+)\)\n$/.exec(warning(text) ?? "");
  expect(cited, `a quoted warning ending "(Pagedeck documentation: <title>)"`).not.toBeNull();
  expect(/^title: (.+)$/m.exec(text)?.[1]).toBe(cited?.[1]);
});
