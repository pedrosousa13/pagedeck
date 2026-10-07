import { expect, test } from "vitest";
import { colourFaults, pairFaults } from "./sheet.js";
import { readThemes } from "./tokens.js";

const THEMES = readThemes(`
  :root { --fw-bg: #ffffff; --fw-fg: #000000; --fw-fg-muted: #767676; --fw-bg-accent: #777777; }
  @media (prefers-color-scheme: dark) {
    :root { --fw-bg: #000000; --fw-fg: #ffffff; --fw-fg-muted: #8a8a8a; }
  }
`);

test("a colour set through a brand token passes, and a literal or palette colour is named", () => {
  const { checked, faults } = colourFaults(
    ".a{color:var(--fw-fg);border:1px solid var(--fw-rule)}" +
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
    ":root{--fw-bg:#f2f4f1;--color-red-500:red}" +
      ".a{background-color:transparent;color:inherit;outline:none}" +
      ".b{color:var(--shiki-dark)!important;background-color:var(--shiki-dark-bg) !important}" +
      ".c{border-top:2px solid currentcolor;text-decoration-color:#0000}",
  );
  expect(faults).toEqual([]);
});

test("comments are not read as rules", () => {
  expect(colourFaults("/* .a{color:red} */.b{color:var(--fw-fg)}").faults).toEqual([]);
});

test("a rule pairing a text token with a background token is measured in both themes", () => {
  const { measured, faults } = pairFaults(
    ".ok{color:var(--fw-fg);background-color:var(--fw-bg)}" +
      ".low:hover{color:var(--fw-fg-muted);background-color:var(--fw-bg-accent)}" +
      ".alone{color:var(--fw-fg-muted)}",
    THEMES,
  );
  expect(measured).toEqual([".ok", ".low:hover"]);
  expect(faults).toEqual([
    "  .low:hover (light): --fw-fg-muted on --fw-bg-accent is 1.01:1",
    "  .low:hover (dark): --fw-fg-muted on --fw-bg-accent is 1.30:1",
  ]);
});
