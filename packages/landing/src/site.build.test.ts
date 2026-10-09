import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  budgetReportPath,
  DIAGNOSTIC_MARKER,
  readManifest,
  RETENTION_DIR,
  SECURITY_HEADERS,
} from "@pagedeck/core";
import type { Manifest, ManifestPage } from "@pagedeck/core";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { netlify } from "@pagedeck/adapter-netlify";
import { nginx } from "@pagedeck/adapter-nginx";
import { interpretCloudflarePages } from "../../adapter-cloudflare-pages/src/interpret.test-support.js";
import { interpretCloudFront } from "../../adapter-cloudfront/src/interpret.test-support.js";
import { interpretNetlify } from "../../adapter-netlify/src/interpret.test-support.js";
import { interpretNginx } from "../../adapter-nginx/src/interpret.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { colourFaults, pairFaults, readThemes } from "@pagedeck/brand";
import { createMarkdownRenderer, parseFrontmatter } from "@pagedeck/markdown-loader";
import { TWIN_PAYLOAD } from "@pagedeck/site/audit-site";
import { formatBytes, parseBytes, utf8Bytes } from "./bytes.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import { PRODUCT } from "./product.js";

const ADAPTERS = { "cloudfront-function": cloudfront(), netlify: netlify(), nginx: nginx() };

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const STORE = join(SITE, "content.db");
const RETAINED = join(SITE, RETENTION_DIR);

const CONTENT = "/";
const INTERACTIVE = "/interactive/";
const FEATURES = "/features/";
const SERVER_DATA = "/server-data/";

// Only a proxied instance writes a census row, which tells a proxy from a tree
// child. A scratch directory, because the file is appended to.
const CENSUS_DIR = mkdtempSync(join(tmpdir(), "pagedeck-landing-census-"));
const CENSUS = join(CENSUS_DIR, "census.jsonl");

// Restated: `BudgetReport` is internal to `@pagedeck/core`.
interface BudgetRow {
  locale: string;
  path: string;
  limitText?: string;
  limit?: number;
  actual: number;
  breach: boolean;
  chunks: readonly { path: string; bytes: number }[];
  largestIslandProps: number;
}

const BUDGET_REPORT = budgetReportPath(SITE);

// The limits are spelled again rather than imported, so a limit raised in
// `../site` to pass a regression fails here.
const PAGE_LIMIT = 60 * 1024;

// Every emitted `js` byte, lazy chunks included, which no budget row counts
// (AGENTS.md, "The landing site").
const BUILD_CEILING = 66 * 1024;

const FEATURES_LIMIT_TEXT = "62kb";
const FEATURES_LIMIT = 62 * 1024;

const SERVER_DATA_LIMIT_TEXT = "60kb";
const SERVER_DATA_LIMIT = 60 * 1024;

// The framework's default, spelled again so a default raised in core fails here.
const ISLAND_PROPS_LIMIT_TEXT = "3kb";
const ISLAND_PROPS_LIMIT = 3 * 1024;

const BIN = join(SITE, "..", "core", "dist", "bin.js");

