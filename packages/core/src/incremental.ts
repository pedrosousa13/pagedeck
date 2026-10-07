import type { ContentStoreReader, PublishWindow } from "@pagedeck/content";
import type { CarriedComponent, PageDemand } from "./entries.js";
import type { FoldAdjustment } from "./fold.js";
import type { Manifest, ManifestPage } from "./manifest.js";
import type { EntryRef, Page } from "./pages.js";
import { refKey } from "./pages.js";
import type { TierPlan } from "./tiers.js";

export interface PageKey {
  locale: string;
  path: string;
  domain?: string;
}

export function pageKey(page: PageKey): string {
  return `${page.locale} ${page.path}`;
}

export interface BuildDelta {
  since: number;
  head: number;
  changed: readonly EntryRef[];
  vanished: readonly EntryRef[];
  requested: readonly EntryRef[];
}

export type AffectedReason =
  | { kind: "own-entry"; ref: EntryRef }
  | { kind: "dependency"; ref: EntryRef }
  | { kind: "deleted-dependency"; ref: EntryRef }
  | { kind: "requested"; ref: EntryRef }
  | { kind: "new-page" }
  | { kind: "moved"; from: { output: string; domain?: string } }
  | { kind: "no-previous-render" }
  | { kind: "not-found"; noindex: boolean }
  | { kind: "sibling-changed"; page: PageKey }
  | { kind: "unpatched-index"; adapter: string }
  | { kind: "no-previous-index"; adapter: string }
  | { kind: "font-scope"; sheet: string }
  | { kind: "chunk-moved"; href: string };

export interface AffectedPage {
  page: Page;
  reasons: readonly AffectedReason[];
}

export interface ReusedPage {
  page: Page;
  previous: ManifestPage;
}

export interface Removal {
  page: PageKey;
  html: string;
  entryChunk?: string;
  entry?: EntryRef;
}

export interface RedirectPolicy {
  target: "nearest-ancestor" | "none";
  status: 301 | 308;
}

export const DEFAULT_REDIRECT_POLICY: RedirectPolicy = {
  target: "nearest-ancestor",
  status: 308,
};

export interface RedirectRecord {
  domain?: string;
  from: string;
  to: string;
  status: number;
  reason: "deleted-page";
}

export interface IncrementalPlanInput {
  previous: Manifest;
  pages: readonly Page[];
  delta: BuildDelta;
  redirect?: RedirectPolicy;
  notFound?: (page: Pick<Page, "locale" | "path">) => boolean;
}

export interface IncrementalPlan {
  render: readonly AffectedPage[];
  reuse: readonly ReusedPage[];
  remove: readonly Removal[];
  redirects: readonly RedirectRecord[];
  demands: readonly PageDemand[];
  pinned: {
    tiers: TierPlan;
    classes: readonly string[];
    foldTuning: ReadonlyMap<string, readonly FoldAdjustment[]>;
  };
  stats: { total: number; rendered: number; reused: number; removed: number };
}

