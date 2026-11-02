import { describe, expect, test } from "vitest";
import {
  auditVerdict,
  axeVerdict,
  payloadReductions,
  reductionPercent,
  servedUrl,
  totalBytes,
} from "./audit.js";

const URLS = ["/en", "/en/pricing"];

describe("axeVerdict", () => {
  test("a serious or critical violation is blocking, a moderate one is recorded", () => {
    const verdict = axeVerdict({
      urls: URLS,
      results: [
        {
          url: "/en",
          violations: [{ id: "region", impact: "moderate", nodes: 2 }],
        },
        {
          url: "/en/pricing",
          violations: [
            { id: "color-contrast", impact: "serious", nodes: 3 },
            { id: "aria-valid-attr", impact: "critical", nodes: 1 },
          ],
        },
      ],
    });

    expect(verdict.blocking).toEqual([
      '/en/pricing — aria-valid-attr (critical, 1 node)',
      '/en/pricing — color-contrast (serious, 3 nodes)',
    ]);
    expect(verdict.other).toEqual(["/en — region (moderate, 2 nodes)"]);
    expect(verdict.pages).toBe(2);
  });

  test("a clean run over every page is empty on both lists", () => {
    const verdict = axeVerdict({
      urls: URLS,
      results: URLS.map((url) => ({ url, violations: [] })),
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.other).toEqual([]);
    expect(verdict.pages).toBe(2);
  });

  test("a page that was never visited is refused, not passed", () => {
    expect(() =>
      axeVerdict({ urls: URLS, results: [{ url: "/en", violations: [] }] }),
    ).toThrow(/\/en\/pricing/);
  });

  test("a result for a page nobody asked for is refused", () => {
    expect(() =>
      axeVerdict({
        urls: URLS,
        results: [
          ...URLS.map((url) => ({ url, violations: [] })),
          { url: "/de", violations: [] },
        ],
      }),
    ).toThrow(/\/de/);
  });

  test("a violation whose impact axe left unset is blocking", () => {
    const verdict = axeVerdict({
      urls: URLS,
      results: [
        { url: "/en", violations: [{ id: "mystery", impact: null, nodes: 1 }] },
        { url: "/en/pricing", violations: [] },
      ],
    });
    expect(verdict.blocking).toEqual(["/en — mystery (no impact, 1 node)"]);
  });
});

describe("auditVerdict", () => {
  const urls = ["/en", "/en/pricing"];
  const floors = { accessibility: 100, seo: 90 };

  const run = (url: string, scores?: Record<string, number>) => ({
    url,
    scriptBytes: 0,
    scriptRequests: 0,
    scores: scores ?? { accessibility: 100, seo: 100, performance: 41 },
    timings: { largestContentfulPaint: 700, totalBlockingTime: 0 },
  });

  test("a build over every floor fails nothing", () => {
    const verdict = auditVerdict({ urls, runs: [run("/en"), run("/en/pricing")], floors });
    expect(verdict.failures).toEqual([]);
    expect(verdict.assertions).toHaveLength(4);
    expect(verdict.assertions.every((one) => one.ok)).toBe(true);
  });

  test("a category under its floor fails, and one with no floor is recorded rather than asserted", () => {
    const verdict = auditVerdict({
      urls,
      runs: [
        run("/en", { accessibility: 92, seo: 100, performance: 3 }),
        run("/en/pricing"),
      ],
      floors,
    });
    expect(verdict.failures.map((one) => one.name)).toEqual(["accessibility score"]);
    expect(verdict.assertions.some((one) => one.name === "performance score")).toBe(false);
  });

  test("a run for a page not in the set is refused, and a page in the set with no run too", () => {
    expect(() => auditVerdict({ urls, runs: [run("/en")], floors })).toThrow(/\/en\/pricing/);
    expect(() =>
      auditVerdict({ urls, runs: [run("/en"), run("/en/pricing"), run("/de")], floors }),
    ).toThrow(/\/de/);
  });

  test("a floor no run carries a score for is refused rather than skipped", () => {
    expect(() =>
      auditVerdict({
        urls,
        runs: [run("/en"), run("/en/pricing")],
        floors: { ...floors, "best-practices": 90 },
      }),
    ).toThrow(/best-practices/);
  });
});

describe("totalBytes", () => {
  test("the three encodings are summed separately, never one derived from another", () => {
    expect(
      totalBytes([
        { raw: 195_496, gzip: 61_301, brotli: 52_812 },
        { raw: 173, gzip: 148, brotli: 125 },
      ]),
    ).toEqual({ raw: 195_669, gzip: 61_449, brotli: 52_937 });
  });

  test("a page with no chunks is zero in every encoding, which is the 0 kB claim", () => {
    expect(totalBytes([])).toEqual({ raw: 0, gzip: 0, brotli: 0 });
  });
});

describe("payloadReductions", () => {
  const twin = {
    "/en": { raw: 452_538, gzip: 133_120 },
    "/en/pricing": { raw: 452_821, gzip: 133_120 },
  };

  test("each page is measured against the twin figure declared for it", () => {
    expect(
      payloadReductions({
        pages: [
          { url: "/en", total: { raw: 0, gzip: 0, brotli: 0 } },
          {
            url: "/en/pricing",
            total: { raw: 195_669, gzip: 61_449, brotli: 52_937 },
          },
        ],
        twin,
      }),
    ).toEqual([
      { url: "/en", raw: 100, gzip: 100 },
      { url: "/en/pricing", raw: 56.7, gzip: 53.8 },
    ]);
  });

  test("a page with no twin figure is refused, so no page is quietly uncompared", () => {
    expect(() =>
      payloadReductions({
        pages: [
          { url: "/en", total: { raw: 0, gzip: 0, brotli: 0 } },
          { url: "/de", total: { raw: 0, gzip: 0, brotli: 0 } },
          { url: "/en/pricing", total: { raw: 1, gzip: 1, brotli: 1 } },
        ],
        twin,
      }),
    ).toThrow(/\/de/);
  });

  test("a twin figure no page was measured against is refused too", () => {
    expect(() =>
      payloadReductions({
        pages: [{ url: "/en", total: { raw: 0, gzip: 0, brotli: 0 } }],
        twin,
      }),
    ).toThrow(/\/en\/pricing/);
  });
});

describe("reductionPercent", () => {
  test("a payload cut from 133120 to 0 is a 100% reduction", () => {
    expect(reductionPercent(133_120, 0)).toBe(100);
  });

  test("the figure is rounded to one decimal, down, so it is never overstated", () => {
    expect(reductionPercent(133_120, 26_624)).toBe(80);
    expect(reductionPercent(1000, 199)).toBe(80.1);
    expect(reductionPercent(1000, 201)).toBe(79.9);
  });

  test("a twin of zero bytes has no reduction to state, and is refused by name", () => {
    expect(() => reductionPercent(0, 1234)).toThrow(
      /^Payload reduction against 0 B: .* the 1234 B measured here .* TWIN_PAYLOAD in packages\/site\/src\/audit-site\.ts/s,
    );
  });
});

describe("servedUrl", () => {
  test("a budget report row's route becomes the URL the site serves, under its trailing slash", () => {
    const rows = [
      { locale: "en", path: "/" },
      { locale: "de", path: "/" },
      { locale: "en", path: "/pricing" },
      { locale: "en", path: "/legal/terms" },
      { locale: "en", path: "/pricing/" },
    ];
    expect(rows.map((row) => servedUrl(row, "always"))).toEqual([
      "/en/",
      "/de/",
      "/en/pricing/",
      "/en/legal/terms/",
      "/en/pricing/",
    ]);
    expect(rows.map((row) => servedUrl(row, "never"))).toEqual([
      "/en",
      "/de",
      "/en/pricing",
      "/en/legal/terms",
      "/en/pricing",
    ]);
  });
});
