import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScriptDeclaration } from "@pagedeck/core";

const execFileAsync = promisify(execFile);

const WORK = join(import.meta.dirname, "..", ".pagedeck-loadout");
const REPORT = join(WORK, "loadout-report.json");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
const RUNS = 3;

export const MIXES = ["idle", "default", "facade"] as const;
export type Mix = (typeof MIXES)[number];

export interface LoadoutScript {
  readonly name: string;
  readonly costMs: number;
  readonly injectedBy?: string;
  readonly report: "beacon" | "image" | "fetch";
}

export const LOADOUT: readonly LoadoutScript[] = [
  { name: "tag-manager", costMs: 40, report: "fetch" },
  { name: "tag-1", costMs: 20, injectedBy: "tag-manager", report: "fetch" },
  { name: "tag-2", costMs: 20, injectedBy: "tag-manager", report: "fetch" },
  { name: "analytics", costMs: 60, report: "beacon" },
  { name: "pixel", costMs: 30, report: "image" },
  { name: "chat", costMs: 80, report: "fetch" },
];

const CHAT_STYLE = "position:fixed;right:16px;bottom:16px";

/**
 * Inside Partytown `performance` is its window proxy's and `Date` the thread's own,
 * and Partytown deletes `importScripts` and `WorkerGlobalScope` from its worker.
 */
export function loadoutSource(script: LoadoutScript, origin: string): string {
  const url = (path: string): string => JSON.stringify(`${origin}${path}`);
  const injected = LOADOUT.filter(({ injectedBy }) => injectedBy === script.name)
    .map(
      ({ name }) =>
        `var s=document.createElement("script");s.src=${url(`/${name}.js`)};s.async=true;document.head.appendChild(s);`,
    )
    .join("");
  const widget =
    script.name === "chat"
      ? `var b=document.createElement("button");b.textContent="Chat";b.style.cssText=${JSON.stringify(CHAT_STYLE)};document.body.appendChild(b);`
      : "";
  const path = { beacon: "/collect", image: "/pixel.gif", fetch: "/hit" }[script.report];
  const target = `${url(`${path}?script=${script.name}&where=`)}+where`;
  const report = {
    beacon: `navigator.sendBeacon(${target});`,
    image: `new Image().src=${target};`,
    fetch: `fetch(${target});`,
  }[script.report];
  return `(function(){var where=typeof DedicatedWorkerGlobalScope==="function"?"worker":"main";var t=Date.now();while(Date.now()-t<=${String(script.costMs)}){}${injected}${widget}${report}})();\n`;
}

export function declaredScripts(mix: Mix, origin: string): ScriptDeclaration[] {
  return LOADOUT.filter(({ injectedBy }) => injectedBy === undefined).map(({ name }) => {
    const src = `${origin}/${name}.js`;
    if (mix === "idle") return { name, src, strategy: "idle" };
    if (mix === "facade" && name === "chat") {
      return {
        name,
        src,
        strategy: "facade",
        facade: { html: `<button type="button" style="${CHAT_STYLE}">Chat</button>` },
      };
    }
    return { name, src };
  });
}

export function expectedHits(mix: Mix): string[] {
  const where = mix === "idle" ? "main" : "worker";
  return LOADOUT.filter(({ name }) => !(mix === "facade" && name === "chat"))
    .map(({ name }) => `${name}@${where}`)
    .sort();
}

export function siteConfigSource(mix: Mix, origin: string): string {
  return `import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { definePartytown } from "@pagedeck/script-worker";

const upsert = (writer) => {
  writer.upsert({ locale: "en", path: "home", data: {} });
  return { changed: [{ locale: "en", path: "home" }], deleted: [], cursor: 1 };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: upsert,
    syncSince: (writer, cursor) =>
      cursor >= 1 ? { changed: [], deleted: [], cursor: 1 } : upsert(writer),
    fetchOne: () => ({}),
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./site",
    scripts: { scripts: ${JSON.stringify(declaredScripts(mix, origin))}, runtime: definePartytown() },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: { Article: "./components/Article.js" },
    content: () => ({ tree: [{ component: "Article" }] }),
  },
});
`;
}

const ARTICLE = `import { createElement as h } from "react";

export default function Article() {
  return h(
    "article",
    null,
    h("h1", null, "A page that carries a third-party loadout"),
    h("p", null, "This page is the fixture a Lighthouse harness measures. Its own markup is static: a heading and three paragraphs, with no island and no framework JavaScript."),
    h("p", null, "Everything else on it comes from another origin: a tag manager that injects two tags, an analytics script that sends a beacon, a pixel, and a chat widget."),
    h("p", null, "Each of those scripts spins its thread for a declared number of milliseconds, so what it costs is a fixed figure and not whatever a vendor shipped that day."),
  );
}
`;

