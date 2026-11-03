import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScriptDeclaration } from "@pagedeck/core";
// `.ts`: Node loads this file with types stripped, and no `.js` sits beside the source.
import type { LighthouseResult } from "./lighthouse-run.test-support.ts";

const execFileAsync = promisify(execFile);

const WORK = join(import.meta.dirname, "..", ".pagedeck-loadout");
const REPORT = join(WORK, "loadout-report.json");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
const RUNS = 3;

export const MIXES = ["idle", "default", "facade"] as const;
export type Mix = (typeof MIXES)[number];

const REPORTS = {
  beacon: { path: "/collect", call: (target: string) => `navigator.sendBeacon(${target});` },
  image: { path: "/pixel.gif", call: (target: string) => `new Image().src=${target};` },
  fetch: { path: "/hit", call: (target: string) => `fetch(${target});` },
} as const;

export interface LoadoutScript {
  readonly name: string;
  readonly costMs: number;
  readonly injectedBy?: string;
  readonly report: keyof typeof REPORTS;
  /** The one script the facade mix puts behind a placeholder. */
  readonly widget?: true;
}

export const LOADOUT: readonly LoadoutScript[] = [
  { name: "tag-manager", costMs: 40, report: "fetch" },
  { name: "tag-1", costMs: 20, injectedBy: "tag-manager", report: "fetch" },
  { name: "tag-2", costMs: 20, injectedBy: "tag-manager", report: "fetch" },
  { name: "analytics", costMs: 60, report: "beacon" },
  { name: "pixel", costMs: 30, report: "image" },
  { name: "chat", costMs: 80, report: "fetch", widget: true },
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
    script.widget === true
      ? `var b=document.createElement("button");b.textContent="Chat";b.style.cssText=${JSON.stringify(CHAT_STYLE)};document.body.appendChild(b);`
      : "";
  const { path, call } = REPORTS[script.report];
  const report = call(`${url(`${path}?script=${script.name}&where=`)}+where`);
  return `(function(){var where=typeof DedicatedWorkerGlobalScope==="function"?"worker":"main";var t=Date.now();while(Date.now()-t<=${String(script.costMs)}){}${injected}${widget}${report}})();\n`;
}

