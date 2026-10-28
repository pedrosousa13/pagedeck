import { expect, test } from "vitest";
import { colourFaults, pairFaults } from "./sheet.js";
import { readThemes } from "./tokens.js";

const THEMES = readThemes(`
  :root { --pagedeck-bg: #ffffff; --pagedeck-fg: #000000; --pagedeck-fg-muted: #767676; --pagedeck-bg-accent: #777777; }
  @media (prefers-color-scheme: dark) {
    :root { --pagedeck-bg: #000000; --pagedeck-fg: #ffffff; --pagedeck-fg-muted: #8a8a8a; }
  }
`);

test("a colour set through a brand token passes, and a literal or palette colour is named", () => {
  const { checked, faults } = colourFaults(
    ".a{color:var(--pagedeck-fg);border:1px solid var(--pagedeck-rule)}" +
      ".b{background-color:#fff}.c{border-color:var(--color-slate-200)}",
  );
  expect(checked).toBe(4);
  expect(faults).toEqual([
    "  background-color: #fff",
    "  border-color: var(--color-slate-200)",
  ]);
});

test("keywords that name no colour, the highlighter's dark properties and custom properties pass", () => {
  const { faults } = colourFaults(
    ":root{--pagedeck-bg:#f2f4f1;--color-red-500:red}" +
      ".a{background-color:transparent;color:inherit;outline:none}" +
      ".b{color:var(--shiki-dark)!important;background-color:var(--shiki-dark-bg) !important}" +
      ".c{border-top:2px solid currentcolor;text-decoration-color:#0000}",
  );
  expect(faults).toEqual([]);
});

test("comments are not read as rules", () => {
  expect(colourFaults("/* .a{color:red} */.b{color:var(--pagedeck-fg)}").faults).toEqual([]);
});

test("a rule pairing a text token with a background token is measured in both themes", () => {
  const { measured, faults } = pairFaults(
    ".ok{color:var(--pagedeck-fg);background-color:var(--pagedeck-bg)}" +
      ".low:hover{color:var(--pagedeck-fg-muted);background-color:var(--pagedeck-bg-accent)}" +
      ".alone{color:var(--pagedeck-fg-muted)}",
    THEMES,
  );
  expect(measured).toEqual([".ok", ".low:hover"]);
  expect(faults).toEqual([
    "  .low:hover (light): --pagedeck-fg-muted on --pagedeck-bg-accent is 1.01:1",
    "  .low:hover (dark): --pagedeck-fg-muted on --pagedeck-bg-accent is 1.30:1",
  ]);
});
