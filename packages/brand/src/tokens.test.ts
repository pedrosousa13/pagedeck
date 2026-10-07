import { expect, test } from "vitest";
import { contrastPairs, readThemes, unclassifiedTokens } from "./tokens.js";

const SHEET = `
/* A comment holding :root { --fw-fg: #ff0000; } is not a declaration. */
@layer theme {
  :root {
    color-scheme: light dark;
    --fw-bg: #ffffff;
    --fw-bg-raised: #f0f0f0;
    --fw-fg: #111111;
    --fw-fg-accent: #0a6b4d;
    --fw-bg-accent: var(--fw-fg-accent);
    --fw-fg-on-accent: #ffffff;
    --fw-ring: var(--fw-fg-accent);
    --fw-space-md: 1rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fw-bg: #000000;
      --fw-bg-raised: #101010;
      --fw-fg: #eeeeee;
      --fw-fg-accent: #5fd4a4;
      --fw-fg-on-accent: #000000;
    }
  }
}
`;

test("the light theme is the top-level :root, comments ignored", () => {
  const { light } = readThemes(SHEET);
  expect(light.resolved.get("--fw-fg")).toBe("#111111");
  expect(light.declared.get("--fw-bg-accent")).toBe("var(--fw-fg-accent)");
});

test("the dark theme is the light one overlaid with the dark block", () => {
  const { dark } = readThemes(SHEET);
  expect(dark.resolved.get("--fw-fg")).toBe("#eeeeee");
  expect(dark.declared.has("--fw-bg-accent")).toBe(false);
});

test("a var() reference resolves inside the theme it is read in", () => {
  const { light, dark } = readThemes(SHEET);
  expect(light.resolved.get("--fw-bg-accent")).toBe("#0a6b4d");
  expect(dark.resolved.get("--fw-bg-accent")).toBe("#5fd4a4");
  expect(dark.resolved.get("--fw-ring")).toBe("#5fd4a4");
});

test("text pairs with every surface, an on-X ink only with its own fill, the ring at 3:1", () => {
  const { light } = readThemes(SHEET);
  const pairs = contrastPairs(light).map(
    ({ fg, bg, minimum }) => `${fg} on ${bg} ${String(minimum)}`,
  );
  expect(pairs.sort()).toEqual(
    [
      "--fw-fg on --fw-bg 4.5",
      "--fw-fg on --fw-bg-raised 4.5",
      "--fw-fg-accent on --fw-bg 4.5",
      "--fw-fg-accent on --fw-bg-raised 4.5",
      "--fw-fg-on-accent on --fw-bg-accent 4.5",
      "--fw-ring on --fw-bg 3",
      "--fw-ring on --fw-bg-raised 3",
    ].sort(),
  );
});

test("a sheet with no dark block is refused, naming the block it needs", () => {
  expect(() => readThemes(":root { --fw-bg: #ffffff; }")).toThrow(
    "Brand tokens: found no :root inside @media (prefers-color-scheme: dark) — declare the dark theme there, beside the light :root",
  );
});

test("a second light :root is refused rather than skipped", () => {
  expect(() => readThemes(`${SHEET}\n:root { --fw-fg: #ff0000; }`)).toThrow(
    "Brand tokens: found 2 light :root blocks — declare the light theme in one, so the one this check reads is the one a browser applies",
  );
});

test("a second dark :root is refused rather than skipped", () => {
  const second = "@media (prefers-color-scheme: dark) { :root { --fw-fg: #ffffff; } }";
  expect(() => readThemes(`${SHEET}\n${second}`)).toThrow(
    "Brand tokens: found 2 dark :root blocks — declare the dark theme in one, so the one this check reads is the one a browser applies",
  );
});

test("every token in the fixture is classified", () => {
  expect(unclassifiedTokens(readThemes(SHEET).light)).toEqual([]);
});

test("a colour token outside text, surface, ring and decoration is reported", () => {
  const sheet = SHEET.replace("--fw-space-md: 1rem;", "--fw-space-md: 1rem; --fw-danger: #cc0000;");
  expect(unclassifiedTokens(readThemes(sheet).light)).toEqual(["--fw-danger"]);
});