export function declaredScripts(mix: Mix, origin: string): ScriptDeclaration[] {
  return LOADOUT.filter(({ injectedBy }) => injectedBy === undefined).map(({ name, widget }) => {
    const src = `${origin}/${name}.js`;
    if (mix === "idle") return { name, src, strategy: "idle" };
    if (mix === "facade" && widget === true) {
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
  return LOADOUT.filter(({ widget }) => !(mix === "facade" && widget === true))
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

export function readRun(
  lhr: Pick<LighthouseResult, "categories" | "audits" | "runtimeError">,
): RunFigures {
  const score = lhr.categories["performance"]?.score;
  if (typeof score !== "number") {
    const reason =
      lhr.runtimeError === undefined
        ? "and gave no runtime error"
        : `and gave the runtime error ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`;
    throw new Error(
      `Loadout harness: Lighthouse reported no "performance" score for this run, ${reason} — so the run has no figure to record; re-run, and if it repeats fix what the runtime error names`,
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
  const reports = new Map<string, keyof typeof REPORTS>(
    Object.entries(REPORTS).map(([kind, { path }]) => [path, kind as keyof typeof REPORTS]),
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
    const report = reports.get(url.pathname);
    if (report !== undefined) {
      hits.push(`${url.searchParams.get("script") ?? "?"}@${url.searchParams.get("where") ?? "?"}`);
      if (report === "image") {
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

export function buildFailure(mix: Mix, verb: string, site: string, cause: unknown): Error {
  const stderr =
    typeof cause === "object" && cause !== null && "stderr" in cause
      ? String(cause.stderr).trim()
      : "";
  return new Error(
    `Loadout harness, mix "${mix}": \`pagedeck ${verb}\` failed in ${site}, so this mix has no site to measure — fix what it reports below, and run pnpm build first if packages/core/dist is older than the source${stderr === "" ? "" : `:\n${stderr}`}`,
    { cause },
  );
}

async function buildMix(mix: Mix, origin: string): Promise<string> {
  const site = join(WORK, mix);
  mkdirSync(join(site, "components"), { recursive: true });
  writeFileSync(join(site, "pagedeck.config.ts"), siteConfigSource(mix, origin));
  writeFileSync(join(site, "components", "Article.js"), ARTICLE);
  for (const verb of ["sync", "build"]) {
    try {
      await execFileAsync(process.execPath, [BIN, verb], { cwd: site });
    } catch (cause) {
      throw buildFailure(mix, verb, site, cause);
    }
  }
  return join(site, "site");
}

export function runFailures(input: {
  readonly mix: Mix;
  readonly run: number;
  readonly outcome: RunFigures | Error;
  readonly hits: readonly string[];
  readonly origins: readonly string[];
}): string[] {
  const at = `mix "${input.mix}" run ${String(input.run)}`;
  if (input.outcome instanceof Error) return [`${at}: ${input.outcome.message}`];
  const failures: string[] = [];
  const left = offMachine(input.outcome.urls, input.origins);
  if (left.length > 0) {
    failures.push(
      `${at}: ${String(left.length)} ${left.length === 1 ? "request" : "requests"} went to neither ${input.origins.join(" nor ")} — find what on the page or in the loadout names ${left.length === 1 ? "it" : "them"}:\n${left.map((url) => `  ${url}`).join("\n")}`,
    );
  }
  const expected = expectedHits(input.mix);
  if (JSON.stringify(input.hits) !== JSON.stringify(expected)) {
    failures.push(
      `${at}: the loadout reported ${JSON.stringify(input.hits)}, and the mix's strategies call for ${JSON.stringify(expected)} — a script that did not report did not run inside the measurement, and one reporting "main" under a worker strategy ran on the main thread, so the run measured another loadout than the one declared`,
    );
  }
  return failures;
}

async function main(): Promise<number> {
  const { serveBuild } = await import("@pagedeck/site/audit-site");
  const { launchLighthouse, machineConditions } = await import(
    "./lighthouse-run.test-support.ts"
  );

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const machine = machineConditions();
  let lighthouse:
    | Pick<LighthouseResult, "lighthouseVersion" | "environment" | "configSettings">
    | undefined;
  const loadout = await serveLoadout();
  const failures: string[] = [];
  const measured: { mix: Mix; runs: RunFigures[]; hits: string[][] }[] = [];

  try {
    const builds: { mix: Mix; out: string }[] = [];
    for (const mix of MIXES) builds.push({ mix, out: await buildMix(mix, loadout.origin) });

    const browser = await launchLighthouse();
    try {
      for (const { mix, out } of builds) {
        const served = await serveBuild(out);
        const entry = { mix, runs: [] as RunFigures[], hits: [] as string[][] };
        measured.push(entry);
        try {
          for (let run = 1; run <= RUNS; run++) {
            loadout.hits.length = 0;
            let outcome: RunFigures | Error;
            try {
              const lhr = await browser.audit(`${served.origin}/`, `Loadout harness, mix "${mix}"`);
              lighthouse ??= lhr;
              outcome = readRun(lhr);
              entry.runs.push(outcome);
            } catch (error) {
              outcome = error instanceof Error ? error : new Error(String(error));
            }
            const hits = [...loadout.hits].sort();
            entry.hits.push(hits);
            failures.push(
              ...runFailures({
                mix,
                run,
                outcome,
                hits,
                origins: [served.origin, loadout.origin],
              }),
            );
          }
        } finally {
          await served.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await loadout.close();
  }

  const conditions = {
    ...machine,
    lighthouse: lighthouse?.lighthouseVersion ?? null,
    userAgent: lighthouse?.environment.hostUserAgent ?? null,
    benchmarkIndex: lighthouse?.environment.benchmarkIndex ?? null,
    formFactor: lighthouse?.configSettings.formFactor ?? null,
    throttlingMethod: lighthouse?.configSettings.throttlingMethod ?? null,
    throttling: lighthouse?.configSettings.throttling ?? null,
  };
  writeFileSync(
    REPORT,
    `${JSON.stringify({ conditions, loadout: LOADOUT, mixes: measured, failures }, null, 2)}\n`,
  );
  process.stdout.write(
    [
      "",
      `Lighthouse ${String(conditions.lighthouse)}, ${String(conditions.formFactor)}, ${String(conditions.throttlingMethod)} throttling, ${String(conditions.cores)} cores, node ${conditions.node}`,
      String(conditions.userAgent),
      "",
      table(measured.filter(({ runs }) => runs.length > 0)),
      "",
      `report: ${REPORT}`,
      "",
    ].join("\n"),
  );
  if (failures.length === 0) return 0;
  process.stderr.write(
    `Loadout harness: ${String(failures.length)} ${failures.length === 1 ? "failure" : "failures"}, so these figures are not a measurement of the declared loadout on this machine alone:\n${failures.join("\n")}\n`,
  );
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
