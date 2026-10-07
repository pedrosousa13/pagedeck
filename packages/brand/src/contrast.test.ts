import { expect, test } from "vitest";
import { contrastRatio } from "./contrast.js";

test("black on white is 21:1, and the order of the two does not matter", () => {
  expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
});

test("a colour on itself is 1:1", () => {
  expect(contrastRatio("#0a6b4d", "#0a6b4d")).toBeCloseTo(1, 5);
});

test("#777777 on white misses 4.5:1 and #767676 makes it", () => {
  expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
});

test("three-digit hex is read as its six-digit expansion, in either case", () => {
  expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 5);
});

test("a colour that is not hex is refused with the value and the fix", () => {
  expect(() => contrastRatio("rgb(0 0 0)", "#ffffff")).toThrow(
    'Colour "rgb(0 0 0)": is not a hex colour this check can read — write brand colour tokens as #rrggbb or #rgb',
  );
});