// Only marked lines are faults (#184).
async function run(verb: string): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
    env: { ...process.env, PAGEDECK_PROXY_CENSUS: CENSUS },
  });
  const lines = stderr.split("\n");
  expect(
    lines.filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `)),
  ).toEqual([]);
}

function deployKey(url: string): string {
  return url.startsWith("/") ? url.slice(1) : url;
}

function assetUrls(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g),
  ].map((match) => deployKey(match[1] as string));
}

// Drops stylesheets: `build.css` links one on every page, and the checks that
// read this list are about JavaScript.
function nonStyleAssetUrls(html: string): string[] {
  return assetUrls(html).filter((url) => !url.endsWith(".css"));
}

function modulePreloads(html: string): string[] {
  return [...html.matchAll(/<link rel="modulepreload" href="([^"]*)">/g)].map(
    (match) => deployKey(match[1] as string),
  );
}

// Escapes twice: once as the sheet writes the selector, then the result for
// `RegExp`, where an unescaped `.` or `[` compiles and silently mis-matches.
function selectorPattern(name: string): string {
  const selector = name.replace(/[^\w-]/g, (char) => `\\${char}`);
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches inside element tags only, so a tag quoted in a fenced block is not
// read as markup.
function classesOf(html: string): Set<string> {
  const names = new Set<string>();
  for (const [, attribute] of html.matchAll(
    /<[a-zA-Z][^>]*\sclass="([^"]*)"/g,
  )) {
    for (const name of (attribute as string).split(/\s+/)) {
      if (name !== "") names.add(name);
    }
  }
  return names;
}

function linkedCss(html: string): string {
  return assetUrls(html)
    .filter((url) => url.endsWith(".css"))
    .map((url) => readFileSync(join(OUT, url), "utf8"))
    .join("\n");
}

function jsFiles(): string[] {
  return manifest.files
    .filter((file) => file.kind === "js")
    .map((file) => deployKey(file.path));
}

// A substring match over content-hashed names can over-report an edge but never
// miss one, so this is a superset of the real closure.
function jsClosure(from: string): string[] {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = readFileSync(join(OUT, key), "utf8");
    for (const other of jsFiles()) {
      const name = other.slice(other.lastIndexOf("/") + 1);
      if (other !== key && text.includes(name)) queue.push(other);
    }
  }
  return [...seen].sort();
}

function document(output: string): string {
  return readFileSync(join(OUT, output, "index.html"), "utf8");
}

function page(path: string): ManifestPage {
  const found = manifest.pages.find((row) => row.path === path);
  if (found === undefined) {
    throw new Error(
      `Manifest: records no page ${path} — it holds ${manifest.pages
        .map((row) => row.path)
        .join(", ")}`,
    );
  }
  return found;
}

function spend(path: string): BudgetRow {
  const found = budget.pages.find((row) => row.path === path);
  if (found === undefined) {
    throw new Error(
      `Budget report: records no page ${path} — it holds ${budget.pages
        .map((row) => row.path)
        .join(", ")}`,
    );
  }
  return found;
}

let manifest: Manifest;
let budget: {
  islandPropsLimit: { limitText: string; limit: number };
  pages: readonly BudgetRow[];
};

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });
  rmSync(BUDGET_REPORT, { force: true });

  await run("sync");
  await run("build");

  manifest = readManifest(
    readFileSync(join(OUT, "manifest.json"), "utf8"),
    "manifest.json",
  );
  budget = JSON.parse(readFileSync(BUDGET_REPORT, "utf8")) as typeof budget;
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });
  rmSync(BUDGET_REPORT, { force: true });
  rmSync(CENSUS_DIR, { recursive: true, force: true });
});

test("the site is the four pages its claims need, and no more", () => {
  expect(manifest.pages.map((row) => row.path).sort()).toEqual([
    CONTENT,
    FEATURES,
    INTERACTIVE,
    SERVER_DATA,
  ]);
  expect(page(CONTENT).output).toBe(CONTENT);
  expect(page(INTERACTIVE).output).toBe(INTERACTIVE);
  expect(manifest.pages.every((row) => row.domain === undefined)).toBe(true);
  for (const row of manifest.pages) {
    expect(document(row.output)).toMatch(/<title>[^<]+<\/title>/);
  }
});

test("the content page is template-driven and the three others tree-driven, which is why one can be static", () => {
  const content = page(CONTENT);
  expect(content.template).toBe("landing_page");
  expect(content.entry).toBeDefined();
  expect(content.collection).toBe("pages");

  for (const path of [INTERACTIVE, FEATURES, SERVER_DATA]) {
    const tree = page(path);
    expect(tree.template, path).toBeUndefined();
    expect(tree.entry, path).toBeUndefined();
    expect(tree.collection, path).toBeUndefined();
  }
});

test("the content page ships 0 bytes of JavaScript, with the island page in the same build", () => {
  const html = document(page(CONTENT).output);
  expect(html).not.toContain("<script");
  expect(nonStyleAssetUrls(html)).toEqual([]);
  expect(modulePreloads(html)).toEqual([]);
  expect(page(CONTENT).entryChunk).toBeUndefined();
  expect(page(CONTENT).components).toEqual([]);

  const row = spend(CONTENT);
  expect(row.limitText).toBe("0b");
  expect(row.limit).toBe(0);
  expect(row.actual).toBe(0);
  expect(row.breach).toBe(false);
  expect(row.chunks).toEqual([]);
});

test("the island page carries exactly one island, server-rendered before any script", () => {
  const interactive = page(INTERACTIVE);
  expect(interactive.entryChunk).toBeDefined();
  expect(interactive.components.map((component) => component.name)).toEqual([
    "counter",
  ]);

  const html = document(interactive.output);
  expect(html).toContain('data-fw-component="counter"');
  expect(html).toContain('<button type="button">Press me</button>');
  expect(html).toContain("<output>");
  expect(html).toContain("Press me");

  const entry = deployKey(interactive.entryChunk as string);
  expect(nonStyleAssetUrls(html)).toEqual([entry, ...modulePreloads(html)]);
  expect(jsClosure(entry)).toEqual(expect.arrayContaining(modulePreloads(html)));
  expect(modulePreloads(html).some((key) => key.includes("/fw-core-"))).toBe(true);
});

test("the islands' cost is confined to the pages that asked for them", () => {
  expect(
    manifest.pages
      .filter((row) => row.entryChunk !== undefined)
      .map((row) => row.path)
      .sort(),
  ).toEqual([FEATURES, INTERACTIVE, SERVER_DATA]);

  const reached = new Set([
    ...jsClosure(deployKey(page(INTERACTIVE).entryChunk as string)),
    ...jsClosure(deployKey(page(FEATURES).entryChunk as string)),
    ...jsClosure(deployKey(page(SERVER_DATA).entryChunk as string)),
  ]);
  expect([...reached].sort()).toEqual(jsFiles().sort());

  const pinned = [
    [INTERACTIVE, "60kb", PAGE_LIMIT],
    [FEATURES, FEATURES_LIMIT_TEXT, FEATURES_LIMIT],
    [SERVER_DATA, SERVER_DATA_LIMIT_TEXT, SERVER_DATA_LIMIT],
  ] as const;
  for (const [path, text, limit] of pinned) {
    const row = spend(path);
    expect(row.limitText, path).toBe(text);
    expect(row.limit, path).toBe(limit);
    expect(row.breach, path).toBe(false);
    expect(row.actual, path).toBeLessThanOrEqual(limit);
    expect(row.actual, path).toBeGreaterThan(0);
  }

  // Compressed one file at a time, as a browser fetches them.
  const total = jsFiles().reduce(
    (bytes, key) =>
      bytes + brotliCompressSync(readFileSync(join(OUT, key))).byteLength,
    0,
  );
  expect(total).toBeLessThanOrEqual(BUILD_CEILING);
  expect(total).toBeGreaterThanOrEqual(spend(FEATURES).actual);
});

test("every file the manifest records is a file on disk", () => {
  const missing = manifest.files.filter(
    (file) => !existsSync(join(OUT, file.domain ?? "", file.path)),
  );
  expect(missing.map((file) => file.path)).toEqual([]);
  expect(manifest.files.length).toBeGreaterThan(0);
  expect([...new Set(manifest.files.map((file) => file.kind))].sort()).toEqual([
    "asset",
    "css",
    "html",
    "js",
  ]);
  expect(
    manifest.files
      .filter((file) => file.kind === "asset")
      .map((file) => file.path.replace(/\.[0-9a-f]{8}\./, ".<hash>."))
      .sort(),
  ).toEqual([
    "/.assetsignore",
    "/404.html",
    "/_headers",
    "/_redirects",
    "/embed/demo-embed.js",
    "/favicon.ico",
    "/fonts/fira-sans-400-normal.<hash>.woff2",
    "/images/features/stack-1280.webp",
    "/images/features/stack-320.webp",
    "/images/features/stack-640.webp",
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0000.json",
    "/social/en-features.<hash>.png",
  ]);
});

const CLASS_FIX =
  "bring the class within an @source of styles/global.css or give it a rule there, or stop writing it in the markup";

test("every class the emitted documents carry has a rule in the stylesheet they link", () => {
  const linked = new Set<string>();
  for (const row of manifest.pages) {
    const sheets = assetUrls(document(row.output)).filter((url) =>
      url.endsWith(".css"),
    );
    const fonts = sheets.filter((url) => url.startsWith("fonts/"));
    expect(fonts, row.path).toHaveLength(row.path === FEATURES ? 1 : 0);
    expect(sheets.slice(0, fonts.length), row.path).toEqual(fonts);
    const rest = sheets.slice(fonts.length);
    expect(rest, row.path).toHaveLength(1);
    linked.add(rest.join(" "));
  }
  expect([...linked]).toHaveLength(1);

  const faults: string[] = [];
  let checked = 0;
  for (const row of manifest.pages) {
    const html = document(row.output);
    const css = linkedCss(html);
    for (const name of classesOf(html)) {
      checked += 1;
      const rule = new RegExp(
        `(?<=(?:^|[{},])\\s*)\\.${selectorPattern(name)}(?![\\w-])\\s*(?:,[^{}]*)?\\{([^}]+)\\}`,
      ).exec(css);
      if (rule === null) {
        faults.push(
          `  ${row.path}: ${name} — no rule in the emitted stylesheet — ${CLASS_FIX}`,
        );
        continue;
      }
      const body = rule[1] as string;
      for (const [, variable] of body.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!css.includes(`${variable as string}:`)) {
          faults.push(
            `  ${row.path}: ${name} — {${body}} reaches ${variable as string}, which this sheet never defines — ${CLASS_FIX}`,
          );
        }
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThan(5);
});

const DOCS_ORIGIN = "https://docs.pagedeck.example";

const DOGFOOD_ORIGIN = "https://dogfood.example";

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

function landmarks(html: string): { before: string; main: string; after: string } {
  const open = html.indexOf("<main");
  const close = html.indexOf("</main>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return {
    before: html.slice(html.indexOf("<body"), open),
    main: html.slice(open, close),
    after: html.slice(close),
  };
}

test("the front page is a hero with its ruler and a section per block of its markdown, each labelled by its heading", () => {
  const html = document(page(CONTENT).output);
  const { main } = landmarks(html);

  expect(main.match(/<h1\b/g)).toHaveLength(1);
  const labelled = [...main.matchAll(/<section\b[^>]*\saria-labelledby="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  expect(labelled.length).toBe(4);
  for (const id of labelled) {
    expect(main, id).toContain(`<h2 id="${id}"`);
  }
  const layouts = [...main.matchAll(/<section\b[^>]*\sclass="fw-section fw-section--([\w-]+)"/g)].map(
    (match) => match[1],
  );
  expect(layouts).toEqual(["compare", "data", "closing", "sources"]);
  expect(main).toContain('<figure class="fw-ruler"');
  expect(sectionOf(main, "closing")).toMatch(/<h2\b[^>]*>[^<]*not on npm/);
});

function sectionOf(main: string, layout: string): string {
  return new RegExp(`<section\\b[^>]*fw-section--${layout}[\\s\\S]*?</section>`).exec(main)?.[0] ?? "";
}

function rulerRows(main: string): { name: string; value: string; share: number; note: string }[] {
  const ruler = /<figure class="fw-ruler"[\s\S]*?<\/figure>/.exec(main)?.[0] ?? "";
  return [...ruler.matchAll(/<li class="fw-ruler__row[^"]*">([\s\S]*?)<\/li>/g)].map((row) => {
    const part = (name: string) =>
      new RegExp(`<span class="fw-ruler__${name}"[^>]*>([\\s\\S]*?)</span>`).exec(row[1] as string)?.[1] ?? "";
    const share = /--share:\s*([\d.]+)/.exec(row[1] as string)?.[1];
    return { name: part("name"), value: part("value"), share: Number(share), note: part("note") };
  });
}

function pickerProps(): string {
  const props = /<fw-island\b[^>]*\sdata-fw-props="([^"]*)"/.exec(
    document(page(SERVER_DATA).output),
  )?.[1];
  expect(props).toBeDefined();
  return (props as string)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("the ruler's three figures are the measurements they name, drawn to one scale", () => {
  const { main } = landmarks(document(page(CONTENT).output));
  const rows = rulerRows(main);
  expect(rows.map((row) => row.name)).toEqual(["Next.js App Router", "Astro", "Pagedeck"]);
  expect(rows.map((row) => row.value)).toEqual([
    formatBytes(TWIN_PAYLOAD.content.gzip),
    formatBytes(0),
    formatBytes(spend(CONTENT).actual),
  ]);
  expect(research("2026-08-23-build-vs-adopt.md")).toContain(
    "Astro ships 0 bytes of JS and 0 script tags on a content-only page",
  );
  expect(research("2026-08-23-app-router-static-export.md")).toContain("133,120 bytes gzip");
  const largest = Math.max(...rows.map((row) => parseBytes(row.value)));
  for (const row of rows) {
    expect(row.share, row.name).toBeCloseTo(parseBytes(row.value) / largest, 4);
  }
  expect(rows[0]?.share).toBe(1);
  expect(rows[2]?.note).toContain("fails the build");
  expect(main).toMatch(/<figcaption[^>]*>JavaScript on a page with nothing interactive<\/figcaption>/);
});

test("the data section's figures are /server-data's, and the sources section says where every figure is from", () => {
  const { main } = landmarks(document(page(CONTENT).output));
  const whole = formatBytes(utf8Bytes(JSON.stringify(PRODUCT)));
  const sent = formatBytes(utf8Bytes(pickerProps()));
  const data = sectionOf(main, "data");
  expect(data).toContain(whole);
  expect(data).toContain(sent);
  expect(hrefsOf(data)).toContain(SERVER_DATA);

  const sources = sectionOf(main, "sources");
  expect(sources).toContain("build.budget");
  expect(sources).toContain("docs/research/2026-08-23-app-router-static-export.md");
  expect(sources).toContain(formatBytes(TWIN_PAYLOAD.content.raw));
  expect(sources).toContain("docs/research/2026-08-23-build-vs-adopt.md");
  expect(sources).toContain("docs/research/2026-08-23-astro-incremental-builds.md");
  expect(sources).toContain("docs/success-criteria.md");
  expect(sources).toContain("docs/specs/2026-08-23-framework-design.md");
  expect(hrefsOf(sources)).toContain(SERVER_DATA);
  expect(sources).toContain("shape of a CMS entry");
  const body = main.slice(0, main.indexOf("fw-section--sources"));
  expect(body).not.toContain("docs/research");
  expect(body).not.toContain("docs/success-criteria.md");
});

function research(name: string): string {
  return readFileSync(join(SITE, "..", "..", "docs", "research", name), "utf8");
}

function comparison(main: string): Map<string, Map<string, string>> {
  const rows = new Map<string, Map<string, string>>();
  for (const [, row] of sectionOf(main, "compare").matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row as string).matchAll(/<(t[hd])\b[^>]*\sdata-label="([^"]*)">([\s\S]*?)<\/\1>/g)];
    if (cells.length === 0) continue;
    rows.set(
      cells[0]?.[3] as string,
      new Map(cells.map((cell) => [cell[2] as string, cell[3] as string])),
    );
  }
  return rows;
}

test("the comparison names Next.js and Astro, and every cell of theirs is the research's", () => {
  const { main } = landmarks(document(page(CONTENT).output));
  const rows = comparison(main);
  const NEXT = "Next.js App Router";
  const ASTRO = "Astro";
  const OURS = "Pagedeck";
  const appRouter = research("2026-08-23-app-router-static-export.md");
  const adopt = research("2026-08-23-build-vs-adopt.md");
  const incremental = research("2026-08-23-astro-incremental-builds.md");
  const docs = (name: string) => readFileSync(join(SITE, "..", "..", "docs", name), "utf8");
  const criteria = docs("success-criteria.md");
  const spec = docs("specs/2026-08-23-framework-design.md");
  const scaling = docs("scaling-verification.md");
  const sources = sectionOf(main, "sources").replace(/\s+/g, " ");

  const measured = /\*\*([\d,]+) bytes of inlined RSC flight payload\*\*[^*]*\*\*([\d,]+) bytes of actual markup\*\*/.exec(appRouter);
  expect(measured).not.toBeNull();
  const [flight, markup] = [measured?.[1], measured?.[2]].map((figure) =>
    formatBytes(Number((figure as string).replace(/,/g, ""))),
  );

  const PINS: readonly (readonly [string, string, string, string, string])[] = [
    ["Page data in the HTML", NEXT, `${flight} flight payload on ${markup} of markup`, appRouter, "bytes of inlined RSC flight payload"],
    ["Page data in the HTML", ASTRO, "Island props only", adopt, "no serialized page blob"],
    ["Marking a component interactive", NEXT, "use client", appRouter, '`"use client"` boundaries as a first-class'],
    ["Marking a component interactive", ASTRO, "client:*", adopt, "a `client:` directive at each use"],
    ["Per-page JavaScript budgets", NEXT, "removed in 16.0", appRouter, "The JS bundle size metrics have been removed from `next build`"],
    ["Per-page JavaScript budgets", ASTRO, "Not built in", adopt, "Budgets and determinism become CI bolt-ons"],
    ["Rebuilding a static site after one edit", NEXT, "Every route", appRouter, "re-rendered all 5,003 routes"],
    ["Rebuilding a static site after one edit", ASTRO, "cacheKey", adopt, "needs a hand-written `cacheKey` per path"],
    ["Rebuilding a static site after one edit", ASTRO, "experimental", incremental, "behind `experimental.incrementalBuild`"],
    ["Rebuilding a static site after one edit", OURS, "Only the pages the edit touched", spec, "re-renders only those pages' HTML"],
    ["Rebuilding a static site after one edit", OURS, "Only the pages the edit touched", scaling, "the harness now spawns `pagedeck build --incremental`"],
    ["Deploying only changed files", NEXT, "Every HTML file changes on each build", appRouter, "The HTML and `.txt` files, however, are all rewritten."],
    ["Deploying only changed files", ASTRO, "With an external diff tool", adopt, "manifest-diff deploy on plain Astro works today"],
    ["Deploying only changed files", ASTRO, "byte-stable", adopt, "No-change rebuilds are byte-stable."],
    ["Deploying only changed files", OURS, "<code>pagedeck diff</code>", criteria, "incremental deploy published 1 file"],
    // The research measured a static export, so this cell rests on the page's own
    // sources note.
    ["Rendering on request", NEXT, "Yes", sources, "Next.js renders on request when it runs as a server"],
    ["Rendering on request", ASTRO, "Yes", incremental, "on-demand (SSR) routes"],
  ];
  for (const [row, column, says, source, sentence] of PINS) {
    expect(rows.get(row)?.get(column), `${row} / ${column}`).toContain(says);
    expect(source, `${row} / ${column}: its source`).toContain(sentence);
  }
  const pinned = new Set(PINS.map(([row, column]) => `${row} / ${column}`));
  for (const [row] of rows) {
    expect(pinned.has(`${row} / ${NEXT}`), `${row} / ${NEXT} has no pin`).toBe(true);
    expect(pinned.has(`${row} / ${ASTRO}`), `${row} / ${ASTRO} has no pin`).toBe(true);
  }

  expect(rows.size).toBeLessThanOrEqual(6);
  expect(rows.get("Page data in the HTML")?.get(OURS)).toBe(rows.get("Page data in the HTML")?.get(ASTRO));
  const declared = rows.get("Marking a component interactive");
  expect(declared?.get(OURS)).toBe(declared?.get(NEXT));
  expect(rows.get("Rendering on request")?.get(OURS)).toContain("No");
});

test("no page prints a byte count of 1,000 or more in bytes", () => {
  for (const row of manifest.pages) {
    const { main } = landmarks(document(row.output));
    const text = main.replace(/<[^>]*>/g, " ");
    expect(text.match(/\b(?:\d{1,3}(?:,\d{3})+|\d{4,}) B\b/g), row.path).toBeNull();
  }
});

test("both pages declare a viewport and a description, so a phone and a crawler read them as written", () => {
  for (const row of manifest.pages) {
    const html = document(row.output);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.split('name="viewport"').length - 1, row.path).toBe(1);
    expect(head, row.path).toMatch(/<meta name="description" content="[^"]{50,}">/);
  }
});

test("the header and footer sit outside <main> on every page, and link the docs, the island page, the showcase and the server-data page", () => {
  for (const row of manifest.pages) {
    const { before, after } = landmarks(document(row.output));
    expect(before, row.path).toContain("<header");
    expect(after, row.path).toContain("<footer");
    const chrome = hrefsOf(before + after);
    expect(chrome, row.path).toContain("/");
    expect(chrome, row.path).toContain(INTERACTIVE);
    expect(hrefsOf(before), row.path).toContain(FEATURES);
    expect(hrefsOf(after), row.path).toContain(FEATURES);
    expect(hrefsOf(before), row.path).toContain(SERVER_DATA);
    expect(hrefsOf(after), row.path).toContain(SERVER_DATA);
    expect(
      chrome.some((href) => href.startsWith(`${DOCS_ORIGIN}/`)),
      row.path,
    ).toBe(true);
  }
});

test("the front page's call to action goes to the docs' first tutorial", () => {
  const { main } = landmarks(document(page(CONTENT).output));
  expect(hrefsOf(main)).toContain(`${DOCS_ORIGIN}/tutorials/your-first-site`);
});

test("the front page links the showcase from its own copy, not only from the header", () => {
  const { main } = landmarks(document(page(CONTENT).output));
  expect(hrefsOf(main)).toContain(FEATURES);
});

test("every link off this site goes to the docs placeholder, and the showcase's also to the dogfood site's", () => {
  for (const row of manifest.pages) {
    const allowed =
      row.path === FEATURES ? [DOCS_ORIGIN, DOGFOOD_ORIGIN] : [DOCS_ORIGIN];
    const external = hrefsOf(document(row.output)).filter((href) =>
      /^[a-z]+:/i.test(href),
    );
    expect(
      external.filter(
        (href) => !allowed.some((origin) => href.startsWith(`${origin}/`)),
      ),
      row.path,
    ).toEqual([]);
  }
});

test("every colour the stylesheet sets is a brand token", () => {
  const { checked, faults } = colourFaults(linkedCss(document(page(CONTENT).output)));
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThan(5);
});

test("the site serves an icon at /favicon.ico", () => {
  const icon = readFileSync(join(OUT, "favicon.ico"));
  expect([...icon.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  expect(icon.readUInt16LE(4)).toBeGreaterThan(0);
});

test("both documents declare English, which the comparison table's hyphenation needs", () => {
  for (const row of manifest.pages) {
    expect(document(row.output), row.path).toMatch(/<html lang="en"/);
  }
});

test("every text/background pair a rule sets is AA in both themes", () => {
  const { measured, faults } = pairFaults(
    linkedCss(document(page(CONTENT).output)),
    readThemes(readFileSync(join(SITE, "..", "brand", "brand.css"), "utf8")),
  );
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(measured.some((selector) => selector.includes(".fw-button:hover"))).toBe(true);
});

describe("/features", () => {
  const SECTIONS = [
    "islands",
    "search",
    "consent",
    "images",
    "fonts",
    "social-cards",
    "i18n",
  ];

  const DOCS: Record<string, string> = {
    islands: "reference/fold-strategy",
    search: "reference/site-search",
    consent: "reference/third-party-scripts",
    images: "reference/images",
    fonts: "reference/fonts",
    "social-cards": "reference/page-head",
    i18n: "reference/canonicals-and-hreflang",
  };

  const html = () => document(page(FEATURES).output);
  const main = () => landmarks(html()).main;

  function section(id: string): string {
    const body = main();
    const open = body.indexOf(`<section id="${id}"`);
    expect(open, id).toBeGreaterThan(-1);
    // The next feature's section: the consent banner renders a `<section>` of its
    // own.
    const next = body.indexOf('<section id="', open + 1);
    return body.slice(open, next === -1 ? undefined : next);
  }

  test("it has one labelled section per feature, in #551's order, under one <h1>", () => {
    expect(main().match(/<h1\b/g)).toHaveLength(1);
    const ids = [...main().matchAll(/<section id="([^"]+)" aria-labelledby="([^"]+)"/g)];
    expect(ids.map((match) => match[1])).toEqual(SECTIONS);
    for (const [, id, label] of ids) {
      expect(main(), id).toContain(`<h2 id="${label as string}"`);
    }
  });

  test("each section links its docs page, and every page it links exists in packages/docs", () => {
    for (const id of SECTIONS) {
      const docs = hrefsOf(section(id)).filter((href) =>
        href.startsWith(`${DOCS_ORIGIN}/`),
      );
      const expected = DOCS[id];
      expect(docs.map((href) => href.split("#")[0]), id).toEqual([
        `${DOCS_ORIGIN}/${expected}`,
      ]);
      expect(
        existsSync(join(SITE, "..", "docs", `${expected}.md`)),
        expected,
      ).toBe(true);
    }
  });

  // Fences are cut first: a heading inside one is text, and the renderer would
  // otherwise need the docs site's fence-language list.
  test("every docs link's #fragment names a heading on that docs page", async () => {
    const renderer = await createMarkdownRenderer({ languages: [] });
    const fragments = SECTIONS.flatMap((id) =>
      hrefsOf(section(id)).filter(
        (href) => href.startsWith(`${DOCS_ORIGIN}/`) && href.includes("#"),
      ),
    );
    expect(fragments.length).toBeGreaterThan(0);
    for (const href of fragments) {
      const [path, fragment] = href.slice(DOCS_ORIGIN.length + 1).split("#") as [string, string];
      const file = join(SITE, "..", "docs", `${path}.md`);
      const { body } = parseFrontmatter(readFileSync(file, "utf8"), file);
      const unfenced = body.replace(/^```[\s\S]*?^```/gm, "");
      const { toc } = await renderer.render(unfenced, file);
      expect(toc.map((entry) => entry.slug), href).toContain(fragment);
    }
  });

  test("the islands are the demos' and no others, each under the strategy it demonstrates", () => {
    expect(
      page(FEATURES)
        .components.map((component) => component.name)
        .sort(),
    ).toEqual([
      "consent_banner",
      "island_idle",
      "island_load",
      "island_visible",
      "search",
    ]);
    const modes = Object.fromEntries(
      [...html().matchAll(/data-fw-component="([^"]+)"[^>]*?data-fw-mode="([^"]+)"/g)].map(
        (match) => [match[1] as string, match[2] as string],
      ),
    );
    expect(modes).toMatchObject({
      island_load: "load",
      island_idle: "idle",
      island_visible: "visible",
      search: "idle",
    });
    const islands = section("islands");
    expect(islands).toContain('data-probe="static"');
    expect(islands).not.toMatch(/data-fw-component="static/);
  });

  test("the embed is a gated facade, mounted in its section, whose script is this site's own file", () => {
    const consent = section("consent");
    expect(consent).toMatch(/<div id="embed-demo"[^>]*>[\s\S]*data-fw-facade="[0-9a-f]{8}-0"/);
    expect(consent).toContain('data-fw-consent="denied"');
    expect(html()).toContain('"/embed/demo-embed.js"');
    expect(existsSync(join(OUT, "embed", "demo-embed.js"))).toBe(true);
  });

  test("the responsive image is served from this site's own files, one per width", () => {
    const images = section("images");
    const srcset = /srcSet="([^"]+)"|srcset="([^"]+)"/.exec(images);
    expect(srcset).not.toBeNull();
    const candidates = (srcset?.[1] ?? srcset?.[2] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+/));
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    for (const [url, descriptor] of candidates) {
      expect(url, url).toMatch(/^\/images\//);
      expect(descriptor, url).toMatch(/^\d+w$/);
      expect(existsSync(join(OUT, url as string)), url).toBe(true);
    }
    expect(images).toMatch(/\ssizes="[^"]+"/);
  });

  test("the image caption states the widths and formats the srcset actually offers", () => {
    const images = section("images");
    const srcset = (/srcset="([^"]+)"/i.exec(images)?.[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().split(/\s+/) as [string, string]);
    const fact = (label: string) =>
      new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`).exec(images)?.[1];
    expect(fact("widths")).toBe(srcset.map(([, width]) => width).join(", "));
    expect(fact("formats")).toBe(
      [...new Set(srcset.map(([url]) => url.slice(url.lastIndexOf(".") + 1)))].join(", "),
    );
  });

  test("the font demo's face is subset, declared and preloaded here, and no other page links or preloads it", () => {
    const fontSheets = assetUrls(html()).filter(
      (url) => url.startsWith("fonts/") && url.endsWith(".css"),
    );
    expect(fontSheets).toHaveLength(1);
    const sheet = readFileSync(join(OUT, fontSheets[0] as string), "utf8");
    expect(sheet).toMatch(/@font-face\s*\{[^}]*font-family:\s*"Fira Sans"[^}]*unicode-range:/);
    expect(section("fonts")).toContain('class="fw-specimen"');

    const subset = manifest.files.find((file) => /^\/fonts\/fira-sans-400-normal\./.test(file.path));
    expect(html()).toContain(
      `<link rel="preload" href="${String(subset?.path)}" as="font" type="font/woff2" crossorigin>`,
    );
    for (const row of manifest.pages) {
      if (row.path === FEATURES) continue;
      const other = document(row.output);
      expect(other, row.path).not.toMatch(/rel="preload"[^>]*as="font"/);
      expect(assetUrls(other).filter((url) => url.startsWith("fonts/")), row.path).toEqual([]);
    }
  });

  test("the showcase, and only the showcase, carries a drawn social card", () => {
    for (const row of manifest.pages) {
      const card = /<meta property="og:image" content="([^"]+)"/.exec(document(row.output));
      if (row.path !== FEATURES) {
        expect(card, row.path).toBeNull();
        continue;
      }
      expect(card?.[1]).toMatch(/^\/social\/[\w.-]+\.png$/);
      expect(existsSync(join(OUT, card?.[1] as string))).toBe(true);
    }
  });

  test("the social cards section shows this page's own card, the file its og:image names", () => {
    const og = /<meta property="og:image" content="([^"]+)"/.exec(html())?.[1];
    expect(og).toMatch(/^\/social\/[\w.-]+\.png$/);
    const img = /<img\b[^>]*>/.exec(section("social-cards"))?.[0] ?? "";
    expect(img).toContain(`src="${String(og)}"`);
    expect(img).toContain('width="1200"');
    expect(img).toContain('height="630"');
    expect(img).toContain('loading="lazy"');
    expect(img).toMatch(/alt="[^"]*Every feature, running on this page[^"]*"/);
    expect(existsSync(join(OUT, String(og)))).toBe(true);
  });

  test("the i18n section links the dogfood site's /en and /de pair", () => {
    const links = hrefsOf(section("i18n"));
    expect(links).toContain(`${DOGFOOD_ORIGIN}/en`);
    expect(links).toContain(`${DOGFOOD_ORIGIN}/de`);
  });

  test("nothing the document loads is on another origin", () => {
    const fetched = [
      ...html().matchAll(/<(?:script|img|link|source|iframe)\b[^>]*\s(?:src|href|srcset)="([^"]+)"/g),
    ].map((match) => match[1] as string);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.filter((url) => /^(?:[a-z]+:)?\/\//i.test(url))).toEqual([]);
  });
});

