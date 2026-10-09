import { describe, expect, test } from "vitest";
import {
  auditVerdict,
  axeVerdict,
  emittedHashes,
  hashInsensitiveGzip,
  normaliseAssetHashes,
  payloadReductions,
  reductionPercent,
  runtimeSplit,
  runtimeVerdict,
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
  const budgets = {
    "/en": { scriptBytes: 0, scriptRequests: 0 },
    "/en/pricing": { scriptBytes: 60_000, scriptRequests: 2 },
  };
  const floors = { accessibility: 100, seo: 90 };

  const run = (
    url: string,
    over: { scriptBytes?: number; scriptRequests?: number; scores?: Record<string, number> } = {},
  ) => ({
    url,
    scriptBytes: over.scriptBytes ?? 0,
    scriptRequests: over.scriptRequests ?? 0,
    scores: over.scores ?? { accessibility: 100, seo: 100, performance: 41 },
    timings: { largestContentfulPaint: 700, totalBlockingTime: 0 },
  });

  test("a build inside every budget and over every floor fails nothing", () => {
    const verdict = auditVerdict({
      runs: [run("/en"), run("/en/pricing", { scriptBytes: 52_000, scriptRequests: 2 })],
      budgets,
      floors,
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.assertions).toHaveLength(8);
    expect(verdict.assertions.every((one) => one.ok)).toBe(true);
  });

  test("a page over its script-byte budget fails, naming the budget and the spend", () => {
    const verdict = auditVerdict({
      runs: [run("/en", { scriptBytes: 900, scriptRequests: 1 }), run("/en/pricing", { scriptRequests: 2 })],
      budgets,
      floors,
    });
    expect(verdict.failures.map((one) => `${one.url} ${one.name} ${one.expected} ${one.actual}`)).toEqual([
      "/en script bytes <= 0 900",
      "/en script requests <= 0 1",
    ]);
  });

  test("a category under its floor fails, and one with no floor is recorded rather than asserted", () => {
    const verdict = auditVerdict({
      runs: [
        run("/en", { scores: { accessibility: 92, seo: 100, performance: 3 } }),
        run("/en/pricing", { scriptRequests: 2 }),
      ],
      budgets,
      floors,
    });
    expect(verdict.failures.map((one) => one.name)).toEqual(["accessibility score"]);
    expect(verdict.assertions.some((one) => one.name === "performance score")).toBe(false);
  });

  test("a run for a page with no budget is refused, and a budget with no run too", () => {
    expect(() => auditVerdict({ runs: [run("/en")], budgets, floors })).toThrow(
      /\/en\/pricing/,
    );
    expect(() =>
      auditVerdict({ runs: [run("/en"), run("/en/pricing"), run("/de")], budgets, floors }),
    ).toThrow(/\/de/);
  });

  test("a floor no run carries a score for is refused rather than skipped", () => {
    expect(() =>
      auditVerdict({
        runs: [run("/en"), run("/en/pricing", { scriptRequests: 2 })],
        budgets,
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

describe("hashInsensitiveGzip", () => {
  const entry = (css: string, core: string) =>
    Buffer.from(
      `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/fw-core-${core}.js","assets/rolldown-runtime-BpQH8Ho1.js","assets/fw-measure-react-DxHXGJIq.js","assets/fw-core-${css}.css"])))=>i.map(i=>d[i]);import{n as e,r as t}from"./fw-core-${core}.js";e(t,()=>import("./slot-y2iDUnVn.js"),__vite__mapDeps([0,1,2,3]));`,
    );
  const emitted = (css: string, core: string) =>
    emittedHashes([
      `fw-core-${core}.js`,
      "rolldown-runtime-BpQH8Ho1.js",
      "fw-measure-react-DxHXGJIq.js",
      `fw-core-${css}.css`,
      "slot-y2iDUnVn.js",
    ]);

  test("two chunks that differ only in a referenced hash measure the same", () => {
    const before = entry("BbHxMLsE", "BNZ1wc_V");
    const after = entry("G2979gDk", "I8L5-rxT");
    expect(after.byteLength).toBe(before.byteLength);
    expect(hashInsensitiveGzip(after, emitted("G2979gDk", "I8L5-rxT"))).toBe(
      hashInsensitiveGzip(before, emitted("BbHxMLsE", "BNZ1wc_V")),
    );
  });

  test("a real byte change still counts", () => {
    const hashes = emitted("BbHxMLsE", "BNZ1wc_V");
    const before = entry("BbHxMLsE", "BNZ1wc_V");
    const grown = Buffer.concat([before, Buffer.from("console.log(`a real change`);")]);
    expect(hashInsensitiveGzip(grown, hashes)).toBeGreaterThan(
      hashInsensitiveGzip(before, hashes),
    );
  });

  test("a name shaped like a hash but not one the build emitted is left alone", () => {
    // `-promises.js` is a dash, eight characters of the hash alphabet and an
    // extension: the shape alone cannot tell it from `-BpQH8Ho1.js`.
    const hashes = emitted("BbHxMLsE", "BNZ1wc_V");
    const text = 'import"./polyfill-promises.js";import"./fw-core-BNZ1wc_V.js";';
    expect(normaliseAssetHashes(text, hashes)).toBe(
      'import"./polyfill-promises.js";import"./fw-core-00000000.js";',
    );
  });

  test("an emitted file's hash is the eight characters before its extension, dashes included", () => {
    expect(
      emittedHashes(["fw-core-I8L5-rxT.js", "fw-core-G2979gDk.css", "favicon.ico"]),
    ).toEqual(["I8L5-rxT", "G2979gDk"]);
  });
});

describe("runtimeSplit", () => {
  const chunk = (path: string, raw: number, gzip: number, brotli: number) => ({
    path,
    raw,
    gzip,
    brotli,
  });

  test("the React chunk is set apart and every other chunk the page loads is the framework's own", () => {
    expect(
      runtimeSplit({
        url: "/en/pricing",
        react: "fw-measure-react",
        chunks: [
          chunk("/assets/fw-measure-react-DxHXGJIq.js", 189_881, 59_000, 50_789),
          chunk("/assets/fw-core-CZK97gOy.js", 5_719, 2_600, 2_345),
          chunk("/assets/entry-7b7f141ef145a3d4-DHGyDJFu.js", 397, 280, 252),
          chunk("/assets/rolldown-runtime-BpQH8Ho1.js", 227, 170, 152),
        ],
      }),
    ).toEqual({
      url: "/en/pricing",
      react: { raw: 189_881, gzip: 59_000, brotli: 50_789 },
      own: { raw: 6_343, gzip: 3_050, brotli: 2_749 },
    });
  });

  test("a page with no React chunk is refused, because React would be counted as the framework's", () => {
    expect(() =>
      runtimeSplit({
        url: "/en/pricing",
        react: "fw-measure-react",
        chunks: [chunk("/assets/fw-core-nhIt6jgf.js", 195_495, 61_302, 52_888)],
      }),
    ).toThrow(/^Runtime bytes "\/en\/pricing": .*no chunk named "fw-measure-react"/s);
  });

  test("a chunk is matched by its whole name, so a component that merely starts with it is the framework's", () => {
    expect(() =>
      runtimeSplit({
        url: "/en/pricing",
        react: "fw-measure-react",
        chunks: [chunk("/assets/fw-measure-reactions-AAAAAAAA.js", 10, 10, 10)],
      }),
    ).toThrow(/no chunk named "fw-measure-react"/);
  });

  test("two React chunks are refused rather than summed, since the group is meant to be one chunk", () => {
    expect(() =>
      runtimeSplit({
        url: "/en/pricing",
        react: "fw-measure-react",
        chunks: [
          chunk("/assets/fw-measure-react-AAAAAAAA.js", 10, 10, 10),
          chunk("/assets/fw-measure-react-BBBBBBBB.js", 10, 10, 10),
        ],
      }),
    ).toThrow(/2 chunks named "fw-measure-react"/);
  });
});

describe("runtimeVerdict", () => {
  const ceiling = { raw: 6_343, gzip: 3_050 };
  const split = (raw: number, gzip: number) => ({
    url: "/en/pricing",
    react: { raw: 189_881, gzip: 59_000, brotli: 50_789 },
    own: { raw, gzip, brotli: 1 },
  });

  test("a figure at its ceiling passes, raw and gzip alike", () => {
    const verdict = runtimeVerdict({ split: split(6_343, 3_050), ceiling });
    expect(verdict.failures).toEqual([]);
    expect(verdict.assertions.map((one) => one.name)).toEqual([
      "framework-own bytes, raw",
      "framework-own bytes, gzip",
    ]);
  });

  test("one byte over the raw ceiling fails, naming the ceiling and the figure", () => {
    const verdict = runtimeVerdict({ split: split(6_344, 3_050), ceiling });
    expect(
      verdict.failures.map((one) => `${one.url} ${one.name} ${one.expected} ${one.actual}`),
    ).toEqual(["/en/pricing framework-own bytes, raw <= 6343 6344"]);
  });

  test("one byte over the gzip ceiling fails on its own", () => {
    const verdict = runtimeVerdict({ split: split(6_343, 3_051), ceiling });
    expect(
      verdict.failures.map((one) => `${one.url} ${one.name} ${one.expected} ${one.actual}`),
    ).toEqual(["/en/pricing framework-own bytes, gzip <= 3050 3051"]);
  });

  test("React's own bytes are not compared against anything", () => {
    const verdict = runtimeVerdict({
      split: {
        ...split(6_343, 3_050),
        react: { raw: 999_999, gzip: 999_999, brotli: 999_999 },
      },
      ceiling,
    });
    expect(verdict.failures).toEqual([]);
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