function beforePage(
  a: { locale: string; path: string },
  b: { locale: string; path: string },
): number {
  if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

function beforeRef(a: EntryRef, b: EntryRef): number {
  const left = refKey(a);
  const right = refKey(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sortedRefs(refs: readonly EntryRef[]): EntryRef[] {
  const byKey = new Map(refs.map((ref) => [refKey(ref), ref]));
  return [...byKey.values()].sort(beforeRef);
}

export function readDelta(
  store: ContentStoreReader,
  previous: Manifest,
  requested: readonly EntryRef[] = [],
): BuildDelta {
  const since = previous.store.seq;
  const rows = store.changedSince(since);
  const changed = sortedRefs(rows.map((row) => asRef(row)));

  const depended = sortedRefs(
    previous.pages.flatMap((page) => [...page.dependencies]),
  );
  const vanished = depended.filter(
    (ref) => store.getEntry(ref.collection, ref.locale, ref.path) === undefined,
  );

  return {
    since,
    head: store.getLastSeq(),
    changed,
    vanished,
    requested: sortedRefs(requested),
  };
}

export interface ScheduledCollection {
  name: string;
  publishField?: string;
  unpublishField?: string;
}

function declaredWindow(
  collection: ScheduledCollection,
): PublishWindow | undefined {
  const { publishField, unpublishField } = collection;
  if (publishField !== undefined) return { publishField, unpublishField };
  if (unpublishField !== undefined) return { unpublishField };
  return undefined;
}

export function publicationChanges(
  store: ContentStoreReader,
  previous: Manifest,
  collections: readonly ScheduledCollection[],
  now: string,
): EntryRef[] {
  const changes: EntryRef[] = [];
  for (const collection of collections) {
    const window = declaredWindow(collection);
    if (window === undefined) continue;
    const was = new Map(
      store
        .listDue(collection.name, window, previous.build.createdAt)
        .map((entry) => [refKey(entry), asRef(entry)]),
    );
    for (const entry of store.listDue(collection.name, window, now)) {
      if (!was.delete(refKey(entry))) changes.push(asRef(entry));
    }
    changes.push(...was.values());
  }
  return sortedRefs(changes);
}

function asRef(entry: {
  collection: string;
  locale: string;
  path: string;
}): EntryRef {
  return {
    collection: entry.collection,
    locale: entry.locale,
    path: entry.path,
  };
}

function reverseIndex(
  rows: readonly { key: string; dependencies: readonly EntryRef[] }[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    for (const ref of row.dependencies) {
      const key = refKey(ref);
      // Appended in place, never respread: a global's list spans the site, and
      // copying per append is quadratic.
      const pages = index.get(key);
      if (pages === undefined) index.set(key, [row.key]);
      else pages.push(row.key);
    }
  }
  return index;
}

function keyOf(page: Page): PageKey {
  return {
    locale: page.locale,
    path: page.path,
    ...(page.domain === undefined ? {} : { domain: page.domain }),
  };
}

/**
 * Deliberately not `ownEntry`: a fallback page's own entry counts here (#305,
 * #354).
 */
function ownEntryKey(page: Page): string | undefined {
  if (page.collection === undefined || page.entry === undefined)
    return undefined;
  return refKey({
    collection: page.collection,
    locale: page.entry.locale,
    path: page.entry.path,
  });
}

/**
 * `speculationRules`' rule, restated; `speculation-agreement.test.ts` keeps the
 * two in step (#354).
 */
function ownEntry(row: {
  collection?: string;
  entry?: { locale: string; path: string };
  fallbackFrom?: string;
}): EntryRef | undefined {
  if (row.collection === undefined || row.entry === undefined) return undefined;
  if (row.fallbackFrom !== undefined) return undefined;
  return {
    collection: row.collection,
    locale: row.entry.locale,
    path: row.entry.path,
  };
}

function hasRender(row: ManifestPage): boolean {
  return row.html !== "";
}

function segments(output: string): string[] {
  return output.split("/").filter((segment) => segment !== "");
}

function isProperPrefix(candidate: string[], of: string[]): boolean {
  if (candidate.length >= of.length) return false;
  return candidate.every((segment, index) => segment === of[index]);
}

function nearestAncestor(
  removed: ManifestPage,
  pages: readonly Page[],
): Page | undefined {
  const target = segments(removed.output);
  let best: Page | undefined;
  let depth = -1;
  for (const page of pages) {
    if (page.domain !== removed.domain) continue;
    const candidate = segments(page.output);
    if (!isProperPrefix(candidate, target)) continue;
    if (candidate.length > depth) {
      best = page;
      depth = candidate.length;
    }
  }
  return best;
}

export function planIncremental(input: IncrementalPlanInput): IncrementalPlan {
  const policy = input.redirect ?? DEFAULT_REDIRECT_POLICY;
  const routed = new Map(input.pages.map((page) => [pageKey(page), page]));
  const previousOf = new Map(
    input.previous.pages.map((page) => [pageKey(page), page]),
  );

  const currentIndex = reverseIndex(
    input.pages.map((page) => ({
      key: pageKey(page),
      dependencies: page.dependencies,
    })),
  );
  const previousIndex = reverseIndex(
    input.previous.pages.map((page) => ({
      key: pageKey(page),
      dependencies: page.dependencies,
    })),
  );

  const reasons = new Map<string, AffectedReason[]>();
  // Appended in place, never respread: a site-wide edit reaches every page.
  const note = (key: string, reason: AffectedReason): void => {
    const why = reasons.get(key);
    if (why === undefined) reasons.set(key, [reason]);
    else why.push(reason);
  };

  for (const page of input.pages) {
    const key = pageKey(page);
    const row = previousOf.get(key);
    if (row === undefined) note(key, { kind: "new-page" });
    else if (!hasRender(row)) note(key, { kind: "no-previous-render" });
    else if (row.output !== page.output || row.domain !== page.domain) {
      note(key, {
        kind: "moved",
        from: {
          output: row.output,
          ...(row.domain === undefined ? {} : { domain: row.domain }),
        },
      });
    }
    const noindex = input.notFound?.(page) ?? false;
    if (row !== undefined && hasRender(row) && (row.noindex === true) !== noindex) {
      note(key, { kind: "not-found", noindex });
    }
  }

  const vanished = new Set(input.delta.vanished.map(refKey));
  const changed = new Set(input.delta.changed.map(refKey));
  const triggers = sortedRefs([
    ...input.delta.changed,
    ...input.delta.vanished,
    ...input.delta.requested,
  ]);

  for (const ref of triggers) {
    const key = refKey(ref);
    // Both indices: a vanished ref the current table still names must render
    // and fail.
    const touched = new Set([
      ...(currentIndex.get(key) ?? []),
      ...(previousIndex.get(key) ?? []),
    ]);
    for (const identity of touched) {
      const page = routed.get(identity);
      if (page === undefined) continue;
      if (vanished.has(key)) note(identity, { kind: "deleted-dependency", ref });
      else if (!changed.has(key)) note(identity, { kind: "requested", ref });
      else if (ownEntryKey(page) === key) note(identity, { kind: "own-entry", ref });
      else note(identity, { kind: "dependency", ref });
    }
  }

  const render: AffectedPage[] = [];
  const reuse: ReusedPage[] = [];
  for (const page of input.pages) {
    const why = reasons.get(pageKey(page));
    if (why !== undefined) {
      render.push({ page, reasons: why });
      continue;
    }
    reuse.push({ page, previous: previousOf.get(pageKey(page)) as ManifestPage });
  }

  const remove: Removal[] = [];
  const redirects: RedirectRecord[] = [];
  for (const row of input.previous.pages) {
    // Identity alone: a moved page is re-rendered above, and a `Removal` would
    // redirect it away.
    if (routed.has(pageKey(row))) continue;
    const own = ownEntry(row);
    remove.push({
      page: {
        locale: row.locale,
        path: row.path,
        ...(row.domain === undefined ? {} : { domain: row.domain }),
      },
      html: row.html,
      ...(row.entryChunk === undefined ? {} : { entryChunk: row.entryChunk }),
      ...(own === undefined ? {} : { entry: own }),
    });
    if (policy.target === "none") continue;
    const target = nearestAncestor(row, input.pages);
    if (target === undefined) continue;
    redirects.push({
      ...(row.domain === undefined ? {} : { domain: row.domain }),
      from: row.output,
      to: target.output,
      status: policy.status,
      reason: "deleted-page",
    });
  }

  const demands: PageDemand[] = reuse
    .map((one) => ({
      page: one.page,
      carried: one.previous.components.map(
        ({ name, eager }): CarriedComponent => ({ name, eager }),
      ),
    }))
    .sort((a, b) => beforePage(a.page, b.page));

  return {
    render,
    reuse,
    remove,
    redirects,
    demands,
    pinned: {
      tiers: input.previous.tiers,
      classes: input.previous.classes,
      foldTuning: new Map(
        reuse.map((one) => [pageKey(one.page), one.previous.foldTuning]),
      ),
    },
    stats: {
      total: input.pages.length,
      rendered: render.length,
      reused: reuse.length,
      removed: remove.length,
    },
  };
}

export function crossPageAffected(input: {
  plan: IncrementalPlan;
  alternates: boolean;
  speculation: boolean;
}): readonly AffectedPage[] {
  const { plan, alternates, speculation } = input;
  if (!alternates && !speculation) return [];

  const byPath = new Map<string, PageKey[]>();
  const byEntry = new Map<string, PageKey>();
  const note = (moved: PageKey, own?: EntryRef): void => {
    const group = byPath.get(moved.path);
    if (group === undefined) byPath.set(moved.path, [moved]);
    else group.push(moved);
    // First writer wins, and render rows are noted before removals, so a moved
    // page is quoted at the path this build emits.
    if (own === undefined) return;
    const key = refKey(own);
    if (!byEntry.has(key)) byEntry.set(key, moved);
  };

  for (const affected of plan.render) {
    const structural = affected.reasons.some(
      (reason) =>
        reason.kind === "new-page" ||
        reason.kind === "moved" ||
        reason.kind === "not-found",
    );
    if (!structural) continue;
    note(keyOf(affected.page), ownEntry(affected.page));
  }
  for (const removal of plan.remove) note(removal.page, removal.entry);

  const widened: AffectedPage[] = [];
  for (const { page } of plan.reuse) {
    const siblings = [
      ...(alternates ? (byPath.get(page.path) ?? []) : []),
      ...(speculation
        ? (page.relations ?? []).flatMap((ref) => {
            const moved = byEntry.get(refKey(ref));
            return moved === undefined ? [] : [moved];
          })
        : []),
    ];
    if (siblings.length === 0) continue;
    const reasons = new Map<string, AffectedReason>();
    for (const sibling of siblings) {
      const key = pageKey(sibling);
      if (reasons.has(key)) continue;
      reasons.set(key, { kind: "sibling-changed", page: sibling });
    }
    widened.push({ page, reasons: [...reasons.values()] });
  }
  return widened;
}

export function mergeDemands(
  carried: readonly PageDemand[],
  rendered: readonly PageDemand[],
): readonly PageDemand[] {
  const byPage = new Map(carried.map((one) => [pageKey(one.page), one]));
  for (const demand of rendered) byPage.set(pageKey(demand.page), demand);
  return [...byPage.values()].sort((a, b) => beforePage(a.page, b.page));
}
