// A Vitest harness, not a node runnable: Node cannot resolve `./audit.js`, which only
// `tsc` emits, and publishing `./audit` as a subpath for one harness is a bad trade.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auditVerdict, payloadReductions } from "./audit.js";
import type { AuditVerdict, LighthouseRun, PayloadReduction } from "./audit.js";
import {
  AUDIT_URLS,
  SCORE_FLOORS,
  TWIN_PAGE_KIND,
  TWIN_PAYLOAD,
  buildAuditSite,
  measurePayload,
  serveBuild,
} from "./audit-site.js";
import type { PagePayload } from "./audit-site.js";
import { launchLighthouse, machineConditions } from "./lighthouse-run.test-support.js";
import type { LighthouseResult, MachineConditions } from "./lighthouse-run.test-support.js";

const WORK = join(import.meta.dirname, "..", ".pagedeck-site-audit");
const REPORT = join(WORK, "lighthouse-report.json");

const TIMINGS = [
  "firstContentfulPaint",
  "largestContentfulPaint",
  "speedIndex",
  "totalBlockingTime",
  "cumulativeLayoutShift",
  "timeToFirstByte",
] as const;

interface AuditReport {
  readonly conditions: MachineConditions & {
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

  const browser = await launchLighthouse();

  const conditions = {
    ...machineConditions(),
    lighthouse: "",
    origin: served.origin,
  };
  const write = (report: AuditReport): void => {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  };

  runs = [];
  try {
    for (const url of AUDIT_URLS) {
      const lhr = await browser.audit(served.origin + url, `Site audit "${url}"`);
      conditions.lighthouse = lhr.lighthouseVersion;
      runs.push(readRun(url, lhr));
      write({ conditions, payload, reductions: reduction, runs, verdict: null });
    }
  } finally {
    await browser.close();
    await served.close();
  }

  verdict = auditVerdict({ urls: AUDIT_URLS, runs, floors: SCORE_FLOORS });
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

test("every page of the representative set is over every score floor", () => {
  expect(runs.map((one) => one.url)).toEqual([...AUDIT_URLS]);
  expect(verdict.failures.map((one) => `${one.url}: ${one.name} expected ${one.expected}, measured ${one.actual}`)).toEqual([]);
  expect(verdict.assertions).toHaveLength(
    AUDIT_URLS.length * Object.keys(SCORE_FLOORS).length,
  );
});

test("the build's own byte count and the browser's agree about which pages ship JavaScript", () => {
  expect(
    payloads.filter((page) => page.total.raw > 0).map((page) => page.url),
  ).toEqual(["/en/pricing/"]);
  expect(runs.filter((run) => run.scriptBytes > 0).map((run) => run.url)).toEqual(
    ["/en/pricing/"],
  );
  expect(payloads.map((page) => page.url).sort()).toEqual([...AUDIT_URLS].sort());

  expect(reductions.map((one) => one.url).sort()).toEqual([...AUDIT_URLS].sort());
  expect(
    reductions.filter((one) => one.raw === 100 && one.gzip === 100).map((one) => one.url),
  ).toEqual(["/de/", "/en/", "/en/legal/terms/"]);
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