describe("/server-data", () => {
  const PICKER = "variant_picker";

  const SENTINEL = "SENTINEL-internal-notes-7c1e";

  const SHOWN = [
    "name",
    "tagline",
    "description.*.children.*.text",
    "specs.*.label",
    "specs.*.value",
    "sku",
    "variants.*.id",
    "variants.*.colour",
    "variants.*.size",
  ].map((path) => new RegExp(`^${path.replace(/\./g, "\\.").replace(/\*/g, "\\d+")}$`));

  const html = () => document(page(SERVER_DATA).output);

  function escaped(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  function marker(): { prefix: string; props: string } {
    const tags = [...html().matchAll(/<fw-island\b[^>]*>/g)].map((match) => match[0]);
    expect(tags).toHaveLength(1);
    const tag = tags[0] as string;
    expect(tag).toContain(`data-fw-component="${PICKER}"`);
    const prefix = /data-fw-prefix="([^"]*)"/.exec(tag)?.[1] ?? "";
    const props = (/data-fw-props="([^"]*)"/.exec(tag)?.[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    return { prefix, props };
  }

  function strings(value: unknown, path = ""): [string, string][] {
    if (typeof value === "string") return [[path, value]];
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) =>
      strings(child, path === "" ? key : `${path}.${key}`),
    );
  }

  function textFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return textFiles(path);
      return /\.(?:html|js|json|css|txt|xml)$/.test(entry.name) ? [path] : [];
    });
  }

  const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

  test("the entry is large and carries the sentinel, and no file the build wrote contains it", () => {
    expect(PRODUCT.editorial.internalNotes).toContain(SENTINEL);
    expect(utf8(JSON.stringify(PRODUCT))).toBeGreaterThanOrEqual(50 * 1024);
    const files = textFiles(OUT);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8").includes(SENTINEL), file).toBe(false);
    }
  });

  test("the island's props are in its marker, and they are only the fields it needs", () => {
    expect(page(SERVER_DATA).components.map((component) => component.name)).toEqual([PICKER]);
    const price = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: PRODUCT.price.currency,
    }).format(PRODUCT.price.amount / 100);
    expect(JSON.parse(marker().props)).toEqual({
      sku: PRODUCT.sku,
      price,
      variants: PRODUCT.variants.map(({ id, colour, size }) => ({ id, colour, size })),
    });
    expect(html()).toMatch(/<button type="submit"[^>]*>Add to cart<\/button>/);
  });

  test("the picker's props fit the default island props budget, and the whole entry would not", () => {
    expect(budget.islandPropsLimit).toEqual({
      limitText: ISLAND_PROPS_LIMIT_TEXT,
      limit: ISLAND_PROPS_LIMIT,
    });
    const row = spend(SERVER_DATA);
    expect(row.largestIslandProps).toBe(utf8(marker().props));
    expect(row.largestIslandProps).toBeLessThanOrEqual(ISLAND_PROPS_LIMIT);
    expect(utf8(JSON.stringify(PRODUCT))).toBeGreaterThan(ISLAND_PROPS_LIMIT);
  });

  test("no string field of the entry the page neither renders nor passes reaches the document", () => {
    const document = html();
    const all = strings(PRODUCT);
    const isShown = (path: string) => SHOWN.some((shown) => shown.test(path));
    // Short strings are skipped: "M" or "Slate" could appear in the page's own copy.
    const shownValues = new Set(all.filter(([path]) => isShown(path)).map(([, value]) => value));
    const hidden = all.filter(
      ([path, value]) => value.length >= 8 && !isShown(path) && !shownValues.has(value),
    );
    const leaked = hidden.filter(
      ([, value]) => document.includes(value) || document.includes(escaped(value)),
    );
    expect(leaked.map(([path]) => path)).toEqual([]);
    expect(hidden.length).toBeGreaterThan(200);
    const shown = all.filter(([path]) => /^description\.\d+\.children\.\d+\.text$/.test(path));
    expect(shown.length).toBeGreaterThan(0);
    for (const [path, value] of shown) {
      expect(document.includes(escaped(value)), path).toBe(true);
    }
  });

  test("the island is reached through a client-reference proxy, not as an entry-tree child", () => {
    const rows = readFileSync(CENSUS, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as {
        entry: string;
        component: string;
        renderedBy: string | null;
        prefix: string;
        refusedChildren: boolean;
      });
    expect(rows).toEqual([
      {
        entry: `/en${SERVER_DATA}`,
        component: PICKER,
        renderedBy: null,
        prefix: marker().prefix,
        refusedChildren: false,
      },
    ]);
  });

  test("the page states both sizes, and each is the size of what it names", () => {
    const figure = formatBytes;
    const whole = utf8(JSON.stringify(PRODUCT));
    const props = utf8(marker().props);
    const { main } = landmarks(html());
    expect(main).toContain(figure(whole));
    expect(main).toContain(figure(props));
    expect(props).toBeLessThan(whole / 10);
  });

  test("the page carries no page-level data: no inline script, one script naming its entry", () => {
    const document = html();
    expect(document).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page(SERVER_DATA).inlineScriptHashes ?? []).toEqual([]);
    expect(nonStyleAssetUrls(document)).toEqual([
      deployKey(page(SERVER_DATA).entryChunk as string),
      ...modulePreloads(document),
    ]);
  });
});

