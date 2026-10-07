import { join } from "node:path";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
  ISLAND_TEMPLATE_TAG,
} from "@pagedeck/islands";
import { ConfigError } from "./exit.js";
import type { BuildStamp } from "./manifest.js";
import {
  matchingPattern,
  parsePatterns,
  patternMapFaultReport,
} from "./page-patterns.js";
import type { PageIdentity } from "./page-patterns.js";

export type BudgetMap = Readonly<Record<string, string>>;

export type { PageIdentity };

export interface BudgetChunk {
  path: string;
  imports: readonly string[];
  bytes: number;
}

export interface BudgetStylesheet {
  path: string;
  bytes: number;
}

export interface BudgetChunkSpend {
  path: string;
  bytes: number;
}

export interface BudgetPageSpend {
  locale: string;
  path: string;
  pattern?: string;
  limitText?: string;
  limit?: number;
  actual: number;
  jsInlined: number;
  css: number;
  cssInlined: number;
  html: number;
  breach: boolean;
  chunks: readonly BudgetChunkSpend[];
  causes: readonly string[];
  largestIslandProps: number;
  islandPropsBreaches: readonly IslandPropsSpend[];
}

export interface IslandPropSpend {
  name: string;
  bytes: number;
}

export interface IslandPropsSpend {
  component: string;
  prefix: string;
  bytes: number;
  props: readonly IslandPropSpend[];
}

export interface PageIslandProps {
  largest: number;
  breaches: readonly IslandPropsSpend[];
}

export interface IslandPropsLimit {
  limitText: string;
  limit: number;
}

export interface IslandPropsBudget extends IslandPropsLimit {
  byPage: ReadonlyMap<string, PageIslandProps>;
}

export interface BudgetReport {
  version: 2;
  build: BuildStamp;
  islandPropsLimit: { limitText: string; limit: number };
  pages: readonly BudgetPageSpend[];
}

const BUDGET_REPORT_DIR = ".pagedeck";

const BUDGET_REPORT_FILE = "budget-report.json";

export function budgetReportPath(root: string): string {
  return join(root, BUDGET_REPORT_DIR, BUDGET_REPORT_FILE);
}

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
};

/** `kb` is 1024 bytes, matching the `1024 B` a failure message prints. */
function parseSize(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)$/i.exec(text.trim());
  if (match === null) return undefined;
  const unit = UNITS[(match[2] as string).toLowerCase()] as number;
  return Math.round(Number(match[1]) * unit);
}

const SIZE_FIX =
  'write a number and a unit, one of b, kb or mb, such as "15kb"';
const SHAPE_FIX = 'budget: { "/pricing": "15kb" }';

export function budgetFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  return patternMapFaultReport({
    value,
    where,
    field: "build.budget",
    shapeFix: SHAPE_FIX,
    rule: {
      fault: (limit) =>
        typeof limit !== "string"
          ? "not a string"
          : parseSize(limit) === undefined
            ? `"${limit}"`
            : undefined,
      subject: [
        "declares % limit that is not a size",
        "declares % limits that are not sizes",
      ],
      fix: SIZE_FIX,
      ambiguousFix:
        "make one of the pair more specific, or give both the same limit",
    },
  });
}

export const DEFAULT_ISLAND_PROPS_BUDGET = "3kb";

export function islandPropsBudgetFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  const quoted =
    typeof value !== "string"
      ? `${JSON.stringify(value)} — not a string`
      : parseSize(value) === undefined
        ? `"${value}"`
        : undefined;
  if (quoted === undefined) return undefined;
  return `${where}: "build.islandPropsBudget" is not a size — write a number and a unit, one of b, kb or mb, such as "4kb":\n  ${quoted}`;
}

export function islandPropsLimit(
  declared: string | undefined,
): IslandPropsLimit {
  const limitText = declared ?? DEFAULT_ISLAND_PROPS_BUDGET;
  return { limitText, limit: parseSize(limitText) ?? 0 };
}

const ISLAND_MARKER = new RegExp(
  `<${ISLAND_TAG}(?=[\\s/>])((?:[^>"]|"[^"]*")*)>`,
  "g",
);

// A stash's text holds no "<", so the first closing tag is its own.
const STASH = new RegExp(
  `<${ISLAND_TEMPLATE_TAG} ${ISLAND_TEMPLATE_ATTRIBUTE}="[^"]*">([^<]*)</${ISLAND_TEMPLATE_TAG}>`,
  "g",
);

/** The inverse of `escapeStash` in render.tsx. */
function unescapeStash(text: string): string {
  return text.replace(/&(?:lt|amp);/g, (entity) =>
    entity === "&lt;" ? "<" : "&",
  );
}

/**
 * A stashed slot's markers are text, escaped once more per stash they sit in,
 * so each stash is read back and scanned on its own.
 */
