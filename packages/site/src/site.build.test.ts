import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
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
import { interpretCloudFront } from "../../adapter-cloudfront/src/interpret.test-support.js";
import { interpretNetlify } from "../../adapter-netlify/src/interpret.test-support.js";
import { interpretNginx } from "../../adapter-nginx/src/interpret.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { resolveRequest } from "../../edge/src/oracle.test-support.js";
import { colourFaults, contrastRatio, pairFaults, readThemes } from "@pagedeck/brand";
import { safelist } from "@pagedeck/design-system";
import { CONTENT_SECURITY_POLICY } from "./csp.js";

const ADAPTERS = { "cloudfront-function": cloudfront(), netlify: netlify(), nginx: nginx() };

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const STORE = join(SITE, "content.db");
const RETAINED = join(SITE, RETENTION_DIR);

const EN_HOME = { locale: "en", path: "/" };
const DE_HOME = { locale: "de", path: "/" };
const TERMS = { locale: "en", path: "/legal/terms" };
const PRICING = { locale: "en", path: "/pricing" };

const CONTENT_PAGES = [EN_HOME, DE_HOME, TERMS];

// Declared here: `BudgetReport` is internal to `@pagedeck/core`.
interface BudgetRow {
  locale: string;
  path: string;
  limitText?: string;
  limit?: number;
  actual: number;
  jsInlined: number;
  breach: boolean;
  chunks: readonly { path: string; bytes: number }[];
}

const BUDGET_REPORT = budgetReportPath(SITE);

// Values `../site` declares are spelled again in this file, not read from it: a value
// quietly changed there has to fail something.
const PAGE_LIMIT = 60 * 1024;

// Every `js` file, the lazily-loaded `slot` chunk included, which no budget row
// charges. Derivation in AGENTS.md, "The site port".
const BUILD_CEILING = 61 * 1024;

// Run `pnpm build` first: the spawned `pagedeck` resolves `@pagedeck/site` to `dist`, so a bare
// `vitest run` tests the last build, not the working tree.
const BIN = join(SITE, "..", "core", "dist", "bin.js");

