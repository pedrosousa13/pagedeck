import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { contrastPairs, readThemes, unclassifiedTokens } from "./tokens.js";

const PACKAGES = join(import.meta.dirname, "..", "..");
const BRAND_CSS = join(PACKAGES, "brand", "brand.css");
const css = readFileSync(BRAND_CSS, "utf8");
const themes = readThemes(css);

test.each(["light", "dark"] as const)(
  "every text/background pair in the %s theme meets WCAG AA",
  (theme) => {
    const pairs = contrastPairs(themes[theme]);
    const faults = pairs
      .filter((pair) => pair.ratio < pair.minimum)
      .map(
        (pair) =>
          `  ${pair.fg} on ${pair.bg}: ${pair.ratio.toFixed(2)}:1, needs ${String(pair.minimum)}:1 — change one of the two in packages/brand/brand.css`,
      );
    expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
    // A floor, so a reader that stops finding tokens cannot pass over nothing.
    expect(pairs.length).toBeGreaterThanOrEqual(17);
  },
);

test("every token is placed: a text, surface, ring or decoration colour, or a non-colour family", () => {
  expect(unclassifiedTokens(themes.light)).toEqual([]);
  expect(unclassifiedTokens(themes.dark)).toEqual([]);
});

test("the dark theme redeclares every colour the light theme states outright", () => {
  const literal = [...themes.light.declared.entries()]
    .filter(([, value]) => value.startsWith("#"))
    .map(([name]) => name);
  expect(literal.length).toBeGreaterThan(0);
  expect(literal.filter((name) => !themes.dark.declared.has(name))).toEqual([]);
});

test("each of the three sites imports this one token source", () => {
  for (const site of ["landing", "docs", "site"]) {
    const sheet = join(PACKAGES, site, "styles", "global.css");
    const imports = [
      ...readFileSync(sheet, "utf8").matchAll(/@import\s+"([^"]+)"/g),
    ].map(([, path]) => resolve(join(PACKAGES, site, "styles"), path as string));
    expect(imports, site).toContain(BRAND_CSS);
  }
});
