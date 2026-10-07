import { expect, test } from "vitest";
import { DEFAULT_LADDER, parseLadder, tooSlowToClimb } from "./scaling.harness.js";

test("the default ladder climbs smallest first and stops short of 50,000", () => {
  expect(DEFAULT_LADDER).toEqual([100, 500, 2_000, 8_000, 32_000]);
  expect([...DEFAULT_LADDER].sort((a, b) => a - b)).toEqual([...DEFAULT_LADDER]);
  expect(Math.max(...DEFAULT_LADDER)).toBeLessThan(50_000);
  expect(parseLadder([])).toEqual({ pages: DEFAULT_LADDER, locales: 2 });
});

test("a ladder given on the command line replaces the default rather than adding to it", () => {
  expect(parseLadder(["--pages", "50,250", "--locales", "4"])).toEqual({
    pages: [50, 250],
    locales: 4,
  });
});

test("a rung that is not a whole number of pages is refused, not rounded", () => {
  expect(() => parseLadder(["--pages", "100,half"])).toThrow(/"half"/);
});

test("an unknown option is refused rather than ignored", () => {
  expect(() => parseLadder(["--page", "100"])).toThrow(/--page/);
});

test("a rung slower than the budget stops the climb, naming what it cost", () => {
  expect(tooSlowToClimb(200_000, 180_000)).toMatch(/200\.00s across its verbs/);
  expect(tooSlowToClimb(20_000, 180_000)).toBeUndefined();
});
