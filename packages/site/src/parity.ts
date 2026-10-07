import { ConfigError, redactTarget } from "@pagedeck/core";
import { JSDOM } from "jsdom";
import type { ParsedNode } from "jsdom";

export interface Heading {
  readonly level: number;
  readonly text: string;
}

export type PageField =
  | "status"
  | "lang"
  | "title"
  | "metaDescription"
  | "canonical"
  | "alternates"
  | "headings"
  | "internalHrefs"
  | "text";

export type ParityField = PageField | "redirect";

export interface PageFacts {
  readonly url: string;
  readonly status: number;
  readonly lang: string | undefined;
  readonly title: string | undefined;
  readonly metaDescription: string | undefined;
  readonly canonical: string | undefined;
  readonly alternates: Readonly<Record<string, string>>;
  readonly headings: readonly Heading[];
  readonly internalHrefs: readonly string[];
  readonly text: string;
}

export interface RedirectFact {
  readonly from: string;
  readonly to: string;
  readonly status: number;
}

export type BaselineOrigin =
  | {
      readonly kind: "captured";
      readonly from: string;
      readonly at: string;
    }
  | {
      readonly kind: "declared";
      readonly why: string;
    };

export interface ParityBaseline {
  readonly origin: BaselineOrigin;
  readonly pages: readonly PageFacts[];
  readonly redirects: readonly RedirectFact[];
}

export interface BuiltSite {
  readonly pages: readonly PageFacts[];
  readonly redirects: readonly RedirectFact[];
}

export interface ExpectationRule {
  readonly url?: string;
  readonly field: ParityField;
  readonly why: string;
  readonly baselineOnly?: readonly string[];
  readonly builtOnly?: readonly string[];
}

export interface Difference {
  readonly url: string;
  readonly field: ParityField;
  readonly baseline: string;
  readonly built: string;
}

export interface ExplainedDifference extends Difference {
  readonly why: string;
}

export interface PageVerdict {
  readonly url: string;
  readonly defects: readonly Difference[];
  readonly expected: readonly ExplainedDifference[];
}

export interface RedirectVerdict {
  readonly from: string;
  readonly outcome: "same" | "differs" | "missing" | "unexpected";
  readonly baseline?: RedirectFact;
  readonly built?: RedirectFact;
}

export interface ParityCoverage {
  readonly baselineUrls: number;
  readonly builtUrls: number;
  readonly compared: number;
  readonly missingFromBuild: readonly string[];
  readonly newInBuild: readonly string[];
}

export interface ParityReport {
  readonly baselineOrigin: BaselineOrigin;
  readonly coverage: ParityCoverage;
  readonly pages: readonly PageVerdict[];
  readonly redirects: readonly RedirectVerdict[];
  readonly defects: readonly Difference[];
  readonly expected: readonly ExplainedDifference[];
  readonly stale: readonly ExpectationRule[];
}

export interface ParityComparison {
  readonly baseline: ParityBaseline;
  readonly built: BuiltSite;
  readonly rules?: readonly ExpectationRule[];
}

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function optional(text: string | null | undefined): string | undefined {
  const value = normalize(text);
  return value === "" ? undefined : value;
}

const TEXT_NODE = 3;

const COMMENT_NODE = 8;

// Not `textContent`, which joins across element boundaries. Text either side of a
// comment joins with no space: React writes `<!-- -->` between adjacent text (#331).
function visibleText(node: ParsedNode, into: string[]): string[] {
  let run = "";
  const flush = (): void => {
    const text = normalize(run);
    if (text !== "") into.push(text);
    run = "";
  };
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) run += child.nodeValue ?? "";
    else if (child.nodeType !== COMMENT_NODE) {
      flush();
      visibleText(child, into);
    }
  }
  flush();
  return into;
}

function isInternal(href: string): boolean {
  if (href.startsWith("//")) return false;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

export function pageFacts(url: string, status: number, html: string): PageFacts {
  const document = new JSDOM(html).window.document;

  // A static copy of the list, so removing as we go is safe.
  for (const element of [...document.querySelectorAll("script, style")]) {
    element.remove();
  }

  const alternates: Record<string, string> = {};
  for (const link of document.querySelectorAll("link[rel=alternate]")) {
    const hreflang = link.getAttribute("hreflang");
    const href = link.getAttribute("href");
    if (hreflang === null || href === null) continue;
    alternates[hreflang] = href;
  }

  const headings: Heading[] = [];
  for (const heading of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    headings.push({
      level: Number(heading.tagName.slice(1)),
      text: normalize(heading.textContent),
    });
  }

  const hrefs = new Set<string>();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (href === null || !isInternal(href)) continue;
    hrefs.add(href);
  }

  return {
    url,
    status,
    lang: optional(document.documentElement.getAttribute("lang")),
    title: optional(document.querySelector("title")?.textContent),
    metaDescription: optional(
      document.querySelector("meta[name=description]")?.getAttribute("content"),
    ),
    canonical: optional(
      document.querySelector("link[rel=canonical]")?.getAttribute("href"),
    ),
    alternates,
    headings,
    internalHrefs: [...hrefs].sort(),
    text: document.body === null ? "" : visibleText(document.body, []).join(" "),
  };
}

