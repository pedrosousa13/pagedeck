import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  generateSyntheticSite,
  peakRssBytes,
  reportText,
  rungShortfall,
  scalingReport,
} from "@pagedeck/bench";
import type { Rung, ScalingReport } from "@pagedeck/bench";
import { DIAGNOSTIC_MARKER, planIncremental, readManifest } from "@pagedeck/core";
import type { EntryRef, Manifest, Page } from "@pagedeck/core";

/** Everything this harness writes, under one directory `.gitignore` names. */
const WORK = join(import.meta.dirname, "..", ".pagedeck-scaling");
const REPORT = join(WORK, "scaling-report.json");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Factors of four or five, so a quadratic term shows as a ratio of sixteen. 50,000 is asked
// for with `--pages 50000`, not run unattended: it is a memory question per box.
export const DEFAULT_LADDER: readonly number[] = [100, 500, 2_000, 8_000, 32_000];

// Two, so a rung measures locale prefixes and a second copy of the path set.
const DEFAULT_LOCALES = 2;

// #60: stop once a rung exceeds about three minutes.
const RUNG_BUDGET_MS = 180_000;

const RSS_SAMPLE_MS = 50;

interface Ladder {
  pages: readonly number[];
  locales: number;
}

// Refused, not guessed: a mistyped flag must not quietly measure the default ladder.
export function parseLadder(args: readonly string[]): Ladder {
  let pages = DEFAULT_LADDER;
  let locales = DEFAULT_LOCALES;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const value = args[index + 1];
    if (arg === "--pages" || arg === "--locales") {
      if (value === undefined) {
        throw new Error(
          `Scaling ladder: "${arg}" was given no value — write it as ${arg} ${arg === "--pages" ? "100,500,2000" : "2"}`,
        );
      }
      index += 1;
      if (arg === "--locales") {
        locales = whole(value, "--locales");
        continue;
      }
      pages = value.split(",").map((rung) => whole(rung, "--pages"));
      continue;
    }
    throw new Error(
      `Scaling ladder: "${arg}" is not an option this harness takes — it takes --pages, a comma-separated list of page counts, and --locales, a count; run it with neither to climb ${DEFAULT_LADDER.join(", ")}`,
    );
  }
  return { pages, locales };
}

