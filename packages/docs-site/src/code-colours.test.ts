import { expect, test } from "vitest";
import { codeColours } from "./code-colours.test-support.js";

const span = (style: string) => `<span style="${style}">x</span>`;

test("each token's light colour and its dark colour are read, in any hex case", () => {
  const found = codeColours(
    span("color:#CF222E;--shiki-dark:#FF7B72") + span("color:#abc;--shiki-dark:#123"),
  );
  expect([...found.light]).toEqual(["#cf222e", "#aabbcc"]);
  expect([...found.dark]).toEqual(["#ff7b72", "#112233"]);
  expect(found.unmeasurable).toEqual([]);
});

test("an opaque alpha byte is dropped, and any other alpha is refused rather than measured as opaque", () => {
  const found = codeColours(
    span("color:#24292EFF;--shiki-dark:#e1e4e8f") + span("color:#24292e77;--shiki-dark:#e1e4e8"),
  );
  expect([...found.light]).toEqual(["#24292e"]);
  expect([...found.dark]).toEqual(["#e1e4e8"]);
  expect(found.unmeasurable).toEqual(["--shiki-dark:#e1e4e8f", "color:#24292e77"]);
});

test("a colour that is not hex at all is refused", () => {
  const found = codeColours(span("color:rgb(0 0 0);--shiki-dark:inherit"));
  expect(found.unmeasurable).toEqual(["color:rgb(0 0 0)", "--shiki-dark:inherit"]);
});

test("a span with no dark colour is not a highlighted token", () => {
  expect(codeColours(span("color:red")).unmeasurable).toEqual([]);
});