// A run that warns fails (#184), and `loadsOtherTools` asserts a third-party line
// survived. The marker's trailing space matters: this repo's plugins are named `pagedeck:…`.
async function run(
  verb: string,
  loadsOtherTools: boolean,
): Promise<void> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  const lines = stderr.split("\n");
  expect(
    lines.filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `)),
  ).toEqual([]);
  if (!loadsOtherTools) return;
  const passedThrough = lines.filter(
    (line) => line.trim() !== "" && !line.startsWith(DIAGNOSTIC_MARKER),
  );
  expect(passedThrough.length).toBeGreaterThan(0);
}

function deployKey(url: string): string {
  return url.startsWith("/") ? url.slice(1) : url;
}

// Drops URLs that name a host, not URLs lacking a leading `/`: a relative URL nothing
// recorded must still fail (#288).
function assetUrls(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g),
  ]
    .map((match) => match[1] as string)
    .filter((url) => !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url))
    .map(deployKey);
}

// The `fonts/` prefix, not an extension: the preload link names a `.woff2`.
function nonFontAssetUrls(html: string): string[] {
  return assetUrls(html).filter(
    (url) => !url.startsWith("fonts/") && !url.endsWith(".css"),
  );
}

// Escaped twice, once for the sheet's backslash and once for the regex. Both
// spellings compile, so a mistake is silent.
function selectorPattern(name: string): string {
  const selector = name.replace(/[^\w-]/g, (char) => `\\${char}`);
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// From elements, not a `class="…"` scan, which also reads escaped markup in text.
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

// An edge is another chunk's manifest name found in this one's text: it can
// over-report an edge, never miss one.
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

function page(id: { locale: string; path: string }): ManifestPage {
  const found = manifest.pages.find(
    (row) => row.locale === id.locale && row.path === id.path,
  );
  if (found === undefined) {
    throw new Error(
      `Manifest: records no page ${id.locale} ${id.path} — it holds ${manifest.pages
        .map((row) => `${row.locale} ${row.path}`)
        .join(", ")}`,
    );
  }
  return found;
}

function spend(id: { locale: string; path: string }): BudgetRow {
  const found = budget.pages.find(
    (row) => row.locale === id.locale && row.path === id.path,
  );
  if (found === undefined) {
    throw new Error(
      `Budget report: records no page ${id.locale} ${id.path} — it holds ${budget.pages
        .map((row) => `${row.locale} ${row.path}`)
        .join(", ")}`,
    );
  }
  return found;
}

let manifest: Manifest;
let budget: { pages: readonly BudgetRow[] };

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });
  rmSync(BUDGET_REPORT, { force: true });

  await run("sync", false);
  await run("build", true);

  manifest = readManifest(
    readFileSync(join(OUT, "manifest.json"), "utf8"),
    "manifest.json",
  );
  budget = JSON.parse(readFileSync(BUDGET_REPORT, "utf8")) as {
    pages: readonly BudgetRow[];
  };
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(STORE, { force: true });
  rmSync(RETAINED, { recursive: true, force: true });
  rmSync(BUDGET_REPORT, { force: true });
});

test("the site is the published entries, at the URLs their entry ids imply", () => {
  // Listed, not walked: a fifth page would mean the sync started selecting drafts.
  expect(
    manifest.pages.map((row) => `${row.locale} ${row.path}`).sort(),
  ).toEqual(["de /", "en /", "en /legal/terms", "en /pricing"]);

  expect(page(EN_HOME).output).toBe("/en");
  expect(page(DE_HOME).output).toBe("/de");
  expect(page(PRICING).output).toBe("/en/pricing");
  expect(manifest.pages.every((row) => row.domain === undefined)).toBe(true);

  // #161: `route: (entry) => [entry.path]` ships `/en/legal%2Fterms` with a green build.
  expect(page(TERMS).output).toBe("/en/legal/terms");
  expect(manifest.pages.some((row) => row.output.includes("%"))).toBe(false);
  expect(existsSync(join(OUT, "en", "legal", "terms", "index.html"))).toBe(
    true,
  );

  for (const row of manifest.pages) {
    expect(document(row.output)).toMatch(/<title>[^<]+<\/title>/);
  }

  for (const row of manifest.pages) {
    const descriptions = [
      ...document(row.output).matchAll(
        /<meta name="description" content="([^"]*)">/g,
      ),
    ].map((match) => (match[1] ?? "").trim());
    expect({ page: row.output, descriptions }).toEqual({
      page: row.output,
      descriptions: [expect.stringMatching(/\S/)],
    });
  }
});

test("the content pages ship 0 bytes of JavaScript, with the island page in the same build", () => {
  for (const id of CONTENT_PAGES) {
    const html = document(page(id).output);
    expect(html).not.toContain("<script");
    expect(nonFontAssetUrls(html)).toEqual([]);
    expect(page(id).entryChunk).toBeUndefined();
    expect(page(id).components).toEqual([]);

    const row = spend(id);
    expect(row.limitText).toBe("0b");
    expect(row.limit).toBe(0);
    expect(row.actual).toBe(0);
    expect(row.breach).toBe(false);
    expect(row.chunks).toEqual([]);
    expect(row.jsInlined).toBe(0);
  }
});

test("the interactive page carries exactly one island, server-rendered before any script", () => {
  const pricing = page(PRICING);
  expect(pricing.template).toBe("pricing_page");
  expect(pricing.entryChunk).toBeDefined();
  expect(pricing.components.map((component) => component.name)).toEqual([
    "pricing_page",
  ]);

  const html = document(pricing.output);
  expect(html).toContain('data-fw-component="pricing_page"');
  expect(html).toContain("Billed monthly");
  expect(html).toContain("<td>Starter</td>");

  expect(nonFontAssetUrls(html)).toEqual([deployKey(pricing.entryChunk as string)]);
});

test("the island's cost is confined to the page that asked for it", () => {
  const pricing = page(PRICING);

  expect(
    manifest.pages
      .filter((row) => row.entryChunk !== undefined)
      .map((row) => `${row.locale} ${row.path}`),
  ).toEqual(["en /pricing"]);

  expect(jsClosure(deployKey(pricing.entryChunk as string))).toEqual(
    jsFiles().sort(),
  );

  const row = spend(PRICING);
  expect(row.limitText).toBe("60kb");
  expect(row.limit).toBe(PAGE_LIMIT);
  expect(row.breach).toBe(false);
  expect(row.actual).toBeLessThanOrEqual(PAGE_LIMIT);
  expect(row.jsInlined).toBeGreaterThan(0);
  expect(row.actual).toBeGreaterThan(0);

  // Compressed one file at a time: a browser fetches them separately.
  const total = jsFiles().reduce(
    (bytes, key) =>
      bytes + brotliCompressSync(readFileSync(join(OUT, key))).byteLength,
    0,
  );
  expect(total).toBeLessThanOrEqual(BUILD_CEILING);
  // Against `actual` minus `jsInlined`: the inline loader is in no `js` file (#346).
  expect(total).toBeGreaterThanOrEqual(row.actual - row.jsInlined);
  expect(row.actual - row.jsInlined).toBe(
    row.chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0),
  );
});

const CMP_SRC = "https://consent.example/cmp.js";
const ANALYTICS_SRC = "https://analytics.example/analytics.js";

// Matched, not parsed: this looks for a tag the build wrote, not an address in one.
function scriptLoader(html: string): string | undefined {
  return /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
}

test("the pricing page carries the script layer, and the gated script waits for consent", () => {
  const html = document(page(PRICING).output);
  const loader = scriptLoader(html);
  expect(loader).toBeDefined();
  const text = loader as string;

  expect(html.match(/<script/g)).toHaveLength(2);

  expect(text).toContain(`load(["${CMP_SRC}"])`);
  expect(text).toContain('"requestIdleCallback" in window');
  expect(text).not.toContain("necessary");

  expect(text).toContain(`var gt=[["${ANALYTICS_SRC}","analytics",0]]`);
  expect(text).toContain("gate(gt[m],one)");
  expect(text).toContain('["pointerdown","keydown","wheel"]');

  expect(text).toContain('window["fwConsent"]');
  expect(text).toContain('"fw:consent"');

  // A second occurrence would be a path to the source that the gate is not on.
  expect(html.split(ANALYTICS_SRC)).toHaveLength(2);

  for (const id of CONTENT_PAGES) {
    const content = document(page(id).output);
    expect(content).not.toContain(CMP_SRC);
    expect(content).not.toContain(ANALYTICS_SRC);
  }
});

test("the entries' fields reach the components as the components spell them", () => {
  const home = document(page(EN_HOME).output);
  expect(home).toContain('href="/en/pricing"');
  expect(home).toContain(">See pricing</a>");
  expect(existsSync(join(OUT, "en", "pricing", "index.html"))).toBe(true);

  const terms = document(page(TERMS).output);
  expect(terms).toContain("<h1>Terms</h1>");
  expect(terms).toContain("<p>The terms.</p>");
});

test("every file the manifest records is a file on disk", () => {
  const missing = manifest.files.filter(
    (file) => !existsSync(join(OUT, file.domain ?? "", file.path)),
  );
  expect(missing.map((file) => file.path)).toEqual([]);
  expect(manifest.files.length).toBeGreaterThan(0);

  const recorded = new Set(manifest.files.map((file) => deployKey(file.path)));
  for (const row of manifest.pages) {
    for (const url of assetUrls(document(row.output))) {
      expect(recorded.has(url)).toBe(true);
      expect(existsSync(join(OUT, url))).toBe(true);
    }
  }

  expect([...new Set(manifest.files.map((file) => file.kind))].sort()).toEqual([
    "asset",
    "css",
    "html",
    "js",
  ]);
});

test("the site's declared redirects and headers reach the compiled edge artifacts", () => {
  expect(manifest.routing.trees.map((tree) => tree.domain)).toEqual([undefined]);

  const netlify = ADAPTERS["netlify"].compile(manifest.routing);

  const redirects = netlify.artifacts.find((one) => one.path === "/_redirects");
  expect(redirects?.role).toBe("tree-file");
  expect(redirects?.contents).toContain("/en/plans /en/pricing 301");
  expect(redirects?.contents).toContain("/en/terms /en/legal/terms 301");
  expect(existsSync(join(OUT, "en", "pricing", "index.html"))).toBe(true);
  expect(existsSync(join(OUT, "en", "legal", "terms", "index.html"))).toBe(true);

  const headers = netlify.artifacts.find((one) => one.path === "/_headers");
  expect(headers?.role).toBe("tree-file");
  expect(headers?.contents).toContain("X-Content-Type-Options: nosniff");
  expect(headers?.contents).toContain("X-Frame-Options: DENY");
  expect(headers?.contents).toContain(
    "Referrer-Policy: strict-origin-when-cross-origin",
  );

  const cloudfront = ADAPTERS["cloudfront-function"].compile(manifest.routing);
  expect(cloudfront.artifacts.every((one) => one.role !== "tree-file")).toBe(true);
  const viewer = cloudfront.artifacts.find(
    (one) => one.slot === "viewer-request",
  );
  expect(viewer?.contents).toContain("/en/plans");
  expect(viewer?.contents).toContain("/en/pricing");
});

// `srcSet` and `fetchPriority` camel-cased, as React writes them, so a React change
// to either fails a test.
const HERO = "/images/uploads/hero.jpg";

test("the home pages serve their hero through the site's own image adapter", () => {
  const en = document(page(EN_HOME).output);
  const de = document(page(DE_HOME).output);

  for (const html of [en, de]) {
    expect(html).toContain(`src="${HERO}-1280.webp"`);
    expect(html).toContain(
      `srcSet="${HERO}-320.webp 320w, ` +
        `${HERO}-640.webp 640w, ` +
        `${HERO}-1280.webp 1280w"`,
    );
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain('width="2400"');
    expect(html).toContain('height="1350"');
    expect(html).not.toContain("fieldtype");
    expect(html).not.toContain('/uploads/hero.jpg"');
  }

  expect(en).toContain('alt="A build finishing in a terminal"');
  expect(de).toContain('alt="Ein Build, der im Terminal fertig wird"');

  expect(en).toContain('loading="eager"');
  expect(en).toContain('fetchPriority="high"');
  expect(de).toContain('loading="lazy"');
  expect(de).toContain('fetchPriority="auto"');

  expect(en).toContain('<link rel="preload" as="image"');
  expect(de).not.toContain('as="image"');
});

