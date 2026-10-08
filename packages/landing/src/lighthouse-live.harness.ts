import { launch } from "chrome-launcher";
import { chromium } from "playwright";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";

const LIVE = "https://pagedeck-landing.pedrodsousa.workers.dev";
const PAGES = ["/", "/features/", "/interactive/", "/server-data/"] as const;
const RUNS = 2;
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;
const METRICS = {
  LCP: "largestContentfulPaint",
  TBT: "totalBlockingTime",
  CLS: "cumulativeLayoutShift",
  FCP: "firstContentfulPaint",
  SI: "speedIndex",
} as const;

// Declared here: `lighthouse`'s types reach `lib.dom` (#289).
interface LighthouseResult {
  readonly lighthouseVersion: string;
  readonly categories: Readonly<Record<string, { readonly score: number | null }>>;
  readonly audits: Readonly<
    Record<
      string,
      { readonly details?: { readonly items?: readonly Readonly<Record<string, unknown>>[] } } | undefined
    >
  >;
}

const chrome = await launch({
  chromePath: chromium.executablePath(),
  chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
});

const rows: string[] = [];
const offOrigin = new Set<string>();
let version = "";
try {
  for (const page of PAGES) {
    for (const form of ["mobile", "desktop"] as const) {
      for (let run = 1; run <= RUNS; run += 1) {
        const result = await lighthouse(
          LIVE + page,
          { port: chrome.port, output: "json", logLevel: "error" },
          form === "desktop" ? desktopConfig : undefined,
        );
        if (result === undefined) {
          throw new Error(
            `Live Lighthouse "${page}" ${form} run ${String(run)}: Lighthouse returned no result. Open ${LIVE}${page} and check it answers, then run again`,
          );
        }
        const lhr = result.lhr as unknown as LighthouseResult;
        version = lhr.lighthouseVersion;
        const metrics = lhr.audits["metrics"]?.details?.items?.[0] ?? {};
        for (const request of lhr.audits["network-requests"]?.details?.items ?? []) {
          const url = request["url"];
          if (typeof url === "string" && !url.startsWith(`${LIVE}/`) && !url.startsWith("data:")) {
            offOrigin.add(url);
          }
        }
        const scores = CATEGORIES.map((id) => {
          const score = lhr.categories[id]?.score;
          return score === null || score === undefined ? "—" : String(Math.round(score * 100));
        });
        const values = Object.values(METRICS).map((name) => {
          const value = metrics[name];
          if (typeof value !== "number") return "—";
          return name === "cumulativeLayoutShift" ? value.toFixed(3) : String(Math.round(value));
        });
        rows.push(`| \`${page}\` | ${form} | ${String(run)} | ${[...scores, ...values].join(" | ")} |`);
        process.stdout.write(`${rows.at(-1) ?? ""}\n`);
      }
    }
  }
} finally {
  await chrome.kill();
}

process.stdout.write(
  [
    "",
    `${new Date().toISOString()}, Lighthouse ${version}, ${LIVE}`,
    "",
    `| Page | Form | Run | Perf | A11y | BP | SEO | ${Object.keys(METRICS).join(" | ")} |`,
    `| --- | --- | ---: | ${Array(4 + Object.keys(METRICS).length).fill("---:").join(" | ")} |`,
    ...rows,
    "",
    offOrigin.size === 0
      ? `Every request went to ${LIVE}.`
      : `Requests to another origin:\n${[...offOrigin].sort().join("\n")}`,
    "",
  ].join("\n"),
);
