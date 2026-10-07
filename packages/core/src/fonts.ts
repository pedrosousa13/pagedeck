import { escapeAttributeValue } from "./head.js";
import { patternFault } from "./page-patterns.js";
import { quote } from "./quote.js";

export interface FontMetrics {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly xHeight: number;
  readonly monospaceAdvance?: number;
}

export interface FontSubsetRequest {
  readonly family: string;
  readonly src: string;
  readonly unicodeRanges: readonly string[];
}

export interface FontSubsetResult {
  readonly bytes: Uint8Array;
  readonly metrics: FontMetrics;
}

export interface FontAdapter {
  readonly name: string;
  subset(
    request: FontSubsetRequest,
  ): FontSubsetResult | Promise<FontSubsetResult>;
}

const FONT_DISPLAY_VALUES = [
  "auto",
  "block",
  "swap",
  "fallback",
  "optional",
] as const;

type FontDisplay = (typeof FONT_DISPLAY_VALUES)[number];

const FONT_STYLE_VALUES = ["normal", "italic"] as const;

export interface FontFace {
  readonly family: string;
  readonly src: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly display: FontDisplay;
  readonly aboveFold?: boolean;
  readonly unicodeRanges: readonly string[];
  readonly fallback: readonly string[];
  readonly fallbackMetrics?: Readonly<Record<string, FontMetrics>>;
  readonly pages?: readonly string[];
}

export interface FontsSetting {
  readonly adapter: FontAdapter;
  readonly faces: readonly FontFace[];
}

export const WEB_SAFE_FALLBACK_METRICS: Readonly<Record<string, FontMetrics>> = {
  Arial: {
    unitsPerEm: 2048,
    ascent: 1854,
    descent: 434,
    lineGap: 67,
    xHeight: 1062,
  },
  Helvetica: {
    unitsPerEm: 2048,
    ascent: 1577,
    descent: 471,
    lineGap: 0,
    xHeight: 1071,
  },
  Georgia: {
    unitsPerEm: 2048,
    ascent: 1878,
    descent: 449,
    lineGap: 0,
    xHeight: 986,
  },
  "Times New Roman": {
    unitsPerEm: 2048,
    ascent: 1825,
    descent: 443,
    lineGap: 87,
    xHeight: 916,
  },
  "Courier New": {
    unitsPerEm: 2048,
    ascent: 1705,
    descent: 615,
    lineGap: 0,
    xHeight: 866,
    monospaceAdvance: 1229,
  },
};

const WEB_SAFE_FALLBACK_NAMES = Object.keys(WEB_SAFE_FALLBACK_METRICS);

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
]);

export function fallbackMetricsFor(
  family: string,
  overrides?: Readonly<Record<string, FontMetrics>>,
): FontMetrics | undefined {
  return overrides?.[family] ?? WEB_SAFE_FALLBACK_METRICS[family];
}

/** Backslash first, or the quote's escape would be escaped again. */
function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

const FONT_FORMATS: Readonly<Record<string, string>> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};
const FONT_MIME_TYPES: Readonly<Record<string, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

function extensionOf(href: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(href);
  return match?.[1]?.toLowerCase() ?? "";
}

export function fontFaceRule(face: FontFace, href: string): string {
  const format = FONT_FORMATS[extensionOf(href)];
  const src = `url("${escapeCssString(href)}")${format === undefined ? "" : ` format("${format}")`}`;
  return [
    "@font-face {",
    `  font-family: "${escapeCssString(face.family)}";`,
    `  src: ${src};`,
    `  font-weight: ${String(face.weight)};`,
    `  font-style: ${face.style};`,
    `  font-display: ${face.display};`,
    ...(face.unicodeRanges.length === 0
      ? []
      : [`  unicode-range: ${face.unicodeRanges.join(", ")};`]),
    "}",
  ].join("\n");
}

function toPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(4)}%`;
}

/**
 * `font-weight` and `font-style` are the web face's own: without them, the last
 * of two faces sharing a fallback family would govern both.
 */
export function fallbackFontFaceRule(input: {
  readonly family: string;
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly webFont: FontMetrics;
  readonly fallback: FontMetrics;
}): string {
  const { family, weight, style, webFont, fallback } = input;
  const sizeAdjust =
    webFont.monospaceAdvance !== undefined && fallback.monospaceAdvance !== undefined
      ? webFont.monospaceAdvance /
        webFont.unitsPerEm /
        (fallback.monospaceAdvance / fallback.unitsPerEm)
      : webFont.xHeight /
        webFont.unitsPerEm /
        (fallback.xHeight / fallback.unitsPerEm);
  // Divided by `sizeAdjust`: the browser scales overridden metrics by
  // `size-adjust` too.
  const override = (metric: number): string =>
    toPercent(metric / webFont.unitsPerEm / sizeAdjust);
  const quoted = escapeCssString(family);
  return [
    "@font-face {",
    `  font-family: "${quoted}";`,
    `  src: local("${quoted}");`,
    `  font-weight: ${String(weight)};`,
    `  font-style: ${style};`,
    `  size-adjust: ${toPercent(sizeAdjust)};`,
    `  ascent-override: ${override(webFont.ascent)};`,
    `  descent-override: ${override(webFont.descent)};`,
    `  line-gap-override: ${override(webFont.lineGap)};`,
    "}",
  ].join("\n");
}

/**
 * `crossorigin` is required: a font is fetched in CORS mode, and a preload
 * without it is fetched twice.
 */
export function fontPreloadLink(face: FontFace, href: string): string | undefined {
  if (face.aboveFold !== true) return undefined;
  const type = FONT_MIME_TYPES[extensionOf(href)];
  const typeAttr = type === undefined ? "" : ` type="${type}"`;
  return `<link rel="preload" href="${escapeAttributeValue(href)}" as="font"${typeAttr} crossorigin>`;
}

const FONTS_SHAPE_FIX =
  'fonts: { adapter: { name: "acme-subsetter", subset: (request) => ({ bytes, metrics }) }, faces: [{ family: "Acme Sans", src: "/site/fonts/acme-sans.ttf", weight: 400, style: "normal", display: "swap", unicodeRanges: ["U+0-10FFFF"], fallback: ["Georgia"] }] }';
const ADAPTER_NAME_FIX =
  'write the name this adapter is reported by, such as "acme-subsetter"';
const ADAPTER_SUBSET_FIX =
  "write the function this build hands one face's source and declared ranges to, as subset: (request) => ({ bytes, metrics })";
const FACE_FAMILY_FIX =
  'give the face its own family name, such as family: "Acme Sans"';
const FACE_SRC_FIX =
  'point src at the face\'s own source font file, such as src: "/site/fonts/acme-sans.ttf"';
const FALLBACK_METRICS_FIX = `declare "fallbackMetrics" for it, or use one of: ${WEB_SAFE_FALLBACK_NAMES.join(", ")}`;
const FACE_WEIGHT_FIX =
  "write the weight this face is selected by, as a number from 1 to 1000, such as weight: 400";
const FACE_STYLE_FIX = `write one of: ${FONT_STYLE_VALUES.join(", ")}`;
const FACE_DISPLAY_FIX = `write one of: ${FONT_DISPLAY_VALUES.join(", ")}`;
const MALFORMED_RANGE_FIX =
  'write each range as the CSS unicode-range grammar admits — a pair such as "U+0-10FFFF", a single codepoint such as "U+0041", or a trailing wildcard such as "U+4??"';
const FACE_PAGES_FIX =
  'write "pages" as a list of page patterns, each a path starting with "/" and optionally prefixed "<locale>:", such as pages: ["/features", "en:/blog/**"], or leave "pages" out to link the face on every page';

function pagesFaults(face: Record<string, unknown>, index: number): string[] {
  if (!Object.hasOwn(face, "pages") || face["pages"] === undefined) return [];
  const pages = face["pages"];
  const label = faceLabel(face, index);
  if (!Array.isArray(pages)) return [`  ${label} — ${quote(pages)} — not a list`];
  if (pages.length === 0) {
    return [`  ${label} — [] — an empty list, which links the face on no page`];
  }
  return (pages as readonly unknown[]).flatMap((key) => {
    if (typeof key !== "string") return [`  ${label} — ${quote(key)} — not a page pattern`];
    const fault = patternFault(key);
    return fault === undefined ? [] : [`  ${label} — ${quote(key)} — ${fault}`];
  });
}

function isMalformedUnicodeRange(range: string): boolean {
  const match = /^U\+([0-9A-Fa-f?]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/i.exec(range);
  if (match === null) return true;
  const first = match[1];
  const second = match[2];
  if (first === undefined) return true;
  if (second !== undefined) {
    if (first.includes("?")) return true;
    const start = Number.parseInt(first, 16);
    const end = Number.parseInt(second, 16);
    return start > end || end > 0x10ffff;
  }
  if (first.includes("?")) {
    return !/^[0-9A-Fa-f]*\?+$/i.test(first);
  }
  return Number.parseInt(first, 16) > 0x10ffff;
}

function adapterFaults(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`  "adapter" — ${quote(value)} — not an object — ${FONTS_SHAPE_FIX}`];
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const faults: string[] = [];
  const name = read("name");
  if (typeof name !== "string" || name.trim() === "") {
    faults.push(
      `  "adapter.name" — ${quote(name)} — not an adapter name — ${ADAPTER_NAME_FIX}`,
    );
  }
  if (typeof read("subset") !== "function") {
    faults.push(
      `  "adapter.subset" — ${quote(read("subset"))} — not a subset function — ${ADAPTER_SUBSET_FIX}`,
    );
  }
  return faults;
}

function faceLabel(face: Record<string, unknown>, index: number): string {
  const family = face["family"];
  return typeof family === "string" && family.trim() !== ""
    ? `faces[${String(index)}] (${JSON.stringify(family)})`
    : `faces[${String(index)}]`;
}

export function fontsFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.fonts" must be an object with an adapter and a list of faces — ${FONTS_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const sections: string[] = [];

  const adapterIssues = adapterFaults(read("adapter"));
  if (adapterIssues.length > 0) {
    sections.push(
      `${where}: "build.fonts.adapter" declares ${
        adapterIssues.length === 1
          ? "1 field this build cannot subset through"
          : `${String(adapterIssues.length)} fields this build cannot subset through`
      } — declare each as the type its own line names:\n${adapterIssues.join("\n")}`,
    );
  }

  const faces = read("faces");
  if (Array.isArray(faces)) {
    const entries = (faces as readonly unknown[]).flatMap((face, index) =>
      typeof face === "object" && face !== null && !Array.isArray(face)
        ? [{ face: face as Record<string, unknown>, index }]
        : [],
    );

    const missingFamily = entries.filter(
      ({ face }) =>
        typeof face["family"] !== "string" ||
        (face["family"] as string).trim() === "",
    );
    if (missingFamily.length > 0) {
      const lines = missingFamily
        .map(({ face, index }) => `  ${faceLabel(face, index)}`)
        .join("\n");
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          missingFamily.length === 1
            ? "1 face with no family"
            : `${String(missingFamily.length)} faces with no family`
        } — ${FACE_FAMILY_FIX}:\n${lines}`,
      );
    }

    const missingSrc = entries.filter(
      ({ face }) =>
        typeof face["src"] !== "string" || (face["src"] as string).trim() === "",
    );
    if (missingSrc.length > 0) {
      const lines = missingSrc
        .map(({ face, index }) => `  ${faceLabel(face, index)}`)
        .join("\n");
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          missingSrc.length === 1
            ? "1 face with no source path"
            : `${String(missingSrc.length)} faces with no source path`
        } — ${FACE_SRC_FIX}:\n${lines}`,
      );
    }

    const selectorFaults = entries.flatMap(({ face, index }) => {
      const lines: string[] = [];
      const weight = face["weight"];
      if (
        typeof weight !== "number" ||
        !Number.isFinite(weight) ||
        weight < 1 ||
        weight > 1000
      ) {
        lines.push(
          `  ${faceLabel(face, index)} — "weight" — ${quote(weight)} — not a font weight — ${FACE_WEIGHT_FIX}`,
        );
      }
      const style = face["style"];
      if (!FONT_STYLE_VALUES.some((value) => value === style)) {
        lines.push(
          `  ${faceLabel(face, index)} — "style" — ${quote(style)} — not a font style — ${FACE_STYLE_FIX}`,
        );
      }
      const display = face["display"];
      if (!FONT_DISPLAY_VALUES.some((value) => value === display)) {
        lines.push(
          `  ${faceLabel(face, index)} — "display" — ${quote(display)} — not a font-display value — ${FACE_DISPLAY_FIX}`,
        );
      }
      return lines;
    });
    if (selectorFaults.length > 0) {
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          selectorFaults.length === 1
            ? "1 face field this build cannot write a @font-face from"
            : `${String(selectorFaults.length)} face fields this build cannot write a @font-face from`
        } — declare each as the type its own line names:\n${selectorFaults.join("\n")}`,
      );
    }

    const unresolvedFallbacks = entries.flatMap(({ face, index }) => {
      const fallback = face["fallback"];
      if (!Array.isArray(fallback)) return [];
      const overrides =
        typeof face["fallbackMetrics"] === "object" && face["fallbackMetrics"] !== null
          ? (face["fallbackMetrics"] as Readonly<Record<string, FontMetrics>>)
          : undefined;
      return (fallback as readonly unknown[]).flatMap((family) => {
        if (typeof family !== "string") return [];
        if (GENERIC_FAMILIES.has(family.toLowerCase())) return [];
        if (fallbackMetricsFor(family, overrides) !== undefined) return [];
        return [`  ${faceLabel(face, index)} — ${quote(family)}`];
      });
    });
    if (unresolvedFallbacks.length > 0) {
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          unresolvedFallbacks.length === 1
            ? "1 fallback family with no metrics"
            : `${String(unresolvedFallbacks.length)} fallback families with no metrics`
        } — ${FALLBACK_METRICS_FIX}:\n${unresolvedFallbacks.join("\n")}`,
      );
    }

    const malformedRanges = entries.flatMap(({ face, index }) => {
      const ranges = face["unicodeRanges"];
      if (!Array.isArray(ranges)) return [];
      return (ranges as readonly unknown[]).flatMap((range) => {
        if (typeof range === "string" && !isMalformedUnicodeRange(range)) {
          return [];
        }
        return [`  ${faceLabel(face, index)} — ${quote(range)}`];
      });
    });
    if (malformedRanges.length > 0) {
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          malformedRanges.length === 1
            ? "1 malformed unicode range"
            : `${String(malformedRanges.length)} malformed unicode ranges`
        } — ${MALFORMED_RANGE_FIX}:\n${malformedRanges.join("\n")}`,
      );
    }

    const unreadablePages = entries.flatMap(({ face, index }) => pagesFaults(face, index));
    if (unreadablePages.length > 0) {
      sections.push(
        `${where}: "build.fonts.faces" declares ${
          unreadablePages.length === 1
            ? "1 page scope this build cannot read"
            : `${String(unreadablePages.length)} page scopes this build cannot read`
        } — ${FACE_PAGES_FIX}:\n${unreadablePages.join("\n")}`,
      );
    }
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}
