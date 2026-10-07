import { gzipSync } from "node:zlib";

export interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: number;
}

export interface AxePageResult {
  readonly url: string;
  readonly violations: readonly AxeViolation[];
}

const BLOCKING = new Set(["serious", "critical"]);

export interface AxeVerdict {
  readonly pages: number;
  readonly blocking: readonly string[];
  readonly other: readonly string[];
}

function describe(url: string, violation: AxeViolation): string {
  const impact = violation.impact ?? "no impact";
  const nodes = `${String(violation.nodes)} node${violation.nodes === 1 ? "" : "s"}`;
  return `${url} — ${violation.id} (${impact}, ${nodes})`;
}

function urlFaults(
  what: string,
  urls: readonly string[],
  seen: readonly string[],
): string[] {
  const asked = new Set(urls);
  const counts = new Map<string, number>();
  for (const url of seen) counts.set(url, (counts.get(url) ?? 0) + 1);

  const faults: string[] = [];
  for (const url of urls) {
    const count = counts.get(url) ?? 0;
    if (count === 0) {
      faults.push(
        `${url}: in the set ${what} names and never measured, so a green verdict would cover less than it claims to`,
      );
    } else if (count > 1) {
      faults.push(`${url}: measured ${String(count)} times, so one result is being discarded`);
    }
  }
  for (const url of counts.keys()) {
    if (!asked.has(url)) {
      faults.push(`${url}: measured but not in the set ${what} names`);
    }
  }
  return faults;
}

// A bare `Error`, not `ConfigError`: these throw inside a Vitest hook, where no caller
// branches on the class.
function refusal(what: string, faults: readonly string[]): Error {
  return new Error(
    `${what}: ${String(faults.length)} fault${faults.length === 1 ? "" : "s"} in what was measured, so a green verdict would not mean what it says — fix each and re-run:\n  ${faults.join("\n  ")}`,
  );
}

function accountForUrls(
  what: string,
  urls: readonly string[],
  seen: readonly string[],
): void {
  const faults = urlFaults(what, urls, seen);
  if (faults.length > 0) throw refusal(what, faults);
}

export function axeVerdict(input: {
  readonly urls: readonly string[];
  readonly results: readonly AxePageResult[];
}): AxeVerdict {
  accountForUrls(
    "Site a11y pass",
    input.urls,
    input.results.map((one) => one.url),
  );

  const byUrl = new Map(input.results.map((one) => [one.url, one]));
  const blocking: string[] = [];
  const other: string[] = [];
  // In the set's order: a report whose order moves between runs cannot be diffed.
  for (const url of input.urls) {
    const found = byUrl.get(url) as AxePageResult;
    for (const violation of [...found.violations].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const line = describe(url, violation);
      const blocks =
        violation.impact === null || BLOCKING.has(violation.impact);
      (blocks ? blocking : other).push(line);
    }
  }
  return { pages: input.urls.length, blocking, other };
}

export interface LighthouseRun {
  readonly url: string;
  readonly scores: Readonly<Record<string, number>>;
  readonly scriptBytes: number;
  readonly scriptRequests: number;
  // Recorded, never asserted: a timing assertion on a shared runner flakes (#57).
  readonly timings: Readonly<Record<string, number>>;
}

export interface AuditBudget {
  readonly scriptBytes: number;
  readonly scriptRequests: number;
}

