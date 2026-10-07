import { expect, test } from "vitest";
import {
  INCREMENTAL_END_TO_END,
  reportText,
  rungShortfall,
  scalingReport,
} from "./report.js";
import type { Rung } from "./report.js";

function rung(overrides: Partial<Rung> = {}): Rung {
  return {
    pages: 100,
    locales: 2,
    islandPages: 33,
    pagesBuilt: 100,
    outputFiles: 140,
    entryChunks: 33,
    syncMs: 400,
    buildMs: 5_000,
    incrementalSyncMs: 120,
    planMs: 8,
    incrementalBuildMs: 900,
    buildPeakRssBytes: 500_000_000,
    storeBytes: 200_000,
    storeGzipBytes: 40_000,
    ...overrides,
  };
}

test("per-page build cost is the measured wall clock over the pages that were built", () => {
  const report = scalingReport([rung({ pages: 100, pagesBuilt: 100, buildMs: 5_000 })]);
  expect(report.rungs[0]?.perPageBuildMs).toBe(50);
});

test("a rung that built fewer pages than were generated is named rather than averaged", () => {
  expect(rungShortfall(rung({ pages: 500, pagesBuilt: 499 }))).toMatch(
    /499 of the 500 pages/,
  );
  expect(rungShortfall(rung({ pages: 500, pagesBuilt: 500 }))).toBeUndefined();
});

test("spec §16's end-to-end incremental target is the build figure and not either of its halves", () => {
  const report = scalingReport([
    rung({ incrementalSyncMs: 1_130, planMs: 240, incrementalBuildMs: 7_620 }),
  ]);
  expect(report.incrementalEndToEnd.measured).toBe(true);
  expect(report.incrementalEndToEnd.note).toBe(INCREMENTAL_END_TO_END);

  // The three figures are far apart, so a wrong column is a failure, not a rounding.
  const text = reportText(report);
  const row = text
    .split("\n")
    .find((one) => one.trimStart().startsWith("100")) as string;
  expect(row).toContain("7.62");
  const headings = text
    .split("\n")
    .find((one) => one.includes("inc build s")) as string;
  expect(headings.indexOf("inc build s")).toBeGreaterThan(
    headings.indexOf("plan s"),
  );

  const line = text
    .split("\n")
    .find((one) => one.includes("Incremental, end to end")) as string;
  expect(line).toContain('"inc build s"');
  expect(line).not.toMatch(/\d/);
});

test("the text carries the two §16 targets and the Astro baseline it is read against", () => {
  const text = reportText(scalingReport([rung()]));
  expect(text).toContain("50,000");
  expect(text).toContain("10 min");
  expect(text).toContain("30 s");
  expect(text).toContain("24.6");
  expect(text).toContain(INCREMENTAL_END_TO_END);
});

test("the text carries a row per rung, with the per-page cost linearity is read off", () => {
  const text = reportText(
    scalingReport([
      rung({ pages: 100, pagesBuilt: 100, buildMs: 5_000 }),
      rung({ pages: 500, pagesBuilt: 500, buildMs: 30_000 }),
    ]),
  );
  expect(text).toContain("100");
  expect(text).toContain("500");
  expect(text).toContain("50.0");
  expect(text).toContain("60.0");
});