export function redactOrigin(origin: string): string {
  return redactTarget(origin).replace(/\/+$/, "");
}

function show(value: unknown): string {
  if (value === undefined) return "absent";
  return typeof value === "string" ? value : JSON.stringify(value);
}

const PAGE_FIELDS: readonly PageField[] = [
  "status",
  "lang",
  "title",
  "metaDescription",
  "canonical",
  "alternates",
  "headings",
  "internalHrefs",
  "text",
];

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

const FINER_FIELDS: Readonly<Partial<Record<ParityField, "list" | "span">>> = {
  internalHrefs: "list",
  headings: "list",
  text: "span",
  title: "span",
  metaDescription: "span",
  canonical: "span",
  lang: "span",
};

function isFiner(rule: ExpectationRule): boolean {
  return rule.baselineOnly !== undefined || rule.builtOnly !== undefined;
}

function ruleLine(rule: ExpectationRule): string {
  return `  "${rule.field}" — ${rule.url === undefined ? "on every page" : `on "${rule.url}"`}`;
}

// Checked up front, so a blank reason is refused even on a run with nothing for it
// to cover.
function checkRules(rules: readonly ExpectationRule[]): void {
  const paragraphs: string[] = [];
  const fault = (
    faulty: readonly ExpectationRule[],
    one: string,
    many: string,
    advice: string,
  ): void => {
    if (faulty.length === 0) return;
    paragraphs.push(
      `Parity expectation rules: ${String(faulty.length)} ${faulty.length === 1 ? one : many} — ${advice}:\n${faulty.map(ruleLine).join("\n")}`,
    );
  };
  fault(
    rules.filter((rule) => rule.why.trim() === ""),
    "rule has no reason",
    "rules have no reason",
    "a rule with no reason is not a rule, it is a tolerance; say why each difference is expected, or delete the rule and let the difference be reported as a defect",
  );
  fault(
    rules.filter((rule) => isFiner(rule) && FINER_FIELDS[rule.field] === undefined),
    "rule names values in a field that has none",
    "rules name values in a field that has none",
    `only ${Object.keys(FINER_FIELDS).join(", ")} have values a rule can name; drop baselineOnly and builtOnly to excuse the whole field, and no rule reaches a page or a redirect one side lacks`,
  );
  fault(
    rules.filter(
      (rule) =>
        isFiner(rule) &&
        (rule.baselineOnly?.length ?? 0) + (rule.builtOnly?.length ?? 0) === 0,
    ),
    "rule names no values",
    "rules name no values",
    "an empty baselineOnly or builtOnly makes a rule that excuses nothing and can never be reported stale; name the values, or drop both lists to excuse the whole field",
  );
  fault(
    rules.filter((rule) =>
      [...(rule.baselineOnly ?? []), ...(rule.builtOnly ?? [])].some(
        (value) => value.trim() === "",
      ),
    ),
    "rule names a blank value",
    "rules name a blank value",
    "a blank value names nothing, and as a span it would match every empty field; name the value, or delete it",
  );
  if (paragraphs.length === 0) return;
  throw new ConfigError(paragraphs.join("\n\n"));
}

function covers(rule: ExpectationRule, url: string, field: ParityField): boolean {
  return rule.field === field && (rule.url === undefined || rule.url === url);
}

type Side =
  | { readonly kind: "list"; readonly keys: string[]; readonly items: unknown[] }
  | { readonly kind: "span"; text: string };

function sideOf(field: PageField, value: unknown): Side {
  if (FINER_FIELDS[field] === "list") {
    const items = [...(value as readonly unknown[])];
    const keys = items.map((item) =>
      field === "headings"
        ? `h${String((item as Heading).level)} ${(item as Heading).text}`
        : (item as string),
    );
    return { kind: "list", keys, items };
  }
  return { kind: "span", text: (value as string | undefined) ?? "" };
}

function occurrences(side: Side, value: string): number {
  if (side.kind === "list") return side.keys.filter((key) => key === value).length;
  const text = ` ${side.text} `;
  const needle = ` ${value} `;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length - 1)) {
    count += 1;
  }
  return count;
}

