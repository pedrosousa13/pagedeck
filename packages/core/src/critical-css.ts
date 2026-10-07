import { ConfigError } from "./exit.js";
import {
  matchingPattern,
  parsePatterns,
  patternMapFaultReport,
} from "./page-patterns.js";
import type { PageIdentity } from "./page-patterns.js";

export type CriticalCssMap = Readonly<Record<string, boolean>>;

const SHAPE_FIX = 'criticalCss: { "/landing/**": true }';
const FLAG_FIX =
  "write true to inline a page's stylesheets into its HTML, or false to leave it linking them";

export function criticalCssFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  return patternMapFaultReport({
    value,
    where,
    field: "build.criticalCss",
    shapeFix: SHAPE_FIX,
    rule: {
      fault: (flag) =>
        typeof flag === "boolean"
          ? undefined
          : // Despite its type, `JSON.stringify` returns `undefined` for
          // `undefined`, functions and symbols.
            (JSON.stringify(flag) ?? String(flag)),
      subject: [
        "declares % value that is not true or false",
        "declares % values that are not true or false",
      ],
      fix: FLAG_FIX,
      ambiguousFix:
        "make one of the pair more specific, or give both the same flag",
    },
  });
}

export function inlinedPages(
  criticalCss: CriticalCssMap,
  pages: readonly PageIdentity[],
): ReadonlySet<string> {
  const patterns = parsePatterns(Object.keys(criticalCss));
  const inlined = new Set<string>();
  for (const page of pages) {
    const winner = matchingPattern(patterns, page);
    if (winner === undefined) continue;
    if (criticalCss[winner.key] === true) {
      inlined.add(`${page.locale} ${page.path}`);
    }
  }
  return inlined;
}

/**
 * A parser closes `<style>` at `</style` alone, so no trailing `>` is matched.
 */
const CLOSING_STYLE = /<\/style/i;

const UNEMITTED_INLINE_FIX =
  "the inlined URL and the file name must be one spelling: see chunkPath in client-build.ts";
const CLOSING_STYLE_FIX =
  'remove the "</style" sequence from the stylesheet, or drop the page from build.criticalCss so the sheet is linked instead';

function positionOf(text: string, index: number): string {
  const before = text.slice(0, index);
  const lastBreak = before.lastIndexOf("\n");
  const line = before.split("\n").length;
  return `line ${String(line)}, column ${String(index - lastBreak)}`;
}

export function closingStylePosition(css: string): string | undefined {
  const match = CLOSING_STYLE.exec(css);
  return match === null ? undefined : positionOf(css, match.index);
}

export function inlineStyleElements(
  inlinedByPage: ReadonlyMap<string, readonly string[]>,
  cssByPath: ReadonlyMap<string, string>,
): Map<string, readonly string[]> {
  const unemitted: string[] = [];
  const closing: string[] = [];
  const tags = new Map<string, readonly string[]>();
  for (const [key, inlined] of inlinedByPage) {
    if (inlined.length === 0) continue;
    const elements: string[] = [];
    for (const href of inlined) {
      const css = cssByPath.get(href);
      if (css === undefined) {
        unemitted.push(`  "${href}" — inlined into ${key}, emitted by nothing`);
        continue;
      }
      const position = closingStylePosition(css);
      if (position !== undefined) {
        closing.push(
          `  "${href}" — inlined into ${key}, "</style" at ${position}`,
        );
        continue;
      }
      elements.push(`<style>${css}</style>`);
    }
    tags.set(key, elements);
  }

  const sections: string[] = [];
  if (unemitted.length > 0) {
    sections.push(
      `Critical CSS: ${String(unemitted.length)} ${
        unemitted.length === 1
          ? "inlined stylesheet was never emitted, so the page it is on would render unstyled"
          : "inlined stylesheets were never emitted, so the pages they are on would render unstyled"
      } — ${UNEMITTED_INLINE_FIX}:\n${unemitted.join("\n")}`,
    );
  }
  if (closing.length > 0) {
    sections.push(
      `Critical CSS: ${String(closing.length)} ${
        closing.length === 1
          ? 'stylesheet cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup'
          : 'stylesheets cannot be inlined because they hold "</style", which ends the element early and puts the rest of the sheet into the page as markup'
      } — ${CLOSING_STYLE_FIX}:\n${closing.join("\n")}`,
    );
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));
  return tags;
}