// Attribute names matched in either case, each anchored on whitespace so `data-src=`
// is not read as `src`.
test("every image candidate on every page is a file this build wrote", () => {
  const attribute = (tag: string, name: string): string | undefined =>
    new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
  const candidatesOf = (list: string | undefined): string[] =>
    (list ?? "")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
      .filter((url) => url !== "");
  const faults: string[] = [];
  let candidates = 0;
  let preloaded = 0;
  for (const row of manifest.pages) {
    const html = document(row.output);
    const images = (html.match(/<img\b[^>]*>/g) ?? []).map((tag) => [
      ...candidatesOf(attribute(tag, "src")),
      ...candidatesOf(attribute(tag, "srcset")),
    ]);
    const preloads = (html.match(/<link\b[^>]*\sas="image"[^>]*>/g) ?? []).map(
      (tag) => [
        ...candidatesOf(attribute(tag, "href")),
        ...candidatesOf(attribute(tag, "imagesrcset")),
      ],
    );
    preloaded += preloads.flat().length;
    for (const url of [...images, ...preloads].flat()) {
      candidates += 1;
      const onDisk =
        /^\/(?!\/)/.test(url) && existsSync(join(OUT, decodeURI(url)));
      if (onDisk) continue;
      faults.push(`  ${row.locale} ${row.path}: ${url}`);
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  // The hero on each front page, a `src` and three candidates apiece, so this
  // cannot pass on a build that renders no image.
  expect(candidates).toBeGreaterThanOrEqual(8);
  expect(preloaded).toBeGreaterThan(0);
});

const ORIGIN = "https://dogfood.example";

// Written out per page, not derived from the route table, which would agree with
// the build whatever it said.
const HEAD_LINKS: readonly {
  id: { locale: string; path: string };
  canonical: string;
  alternates: readonly string[];
}[] = [
  {
    id: DE_HOME,
    canonical: `${ORIGIN}/de`,
    alternates: [`de ${ORIGIN}/de`, `en ${ORIGIN}/en`],
  },
  {
    id: EN_HOME,
    canonical: `${ORIGIN}/en`,
    alternates: [`de ${ORIGIN}/de`, `en ${ORIGIN}/en`],
  },
  { id: TERMS, canonical: `${ORIGIN}/en/legal/terms`, alternates: [] },
  { id: PRICING, canonical: `${ORIGIN}/en/pricing`, alternates: [] },
];

function alternateLinks(html: string): string[] {
  return [
    ...html.matchAll(
      /<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g,
    ),
  ].map((match) => `${match[1] as string} ${match[2] as string}`);
}

function canonicalLink(html: string): string {
  return /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1] ?? "";
}

test("every page canonicalizes to itself, and the two front pages annotate each other", () => {
  for (const { id, canonical, alternates } of HEAD_LINKS) {
    const html = document(page(id).output);
    expect(`${id.locale} ${id.path} ${canonicalLink(html)}`).toBe(
      `${id.locale} ${id.path} ${canonical}`,
    );
    expect(alternateLinks(html)).toEqual(alternates);
  }
});

const DESIGN_SYSTEM_SRC = join(SITE, "..", "design-system", "src");

test("every page declares one viewport, from the site's chrome and not the design system", () => {
  // React writes the void element self-closed; either spelling is the tag.
  const VIEWPORT = /<meta name="viewport" content="width=device-width, initial-scale=1"\/?>/g;
  for (const row of manifest.pages) {
    const html = document(row.output);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head.match(VIEWPORT)?.length ?? 0, row.path).toBe(1);
    expect(html.split('name="viewport"').length - 1, row.path).toBe(1);
  }
  const files = readdirSync(DESIGN_SYSTEM_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/name=["']viewport["']/);
  }
});

const CLASS_FIX =
  "bring the class within an @source of styles/global.css or give it a rule there, or drop it from the component that states it";

// A variable a matched rule uses without a fallback must be defined in the same
// sheet: Tailwind emits a theme variable only for the utilities it generated.
test("every class the emitted documents carry has a rule in the stylesheets they link", () => {
  const linked = new Set<string>();
  for (const row of manifest.pages) {
    const sheets = assetUrls(document(row.output)).filter((url) =>
      url.endsWith(".css"),
    );
    expect(sheets).toHaveLength(2);
    linked.add(sheets.sort().join(" "));
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
          `  ${row.locale} ${row.path}: ${name} — no rule in the emitted stylesheets — ${CLASS_FIX}`,
        );
        continue;
      }
      const body = rule[1] as string;
      for (const [, variable] of body.matchAll(/var\((--[\w-]+)\s*\)/g)) {
        if (!css.includes(`${variable as string}:`)) {
          faults.push(
            `  ${row.locale} ${row.path}: ${name} — {${body}} reaches ${variable as string}, which these sheets never define — ${CLASS_FIX}`,
          );
        }
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  // Fails when any one of the four pages stops being emitted: the smallest carries a
  // single class.
  expect(checked).toBeGreaterThan(15);
});

const BRAND_CSS = readFileSync(join(SITE, "..", "brand", "brand.css"), "utf8");

test("every colour the stylesheets set is a brand token", () => {
  const { checked, faults } = colourFaults(linkedCss(document(page(EN_HOME).output)));
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(checked).toBeGreaterThan(10);
});

test("every text/background pair a rule sets is AA in both themes", () => {
  const { measured, faults } = pairFaults(
    linkedCss(document(page(EN_HOME).output)),
    readThemes(BRAND_CSS),
  );
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
  expect(measured.some((selector) => selector.includes(".consent-banner__accept"))).toBe(true);
});

test("every class a design-system component states has a rule in the site's sheet", () => {
  const css = linkedCss(document(page(EN_HOME).output));
  const stated = Object.entries(safelist)
    .filter(([key]) => !key.includes("."))
    .flatMap(([, classes]) => classes);
  expect(stated.length).toBeGreaterThan(10);
  const missing = stated.filter(
    (name) =>
      !new RegExp(
        `(?<=(?:^|[{},])\\s*)\\.${selectorPattern(name)}(?![\\w-])\\s*(?:,[^{}]*)?\\{[^}]+\\}`,
      ).test(css),
  );
  expect(missing.map((name) => `  ${name} — ${CLASS_FIX}`)).toEqual([]);
});

test("the focus ring sits on a plate of the page ground, so it clears 3:1 on any fill", () => {
  const css = linkedCss(document(page(EN_HOME).output));
  const rules = [...css.matchAll(/(?:^|[{}])\s*:focus-visible\s*\{([^}]*)\}/g)].map(
    (match) => match[1] as string,
  );
  const plate = rules
    .map((body) => /box-shadow:\s*0 0 0 ([\d.]+)px var\(--fw-bg\)/.exec(body)?.[1])
    .find((width) => width !== undefined);
  expect(plate, "no :focus-visible rule sets a box-shadow plate in var(--fw-bg)").toBeDefined();
  const themes = readThemes(BRAND_CSS);
  const px = (token: string): number => Number.parseFloat(themes.light.resolved.get(token) as string);
  expect(Number(plate)).toBeGreaterThan(px("--fw-ring-offset") + px("--fw-ring-width"));
  for (const theme of [themes.light, themes.dark]) {
    expect(
      contrastRatio(theme.resolved.get("--fw-ring") as string, theme.resolved.get("--fw-bg") as string),
    ).toBeGreaterThanOrEqual(3);
  }
});