export function offMachine(urls: readonly string[], origins: readonly string[]): string[] {
  return urls.filter((url) => {
    if (url.startsWith("data:")) return false;
    if (!URL.canParse(url)) return true;
    return !origins.includes(new URL(url).origin);
  });
}

export interface RunFigures {
  readonly performance: number;
  readonly tbt: number;
  readonly lcp: number;
  readonly cls: number;
  readonly urls: readonly string[];
}

// Declared here: `lighthouse`'s types reach `lib.dom` (#289).
interface LighthouseResult {
  readonly categories: Readonly<Record<string, { readonly score: number | null }>>;
  readonly audits: Readonly<
    Record<
      string,
      | { readonly details?: { readonly items?: readonly Readonly<Record<string, unknown>>[] } }
      | undefined
    >
  >;
}

export function readRun(lhr: LighthouseResult): RunFigures {
  const score = lhr.categories["performance"]?.score;
  if (typeof score !== "number") {
    throw new Error(
      'Loadout harness: Lighthouse reported no "performance" score for this run, so it has no figure to record — re-run, and if it repeats read the run\'s runtimeError in the JSON Lighthouse returns',
    );
  }
  const metrics = lhr.audits["metrics"]?.details?.items?.[0] ?? {};
  const metric = (name: string): number => {
    const value = metrics[name];
    if (typeof value !== "number") {
      throw new Error(
        `Loadout harness: Lighthouse's "metrics" audit has no "${name}" for this run, so it would read as zero — re-run, and if it repeats the page did not finish loading in the run`,
      );
    }
    return value;
  };
  return {
    performance: Math.round(score * 100),
    tbt: metric("totalBlockingTime"),
    lcp: metric("largestContentfulPaint"),
    cls: metric("cumulativeLayoutShift"),
    urls: (lhr.audits["network-requests"]?.details?.items ?? []).map((item) =>
      String(item["url"]),
    ),
  };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((one, other) => one - other);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export interface MixRuns {
  readonly mix: Mix;
  readonly runs: readonly RunFigures[];
}

export function table(mixes: readonly MixRuns[]): string {
  const row = (mix: string, run: string, figures: Omit<RunFigures, "urls">): string =>
    [
      mix.padEnd(8),
      run.padStart(4),
      String(Math.round(figures.performance)).padStart(5),
      String(Math.round(figures.tbt)).padStart(7),
      String(Math.round(figures.lcp)).padStart(7),
      figures.cls.toFixed(3).padStart(6),
    ].join(" ");
  const lines = ["mix       run  perf  TBT ms  LCP ms    CLS"];
  for (const { mix, runs } of mixes) {
    runs.forEach((figures, index) => lines.push(row(mix, String(index + 1), figures)));
    lines.push(
      row(mix, "med", {
        performance: median(runs.map((one) => one.performance)),
        tbt: median(runs.map((one) => one.tbt)),
        lcp: median(runs.map((one) => one.lcp)),
        cls: median(runs.map((one) => one.cls)),
      }),
    );
  }
  return lines.join("\n");
}

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

interface LoadoutOrigin {
  readonly origin: string;
  readonly hits: string[];
  close(): Promise<void>;
}

/** `localhost` against the site's `127.0.0.1`: another site, as a vendor's origin is. */
function serveLoadout(): Promise<LoadoutOrigin> {
  const hits: string[] = [];
  const sources = new Map<string, LoadoutScript>(
    LOADOUT.map((script) => [`/${script.name}.js`, script]),
  );
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("access-control-allow-origin", "*");
    const script = sources.get(url.pathname);
    if (script !== undefined) {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(loadoutSource(script, origin));
      return;
    }
    if (["/hit", "/collect", "/pixel.gif"].includes(url.pathname)) {
      hits.push(`${url.searchParams.get("script") ?? "?"}@${url.searchParams.get("where") ?? "?"}`);
      if (url.pathname === "/pixel.gif") {
        response.setHeader("content-type", "image/gif");
        response.end(PIXEL);
      } else {
        response.statusCode = 204;
        response.end();
      }
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      origin = `http://localhost:${String(port)}`;
      resolve({
        origin,
        hits,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

async function buildMix(mix: Mix, origin: string): Promise<string> {
  const site = join(WORK, mix);
  mkdirSync(join(site, "components"), { recursive: true });
  writeFileSync(join(site, "pagedeck.config.ts"), siteConfigSource(mix, origin));
  writeFileSync(join(site, "components", "Article.js"), ARTICLE);
  for (const verb of ["sync", "build"]) {
    await execFileAsync(process.execPath, [BIN, verb], { cwd: site });
  }
  return join(site, "site");
}

interface Conditions {
  at: string;
  cores: number;
  totalMemoryBytes: number;
  node: string;
  platform: string;
  lighthouse: string;
  userAgent: string;
  benchmarkIndex: number | null;
  formFactor: string;
  throttlingMethod: string;
  throttling: unknown;
}

interface FullResult extends LighthouseResult {
  readonly lighthouseVersion: string;
  readonly environment: { readonly hostUserAgent: string; readonly benchmarkIndex?: number };
  readonly configSettings: {
    readonly formFactor: string;
    readonly throttlingMethod: string;
    readonly throttling: unknown;
  };
}

async function main(): Promise<number> {
  const { serveBuild } = await import("@pagedeck/site/audit-site");
  const { launch } = await import("chrome-launcher");
  const { chromium } = await import("playwright");
  const { default: lighthouse } = await import("lighthouse");

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const loadout = await serveLoadout();
  const failures: string[] = [];
  const measured: { mix: Mix; runs: RunFigures[]; hits: string[][] }[] = [];
  const conditions: Conditions = {
    at: new Date().toISOString(),
    cores: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    lighthouse: "",
    userAgent: "",
    benchmarkIndex: null,
    formFactor: "",
    throttlingMethod: "",
    throttling: null,
  };

  try {
    const outs = new Map<Mix, string>();
    for (const mix of MIXES) outs.set(mix, await buildMix(mix, loadout.origin));

    const chrome = await launch({
      chromePath: chromium.executablePath(),
      chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    try {
      for (const mix of MIXES) {
        const served = await serveBuild(outs.get(mix) as string);
        const entry = { mix, runs: [] as RunFigures[], hits: [] as string[][] };
        measured.push(entry);
        try {
          for (let run = 1; run <= RUNS; run++) {
            loadout.hits.length = 0;
            // Default flags, Lighthouse's mobile configuration: criterion 5 is about mobile.
            const result = await lighthouse(`${served.origin}/`, {
              port: chrome.port,
              output: "json",
              logLevel: "error",
            });
            if (result === undefined) {
              throw new Error(
                `Loadout harness, mix "${mix}" run ${String(run)}: Lighthouse returned no result — re-run, and if it repeats the page is not loading at ${served.origin}/`,
              );
            }
            const lhr = result.lhr as unknown as FullResult;
            conditions.lighthouse = lhr.lighthouseVersion;
            conditions.userAgent = lhr.environment.hostUserAgent;
            conditions.benchmarkIndex = lhr.environment.benchmarkIndex ?? null;
            conditions.formFactor = lhr.configSettings.formFactor;
            conditions.throttlingMethod = lhr.configSettings.throttlingMethod;
            conditions.throttling = lhr.configSettings.throttling;
            const figures = readRun(lhr);
            const hits = [...loadout.hits].sort();
            entry.runs.push(figures);
            entry.hits.push(hits);

            const left = offMachine(figures.urls, [served.origin, loadout.origin]);
            if (left.length > 0) {
              failures.push(
                `mix "${mix}" run ${String(run)}: ${String(left.length)} requests went to neither ${served.origin} nor ${loadout.origin} — find what on the page or in the loadout names them:\n${left.map((url) => `  ${url}`).join("\n")}`,
              );
            }
            const expected = expectedHits(mix);
            if (JSON.stringify(hits) !== JSON.stringify(expected)) {
              failures.push(
                `mix "${mix}" run ${String(run)}: the loadout reported ${JSON.stringify(hits)}, and the mix's strategies call for ${JSON.stringify(expected)} — a script that did not report did not run inside the measurement, and one reporting "main" under a worker strategy ran on the main thread, so the run measured another loadout than the one declared`,
              );
            }
          }
        } finally {
          await served.close();
        }
      }
    } finally {
      await chrome.kill();
    }
  } finally {
    await loadout.close();
  }

  writeFileSync(
    REPORT,
    `${JSON.stringify({ conditions, loadout: LOADOUT, mixes: measured, failures }, null, 2)}\n`,
  );
  process.stdout.write(
    [
      "",
      `Lighthouse ${conditions.lighthouse}, ${conditions.formFactor}, ${conditions.throttlingMethod} throttling, ${String(conditions.cores)} cores, node ${conditions.node}`,
      conditions.userAgent,
      "",
      table(measured),
      "",
      `report: ${REPORT}`,
      "",
    ].join("\n"),
  );
  if (failures.length === 0) return 0;
  process.stderr.write(
    `Loadout harness: ${String(failures.length)} ${failures.length === 1 ? "run" : "runs"} measured something other than the declared loadout on this machine alone:\n${failures.join("\n")}\n`,
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
