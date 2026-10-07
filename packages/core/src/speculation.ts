import { refKey } from "./pages.js";
import type { Page } from "./pages.js";
import { quote } from "./quote.js";

export type SpeculationAction = "prefetch" | "prerender";

export interface SpeculationSetting {
  readonly action: SpeculationAction;
  readonly max: number;
}

const SHAPE_FIX = 'speculation: { action: "prefetch", max: 5 }';
const ACTION_FIX =
  'write "prefetch" to fetch the next page\'s bytes, or "prerender" to render it';
const MAX_FIX = "write the most pages one document may list, such as max: 5";

export function speculationFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.speculation" must be an object naming the action its rules take and how many pages one may list — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const faults: string[] = [];
  const action = read("action");
  if (action !== "prefetch" && action !== "prerender") {
    faults.push(
      `  "action" — ${quote(action)} — not a speculation action — ${ACTION_FIX}`,
    );
  }
  const max = read("max");
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    faults.push(
      `  "max" — ${quote(max)} — not a whole number of pages above zero — ${MAX_FIX}`,
    );
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.speculation" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot emit speculation rules from — declare each as the type its own line names:\n${faults.join("\n")}`;
}

export interface SpeculationInput {
  setting: SpeculationSetting;
  pages: readonly Page[];
}

export function speculationRules(
  input: SpeculationInput,
): ReadonlyMap<string, string> {
  const { setting, pages } = input;

  const byEntry = new Map<string, Page>();
  for (const page of pages) {
    // A fallback row carries its supplier's entry, so it would claim the
    // supplier's key and win or lose it by sort order.
    if (page.fallbackFrom !== undefined) continue;
    if (page.collection === undefined || page.entry === undefined) continue;
    byEntry.set(
      refKey({
        collection: page.collection,
        locale: page.entry.locale,
        path: page.entry.path,
      }),
      page,
    );
  }

  const documents = new Map<string, string>();
  for (const page of pages) {
    const urls: string[] = [];
    const seen = new Set<string>();
    for (const ref of page.relations ?? []) {
      if (urls.length >= setting.max) break;
      const target = byEntry.get(refKey(ref));
      if (target === undefined) continue;
      if (target === page) continue;
      if (target.domain !== page.domain) continue;
      if (seen.has(target.output)) continue;
      seen.add(target.output);
      urls.push(target.output);
    }
    if (urls.length === 0) continue;
    documents.set(
      `${page.locale} ${page.path}`,
      JSON.stringify({
        [setting.action]: [{ source: "list", urls }],
      }),
    );
  }
  return documents;
}