test("the site serves the brand's icon at /favicon.ico", () => {
  expect(readFileSync(join(OUT, "favicon.ico")).equals(
    readFileSync(join(SITE, "..", "brand", "favicon.ico")),
  )).toBe(true);
});

const SERVED_HEADERS = [
  ...SECURITY_HEADERS,
  { name: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
];

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

test("every host sends the whole policy and the three security headers with every page", async () => {
  const compiled = (target: keyof typeof ADAPTERS) => ADAPTERS[target].compile(manifest.routing).artifacts;
  const cloudfront = compiled("cloudfront-function");
  const netlify = compiled("netlify");
  const nginx = compiled("nginx");
  const expected = comparable({ kind: "pass", headers: SERVED_HEADERS });
  for (const row of manifest.pages) {
    const request = { path: row.output, found: true };
    expect(comparable(resolveRequest(manifest.routing, request)), row.output).toEqual(expected);
    expect(comparable(await interpretCloudFront(cloudfront, request)), row.output).toEqual(expected);
    expect(comparable(interpretNetlify(netlify, request)), row.output).toEqual(expected);
    expect(comparable(interpretNginx(nginx, request)), row.output).toEqual(expected);
  }
});

test("every page's inline scripts are in the policy it is served with, and the policy lists no other", () => {
  const carried = new Set<string>();
  for (const row of manifest.pages) {
    const policy = servedPolicy(row);
    expect(policy, row.output).toBeDefined();
    const allowed = directiveSources(policy ?? "", "script-src");
    for (const hash of row.inlineScriptHashes ?? []) {
      expect(allowed, `${row.output} carries ${hash}`).toContain(hash);
      carried.add(hash);
    }
  }
  expect(carried.size).toBeGreaterThan(0);
  const listed = directiveSources(CONTENT_SECURITY_POLICY, "script-src").filter((source) =>
    source.startsWith("'sha256-"),
  );
  expect(new Set(listed)).toEqual(carried);
});

test("the policy's script and image hosts are the origins the pages load from", () => {
  const origins = (text: string): string[] => text.match(/https?:\/\/[^\s"'/,?]+/g) ?? [];
  const scripts = new Set<string>();
  const images = new Set<string>();
  let imageTags = 0;
  for (const row of manifest.pages) {
    const html = document(row.output);
    for (const origin of origins(scriptLoader(html) ?? "")) scripts.add(origin);
    for (const tag of html.match(/<script[^>]*>/g) ?? []) {
      for (const origin of origins(tag)) scripts.add(origin);
    }
    for (const tag of html.match(/<img[^>]*>|<link[^>]*as="image"[^>]*>/g) ?? []) {
      imageTags += 1;
      for (const origin of origins(tag)) images.add(origin);
    }
  }
  const hosts = (directive: string) =>
    new Set(
      directiveSources(CONTENT_SECURITY_POLICY, directive).filter(
        (source) => !source.startsWith("'"),
      ),
    );
  expect(scripts.size).toBeGreaterThan(0);
  // Counted as tags: every image is this site's own file, so there are no image
  // origins to count.
  expect(imageTags).toBeGreaterThan(0);
  expect(hosts("script-src")).toEqual(scripts);
  expect(hosts("img-src")).toEqual(images);
});

function servedPolicy(row: ManifestPage): string | undefined {
  const served = resolveRequest(manifest.routing, { path: row.output, found: true });
  return served.kind === "pass"
    ? served.headers.find((header) => header.name.toLowerCase() === "content-security-policy")
        ?.value
    : undefined;
}

function directiveSources(policy: string, directive: string): readonly string[] {
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name === directive) return sources;
  }
  return [];
}
