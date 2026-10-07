import { classesOfHtml } from "./classes.js";
import type { AffectedPage, AffectedReason } from "./incremental.js";
import { pageKey } from "./incremental.js";
import type { FullRebuildRequest } from "./manifest.js";
import type { Page } from "./pages.js";
import { refKey } from "./pages.js";

export const DEFAULT_DRIFT_THRESHOLD = 5;

function thresholdFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the threshold counts pages";
  }
  if (value < 0) {
    return "below zero, and a build that drifts no page is already the lowest count there is";
  }
  return undefined;
}

export function driftThresholdFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  const reason = thresholdFault(value);
  if (reason === undefined) return undefined;
  return `${where}: "build.driftThreshold" is not a count of drifted pages — write a whole number of pages, 0 or more, such as driftThreshold: 3:\n  ${JSON.stringify(value)} — ${reason}`;
}

export interface ReRenderedPage {
  affected: AffectedPage;
  /**
   * The render fragment, not the emitted document: an inlined stylesheet's
   * `[class=…]` selectors would read as permanent drift.
   */
  html: string;
}

export type StylingSafelist = Readonly<Record<string, readonly string[]>>;

function article(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const found = typeof value;
  return `${"aeiou".includes(found[0] as string) ? "an" : "a"} ${found}`;
}

const SAFELIST_FIX = `declare the classes each CMS styling field can render and each component states for itself, as safelist: { "hero.theme": ["bg-white", "text-slate-900"], "hero": ["hero"] }`;

function safelistEntryFault(classes: unknown): string | undefined {
  if (!Array.isArray(classes)) {
    return `is ${article(classes)}, not an array of class names`;
  }
  for (const one of classes as readonly unknown[]) {
    if (typeof one !== "string") {
      return `holds ${article(one)}, and a class name is a string`;
    }
    if (one.trim() === "") {
      return "holds an empty class name, which no rendered class can equal";
    }
    if (/\s/.test(one)) {
      return `holds ${JSON.stringify(one)}, which is several classes in one string — declare each class on its own`;
    }
  }
  return undefined;
}

export function safelistFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.safelist" must be an object keyed by where each class came from — the CMS styling field, or the component whose source states it — ${SAFELIST_FIX}`;
  }
  const lines: string[] = [];
  for (const [key, classes] of Object.entries<unknown>(
    value as Record<string, unknown>,
  )) {
    const fault = safelistEntryFault(classes);
    if (fault !== undefined) lines.push(`  "${key}" — ${fault}`);
  }
  if (lines.length === 0) return undefined;
  return `${where}: "build.safelist" declares ${String(lines.length)} ${
    lines.length === 1
      ? "key that enumerates no class names"
      : "keys that enumerate no class names"
  } — ${SAFELIST_FIX}:\n${lines.join("\n")}`;
}

export interface DriftInput {
  pinned: readonly string[];
  rendered: readonly ReRenderedPage[];
  threshold?: number;
  safelist?: StylingSafelist;
}

export interface DriftedPage {
  page: Page;
  classes: readonly string[];
  reasons: readonly AffectedReason[];
}

export interface DriftReport {
  pages: readonly DriftedPage[];
  threshold: number;
  fullRebuild?: FullRebuildRequest;
}

function sourceOf(reason: AffectedReason): string {
  switch (reason.kind) {
    case "own-entry":
      return `own entry "${refKey(reason.ref)}"`;
    case "dependency":
      return `dependency "${refKey(reason.ref)}"`;
    case "deleted-dependency":
      return `deleted dependency "${refKey(reason.ref)}"`;
    case "requested":
      return `requested entry "${refKey(reason.ref)}"`;
    case "new-page":
      return "no source entry: the route table holds this page and the previous manifest does not";
    case "no-previous-render":
      return "no source entry: the previous manifest records no HTML for this page";
    case "not-found":
      return reason.noindex
        ? "no source entry: this page is now a not-found page, and the previous build wrote it as an ordinary one"
        : "no source entry: this page is no longer a not-found page, and the previous build wrote it as one";
    case "moved":
      return `no source entry: the previous manifest puts this page at "${reason.from.output}"`;
    case "sibling-changed":
      return `no source entry: this page's head joins over the route table, and "${pageKey(reason.page)}" moved in it`;
    case "unpatched-index":
      return `no source entry: the ${JSON.stringify(reason.adapter)} search adapter has no patch, so every page renders for its index`;
    case "no-previous-index":
      return `no source entry: the previous build holds no index from the ${JSON.stringify(reason.adapter)} search adapter, so every page renders for it`;
    case "font-scope":
      return `no source entry: the scoped font stylesheet "${reason.sheet}" is new, gone or scoped to other pages since the previous build, and its pages include this one`;
    case "chunk-moved":
      return `no source entry: this page names "${reason.href}", which this build did not emit, so it is rendered again with the chunks this build did emit`;
  }
}

function sourcesOf(reasons: readonly AffectedReason[]): string {
  return reasons.map(sourceOf).join("; ");
}

export function checkDrift(input: DriftInput): DriftReport {
  const recorded = new Set(input.pinned);
  const declared = new Set(Object.values(input.safelist ?? {}).flat());
  const threshold = input.threshold ?? DEFAULT_DRIFT_THRESHOLD;

  const pages: DriftedPage[] = [];
  for (const one of input.rendered) {
    const missing = classesOfHtml(one.html).filter(
      (name) => !recorded.has(name) && !declared.has(name),
    );
    if (missing.length === 0) continue;
    pages.push({
      page: one.affected.page,
      classes: missing,
      reasons: one.affected.reasons,
    });
  }

  return {
    pages,
    threshold,
    // A count equal to the threshold is within it: spec §9 says "past" it.
    ...(pages.length > threshold
      ? {
          fullRebuild: {
            reason: "class-drift" as const,
            drifted: pages.length,
            threshold,
          },
        }
      : {}),
  };
}

export function driftWarnings(report: DriftReport): readonly string[] {
  if (report.pages.length === 0) return [];

  const count = report.pages.length;
  const subject =
    count === 1
      ? "1 re-rendered page uses classes"
      : `${String(count)} re-rendered pages use classes`;
  const lines = report.pages.map(
    (one) =>
      `  ${pageKey(one.page)} — ${one.classes
        .map((name) => JSON.stringify(name))
        .join(", ")} — ${sourcesOf(one.reasons)}`,
  );
  const drift = `Class drift: ${subject} the last full build's class manifest does not hold — spec §9's invariant is that classes derive from code and never from content, so a class in rendered HTML that no recorded class covers is either a class this site's code states and the site's declared "build.safelist" does not — a CMS-exposed styling option, or a class a component writes for itself — or a component writing a class name out of a content value; check "build.safelist" for the option the source entry below sets and for the components that entry renders, then read those components. This is a warning and not a refusal because the supplement spec §9 inlines into each page below leaves that page correctly styled and the site's stylesheets byte-identical:\n${lines.join("\n")}`;

  if (report.fullRebuild === undefined) return [drift];

  return [
    drift,
    `Class drift: ${String(count)} pages drifted and "build.driftThreshold" allows ${String(report.threshold)}, so this build's manifest records a full rebuild request — an incremental build carries the previous build's class manifest forward rather than re-extracting it, so every class above drifts again on every incremental build until a full build records it, and each of those builds inlines the same supplement into the same pages. This is a warning and not a refusal because every page this build emitted is correct: the request is the manifest's "fullRebuild" field, and spec §9 leaves scheduling the rebuild to the site's CI — run a full pagedeck build, and fix the safelist gap or the component the lines above name.`,
  ];
}
