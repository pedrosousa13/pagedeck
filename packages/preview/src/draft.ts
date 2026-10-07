// The one door a CMS payload comes through (ADR-0004's third door). Component, prop and depth
// refusals are left to `buildPageTree`, so each is made once.
import type {
  EntryNode,
  PageContent,
  PlacedLocale,
} from "@pagedeck/core/tree";
import type { PageContext } from "@pagedeck/islands";

export interface PreviewDraft {
  page: PageContext;
  locale?: PlacedLocale;
  content: PageContent;
  data?: Readonly<Record<string, unknown>>;
}

// Its own class: neither the site's wiring nor the page's code is wrong, but the bridge's message.
export class PreviewDraftError extends Error {
  override readonly name = "PreviewDraftError";
  /** Every fault in the payload, one line each, in the order they were found. */
  readonly faults: readonly string[];

  constructor(message: string, faults: readonly string[]) {
    super(message);
    this.faults = faults;
  }
}

// `refuseDeepTree`'s limit, so a tree this accepts the render accepts for depth too.
const MAXIMUM_DRAFT_DEPTH = 64;

const DRAFT_FIX =
  "send the entry as the CMS holds it, or fix the bridge that shaped it";

function fault(at: string, problem: string): string {
  return `${at} — ${problem}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Iterative and bounded: a deep untrusted chain would overflow the stack with a bare `RangeError`.
function treeFaults(tree: unknown, at: string, found: string[]): void {
  if (!Array.isArray(tree)) {
    found.push(fault(at, "is not an array of nodes"));
    return;
  }
  // Seeded reversed, as children are pushed reversed, so the report reads in content order.
  const pending: { node: unknown; at: string; depth: number }[] = [];
  for (let index = tree.length - 1; index >= 0; index -= 1) {
    pending.push({
      node: tree[index],
      at: `${at}[${String(index)}]`,
      depth: 0,
    });
  }
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node } = next;
    if (!isRecord(node)) {
      found.push(fault(next.at, "is not a node object"));
      continue;
    }
    if (typeof node.component !== "string" || node.component === "") {
      found.push(
        fault(`${next.at}.component`, "is not a registered component's name"),
      );
    }
    if (node.props !== undefined && !isRecord(node.props)) {
      found.push(fault(`${next.at}.props`, "is not an object of props"));
    }
    if (node.children === undefined) continue;
    if (next.depth >= MAXIMUM_DRAFT_DEPTH) {
      found.push(
        fault(
          `${next.at}.children`,
          `nests more than ${String(MAXIMUM_DRAFT_DEPTH)} levels deep`,
        ),
      );
      continue;
    }
    if (!Array.isArray(node.children)) {
      found.push(fault(`${next.at}.children`, "is not an array of nodes"));
      continue;
    }
    const children = node.children as unknown[];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: children[index],
        at: `${next.at}.children[${String(index)}]`,
        depth: next.depth + 1,
      });
    }
  }
}

function pageFaults(page: unknown, found: string[]): void {
  if (!isRecord(page)) {
    found.push(fault("page", "is not an object naming the entry"));
    return;
  }
  if (typeof page.locale !== "string" || page.locale === "") {
    found.push(fault("page.locale", "is not a locale code"));
  }
  // The leading slash is checked: a bridge sending "home" would name the entry `/enhome` (#171).
  // This fault carries its own fix, since the headline fix is what produced it.
  if (typeof page.path !== "string" || !page.path.startsWith("/")) {
    found.push(
      fault(
        "page.path",
        'is not a route, which leads with "/" — root the store\'s entry id, as "/home"',
      ),
    );
  }
}

// `code` is not compared with `page.locale`: `buildPageTree` runs that check (#101, #206).
function localeFaults(locale: unknown, found: string[]): void {
  if (!isRecord(locale)) {
    found.push(fault("locale", "is not a placed locale"));
    return;
  }
  if (typeof locale.code !== "string" || locale.code === "") {
    found.push(fault("locale.code", "is not a locale code"));
  }
  if (typeof locale.label !== "string") {
    found.push(fault("locale.label", "is not a label"));
  }
  if (locale.direction !== "ltr" && locale.direction !== "rtl") {
    found.push(fault("locale.direction", 'is not "ltr" or "rtl"'));
  }
  if (typeof locale.prefix !== "string") {
    found.push(fault("locale.prefix", "is not an output prefix"));
  }
}

function contentFaults(payload: Record<string, unknown>, found: string[]): void {
  const hasTree = payload.tree !== undefined;
  const hasTemplate = payload.template !== undefined;
  if (hasTree && hasTemplate) {
    found.push(fault("tree", "is set on a draft that also names a template"));
    return;
  }
  if (hasTemplate) {
    if (typeof payload.template !== "string" || payload.template === "") {
      found.push(fault("template", "is not a registered component's name"));
    }
    if (payload.props !== undefined && !isRecord(payload.props)) {
      found.push(fault("props", "is not an object of props"));
    }
    return;
  }
  if (!hasTree) {
    found.push(fault("tree", "is missing, and no template is named either"));
    return;
  }
  treeFaults(payload.tree, "tree", found);
}

function draftFailure(faults: readonly string[]): PreviewDraftError {
  const [only] = faults;
  if (faults.length === 1 && only !== undefined) {
    return new PreviewDraftError(
      `Preview draft: ${only} — ${DRAFT_FIX}`,
      faults,
    );
  }
  const detail = faults.map((line) => `  ${line}`).join("\n");
  return new PreviewDraftError(
    `Preview draft: ${String(faults.length)} fields are not what a draft entry carries — ${DRAFT_FIX}:\n${detail}`,
    faults,
  );
}

/**
 * Every fault in one pass, and no value quoted (rule 6): a draft's fields are unpublished
 * content. Each field is read once, so a getter cannot answer this and the renderer differently.
 */
export function readDraft(payload: unknown): PreviewDraft {
  if (!isRecord(payload)) {
    throw draftFailure(["the payload is not a draft entry object"]);
  }
  const faults: string[] = [];
  pageFaults(payload.page, faults);
  if (payload.locale !== undefined) localeFaults(payload.locale, faults);
  if (payload.data !== undefined && !isRecord(payload.data)) {
    faults.push(fault("data", "is not an object of build data"));
  }
  contentFaults(payload, faults);
  if (faults.length > 0) throw draftFailure(faults);

  const content: PageContent =
    payload.template === undefined
      ? { tree: payload.tree as readonly EntryNode[] }
      : {
          template: payload.template as string,
          props: payload.props as Readonly<Record<string, unknown>> | undefined,
        };
  return {
    page: payload.page as PageContext,
    ...(payload.locale === undefined
      ? {}
      : { locale: payload.locale as PlacedLocale }),
    content,
    ...(payload.data === undefined
      ? {}
      : { data: payload.data as Readonly<Record<string, unknown>> }),
  };
}