function whole(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Scaling ladder: ${option} was given "${value}", which is not a positive whole number — a rung is a page count and a locale count is a count`,
    );
  }
  return parsed;
}

// Every verb's time, not the build's: at 32,000 pages `pagedeck sync` costs three times the build.
export function tooSlowToClimb(
  rungMs: number,
  budgetMs: number,
): string | undefined {
  if (rungMs <= budgetMs) return undefined;
  return `Scaling ladder: this rung took ${(rungMs / 1_000).toFixed(2)}s across its verbs, past the ${(budgetMs / 1_000).toFixed(0)}s a rung is given, so the ladder stops here — the rungs already measured are in the report, and a larger one on this box risks the memory exhaustion the whole-site-in-memory staging makes possible rather than adding a reading`;
}

interface Run {
  ms: number;
  peakRssBytes: number | undefined;
}

// `spawn`, not `execFile`: `/proc/<pid>` is gone once `execFile` resolves, and the peak is
// sampled while the child runs. The clock covers start-up and config load, as a user sees it.
async function pagedeck(verb: readonly string[], cwd: string): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [BIN, ...verb], { cwd });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdout.resume();

    let peak: number | undefined;
    const sampler = setInterval(() => {
      try {
        const status = readFileSync(`/proc/${String(child.pid)}/status`, "utf8");
        const read = peakRssBytes(status);
        // `VmHWM` is monotonic, so the last good read is the peak.
        if (read !== undefined) peak = read;
      } catch {
      }
    }, RSS_SAMPLE_MS);

    child.on("error", (cause) => {
      clearInterval(sampler);
      reject(
        new Error(
          `Scaling ladder: pagedeck ${verb.join(" ")} could not be started in "${cwd}" — this harness spawns "${BIN}" as its own process and has no in-process fallback, by design; fix what the cause names`,
          { cause },
        ),
      );
    });
    child.on("close", (status, signal) => {
      clearInterval(sampler);
      const ms = performance.now() - started;
      if (signal !== null) {
        reject(
          new Error(
            `Scaling ladder: pagedeck ${verb.join(" ")} was killed by ${signal} in "${cwd}" — the build did not fail, it was stopped, and a whole site staged in memory is what makes this the kernel's OOM killer at scale; the peak resident set before it died was ${peak === undefined ? "not sampled" : `${(peak / 1024 / 1024).toFixed(0)} MiB`}`,
          ),
        );
        return;
      }
      if (status !== 0) {
        process.stderr.write(stderr);
        reject(
          new Error(
            `Scaling ladder: pagedeck ${verb.join(" ")} failed in "${cwd}" with exit code ${String(status)} — see the diagnostic above; a rung has to build before it can be timed`,
          ),
        );
        return;
      }
      // The framework's own channel only: Babel remarks on `react-dom` on every run.
      const mine = stderr
        .split("\n")
        .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `));
      if (mine.length > 0) process.stderr.write(`${mine.join("\n")}\n`);
      resolve({ ms, peakRssBytes: peak });
    });
  });
}

function pageOf(row: Manifest["pages"][number]): Page {
  return {
    locale: row.locale,
    path: row.path as `/${string}`,
    output: row.output,
    dependencies: row.dependencies,
    ...(row.domain === undefined ? {} : { domain: row.domain }),
    ...(row.collection === undefined ? {} : { collection: row.collection }),
    ...(row.entry === undefined ? {} : { entry: row.entry }),
    ...(row.template === undefined ? {} : { template: row.template }),
    ...(row.fallbackFrom === undefined ? {} : { fallbackFrom: row.fallbackFrom }),
  };
}

// Taken from the manifest, so the planner's ref and the synced file are one entry.
function editOneEntry(site: string, manifest: Manifest): EntryRef {
  const row = manifest.pages.find(
    (one) => one.entry !== undefined && one.collection !== undefined,
  );
  if (row?.entry === undefined || row.collection === undefined) {
    throw new Error(
      `Scaling ladder: the manifest at "${site}" records no page with a stored entry, so there is no content edit to make — every page of a generated site comes from the "pages" collection, and a manifest without one means the build routed something else`,
    );
  }
  const file = join(site, "content", row.entry.locale, `${row.entry.path}.json`);
  const fixture = JSON.parse(readFileSync(file, "utf8")) as {
    rev: number;
    data: { title: string };
  };
  writeFileSync(
    file,
    `${JSON.stringify({ ...fixture, rev: 2, data: { ...fixture.data, title: `${fixture.data.title} (edited)` } }, null, 2)}\n`,
  );
  return {
    collection: row.collection,
    locale: row.entry.locale,
    path: row.entry.path,
  };
}

async function measure(pages: number, locales: number): Promise<Rung> {
  const site = join(WORK, `site-${String(pages)}`);
  const generated = generateSyntheticSite({ directory: site, pages, locales });

  const sync = await pagedeck(["sync"], site);
  const build = await pagedeck(["build"], site);

  const manifest = readManifest(
    readFileSync(join(site, "dist", "manifest.json"), "utf8"),
    "manifest.json",
  );
  // Both store figures from one buffer, before the edit below changes the file.
  const store = readFileSync(join(site, "content.db"));
  const storeBytes = store.length;
  const storeGzipBytes = gzipSync(store).length;

  const changed = editOneEntry(site, manifest);
  const incrementalSync = await pagedeck(["sync", "--incremental"], site);

  const planStarted = performance.now();
  planIncremental({
    previous: manifest,
    pages: manifest.pages.map(pageOf),
    delta: {
      since: manifest.store.seq,
      head: manifest.store.seq + 1,
      changed: [changed],
      vanished: [],
      requested: [],
    },
  });
  const planMs = performance.now() - planStarted;

  // Lets the verb plan for itself rather than making the harness a second caller of the planner.
  const incrementalBuild = await pagedeck(["build", "--incremental"], site);

  const rung: Rung = {
    pages: generated.pages,
    locales,
    islandPages: generated.islandPages,
    pagesBuilt: manifest.pages.length,
    outputFiles: manifest.files.length,
    // Distinct keys: pages sharing entry text share one chunk (#264).
    entryChunks: new Set(manifest.pages.flatMap((row) => row.entryChunk ?? [])).size,
    syncMs: sync.ms,
    buildMs: build.ms,
    incrementalSyncMs: incrementalSync.ms,
    planMs,
    incrementalBuildMs: incrementalBuild.ms,
    // A rung never sampled stops the run rather than reporting `0`.
    buildPeakRssBytes: peakOrRefuse(build, pages),
    storeBytes,
    storeGzipBytes,
  };

  const shortfall = rungShortfall(rung);
  if (shortfall !== undefined) throw new Error(shortfall);

  rmSync(site, { recursive: true, force: true });
  return rung;
}

function peakOrRefuse(build: Run, pages: number): number {
  if (build.peakRssBytes !== undefined) return build.peakRssBytes;
  throw new Error(
    `Scaling ladder: the ${String(pages)}-page build was never sampled for peak memory, so this rung has a wall clock and no memory figure — the sampler reads /proc/<pid>/status every ${String(RSS_SAMPLE_MS)}ms and there is no fallback for a host without /proc (packages/bench/src/rss.ts records why)`,
  );
}

function writeReport(rungs: readonly Rung[]): ScalingReport {
  const report = scalingReport(rungs);
  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        machine: {
          cores: cpus().length,
          totalMemoryBytes: totalmem(),
          node: process.version,
          platform: process.platform,
        },
        report,
      },
      null,
      2,
    )}\n`,
  );
  return report;
}

async function main(argv: readonly string[]): Promise<number> {
  if (!existsSync(BIN)) {
    throw new Error(
      `Scaling ladder: no executable at "${BIN}" — pnpm bench:scaling runs pnpm build first, which is what emits it, so this is a run of node against this file directly; this harness spawns the shipped pagedeck rather than calling the build in process`,
    );
  }
  const ladder = parseLadder(argv);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const rungs: Rung[] = [];
  for (const pages of ladder.pages) {
    process.stderr.write(
      `measuring ${String(pages)} pages over ${String(ladder.locales)} locales…\n`,
    );
    let rung: Rung;
    try {
      rung = await measure(pages, ladder.locales);
    } catch (cause) {
      // A failing rung ends the climb and keeps the rungs below: a failure at scale is a finding.
      process.stderr.write(
        `${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      process.stderr.write(
        `The ladder stops here. The ${String(rungs.length)} rung(s) already measured are in the report below.\n`,
      );
      break;
    }
    rungs.push(rung);
    // Per rung, so a run the kernel kills still leaves a report.
    writeReport(rungs);
    const stop = tooSlowToClimb(
      rung.syncMs +
        rung.buildMs +
        rung.incrementalSyncMs +
        rung.planMs +
        rung.incrementalBuildMs,
      RUNG_BUDGET_MS,
    );
    if (stop !== undefined) {
      process.stderr.write(`${stop}\n`);
      break;
    }
  }

  process.stdout.write(`${reportText(writeReport(rungs))}\nWritten to ${REPORT}\n`);
  // Always `0`: targets, not gates (decision 24).
  return 0;
}

// Only when run directly: the test imports this module's pure functions.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