export interface AuditAssertion {
  readonly url: string;
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

export interface AuditVerdict {
  readonly assertions: readonly AuditAssertion[];
  readonly failures: readonly AuditAssertion[];
}

function check(
  url: string,
  name: string,
  expected: string,
  actual: number,
  ok: boolean,
): AuditAssertion {
  return { url, name, expected, actual: String(actual), ok };
}

export function auditVerdict(input: {
  readonly runs: readonly LighthouseRun[];
  readonly budgets: Readonly<Record<string, AuditBudget>>;
  readonly floors: Readonly<Record<string, number>>;
}): AuditVerdict {
  const urls = Object.keys(input.budgets);

  const faults = urlFaults("Site audit", urls, input.runs.map((one) => one.url));
  for (const [category] of Object.entries(input.floors)) {
    for (const run of input.runs) {
      if (!(category in run.scores)) {
        faults.push(
          `${run.url}: no score for the category "${category}" a floor names, so the floor would be asserted against nothing — name a category Lighthouse reports, or drop the floor`,
        );
      }
    }
  }
  if (faults.length > 0) throw refusal("Site audit", faults);

  const byUrl = new Map(input.runs.map((one) => [one.url, one]));
  const assertions: AuditAssertion[] = [];
  for (const url of urls) {
    const run = byUrl.get(url) as LighthouseRun;
    const budget = input.budgets[url] as AuditBudget;
    assertions.push(
      check(
        url,
        "script bytes",
        `<= ${String(budget.scriptBytes)}`,
        run.scriptBytes,
        run.scriptBytes <= budget.scriptBytes,
      ),
      check(
        url,
        "script requests",
        `<= ${String(budget.scriptRequests)}`,
        run.scriptRequests,
        run.scriptRequests <= budget.scriptRequests,
      ),
    );
    for (const [category, floor] of Object.entries(input.floors)) {
      const score = run.scores[category] as number;
      assertions.push(
        check(url, `${category} score`, `>= ${String(floor)}`, score, score >= floor),
      );
    }
  }
  return { assertions, failures: assertions.filter((one) => !one.ok) };
}

// Floored, and in thousandths of a percent: `(1000 - 201) / 1000 * 100` is
// 79.89999999999999 in floating point.
export function reductionPercent(twin: number, ours: number): number {
  if (twin <= 0) {
    throw new Error(
      `Payload reduction against ${String(twin)} B: the baseline is not a positive byte count, so the ${String(ours)} B measured here has nothing to be a reduction of — give TWIN_PAYLOAD in packages/site/src/audit-site.ts a figure read off docs/research/2026-08-23-app-router-static-export.md, or report the criterion as not measurable`,
    );
  }
  return Math.floor(((twin - ours) * 1000) / twin) / 10;
}

export interface PayloadReduction {
  readonly url: string;
  readonly raw: number;
  readonly gzip: number;
}

export function payloadReductions(input: {
  readonly pages: readonly { readonly url: string; readonly total: PayloadBytes }[];
  readonly twin: Readonly<Record<string, { readonly raw: number; readonly gzip: number }>>;
}): readonly PayloadReduction[] {
  accountForUrls(
    "Payload reduction",
    Object.keys(input.twin),
    input.pages.map((one) => one.url),
  );
  return input.pages.map((page) => {
    const twin = input.twin[page.url] as { raw: number; gzip: number };
    return {
      url: page.url,
      raw: reductionPercent(twin.raw, page.total.raw),
      gzip: reductionPercent(twin.gzip, page.total.gzip),
    };
  });
}

export interface PayloadBytes {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
}

// Summed per chunk, not compressed as one: a browser fetches them separately.
export function totalBytes(chunks: readonly PayloadBytes[]): PayloadBytes {
  return chunks.reduce<PayloadBytes>(
    (total, chunk) => ({
      raw: total.raw + chunk.raw,
      gzip: total.gzip + chunk.gzip,
      brotli: total.brotli + chunk.brotli,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );
}

export interface RuntimeSplit {
  readonly url: string;
  readonly react: PayloadBytes;
  readonly own: PayloadBytes;
}

export function runtimeSplit(input: {
  readonly url: string;
  readonly react: string;
  readonly chunks: readonly (PayloadBytes & { readonly path: string })[];
}): RuntimeSplit {
  const named = new RegExp(
    `/${input.react.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[\\w-]{8}\\.js$`,
  );
  const react = input.chunks.filter((chunk) => named.test(chunk.path));
  if (react.length !== 1) {
    const found =
      react.length === 0
        ? `no chunk named "${input.react}"`
        : `${String(react.length)} chunks named "${input.react}"`;
    throw new Error(
      `Runtime bytes "${input.url}": ${found} among the ${String(input.chunks.length)} this page loads (${input.chunks.map((chunk) => chunk.path).join(", ")}), so React's bytes cannot be told from the framework's — check that the measurement build's React group in packages/site/src/audit-site.ts still captures react, react-dom and scheduler`,
    );
  }
  return {
    url: input.url,
    react: totalBytes(react),
    own: totalBytes(input.chunks.filter((chunk) => !named.test(chunk.path))),
  };
}

export function emittedHashes(fileNames: readonly string[]): string[] {
  return fileNames.flatMap((name) => {
    const match = /-([\w-]{8})\.(?:js|css)$/.exec(name);
    return match === null ? [] : [match[1] as string];
  });
}

// Only the build's own hashes: a pattern would also rewrite `./polyfill-promises.js`.
export function normaliseAssetHashes(text: string, hashes: readonly string[]): string {
  let fixed = text;
  for (const hash of hashes) {
    fixed = fixed.replaceAll(`-${hash}.`, "-00000000.");
  }
  return fixed;
}

// Normalised because a renamed hash moved gzip by a byte with no script byte
// changed (#547).
export function hashInsensitiveGzip(bytes: Uint8Array, hashes: readonly string[]): number {
  const text = normaliseAssetHashes(Buffer.from(bytes).toString("utf8"), hashes);
  return gzipSync(text, { level: 9 }).byteLength;
}

export interface RuntimeCeiling {
  readonly raw: number;
  readonly gzip: number;
}

export function runtimeVerdict(input: {
  readonly split: RuntimeSplit;
  readonly ceiling: RuntimeCeiling;
}): AuditVerdict {
  const { url, own } = input.split;
  const assertions = [
    check(
      url,
      "framework-own bytes, raw",
      `<= ${String(input.ceiling.raw)}`,
      own.raw,
      own.raw <= input.ceiling.raw,
    ),
    check(
      url,
      "framework-own bytes, gzip",
      `<= ${String(input.ceiling.gzip)}`,
      own.gzip,
      own.gzip <= input.ceiling.gzip,
    ),
  ];
  return { assertions, failures: assertions.filter((one) => !one.ok) };
}
