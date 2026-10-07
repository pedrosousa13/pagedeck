import { expect, test } from "vitest";
import { parseOptions, readSplit, spread } from "./island-scan.harness.js";

test("a run with no options measures a small site over both locales", () => {
  expect(parseOptions([])).toEqual({ pages: 24, locales: 2, runs: 5 });
});

test("options given on the command line replace the defaults", () => {
  expect(parseOptions(["--pages", "240", "--locales", "1", "--runs", "3"])).toEqual({
    pages: 240,
    locales: 1,
    runs: 3,
  });
});

test("an unknown option is refused rather than ignored", () => {
  expect(() => parseOptions(["--page", "24"])).toThrow(/--page/);
});

test("a value that is not a positive whole number is refused, not rounded", () => {
  expect(() => parseOptions(["--pages", "half"])).toThrow(/"half"/);
  expect(() => parseOptions(["--runs", "0"])).toThrow(/"0"/);
  expect(() => parseOptions(["--pages"])).toThrow(/was given no value/);
});

test("more locales than the harness names is refused rather than silently capped", () => {
  expect(() => parseOptions(["--locales", "9"])).toThrow(/at most 2/);
});

test("the rendered/reused split is read off the verb's own summary line", () => {
  expect(
    readSplit("incremental: 1 of 24 pages rendered, 23 reused, 0 removed"),
  ).toEqual({ rendered: 1, total: 24 });
  expect(readSplit("built 24 pages, 51 files to /tmp/site")).toBeUndefined();
});

test("a spread reports the extremes as well as the middle", () => {
  expect(spread([30, 10, 20])).toEqual({
    runs: 3,
    minMs: 10,
    medianMs: 20,
    maxMs: 30,
  });
  expect(spread([10, 20, 30, 100])).toEqual({
    runs: 4,
    minMs: 10,
    medianMs: 25,
    maxMs: 100,
  });
  expect(spread([])).toBeUndefined();
});
