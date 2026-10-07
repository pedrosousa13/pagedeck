import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem } from "node:os";
// By package name: Node loads this file with types stripped, and a relative
// `.js` would name a file only `tsc` emits (#182).
import { components } from "@pagedeck/design-system";

const WORK = join(import.meta.dirname, "..", ".pagedeck-island-scan");
// Not under `node_modules`, where Node refuses to strip types, and inside this
// package, so its self-referencing subpaths resolve from here.
const SITE = join(WORK, "site");
const SCAN_LOG = join(WORK, "scan.log");
const REPORT = join(WORK, "island-scan-report.json");
const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
const PROBE = join(import.meta.dirname, "island-scan-probe.harness.ts");
// The emitted tree: a spawned `pagedeck` cannot resolve the source's `./loader.js`
// (#182).
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "dist",
  "index.js",
);

const LOCALES: readonly { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
];

interface Options {
  pages: number;
  locales: number;
  runs: number;
}

export function parseOptions(args: readonly string[]): Options {
  const parsed: Options = { pages: 24, locales: 2, runs: 5 };
  const names = new Map<string, keyof Options>([
    ["--pages", "pages"],
    ["--locales", "locales"],
    ["--runs", "runs"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    const field = names.get(arg);
    if (field === undefined) {
      throw new Error(
        `Island scan measurement: "${arg}" is not an option this harness takes — it takes --pages, --locales and --runs, each a positive whole number; run it with none to measure ${String(parsed.pages)} pages over ${String(parsed.locales)} locales across ${String(parsed.runs)} probed runs`,
      );
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(
        `Island scan measurement: "${arg}" was given no value — write it as ${arg} ${String(parsed[field])}`,
      );
    }
    index += 1;
    const whole = Number(value);
    if (!Number.isInteger(whole) || whole < 1) {
      throw new Error(
        `Island scan measurement: ${arg} was given "${value}", which is not a positive whole number — every option this harness takes is a count of something it writes or runs, so write it as ${arg} ${String(parsed[field])}`,
      );
    }
    parsed[field] = whole;
  }
  if (parsed.locales > LOCALES.length) {
    throw new Error(
      `Island scan measurement: --locales was given ${String(parsed.locales)} and this harness names ${String(LOCALES.length)} locales — add a row to LOCALES, or ask for at most ${String(LOCALES.length)}`,
    );
  }
  return parsed;
}

interface Entry {
  kind: "pricing" | "legal";
  headline: string;
}

function entryOf(index: number, locale: string): Entry {
  return {
    kind: index % 3 === 0 ? "pricing" : "legal",
    headline: `${locale} page ${String(index)}`,
  };
}

function fixtureFile(index: number, locale: string): string {
  return join(SITE, "content", locale, `page-${String(index)}.json`);
}

function writeFixture(
  index: number,
  locale: string,
  rev: number,
  suffix = "",
): void {
  const entry = entryOf(index, locale);
  const file = fixtureFile(index, locale);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify(
      { rev, data: { ...entry, headline: `${entry.headline}${suffix}` } },
      null,
      2,
    )}\n`,
  );
}

function writeConfig(locales: number): void {
  const table = LOCALES.slice(0, locales)
    .map((one) => `${one.code}: { label: ${JSON.stringify(one.label)}, direction: "ltr" }`)
    .join(", ");
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `import { defineCollection, getEntry } from "@pagedeck/content";
import {
  defineConfig,
  defineLocales,
  definePages,
  fromCollection,
  SECURITY_HEADERS,
} from "@pagedeck/core";
import { defineComponents } from "@pagedeck/islands";
import { components, safelist } from "@pagedeck/design-system";
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = defineCollection({
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
});

function contentOf(page, store) {
  const entry = getEntry(store, pages, page.entry);
  if (entry === undefined) {
    throw new Error(
      "Page " + page.locale + " " + page.path + ": is in the route table but not in the store",
    );
  }
  const data = entry.data;
  if (data.kind === "pricing") {
    return {
      tree: [
        {
          component: "pricing_page",
          props: {
            fields: {
              headline: data.headline,
              plans: [
                { name: "Starter", price: "19" },
                { name: "Team", price: "49" },
              ],
            },
          },
          children: [],
        },
      ],
    };
  }
  return {
    tree: [
      {
        component: "legal_page",
        props: { title: data.headline, fields: { body_text: data.headline } },
        children: [],
      },
    ],
  };
}

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ ${table} }),
      sources: [fromCollection(pages)],
    }),
    components: defineComponents({ ...components }),
    safelist,
    tierPolicy: { minSize: 0 },
    content: contentOf,
  },
});
`,
  );
}

interface Written {
  pages: number;
  perLocale: number;
}

function writeSite(options: Options): Written {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  const codes = LOCALES.slice(0, options.locales).map((one) => one.code);
  const perLocale = Math.ceil(options.pages / codes.length);
  let pages = 0;
  for (const code of codes) {
    for (let index = 0; index < perLocale; index += 1) {
      writeFixture(index, code, 1);
      pages += 1;
    }
  }
  writeConfig(options.locales);
  return { pages, perLocale };
}

interface Run {
  ms: number;
  out: string;
}

async function pagedeck(
  verb: readonly string[],
  probe: boolean,
): Promise<Run> {
  return await new Promise<Run>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      [...(probe ? ["--import", PROBE] : []), BIN, ...verb],
      { cwd: SITE, env: { ...process.env, PAGEDECK_ISLAND_SCAN_LOG: SCAN_LOG } },
    );
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (err += chunk));

    child.on("error", (cause) => {
      reject(
        new Error(
          `Island scan measurement: pagedeck ${verb.join(" ")} could not be started in "${SITE}" — this harness spawns "${BIN}" as its own process and has no in-process fallback, by design; fix what the cause names`,
          { cause },
        ),
      );
    });
    child.on("close", (status, signal) => {
      const ms = performance.now() - started;
      if (signal !== null) {
        reject(
          new Error(
            `Island scan measurement: pagedeck ${verb.join(" ")} was killed by ${signal} in "${SITE}" — the build did not fail, it was stopped`,
          ),
        );
        return;
      }
      if (status !== 0) {
        process.stderr.write(err);
        reject(
          new Error(
            `Island scan measurement: pagedeck ${verb.join(" ")} failed in "${SITE}" with exit code ${String(status)} — see the diagnostic above; a site has to build before an incremental build of it can be timed`,
          ),
        );
        return;
      }
      resolve({ ms, out });
    });
  });
}

function scanMs(): number | undefined {
  if (!existsSync(SCAN_LOG)) return undefined;
  const lines = readFileSync(SCAN_LOG, "utf8").split("\n").filter(Boolean);
  rmSync(SCAN_LOG, { force: true });
  if (lines.length !== 1) return undefined;
  const parsed = Number(lines[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface Split {
  rendered: number;
  total: number;
}

export function readSplit(out: string): Split | undefined {
  const line = /incremental: (\d+) of (\d+) pages rendered/.exec(out);
  if (line === null) return undefined;
  return { rendered: Number(line[1]), total: Number(line[2]) };
}

interface Measured {
  probed: boolean;
  syncMs: number;
  buildMs: number;
  deployMs: number;
  scanMs: number | undefined;
  rendered: number;
  total: number;
}

const RENDERED_PER_TWEAK = 1;

async function tweak(
  run: number,
  probe: boolean,
  perLocale: number,
): Promise<Measured> {
  // Above the `rev` every file was written at, or the next sync skips the entry.
  writeFixture(
    run % perLocale,
    LOCALES[0]?.code as string,
    run + 2,
    ` (edit ${String(run)})`,
  );
  const sync = await pagedeck(["sync", "--incremental"], false);
  const build = await pagedeck(["build", "--incremental"], probe);
  const split = readSplit(build.out);
  if (split === undefined) {
    throw new Error(
      `Island scan measurement: pagedeck build --incremental printed no summary line, so there is no evidence its renders were skipped — the line reads "incremental: N of M pages rendered", and a run without one is a run this harness cannot label; run pnpm build so the spawned "${BIN}" is current, and if the verb has reworded the line, move readSplit's pattern with it`,
    );
  }
  if (split.rendered >= split.total) {
    throw new Error(
      `Island scan measurement: pagedeck build --incremental rendered ${String(split.rendered)} of ${String(split.total)} pages, so this run skipped no renders and is not the copy-tweak deploy the measurement is of — the reopen condition this harness answers is about a build whose renders are skipped`,
    );
  }
  if (split.rendered !== RENDERED_PER_TWEAK) {
    throw new Error(
      `Island scan measurement: pagedeck build --incremental rendered ${String(split.rendered)} of ${String(split.total)} pages, and this run rewrote ${String(RENDERED_PER_TWEAK)} entry's copy — a plan that re-rendered pages no fixture here touched is not the copy tweak the report labels every run as, so measure what it re-rendered before reading a number off it`,
    );
  }
  const measured = probe ? scanMs() : undefined;
  if (probe && measured === undefined) {
    throw new Error(
      `Island scan measurement: the probe recorded no single scan for a probed run — "${SCAN_LOG}" should hold exactly one line per pagedeck build; a build that scanned twice, or not at all, is not the term this report is about; if the emitted module the shim stands in front of has moved, island-scan-probe.harness.ts's TARGET is what has to move with it`,
    );
  }
  return {
    probed: probe,
    syncMs: sync.ms,
    buildMs: build.ms,
    deployMs: sync.ms + build.ms,
    ...(measured === undefined ? { scanMs: undefined } : { scanMs: measured }),
    rendered: split.rendered,
    total: split.total,
  };
}

