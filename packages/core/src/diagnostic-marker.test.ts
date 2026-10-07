import { expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, markDiagnostic } from "./diagnostic-marker.js";

test("a one-line diagnostic is marked and stays readable", () => {
  expect(
    markDiagnostic('Config "/site/pagedeck.config.ts": has no default export'),
  ).toBe(
    `${DIAGNOSTIC_MARKER} Config "/site/pagedeck.config.ts": has no default export`,
  );
});

test("every line of a multi-line diagnostic is marked, indentation intact", () => {
  const report = [
    'Collection "articles": 2 entries do not match the collection schema:',
    "  /en/no-title: title — Invalid input",
    "  /en/no-body: body — Invalid input",
  ].join("\n");

  expect(markDiagnostic(report).split("\n")).toEqual([
    `${DIAGNOSTIC_MARKER} Collection "articles": 2 entries do not match the collection schema:`,
    `${DIAGNOSTIC_MARKER}   /en/no-title: title — Invalid input`,
    `${DIAGNOSTIC_MARKER}   /en/no-body: body — Invalid input`,
  ]);
});

test("the marker does not take the bracketed shape third-party advisories use", () => {
  expect(DIAGNOSTIC_MARKER).toBe("pagedeck:");
  expect(DIAGNOSTIC_MARKER.startsWith("[")).toBe(false);
  expect(
    markDiagnostic(
      "[BABEL] Note: The code generator has deoptimised the styling of react-dom-client.production.js",
    ),
  ).toBe(
    "pagedeck: [BABEL] Note: The code generator has deoptimised the styling of react-dom-client.production.js",
  );
});
