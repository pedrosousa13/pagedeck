// A Vitest harness, not a node runnable: Node cannot resolve `./audit.js`, which only
// `tsc` emits, and publishing `./audit` as a subpath for one harness is a bad trade.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { launch } from "chrome-launcher";
import { chromium } from "playwright";
import lighthouse from "lighthouse";
import { auditVerdict, payloadReductions } from "./audit.js";
import type { AuditVerdict, LighthouseRun, PayloadReduction } from "./audit.js";
import {
  AUDIT_URLS,
  BUDGETS,
  SCORE_FLOORS,
  TWIN_PAGE_KIND,
  TWIN_PAYLOAD,
  buildAuditSite,
  measurePayload,
  serveBuild,
} from "./audit-site.js";
import type { PagePayload } from "./audit-site.js";

const WORK = join(import.meta.dirname, "..", ".pagedeck-site-audit");
const REPORT = join(WORK, "lighthouse-report.json");

// Declared here: `lighthouse`'s types reach `lib.dom` (#289).
interface LighthouseResult {
  readonly lighthouseVersion: string;
  readonly categories: Readonly<Record<string, { readonly score: number | null }>>;
  readonly audits: Readonly<
    Record<
      string,
      | {
          readonly details?: {
            readonly items?: readonly Readonly<Record<string, unknown>>[];
          };
        }
      | undefined
    >
  >;
}

const TIMINGS = [
  "firstContentfulPaint",
  "largestContentfulPaint",
  "speedIndex",
  "totalBlockingTime",
  "cumulativeLayoutShift",
  "timeToFirstByte",
] as const;

interface AuditReport {
  readonly conditions: {
    readonly at: string;
    readonly cores: number;
    readonly totalMemoryBytes: number;
    readonly node: string;
    readonly platform: string;
    readonly lighthouse: string;
    readonly origin: string;
  };
  readonly payload: readonly PagePayload[];
  readonly reductions: readonly PayloadReduction[];
  readonly runs: readonly LighthouseRun[];
  readonly verdict: AuditVerdict | null;
}

// An absent `script` row is a real zero: `resource-summary` lists every type it knows.
function readRun(url: string, lhr: LighthouseResult): LighthouseRun {
  const scores: Record<string, number> = {};
  for (const [id, category] of Object.entries(lhr.categories)) {
    // A `null` score is left out, not recorded as zero, so `auditVerdict` refuses a
    // floor naming it instead of reading an absent score as a failing one.
    if (category.score !== null) scores[id] = Math.round(category.score * 100);
  }

  const items = lhr.audits["resource-summary"]?.details?.items ?? [];
  const script = items.find((one) => one["resourceType"] === "script");
  const metrics = lhr.audits["metrics"]?.details?.items?.[0] ?? {};
  const timings: Record<string, number> = {};
  for (const name of TIMINGS) {
    const value = metrics[name];
    if (typeof value === "number") timings[name] = value;
  }
  const count = (field: string): number => {
    const value = script?.[field];
    return typeof value === "number" ? value : 0;
  };

  return {
    url,
    scores,
    scriptBytes: count("transferSize"),
    scriptRequests: count("requestCount"),
    timings,
  };
}

function table(runs: readonly LighthouseRun[]): string {
  const lines = [
    "url                script B  reqs  a11y  seo   bp  perf   FCP    LCP    TBT   SI",
  ];
  for (const run of runs) {
    const cell = (value: number | undefined, width: number): string =>
      (value === undefined ? "—" : String(Math.round(value))).padStart(width);
    lines.push(
      [
        run.url.padEnd(18),
        cell(run.scriptBytes, 8),
        cell(run.scriptRequests, 5),
        cell(run.scores["accessibility"], 5),
        cell(run.scores["seo"], 4),
        cell(run.scores["best-practices"], 4),
        cell(run.scores["performance"], 5),
        cell(run.timings["firstContentfulPaint"], 6),
        cell(run.timings["largestContentfulPaint"], 6),
        cell(run.timings["totalBlockingTime"], 6),
        cell(run.timings["speedIndex"], 5),
      ].join(" "),
    );
  }
  return lines.join("\n");
}

let runs: LighthouseRun[] = [];
let payloads: readonly PagePayload[] = [];
let reductions: readonly PayloadReduction[] = [];
let verdict: AuditVerdict;

