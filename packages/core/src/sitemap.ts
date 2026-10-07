import { pageLinks, variantUrl } from "./alternates.js";
import type { LocaleAlternate } from "./alternates.js";
import { ConfigError } from "./exit.js";
import { localeTree } from "./locales.js";
import type { LocaleSet, PlacedLocale } from "./locales.js";
import { collisionLines, fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import { canonicalizePath } from "./pages.js";
import type { Page } from "./pages.js";
import { quote } from "./quote.js";
import { escapeXml, XML_DECLARATION } from "./xml.js";

export type SitemapPattern = "suffix" | "directory";

export interface SitemapSetting {
  readonly pattern: SitemapPattern;
}

const SHAPE_FIX = 'sitemap: { pattern: "suffix" }';
const PATTERN_FIX =
  'write "suffix" for /sitemap-en.xml, or "directory" for /en/sitemap.xml';

export function sitemapFaultReport(
  value: unknown,
  origin: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.sitemap" must be an object naming the URL pattern its files take — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const pattern = Object.hasOwn(record, "pattern")
    ? record["pattern"]
    : undefined;
  const faults: string[] = [];
  if (pattern !== "suffix" && pattern !== "directory") {
    faults.push(
      `  "pattern" — ${quote(pattern)} — not a sitemap URL pattern — ${PATTERN_FIX}`,
    );
  }
  const sections: string[] = [];
  if (faults.length > 0) {
    sections.push(
      `${where}: "build.sitemap" declares ${String(faults.length)} ${
        faults.length === 1 ? "field" : "fields"
      } this build cannot write sitemaps from — declare each as the type its own line names:\n${faults.join("\n")}`,
    );
  }
  if (origin === undefined) {
    sections.push(
      `${where}: "build.sitemap" is declared without "build.origin", and every <loc> a sitemap holds is an absolute URL — declare origin: "https://example.com", or remove sitemap`,
    );
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

export interface SitemapInput {
  setting: SitemapSetting;
  origin: string;
  xDefault: string | undefined;
  locales: LocaleSet;
  pages: readonly Page[];
  alternates: ReadonlyMap<string, readonly LocaleAlternate[]>;
  emitted: readonly EmittedFile[];
  carried?: ReadonlyMap<string, EmittedFile>;
}

function collisionFix(pattern: SitemapPattern): string {
  const other = pattern === "suffix" ? "directory" : "suffix";
  return `move the page off that address, or declare the other URL pattern — sitemap: { pattern: "${other}" }`;
}

export function sitemapFiles(input: SitemapInput): readonly EmittedFile[] {
  const { setting, origin, xDefault, locales, pages, alternates } = input;

  const byLocale = new Map<string, Page[]>();
  for (const page of pages) {
    const rows = byLocale.get(page.locale) ?? [];
    byLocale.set(page.locale, rows);
    rows.push(page);
  }
  const trees = new Map<string | undefined, PlacedLocale[]>();
  for (const locale of locales.values()) {
    const key = localeTree(locale);
    const tree = trees.get(key) ?? [];
    trees.set(key, tree);
    tree.push(locale);
  }
  for (const tree of trees.values()) {
    tree.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }

  const files: EmittedFile[] = [];
  const domains = [...trees.keys()].sort((a, b) =>
    a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1,
  );
  for (const domain of domains) {
    const tree = trees.get(domain) ?? [];
    const locations: string[] = [];
    for (const locale of tree) {
      const path = sitemapPath(setting.pattern, locale.code);
      // Before the branch: a carried locale is named in the index like a
      // composed one.
      locations.push(
        variantUrl(origin, {
          ...(locale.domain === undefined
            ? {}
            : { declaredDomain: locale.domain }),
          output: path,
        }),
      );
      const kept = input.carried?.get(fileKey(domain, path));
      files.push(
        kept ?? {
          ...(domain === undefined ? {} : { domain }),
          path,
          kind: "asset",
          contents: urlsetXml({
            origin,
            xDefault,
            alternates,
            rows: byLocale.get(locale.code) ?? [],
          }),
        },
      );
    }
    files.push({
      ...(domain === undefined ? {} : { domain }),
      path: INDEX_PATH,
      kind: "asset",
      contents: indexXml(locations),
    });
  }

  const collisions = collisionLines(files, input.emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Sitemaps: ${String(collisions.length)} ${
        collisions.length === 1 ? "sitemap is" : "sitemaps are"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the sitemaps are; ${collisionFix(setting.pattern)}:\n${collisions.join("\n")}`,
    );
  }
  return files;
}

const INDEX_PATH = "/sitemap.xml";

export function sitemapIndexUrl(
  origin: string,
  declaredDomain: string | undefined,
): string {
  return variantUrl(origin, {
    ...(declaredDomain === undefined ? {} : { declaredDomain }),
    output: INDEX_PATH,
  });
}

export function sitemapPath(pattern: SitemapPattern, locale: string): string {
  return canonicalizePath(
    pattern === "suffix" ? `/sitemap-${locale}.xml` : `/${locale}/sitemap.xml`,
  );
}

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

function urlsetXml(input: {
  origin: string;
  xDefault: string | undefined;
  alternates: ReadonlyMap<string, readonly LocaleAlternate[]>;
  rows: readonly Page[];
}): string {
  const sorted = [...input.rows].sort((a, b) =>
    a.output < b.output ? -1 : a.output > b.output ? 1 : 0,
  );
  const entries = sorted.flatMap((page) => {
    const links = pageLinks({
      origin: input.origin,
      xDefault: input.xDefault,
      page,
      variants: input.alternates.get(page.path) ?? [],
    });
    if (links === undefined) return [];
    return [
      "<url>",
      `<loc>${escapeXml(links.canonical)}</loc>`,
      ...links.alternates.map(
        (link) =>
          `<xhtml:link rel="alternate" hreflang="${escapeXml(link.hreflang)}" href="${escapeXml(link.href)}"/>`,
      ),
      "</url>",
    ];
  });
  return `${XML_DECLARATION}
<urlset xmlns="${SITEMAP_NS}" xmlns:xhtml="${XHTML_NS}">
${entries.map((line) => `${line}\n`).join("")}</urlset>
`;
}

function indexXml(locations: readonly string[]): string {
  const entries = locations.flatMap((location) => [
    "<sitemap>",
    `<loc>${escapeXml(location)}</loc>`,
    "</sitemap>",
  ]);
  return `${XML_DECLARATION}
<sitemapindex xmlns="${SITEMAP_NS}">
${entries.map((line) => `${line}\n`).join("")}</sitemapindex>
`;
}
