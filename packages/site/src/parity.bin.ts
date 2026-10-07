import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigError, describeError, EXIT_CODES, quoteIdentifier } from "@pagedeck/core";
import {
  BASELINE_REDIRECTS,
  BASELINE_URLS,
  DECLARED_BASELINE,
  EXPECTATION_RULES,
} from "./parity-baseline.js";
import { compareParity, redactOrigin } from "./parity.js";
import type { ParityBaseline, ParityReport } from "./parity.js";
import { captureBaseline, readBaseline, readBuiltSite } from "./parity-read.js";

const USAGE = [
  "Usage: node dist/parity.bin.js capture --origin <url> --out <file> [--baseline <file>]",
  "       node dist/parity.bin.js compare --build <dir> [--baseline <file>] [--report <file>]",
  "",
  "capture records what an origin serves, as a baseline. compare checks a build",
  "against one and exits non-zero if anything differed that no rule explains,",
  "or if a rule explained nothing.",
  "Without --baseline, both use the declared baseline in src/parity-baseline.ts,",
  "which is this site's stated intent and not a recording of production.",
].join("\n");

function usageError(message: string): ConfigError {
  return new ConfigError([message, "", USAGE].join("\n"));
}

const VERBS = ["capture", "compare"] as const;
type Verb = (typeof VERBS)[number];

const VALUE_OPTIONS = ["--origin", "--out", "--baseline", "--build", "--report"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

interface Args {
  verb: Verb;
  origin?: string;
  out?: string;
  baseline?: string;
  build?: string;
  report?: string;
}

function parse(argv: readonly string[]): Args {
  const verb = VERBS.find((one) => one === argv[0]);
  if (verb === undefined) {
    throw usageError(
      argv[0] === undefined
        ? "No verb given."
        : `Unknown verb ${quoteIdentifier(argv[0])} — use one of: ${VERBS.join(", ")}.`,
    );
  }

  const values = new Map<ValueOption, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const option = VALUE_OPTIONS.find((one) => one === arg);
    if (option === undefined) throw usageError(`Unknown option ${quoteIdentifier(arg)}.`);
    const value = argv[index + 1];
    if (value === undefined) throw usageError(`Option "${option}" takes a value.`);
    index += 1;
    const already = values.get(option);
    if (already !== undefined) {
      throw usageError(
        `Option "${option}" is given twice, as ${quoteIdentifier(already)} and as ${quoteIdentifier(value)} — two sources for one value are refused rather than ranked; pass it once.`,
      );
    }
    values.set(option, value);
  }

  return {
    verb,
    origin: values.get("--origin"),
    out: values.get("--out"),
    baseline: values.get("--baseline"),
    build: values.get("--build"),
    report: values.get("--report"),
  };
}

async function baselineOf(file: string | undefined): Promise<ParityBaseline> {
  if (file === undefined) return DECLARED_BASELINE;
  const path = resolve(process.cwd(), file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `Parity baseline ${quoteIdentifier(path)}: could not be read — capture one with parity capture, or drop --baseline to compare against the declared baseline`,
      { cause },
    );
  }
  return readBaseline(text, path);
}

// Redacted again: this prints an origin out of a baseline somebody else wrote.
function originLine(baseline: ParityBaseline): string {
  const { origin } = baseline;
  return origin.kind === "captured"
    ? `baseline origin: captured from ${redactOrigin(origin.from)} at ${origin.at}`
    : `baseline origin: declared — ${origin.why}`;
}

function lines(report: ParityReport, baseline: ParityBaseline): string[] {
  const { coverage } = report;
  const outcomes = (outcome: string): number =>
    report.redirects.filter((one) => one.outcome === outcome).length;

  const out = [
    originLine(baseline),
    `coverage: ${String(coverage.compared)} of ${String(coverage.baselineUrls)} baseline URLs compared against ${String(coverage.builtUrls)} built URLs`,
    `  missing from the build: ${coverage.missingFromBuild.length === 0 ? "none" : coverage.missingFromBuild.join(", ")}`,
    `  new in the build: ${coverage.newInBuild.length === 0 ? "none" : coverage.newInBuild.join(", ")}`,
    `redirects: ${String(outcomes("same"))} same, ${String(outcomes("differs"))} differ, ${String(outcomes("missing"))} missing, ${String(outcomes("unexpected"))} unexpected`,
    `defects: ${String(report.defects.length)}`,
  ];
  for (const defect of report.defects) {
    out.push(`  ${defect.url} ${defect.field}: baseline ${defect.baseline} / built ${defect.built}`);
  }
  out.push(`expected differences: ${String(report.expected.length)}`);
  for (const difference of report.expected) {
    out.push(
      `  ${difference.url} ${difference.field}: baseline ${difference.baseline} / built ${difference.built} — ${difference.why}`,
    );
  }
  out.push(`stale rules: ${String(report.stale.length)}`);
  for (const rule of report.stale) {
    const named = [
      rule.baselineOnly === undefined ? "" : ` baseline ${JSON.stringify(rule.baselineOnly)}`,
      rule.builtOnly === undefined ? "" : ` built ${JSON.stringify(rule.builtOnly)}`,
    ].join("");
    out.push(
      `  ${rule.url ?? "every page"} ${rule.field}:${named === "" ? " the whole field" : named} excused nothing — ${rule.why}`,
    );
  }
  return out;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  if (args.verb === "capture") {
    if (args.origin === undefined) throw usageError("No --origin given.");
    if (args.out === undefined) throw usageError("No --out given.");
    // From a baseline, not a crawl: a page missing from the origin is the finding, and
    // a crawl cannot report a page it never saw.
    const from = await baselineOf(args.baseline);
    const captured = await captureBaseline({
      origin: args.origin.replace(/\/+$/, ""),
      urls:
        args.baseline === undefined
          ? BASELINE_URLS
          : from.pages.map((page) => page.url),
      redirects:
        args.baseline === undefined
          ? BASELINE_REDIRECTS
          : from.redirects.map((rule) => rule.from),
      at: new Date().toISOString(),
    });
    const out = resolve(process.cwd(), args.out);
    await writeFile(out, `${JSON.stringify(captured, undefined, 2)}\n`, "utf8");
    write(originLine(captured));
    write(
      `captured ${String(captured.pages.length)} pages and ${String(captured.redirects.length)} redirects to ${out}`,
    );
    return EXIT_CODES.success;
  }

  if (args.build === undefined) throw usageError("No --build given.");
  const baseline = await baselineOf(args.baseline);
  const report = compareParity({
    baseline,
    built: await readBuiltSite(resolve(process.cwd(), args.build)),
    rules: EXPECTATION_RULES,
  });
  for (const line of lines(report, baseline)) write(line);

  if (args.report !== undefined) {
    const out = resolve(process.cwd(), args.report);
    await writeFile(out, `${JSON.stringify(report, undefined, 2)}\n`, "utf8");
    write(`report written to ${out}`);
  }

  // `syncFailed`, not exit 2: a defect is a finished run that found a difference. A
  // stale rule fails the run the same way (#545).
  return report.defects.length === 0 && report.stale.length === 0
    ? EXIT_CODES.success
    : EXIT_CODES.syncFailed;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Writes to stderr: rule 8 binds a build process, and this is a separate executable
  // with no `CliIo`.
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode =
    error instanceof ConfigError ? EXIT_CODES.configError : EXIT_CODES.syncFailed;
}