beforeAll(async () => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const out = await buildAuditSite(WORK);
  // `WORK`, not `out`: the budget report sits outside the published tree (#336).
  const payload = measurePayload(WORK, out);
  payloads = payload;
  const reduction = payloadReductions({
    pages: payload,
    twin: Object.fromEntries(
      Object.entries(TWIN_PAGE_KIND).map(([url, kind]) => [url, TWIN_PAYLOAD[kind]]),
    ),
  });
  reductions = reduction;
  const served = await serveBuild(out);

  const chrome = await launch({
    chromePath: chromium.executablePath(),
    // `--no-sandbox`: a runner's container has no user namespace to build one in.
    // `--disable-dev-shm-usage`: a container's 64 MB `/dev/shm` crashes Chromium mid-run.
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });

  const conditions = {
    at: new Date().toISOString(),
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    lighthouse: "",
    origin: served.origin,
  };
  const write = (report: AuditReport): void => {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  };

  runs = [];
  try {
    for (const url of AUDIT_URLS) {
      // Default flags, Lighthouse's mobile configuration: spec §15's criterion 5 is about
      // mobile.
      const result = await lighthouse(served.origin + url, {
        port: chrome.port,
        output: "json",
        logLevel: "error",
      });
      if (result === undefined) {
        // A bare `Error`: inside a Vitest hook, no caller branches on a class.
        throw new Error(
          `Site audit "${url}": Lighthouse returned no result, so this page contributed nothing to the report — re-run, and if it repeats the page is not loading at ${served.origin}${url}`,
        );
      }
      const lhr = result.lhr as unknown as LighthouseResult;
      conditions.lighthouse = lhr.lighthouseVersion;
      runs.push(readRun(url, lhr));
      write({ conditions, payload, reductions: reduction, runs, verdict: null });
    }
  } finally {
    await chrome.kill();
    await served.close();
  }

  verdict = auditVerdict({ runs, budgets: BUDGETS, floors: SCORE_FLOORS });
  write({ conditions, payload, reductions: reduction, runs, verdict });

  process.stdout.write(
    [
      "",
      `Lighthouse ${conditions.lighthouse} over ${conditions.origin}, ${String(conditions.cores)} cores, node ${conditions.node}`,
      "",
      table(runs),
      "",
      "first-render JavaScript off the build, per page, and the reduction against",
      "the Next.js twin recorded in docs/research/2026-08-23-app-router-static-export.md:",
      ...payload.map((page) => {
        const cut = reduction.find((one) => one.url === page.url) as PayloadReduction;
        return `  ${page.url.padEnd(18)} ${String(page.total.raw).padStart(7)} raw  ${String(page.total.gzip).padStart(6)} gzip  ${String(page.total.brotli).padStart(6)} brotli   −${cut.raw.toFixed(1)}% raw  −${cut.gzip.toFixed(1)}% gzip`;
      }),
      "",
      `report: ${REPORT}`,
      "",
    ].join("\n"),
  );
}, 900_000);

afterAll(() => {
  rmSync(join(WORK, "site"), { recursive: true, force: true });
});

test("every page of the representative set is inside its script budget and over every score floor", () => {
  expect(runs.map((one) => one.url)).toEqual([...AUDIT_URLS]);
  expect(verdict.failures.map((one) => `${one.url}: ${one.name} expected ${one.expected}, measured ${one.actual}`)).toEqual([]);
  expect(verdict.assertions).toHaveLength(
    AUDIT_URLS.length * (2 + Object.keys(SCORE_FLOORS).length),
  );
});

test("the build's own byte count and the browser's agree about which pages ship JavaScript", () => {
  expect(
    payloads.filter((page) => page.total.raw > 0).map((page) => page.url),
  ).toEqual(["/en/pricing"]);
  expect(runs.filter((run) => run.scriptBytes > 0).map((run) => run.url)).toEqual(
    ["/en/pricing"],
  );
  expect(payloads.map((page) => page.url).sort()).toEqual([...AUDIT_URLS].sort());

  expect(reductions.map((one) => one.url).sort()).toEqual([...AUDIT_URLS].sort());
  expect(
    reductions.filter((one) => one.raw === 100 && one.gzip === 100).map((one) => one.url),
  ).toEqual(["/de", "/en", "/en/legal/terms"]);
});

test("the timing metrics are recorded and nothing asserts on them", () => {
  // Checked to have arrived, never compared: a timing assertion flakes on a busy
  // runner (#57, #183).
  for (const run of runs) {
    expect(Object.keys(run.timings).sort()).toEqual([...TIMINGS].sort());
    expect(run.scores["performance"]).toBeTypeOf("number");
  }
  expect(
    verdict.assertions.some((one) => one.name === "performance score"),
  ).toBe(false);
});