function markerTags(html: string): string[] {
  return [
    ...[...html.matchAll(ISLAND_MARKER)].map((match) => match[1] as string),
    ...[...html.matchAll(STASH)].flatMap((match) =>
      markerTags(unescapeStash(match[1] as string)),
    ),
  ];
}

function markerAttribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

/** Reverses React's attribute escaping, which is what the marker went through. */
function unescapeAttribute(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#x27);/g,
    (entity) => ATTRIBUTE_ENTITIES[entity] as string,
  );
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function topLevelProps(serialized: string): IslandPropSpend[] {
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  return Object.entries(parsed)
    .map(([name, value]) => ({
      name,
      bytes: utf8Bytes(JSON.stringify(value)),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/**
 * Read back off the document rather than taken from the render, so a page an
 * incremental build carries is weighed exactly as a rendered one.
 */
export function weighIslandProps(
  html: string,
  limit: number,
): PageIslandProps {
  let largest = 0;
  const breaches: IslandPropsSpend[] = [];
  for (const tag of markerTags(html)) {
    const serialized = unescapeAttribute(
      markerAttribute(tag, ISLAND_PROPS_ATTRIBUTE),
    );
    const bytes = utf8Bytes(serialized);
    largest = Math.max(largest, bytes);
    if (bytes <= limit) continue;
    breaches.push({
      component: unescapeAttribute(
        markerAttribute(tag, ISLAND_COMPONENT_ATTRIBUTE),
      ),
      prefix: markerAttribute(tag, ISLAND_PREFIX_ATTRIBUTE),
      bytes,
      props: topLevelProps(serialized),
    });
  }
  breaches.sort(
    (a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix),
  );
  return { largest, breaches };
}

export function planBudgets(input: {
  build: BuildStamp;
  islandProps: IslandPropsBudget;
  budget: BudgetMap;
  pages: readonly PageIdentity[];
  inlinedPages: ReadonlySet<string>;
  entryChunkByPage: ReadonlyMap<string, string>;
  eagerChunksByPage: ReadonlyMap<string, readonly string[]>;
  chunks: readonly BudgetChunk[];
  stylesheetsByPage: ReadonlyMap<string, readonly string[]>;
  inlinedStylesheetsByPage: ReadonlyMap<string, readonly string[]>;
  stylesheets: readonly BudgetStylesheet[];
  inlinedScriptBytesByPage: ReadonlyMap<string, number>;
  causesByPage: ReadonlyMap<string, readonly string[]>;
  htmlBytesByPage: ReadonlyMap<string, number>;
}): BudgetReport {
  const patterns = parsePatterns(Object.keys(input.budget));
  const byPath = new Map(input.chunks.map((chunk) => [chunk.path, chunk]));
  const stylesheetBytes = new Map(
    input.stylesheets.map((sheet) => [sheet.path, sheet.bytes]),
  );

  const pages: BudgetPageSpend[] = [];
  for (const page of input.pages) {
    const key = `${page.locale} ${page.path}`;
    const winner = matchingPattern(patterns, page);
    const props = input.islandProps.byPage.get(key);
    if (
      winner === undefined &&
      !input.inlinedPages.has(key) &&
      (props?.breaches.length ?? 0) === 0
    ) {
      continue;
    }
    const limitText =
      winner === undefined ? undefined : (input.budget[winner.key] as string);
    const limit =
      limitText === undefined ? undefined : (parseSize(limitText) ?? 0);
    const entry = input.entryChunkByPage.get(key);
    const chunks = reachedChunks(
      [
        ...(entry === undefined ? [] : [entry]),
        ...(input.eagerChunksByPage.get(key) ?? []),
      ],
      byPath,
    );
    const jsInlined = input.inlinedScriptBytesByPage.get(key) ?? 0;
    const actual =
      chunks.reduce((sum, chunk) => sum + chunk.bytes, 0) + jsInlined;
    // Deduped again here: `stageSite`'s union stops a duplicate `<link>`, this
    // stops one download being weighed twice.
    const weigh = (sheets: readonly string[] | undefined): number =>
      [...new Set(sheets ?? [])].reduce(
        (sum, href) => sum + (stylesheetBytes.get(href) ?? 0),
        0,
      );
    const css = weigh(input.stylesheetsByPage.get(key));
    const cssInlined = weigh(input.inlinedStylesheetsByPage.get(key));
    pages.push({
      locale: page.locale,
      path: page.path,
      ...(winner === undefined
        ? {}
        : {
            pattern: winner.key,
            limitText: limitText as string,
            limit: limit as number,
          }),
      actual,
      jsInlined,
      css,
      cssInlined,
      html: input.htmlBytesByPage.get(key) ?? 0,
      // CSS and the document are reported, never enforced (spec §9).
      breach: limit !== undefined && actual > limit,
      chunks,
      causes: input.causesByPage.get(key) ?? [],
      largestIslandProps: props?.largest ?? 0,
      islandPropsBreaches: props?.breaches ?? [],
    });
  }
  return {
    version: 2,
    build: input.build,
    islandPropsLimit: {
      limitText: input.islandProps.limitText,
      limit: input.islandProps.limit,
    },
    pages,
  };
}

function reachedChunks(
  roots: readonly string[],
  byPath: ReadonlyMap<string, BudgetChunk>,
): BudgetChunkSpend[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const next of byPath.get(path)?.imports ?? []) queue.push(next);
  }
  return [...seen]
    .map((path) => ({ path, bytes: byPath.get(path)?.bytes ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export function budgetReportJson(report: BudgetReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const TOP_CONTRIBUTORS = 3;

const BREACH_FIX =
  'ship fewer or smaller islands to each page, hydrate one on "visible" or "idle" instead of "load", or raise its limit in pagedeck.config.ts\'s build.budget';

export function checkBudgets(report: BudgetReport): void {
  const paragraphs = [
    javascriptBreaches(report),
    islandPropsBreaches(report),
  ].filter((paragraph) => paragraph !== undefined);
  if (paragraphs.length > 0) throw new ConfigError(paragraphs.join("\n\n"));
}

const ISLAND_PROPS_FIX =
  "or raise the limit in pagedeck.config.ts's build.islandPropsBudget";

function islandPropsBreaches(report: BudgetReport): string | undefined {
  const lines = report.pages.flatMap((page) =>
    page.islandPropsBreaches.map((island) => {
      const shown = island.props.slice(0, TOP_CONTRIBUTORS);
      const over =
        island.props.length === 0
          ? ""
          : `, over ${String(island.props.length)} top-level ${
              island.props.length === 1 ? "prop" : "props"
            }${
              shown.length < island.props.length
                ? `, the ${String(TOP_CONTRIBUTORS)} largest`
                : ""
            }`;
      return [
        `  ${page.locale} ${page.path} — "${island.component}" at prefix "${island.prefix}" carries ${String(
          island.bytes,
        )} B of props against a limit of ${String(
          report.islandPropsLimit.limit,
        )} B${over}${shown.length === 0 ? "" : ":"}`,
        ...shown.map(
          (prop) => `    ${JSON.stringify(prop.name)} — ${String(prop.bytes)} B`,
        ),
      ].join("\n");
    }),
  );
  if (lines.length === 0) return undefined;
  return lines.length === 1
    ? `Island props budget: 1 island carries more props in its marker than the limit allows — pass the island only the fields it renders, ${ISLAND_PROPS_FIX}:\n${lines.join("\n")}`
    : `Island props budget: ${String(lines.length)} islands carry more props in their markers than the limit allows — pass each island only the fields it renders, ${ISLAND_PROPS_FIX}:\n${lines.join("\n")}`;
}

function javascriptBreaches(report: BudgetReport): string | undefined {
  const breaches = report.pages.filter(
    (page): page is BudgetPageSpend & { pattern: string; limit: number } =>
      page.breach,
  );
  if (breaches.length === 0) return undefined;
  const lines = breaches.map((page) => {
    const shown = page.chunks.slice(0, TOP_CONTRIBUTORS);
    const chunkBytes = page.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
    const overChunks = `over ${String(page.chunks.length)} ${
      page.chunks.length === 1 ? "chunk" : "chunks"
    }${
      shown.length < page.chunks.length
        ? `, the ${String(TOP_CONTRIBUTORS)} largest`
        : ""
    }`;
    const spend =
      page.jsInlined === 0
        ? `the page transfers ${String(page.actual)} B ${overChunks}`
        : page.chunks.length === 0
          ? `the page transfers ${String(page.actual)} B, all of it inlined into its document`
          : `the page transfers ${String(page.actual)} B, ${String(
              chunkBytes,
            )} B of it ${overChunks} and ${String(
              page.jsInlined,
            )} B inlined into its document`;
    const head = `  ${page.locale} ${page.path} — "${page.pattern}" allows ${String(
      page.limit,
    )} B, ${spend}:`;
    return [
      head,
      ...shown.map((chunk) => `    ${chunk.path} — ${String(chunk.bytes)} B`),
      ...(page.jsInlined === 0
        ? []
        : [
            `    inlined into the document — ${String(page.jsInlined)} B`,
          ]),
      ...page.causes.map((cause) => `    ${cause}`),
    ].join("\n");
  });
  return `JavaScript budget: ${String(breaches.length)} ${
    breaches.length === 1
      ? "page transfers more JavaScript for first render than its budget allows"
      : "pages transfer more JavaScript for first render than their budget allows"
  } — ${BREACH_FIX}:\n${lines.join("\n")}`;
}