export interface Spread {
  runs: number;
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export function spread(values: readonly number[]): Spread | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    runs: sorted.length,
    minMs: sorted[0] as number,
    maxMs: sorted[sorted.length - 1] as number,
    medianMs:
      sorted.length % 2 === 1
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
  };
}

function percent(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(2)}%`;
}

async function main(argv: readonly string[]): Promise<number> {
  const missing = [BIN, FIXTURES].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `Island scan measurement: ${missing.map((file) => `"${file}"`).join(" and ")} ${missing.length === 1 ? "is" : "are"} not there — pnpm bench:island-scan runs pnpm build first, which is what emits both; this harness spawns the shipped pagedeck rather than calling the build in process, and the site it generates loads the shipped fixture loader`,
    );
  }
  const options = parseOptions(argv);
  const { pages, perLocale } = writeSite(options);
  process.stderr.write(
    `measuring ${String(Object.keys(components).length)} module-map rows over ${String(pages)} pages…\n`,
  );

  await pagedeck(["sync"], false);
  const full = await pagedeck(["build"], false);
  rmSync(SCAN_LOG, { force: true });

  const measured: Measured[] = [];
  for (let run = 0; run < options.runs * 2; run += 1) {
    process.stderr.write(`run ${String(run + 1)} of ${String(options.runs * 2)}…\n`);
    measured.push(await tweak(run, run % 2 === 0, perLocale));
  }

  const probed = measured.filter((one) => one.probed);
  const unprobed = measured.filter((one) => !one.probed);
  const scan = spread(
    probed.map((one) => one.scanMs).filter((one): one is number => one !== undefined),
  );
  const probedBuild = spread(probed.map((one) => one.buildMs));
  const unprobedBuild = spread(unprobed.map((one) => one.buildMs));
  const probedDeploy = spread(probed.map((one) => one.deployMs));
  const everyDeploy = spread(measured.map((one) => one.deployMs));
  if (
    scan === undefined ||
    probedBuild === undefined ||
    unprobedBuild === undefined ||
    probedDeploy === undefined ||
    everyDeploy === undefined
  ) {
    throw new Error(
      `Island scan measurement: --runs was ${String(options.runs)} and a spread needs at least one reading on each side of the probed/unprobed split`,
    );
  }

  const report = {
    machine: {
      cores: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
      platform: process.platform,
    },
    site: {
      pages,
      locales: options.locales,
      moduleMapRows: Object.keys(components).length,
      renderedPerRun: RENDERED_PER_TWEAK,
      fullBuildMs: full.ms,
    },
    scan,
    probedBuild,
    unprobedBuild,
    probedDeploy,
    everyDeploy,
    scanShareOfProbedBuild: scan.medianMs / probedBuild.medianMs,
    scanShareOfProbedDeploy: scan.medianMs / probedDeploy.medianMs,
    runs: measured,
  };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    [
      `Island scan inside pagedeck build --incremental`,
      ``,
      `site: ${String(pages)} pages over ${String(options.locales)} locales, ${String(report.site.moduleMapRows)} module-map rows`,
      `copy tweak: ${String(report.site.renderedPerRun)} of ${String(pages)} pages rendered, on every run`,
      `full build: ${(full.ms / 1000).toFixed(2)}s`,
      ``,
      `| reading | runs | min ms | median ms | max ms |`,
      `| --- | ---: | ---: | ---: | ---: |`,
      row("island scan", scan),
      row("pagedeck build --incremental, probed", probedBuild),
      row("pagedeck build --incremental, unprobed", unprobedBuild),
      row("deploy: both incremental verbs, probed", probedDeploy),
      row("deploy: both incremental verbs, every run", everyDeploy),
      ``,
      `scan as a share of the probed build's median: ${percent(scan.medianMs, probedBuild.medianMs)}`,
      `scan as a share of the probed deploy's median: ${percent(scan.medianMs, probedDeploy.medianMs)}`,
      ``,
      `Written to ${REPORT}`,
      ``,
    ].join("\n"),
  );
  return 0;
}

function row(label: string, of: Spread): string {
  return `| ${label} | ${String(of.runs)} | ${of.minMs.toFixed(1)} | ${of.medianMs.toFixed(1)} | ${of.maxMs.toFixed(1)} |`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