function remove(side: Side, value: string): void {
  if (side.kind === "list") {
    const at = side.keys.indexOf(value);
    side.keys.splice(at, 1);
    side.items.splice(at, 1);
    return;
  }
  const text = ` ${side.text} `;
  const at = text.indexOf(` ${value} `);
  side.text = normalize(text.slice(0, at) + text.slice(at + value.length + 1));
}

function rest(side: Side): string {
  return side.kind === "list" ? show(side.items) : side.text;
}

function index(pages: readonly PageFacts[]): Map<string, PageFacts> {
  const byUrl = new Map<string, PageFacts>();
  for (const page of pages) {
    if (!byUrl.has(page.url)) byUrl.set(page.url, page);
  }
  return byUrl;
}

function duplicateLines(pages: readonly PageFacts[]): string[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    counts.set(page.url, (counts.get(page.url) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([url, count]) => `  "${url}" — ${String(count)} times`);
}

function checkDuplicates(
  baseline: readonly PageFacts[],
  built: readonly PageFacts[],
): void {
  const paragraphs = (
    [
      ["Parity baseline", duplicateLines(baseline)],
      ["Parity build", duplicateLines(built)],
    ] as const
  )
    .filter(([, lines]) => lines.length > 0)
    .map(
      ([side, lines]) =>
        `${side}: ${String(lines.length)} URL${lines.length === 1 ? " is" : "s are"} listed more than once — every URL on each side is compared, or recorded as missing from the other, exactly once, and a URL listed twice makes the coverage counts describe something other than the run:\n${lines.join("\n")}`,
    );
  if (paragraphs.length === 0) return;
  throw new ConfigError(paragraphs.join("\n\n"));
}

// A coverage failure goes to `defects` without consulting a rule: one site-wide
// `status` or `redirect` rule would otherwise excuse every missing page or redirect.
export function compareParity(input: ParityComparison): ParityReport {
  const { baseline, built } = input;
  const rules = input.rules ?? [];
  checkRules(rules);

  if (baseline.pages.length === 0) {
    const origin =
      baseline.origin.kind === "captured"
        ? `captured from "${redactOrigin(baseline.origin.from)}"`
        : "declared";
    throw new ConfigError(
      `Parity baseline (${origin}): holds no pages, so every comparison over it reports no differences because it compared nothing — capture one from an origin that serves the site, or declare the pages in packages/site/src/parity-baseline.ts`,
    );
  }

  checkDuplicates(baseline.pages, built.pages);
  const baselinePages = index(baseline.pages);
  const builtPages = index(built.pages);

  const defects: Difference[] = [];
  const expected: ExplainedDifference[] = [];
  const used = rules.map((rule) => ({
    whole: false,
    baselineOnly: (rule.baselineOnly ?? []).map(() => false),
    builtOnly: (rule.builtOnly ?? []).map(() => false),
  }));
  const record = (
    difference: Difference,
    values?: { readonly baseline: unknown; readonly built: unknown },
  ): void => {
    const { url, field } = difference;
    const whole = rules.findIndex((rule) => !isFiner(rule) && covers(rule, url, field));
    if (whole !== -1) {
      used[whole].whole = true;
      expected.push({ ...difference, why: rules[whole].why });
      return;
    }
    if (values === undefined || field === "redirect" || FINER_FIELDS[field] === undefined) {
      defects.push(difference);
      return;
    }
    const left = sideOf(field, values.baseline);
    const right = sideOf(field, values.built);
    let excusedAny = false;
    rules.forEach((rule, at) => {
      if (!isFiner(rule) || !covers(rule, url, field)) return;
      const take = (
        named: readonly string[] | undefined,
        from: Side,
        other: Side,
        marks: boolean[],
      ): string[] => {
        const taken: string[] = [];
        (named ?? []).forEach((value, position) => {
          if (occurrences(from, value) <= occurrences(other, value)) return;
          remove(from, value);
          taken.push(value);
          marks[position] = true;
        });
        return taken;
      };
      const fromBaseline = take(rule.baselineOnly, left, right, used[at].baselineOnly);
      const fromBuilt = take(rule.builtOnly, right, left, used[at].builtOnly);
      if (fromBaseline.length + fromBuilt.length === 0) return;
      excusedAny = true;
      expected.push({
        url,
        field,
        baseline: show(fromBaseline),
        built: show(fromBuilt),
        why: rule.why,
      });
    });
    if (!excusedAny) defects.push(difference);
    else if (rest(left) !== rest(right)) {
      defects.push({ url, field, baseline: rest(left), built: rest(right) });
    }
  };
  const coverageDefect = (difference: Difference): void => {
    defects.push(difference);
  };

  const verdicts: PageVerdict[] = [];
  const missingFromBuild: string[] = [];
  let compared = 0;

  for (const [url, want] of baselinePages) {
    const got = builtPages.get(url);
    if (got === undefined) {
      missingFromBuild.push(url);
      coverageDefect({
        url,
        field: "status",
        baseline: show(want.status),
        built: "absent",
      });
      continue;
    }
    compared += 1;
    const before = { defects: defects.length, expected: expected.length };
    for (const field of PAGE_FIELDS) {
      if (same(want[field], got[field])) continue;
      record(
        {
          url,
          field,
          baseline: show(want[field]),
          built: show(got[field]),
        },
        { baseline: want[field], built: got[field] },
      );
    }
    verdicts.push({
      url,
      defects: defects.slice(before.defects),
      expected: expected.slice(before.expected),
    });
  }

  const newInBuild: string[] = [];
  for (const url of builtPages.keys()) {
    if (baselinePages.has(url)) continue;
    newInBuild.push(url);
    const got = builtPages.get(url) as PageFacts;
    coverageDefect({
      url,
      field: "status",
      baseline: "absent",
      built: show(got.status),
    });
  }

  const redirects = compareRedirects(
    baseline.redirects,
    built.redirects,
    record,
    coverageDefect,
  );

  if (compared + missingFromBuild.length !== baseline.pages.length) {
    throw new ConfigError(
      `Parity baseline: ${String(baseline.pages.length)} pages accounted for ${String(compared + missingFromBuild.length)} — every baseline URL is compared or recorded as missing from the build, exactly once`,
    );
  }
  if (compared + newInBuild.length !== built.pages.length) {
    throw new ConfigError(
      `Parity build: ${String(built.pages.length)} pages accounted for ${String(compared + newInBuild.length)} — every built URL is compared or recorded as new in the build, exactly once`,
    );
  }

  return {
    baselineOrigin: baseline.origin,
    coverage: {
      baselineUrls: baseline.pages.length,
      builtUrls: built.pages.length,
      compared,
      missingFromBuild,
      newInBuild,
    },
    pages: verdicts,
    redirects,
    defects,
    expected,
    stale: rules.flatMap((rule, at): ExpectationRule[] => {
      const usage = used[at];
      if (!isFiner(rule)) return usage.whole ? [] : [rule];
      const unused = (
        named: readonly string[] | undefined,
        marks: readonly boolean[],
      ): readonly string[] | undefined =>
        named === undefined ? undefined : named.filter((_, position) => !marks[position]);
      const baselineOnly = unused(rule.baselineOnly, usage.baselineOnly);
      const builtOnly = unused(rule.builtOnly, usage.builtOnly);
      if ((baselineOnly?.length ?? 0) + (builtOnly?.length ?? 0) === 0) return [];
      const { baselineOnly: _baseline, builtOnly: _built, ...where } = rule;
      return [
        {
          ...where,
          ...(baselineOnly?.length ? { baselineOnly } : {}),
          ...(builtOnly?.length ? { builtOnly } : {}),
        },
      ];
    }),
  };
}

function compareRedirects(
  baseline: readonly RedirectFact[],
  built: readonly RedirectFact[],
  record: (difference: Difference) => void,
  coverageDefect: (difference: Difference) => void,
): readonly RedirectVerdict[] {
  const byFrom = new Map(built.map((rule) => [rule.from, rule]));
  const verdicts: RedirectVerdict[] = [];

  for (const want of baseline) {
    const got = byFrom.get(want.from);
    if (got === undefined) {
      verdicts.push({ from: want.from, outcome: "missing", baseline: want });
      coverageDefect({
        url: want.from,
        field: "redirect",
        baseline: show(want),
        built: "absent",
      });
      continue;
    }
    if (got.to === want.to && got.status === want.status) {
      verdicts.push({
        from: want.from,
        outcome: "same",
        baseline: want,
        built: got,
      });
      continue;
    }
    verdicts.push({
      from: want.from,
      outcome: "differs",
      baseline: want,
      built: got,
    });
    record({
      url: want.from,
      field: "redirect",
      baseline: show(want),
      built: show(got),
    });
  }

  const declared = new Set(baseline.map((rule) => rule.from));
  for (const got of built) {
    if (declared.has(got.from)) continue;
    verdicts.push({ from: got.from, outcome: "unexpected", built: got });
    coverageDefect({
      url: got.from,
      field: "redirect",
      baseline: "absent",
      built: show(got),
    });
  }

  return verdicts;
}
