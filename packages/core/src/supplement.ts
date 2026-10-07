import { closingStylePosition } from "./critical-css.js";
import type { DriftedPage, DriftReport } from "./drift.js";
import { ConfigError } from "./exit.js";
import { pageKey } from "./incremental.js";

export type SupplementCompiler = (
  classes: readonly string[],
) => string | Promise<string>;

export interface SupplementInput {
  report: DriftReport;
  compile?: SupplementCompiler;
}

export interface SupplementResult {
  styles: ReadonlyMap<string, string>;
  warnings: readonly string[];
}

export function driftSupplementFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value === "function") return undefined;
  return `${where}: "build.driftSupplement" must be a function returning a stylesheet for the classes it is handed — driftSupplement: (classes) => compile(classes)`;
}

function classList(one: DriftedPage): string {
  return one.classes.map((name) => JSON.stringify(name)).join(", ");
}

function line(one: DriftedPage): string {
  return `  ${pageKey(one.page)} — ${classList(one)}`;
}

const NO_COMPILER_FIX =
  "fix the safelist gap or the component the drift report names, or declare build.driftSupplement, as driftSupplement: (classes) => compile(classes)";

function noCompilerWarning(pages: readonly DriftedPage[]): string {
  const count = pages.length;
  const subject =
    count === 1
      ? "1 drifted page has no supplement"
      : `${String(count)} drifted pages have no supplement`;
  return `Class drift: ${subject}, because this site declares no supplement compiler — spec §9 inlines a stylesheet holding only the missing rules into each page below, and this framework names no CSS toolkit to compile one with, so the compiler is the site's to declare; without it each page below ships the classes it drifted on with no rules behind them, which is a page that renders unstyled where those classes are used. This is a warning and not a refusal because a site whose CSS is hand-written has no compiler to declare and the fault is the drift itself — ${NO_COMPILER_FIX}:\n${pages.map(line).join("\n")}`;
}

function emptySupplementWarning(pages: readonly DriftedPage[]): string {
  const count = pages.length;
  const subject =
    count === 1
      ? "1 supplement compiled to no rules"
      : `${String(count)} supplements compiled to no rules`;
  return `Class drift: ${subject}, so each page below ships the classes it drifted on with no rules behind them — "build.driftSupplement" was handed those classes and returned a stylesheet holding nothing, which is what a compiler answers about a class it does not generate: a name somebody typed by hand, or a safelist the toolkit was never told about. This is a warning and not a refusal because the page renders and only the rules for these classes are missing, and an empty answer is the compiler's rather than a fault in this build — fix the safelist gap or the component the drift report names, or generate rules for these classes:\n${pages.map(line).join("\n")}`;
}

const CLOSING_STYLE_FIX =
  'return a stylesheet with no "</style" sequence in it, or fix the safelist gap or the component the drift report names so the page does not drift';

export async function compileSupplements(
  input: SupplementInput,
): Promise<SupplementResult> {
  const drifted = input.report.pages;
  if (drifted.length === 0) return { styles: new Map(), warnings: [] };
  const compile = input.compile;
  if (compile === undefined) {
    return { styles: new Map(), warnings: [noCompilerWarning(drifted)] };
  }

  const styles = new Map<string, string>();
  const empty: DriftedPage[] = [];
  const closing: string[] = [];
  for (const one of drifted) {
    const key = pageKey(one.page);
    let css: string;
    try {
      css = await compile(one.classes);
    } catch (cause) {
      throw new Error(
        `Class drift: the supplement compiler threw on ${key} — "build.driftSupplement" is called with the classes one page used that the last full build's class manifest does not hold, ${classList(one)} here; fix the compiler, or fix the safelist gap or the component the drift report names so the page does not drift`,
        { cause },
      );
    }
    // A `.js` config is never typechecked, so the compiler's answer is checked
    // here.
    if (typeof css !== "string") {
      throw new ConfigError(
        `Class drift: the supplement compiler answered with ${css === null ? "null" : typeof css} on ${key}, and a supplement is a stylesheet — return the CSS covering the classes it is handed, as driftSupplement: (classes) => compile(classes)`,
      );
    }
    if (css.trim() === "") {
      empty.push(one);
      continue;
    }
    const position = closingStylePosition(css);
    if (position !== undefined) {
      closing.push(`  ${key} — "</style" at ${position}`);
      continue;
    }
    styles.set(key, `<style>${css}</style>`);
  }

  if (closing.length > 0) {
    throw new ConfigError(
      `Class drift: ${String(closing.length)} ${
        closing.length === 1
          ? 'supplement cannot be inlined because it holds "</style", which ends the element early and puts the rest of the sheet into the page as markup'
          : 'supplements cannot be inlined because they hold "</style", which ends the element early and puts the rest of the sheet into the page as markup'
      } — ${CLOSING_STYLE_FIX}:\n${closing.join("\n")}`,
    );
  }
  return {
    styles,
    warnings: empty.length === 0 ? [] : [emptySupplementWarning(empty)],
  };
}