const SERVED_HEADERS = [
  ...SECURITY_HEADERS,
  { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  {
    name: "Permissions-Policy",
    value:
      "accelerometer=(), bluetooth=(), camera=(), display-capture=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()",
  },
  { name: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

test("the policy admits no inline <style> element and no form posting to another origin (#62)", () => {
  const directives = CONTENT_SECURITY_POLICY.split("; ").filter(
    (directive) => !directive.startsWith("script-src "),
  );
  expect(directives).toEqual([
    "default-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]);
});

test("no document holds a <style> element, so style-src needs no 'unsafe-inline' (#62)", () => {
  const documents = manifest.files.filter((file) => file.path.endsWith(".html"));
  expect(documents).not.toEqual([]);
  for (const file of documents) {
    expect(readFileSync(join(OUT, file.path), "utf8"), file.path).not.toMatch(/<style[\s>]/i);
  }
});

function edgeText(target: keyof typeof ADAPTERS, path: string): string {
  return (
    ADAPTERS[target].compile(manifest.routing).artifacts.find(
      (artifact) => artifact.path === path,
    )?.contents ?? ""
  );
}

test("the security headers and the policy are in the edge artifacts for every host", () => {
  const netlify = edgeText("netlify", "/_headers");
  const cloudfront = edgeText("cloudfront-function", "routing.response.js");
  const nginx = edgeText("nginx", "routing.conf");
  for (const { name, value } of SERVED_HEADERS) {
    expect(netlify).toContain(`  ${name}: ${value}\n`);
    expect(cloudfront).toContain(`{ name: "${name.toLowerCase()}", value: "${value}" }`);
    expect(nginx).toContain(`add_header "${name}" "${value}" always;`);
  }
});

test("the _headers the build wrote for Workers Static Assets carries every header of the set", () => {
  const written = readFileSync(join(OUT, "_headers"), "utf8");
  expect(written.startsWith("/*\n")).toBe(true);
  for (const { name, value } of SERVED_HEADERS) {
    expect(written).toContain(`  ${name}: ${value}\n`);
  }
});

const HASHED_DIRECTORIES = ["/assets/", "/fonts/", "/social/"];
const IMMUTABLE = { name: "Cache-Control", value: "public, max-age=31536000, immutable" };

test("the _headers the build wrote serves each hashed file immutable with nosniff, and every other file no Cache-Control", () => {
  const written = ["/_headers", "/_redirects"].map((path) => ({
    role: "tree-file" as const,
    path,
    contents: readFileSync(join(OUT, path), "utf8"),
  }));
  const hashed = (path: string) => HASHED_DIRECTORIES.some((prefix) => path.startsWith(prefix));
  for (const prefix of HASHED_DIRECTORIES) {
    expect(manifest.files.some((file) => file.path.startsWith(prefix)), prefix).toBe(true);
  }
  for (const file of manifest.files) {
    if (hashed(file.path)) {
      expect(file.path, "a file under an immutable prefix carries a content hash").toMatch(
        /[.-][A-Za-z0-9_-]{8}\.[a-z0-9]+$/,
      );
    }
    const expected = hashed(file.path) ? [...SECURITY_HEADERS, IMMUTABLE] : SERVED_HEADERS;
    expect(
      comparable(interpretCloudflarePages(written, { path: file.path, found: true })),
      file.path,
    ).toEqual(comparable({ kind: "pass", headers: expected }));
  }
});

test("the .assetsignore keeps the deploy manifest, the deploy directory and the adapter's fallback 404 out of the upload", () => {
  const ignored = readFileSync(join(OUT, ".assetsignore"), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  expect(ignored).toEqual(["/manifest.json", "/.pagedeck", "/404.html"]);
  const declared = manifest.routing.trees.filter((tree) => tree.notFound !== undefined);
  expect(
    declared.map((tree) => tree.notFound),
    "The landing page declares a 404 page, which core writes to /404.html, and public/.assetsignore drops /404.html from the upload — remove that line from public/.assetsignore and set not_found_handling to \"404-page\" in wrangler.jsonc (#52)",
  ).toEqual([]);
  const proxied = readFileSync(join(OUT, "_redirects"), "utf8");
  expect(proxied).toContain("/manifest.json /404.html 200\n");
});

test("every host sends the whole policy and every security header with every page", async () => {
  const compiled = (target: keyof typeof ADAPTERS) => ADAPTERS[target].compile(manifest.routing).artifacts;
  const cloudfront = compiled("cloudfront-function");
  const netlify = compiled("netlify");
  const nginx = compiled("nginx");
  const expected = comparable({ kind: "pass", headers: SERVED_HEADERS });
  for (const page of manifest.pages) {
    const request = { path: page.output, found: true };
    expect(comparable(resolveRequest(manifest.routing, request)), page.path).toEqual(expected);
    expect(comparable(await interpretCloudFront(cloudfront, request)), page.path).toEqual(expected);
    expect(comparable(interpretNetlify(netlify, request)), page.path).toEqual(expected);
    expect(comparable(interpretNginx(nginx, request)), page.path).toEqual(expected);
  }
});

test("every page's inline scripts are in the policy it is served with, and the policy lists no other", () => {
  const carried = new Set<string>();
  for (const page of manifest.pages) {
    const policy = servedPolicy(page);
    expect(policy, page.path).toBeDefined();
    const allowed = scriptSources(policy ?? "");
    for (const hash of page.inlineScriptHashes ?? []) {
      expect(allowed, `${page.path} carries ${hash}`).toContain(hash);
      carried.add(hash);
    }
  }
  expect(carried.size).toBeGreaterThan(0);
  const listed = scriptSources(CONTENT_SECURITY_POLICY).filter((source) =>
    source.startsWith("'sha256-"),
  );
  expect(new Set(listed)).toEqual(carried);
});

function servedPolicy(page: ManifestPage): string | undefined {
  const served = resolveRequest(manifest.routing, { path: page.output, found: true });
  return served.kind === "pass"
    ? served.headers.find((header) => header.name.toLowerCase() === "content-security-policy")
        ?.value
    : undefined;
}

function scriptSources(policy: string): readonly string[] {
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name === "script-src") return sources;
  }
  return [];
}
