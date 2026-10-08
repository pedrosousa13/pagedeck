import { createHash } from "node:crypto";
import { createElement } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { prerender } from "react-dom/static";
import {
  entryId,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
  ISLAND_TEMPLATE_TAG,
  SlotContent,
  checkSharedStore,
} from "@pagedeck/islands";
import type {
  ComponentRegistry,
  HydrationMode,
  ModuleFacts,
  PageContext,
  RootProvider,
} from "@pagedeck/islands";
import type { PlacedLocale } from "./locales.js";
import type { FoldStrategy } from "./fold.js";
import {
  elementFor,
  islandProps,
  IS_NAME_CHARACTER,
  openSeam,
  chromeRegionOf,
  chromeSuffix,
  nodeSource,
  pageNodes,
  pageTree,
  preparePage,
  propsFailure,
  refuseMismatchedLocale,
  refusedProps,
  RenderError,
  refusedFailure,
} from "./tree.js";
import {
  openProxyScope,
  throwContradictedHydration,
  throwProxyFaults,
} from "./client-reference.js";
import { recordProxyInstance } from "./proxy-census.js";
import type {
  ContradictedHydration,
  ProxyFaults,
  ProxyInstance,
} from "./client-reference.js";
import type {
  AnyComponent,
  BuildData,
  ChromeBounds,
  ChromeRegion,
  ComposedIsland,
  EntryNode,
  PageChrome,
  PageContent,
  PropsFailure,
  RefusedProp,
  RenderedIsland,
  SocialCard,
} from "./tree.js";

export {
  RenderError,
  unescapedHtml,
  useBuildData,
  useLocale,
  useSocialCard,
} from "./tree.js";
export type {
  EntryNode,
  PageChrome,
  PageContent,
  RenderedIsland,
  RootProvider,
  SocialCard,
} from "./tree.js";

export type RenderPageInput = PageContent & {
  page: PageContext;
  locale?: PlacedLocale;
  socialCard?: SocialCard;
  registry: ComponentRegistry;
  providers?: readonly RootProvider[];
  data?: Readonly<Record<string, unknown>>;
  modules?: Readonly<Record<string, ModuleFacts>>;
  foldStrategy?: FoldStrategy;
  chrome?: PageChrome;
};

export interface ChromeMarkup {
  before: string;
  after: string;
}

export interface RenderedPage {
  html: string;
  islands: readonly RenderedIsland[];
  absorbed: readonly AbsorbedMetadata[];
  chrome?: ChromeMarkup;
}

const UNRESOLVED_SUSPENSION = { reason: "unresolved-suspension" } as const;

/** Only has to exceed React's own chain of hops between two `use()` reads. */
const SEAM_HOPS = 1024;

/**
 * Microtasks only: IO needs the event loop to turn, and this never lets it. A
 * round with the seam settled and nothing new read means a foreign promise.
 */
function abortIfBlockedOutsideSeam(
  seam: BuildData,
  controller: AbortController,
  isFinished: () => boolean,
): void {
  void (async () => {
    let advancedTo = -1;
    while (!isFinished()) {
      if (seam.consumed.size === advancedTo) {
        controller.abort(UNRESOLVED_SUSPENSION);
        return;
      }
      advancedTo = seam.consumed.size;
      await Promise.allSettled(seam.values.values());
      for (
        let hop = 0;
        hop < SEAM_HOPS && !isFinished() && seam.consumed.size === advancedTo;
        hop += 1
      ) {
        await Promise.resolve();
      }
    }
  })();
}

/**
 * Page identity and tree position only, so every worker derives the same
 * prefix; a counter or any worker-local state would break hydration.
 */
function islandPrefix(page: PageContext, position: readonly number[]): string {
  const identity = `${page.locale}\0${page.path}\0${position.join(".")}`;
  return `i${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

/**
 * The enclosing pass's prefix, not its island's: two slotted panels of one
 * container render in passes of their own and must not share a prefix.
 */
function proxyPrefix(
  page: PageContext,
  pass: string,
  id: string,
  name: string,
): string {
  const identity = `${page.locale}\0${page.path}\0${pass}\0${id}\0${name}`;
  return `i${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}

interface RenderedSlot {
  id: string;
  component: string;
  html: string;
}

/**
 * Counts `<fw-slot>` start tags the pass emitted, not render calls or byte
 * matches (#111). A search, not a parse: its known misses err safe (#129).
 */
function slotCopies(html: string, id: string): number {
  const needle = `${ISLAND_SLOT_ATTRIBUTE}="${id}"`;
  const open = `<${ISLAND_SLOT_TAG}`;
  let copies = 0;
  for (
    let at = html.indexOf(open);
    at !== -1;
    at = html.indexOf(open, at + open.length)
  ) {
    const after = at + open.length;
    if (IS_NAME_CHARACTER.test(html.charAt(after))) continue;

    // React escapes `>` in the values it writes, so the first `>` ends its tag.
    const end = html.indexOf(">", after);
    const startTag = end === -1 ? html.slice(after) : html.slice(after, end);

    for (
      let spelled = startTag.indexOf(needle);
      spelled !== -1;
      spelled = startTag.indexOf(needle, spelled + needle.length)
    ) {
      if (IS_NAME_CHARACTER.test(startTag.charAt(spelled - 1))) continue;
      copies += 1;
      break;
    }
  }
  return copies;
}

/**
 * Escapes each panel as text (#108): a `</template>` in content would otherwise
 * end the stash. The client reads it back from `textContent`.
 */
function stashMarkup(slots: readonly RenderedSlot[]): string {
  return slots
    .map(
      (slot) =>
        `<${ISLAND_TEMPLATE_TAG} ${ISLAND_TEMPLATE_ATTRIBUTE}="${slot.id}">${escapeStash(slot.html)}</${ISLAND_TEMPLATE_TAG}>`,
    )
    .join("");
}

function escapeStash(html: string): string {
  return html.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function islandElement(
  node: EntryNode,
  components: ReadonlyMap<string, ComponentType<never>>,
  position: readonly number[],
  slots: readonly RenderedSlot[],
): ReactElement {
  const key = String(position[position.length - 1]);
  // Non-null: `loadComponents` walked the same tree and filled every name.
  const type = components.get(node.component) as AnyComponent;
  const props: Record<string, unknown> = { ...node.props, key };
  if (slots.length === 0) return createElement(type, props);
  return createElement(
    type,
    props,
    ...slots.map((slot) =>
      createElement(SlotContent, { key: slot.id, slot: slot.id, html: slot.html }),
    ),
  );
}

interface InstanceResult {
  failures: readonly PassFailure[];
  duplicates: readonly DuplicateSlot[];
  island?: RenderedIsland;
  props?: PropsFailure;
  refused?: readonly RefusedProp[];
}

const EMPTY_RESULT: InstanceResult = { failures: [], duplicates: [] };

interface DuplicateSlot {
  container: string;
  child: string;
  index: number;
  copies: number;
}

const DUPLICATE_FIX =
  "slotted content is one node of already-rendered HTML that hydration adopts in place, so a second copy has no DOM of its own and the client would move the first one rather than repeat it; render each slotted child at most once";

function duplicateFailure(
  duplicates: readonly DuplicateSlot[],
  page: PageContext,
): RenderError {
  const [only] = duplicates;
  if (duplicates.length === 1 && only !== undefined) {
    return new RenderError(
      `Component "${only.container}": renders slotted child ${String(only.index)} ("${only.child}") ${String(only.copies)} times, and entry ${entryId(page)} renders it as an island — ${DUPLICATE_FIX}`,
    );
  }
  const detail = duplicates
    .map(
      (duplicate) =>
        `  ${duplicate.container}: child ${String(duplicate.index)} ("${duplicate.child}"), ${String(duplicate.copies)} times`,
    )
    .join("\n");
  return new RenderError(
    `Entry ${entryId(page)}: ${String(duplicates.length)} slotted children are rendered more than once — ${DUPLICATE_FIX}:\n${detail}`,
  );
}

const TABLE_CONTAINERS: ReadonlySet<string> = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "colgroup",
]);

const TABLE_CELLS: ReadonlySet<string> = new Set(["td", "th", "caption"]);

/**
 * A backstop: React self-closes void elements today, but the slash is a no-op
 * in HTML and React may stop writing it.
 */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

interface TableFailure {
  component: string;
  ancestor: string;
}

interface MarkerFaults {
  table: TableFailure[];
  select: string[];
  template: string[];
}

interface HoistedSheet {
  component?: string;
  href: string;
}

export interface HeadClaim {
  singleton: string;
  value: string;
}

export interface AbsorbedMetadata {
  tag: string;
  component?: string;
  claim?: HeadClaim;
}

interface EmittedFaults {
  markers: MarkerFaults;
  sheets: HoistedSheet[];
  absorbed: AbsorbedMetadata[];
  body: string;
}

const TABLE_FIX =
  "the HTML parser moves an unknown element out of table markup before any CSS applies";

const SELECT_FIX =
  "the HTML parser discards content a <select> does not recognise";

const TEMPLATE_FIX =
  "the HTML parser diverts a <template>'s content into a document fragment of its own";

/**
 * A tag stack, not a parser: React closes what it opens, and an end tag pops by
 * search for unbalanced rich text. Exported for `render.test.tsx` alone.
 */
export function faultsInEmittedHtml(
  html: string,
  byPrefix: ReadonlyMap<string, RenderedIsland>,
): EmittedFaults {
  const found: MarkerFaults = { table: [], select: [], template: [] };
  const sheets: HoistedSheet[] = [];
  const absorbed: AbsorbedMetadata[] = [];
  const kept: string[] = [];
  let copied = 0;
  const open: string[] = [];
  const markers: { depth: number; component: string }[] = [];
  let at = 0;

  while (at < html.length) {
    const start = html.indexOf("<", at);
    if (start === -1) break;

    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", start) || html.startsWith("<?", start)) {
      const end = html.indexOf(">", start);
      at = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html.startsWith("</", start);
    let cursor = start + (closing ? 2 : 1);
    const nameStart = cursor;
    while (cursor < html.length && /[^\s/>]/.test(html[cursor] as string)) {
      cursor += 1;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (name === "") {
      at = start + 1;
      continue;
    }

    let quote = "";
    while (cursor < html.length) {
      const char = html[cursor] as string;
      if (quote !== "") {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    const selfClosing = html[cursor - 1] === "/";
    const tag = html.slice(start, cursor + 1);
    at = cursor + 1;

    if (closing) {
      const depth = open.lastIndexOf(name);
      if (depth !== -1) {
        open.length = depth;
        while ((markers.at(-1)?.depth ?? -1) >= depth) markers.pop();
      }
      continue;
    }

    if (
      (name === "title" || name === "meta" || iconLink(name, tag)) &&
      hoistedMetadata(tag, open)
    ) {
      // An unclosed `<title>` stays put: cut, it would take the rest of the
      // page.
      const content = name === "title" ? titleContent(html, at) : undefined;
      if (name === "title" && content === undefined) continue;
      const end = content?.end ?? at;
      const component = markers.at(-1)?.component;
      const claim = claimOf(name, tag, content?.text);
      absorbed.push({
        ...(component === undefined ? {} : { component }),
        ...(claim === undefined ? {} : { claim }),
        tag: html.slice(start, end),
      });
      kept.push(html.slice(copied, start));
      copied = end;
      at = end;
      continue;
    }

    if (name === "link" && HOISTED_ATTRIBUTE.test(tag)) {
      const component = markers.at(-1)?.component;
      sheets.push({
        ...(component === undefined ? {} : { component }),
        href: attributeOf(tag, "href") ?? "",
      });
    }

    if (name === ISLAND_TAG) {
      const island = byPrefix.get(prefixOf(tag) ?? "");
      const host = divertingHostAround(open);
      const ancestor = host === undefined ? tableModeAround(open) : undefined;
      if (island !== undefined) {
        if (host !== undefined) found[host].push(island.component);
        else if (ancestor !== undefined) {
          found.table.push({ component: island.component, ancestor });
        }
        // Only a marker with an end tag: a self-closing one would never be
        // popped.
        if (!selfClosing) {
          markers.push({ depth: open.length, component: island.component });
        }
      }
    }
    if (!selfClosing && !VOID_ELEMENTS.has(name)) open.push(name);
  }

  if (absorbed.length > 0) kept.push(html.slice(copied));
  return {
    markers: found,
    sheets,
    absorbed,
    body: absorbed.length === 0 ? html : kept.join(""),
  };
}

function hoistedMetadata(tag: string, open: readonly string[]): boolean {
  if (MICRODATA_ATTRIBUTE.test(tag)) return false;
  return !open.some((element) => element === "svg" || element === "math");
}

const MICRODATA_ATTRIBUTE = /\sitemprop=/i;

const ICON_RELS: ReadonlySet<string> = new Set(["icon", "apple-touch-icon"]);

function iconLink(name: string, tag: string): boolean {
  if (name !== "link") return false;
  const rel = attributeOf(tag, "rel") ?? "";
  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => ICON_RELS.has(token));
}

function titleContent(
  html: string,
  at: number,
): { text: string; end: number } | undefined {
  const close = html.toLowerCase().indexOf("</title", at);
  if (close === -1) return undefined;
  const end = html.indexOf(">", close);
  if (end === -1) return undefined;
  return { text: html.slice(at, close), end: end + 1 };
}

function claimOf(
  name: string,
  tag: string,
  text: string | undefined,
): HeadClaim | undefined {
  if (name === "title") {
    return { singleton: "<title>", value: decodeEntities(text ?? "") };
  }
  const charset = attributeOf(tag, "charset");
  if (charset !== undefined) {
    return { singleton: "<meta charset>", value: decodeEntities(charset) };
  }
  for (const key of ["name", "property", "http-equiv"] as const) {
    const term = attributeOf(tag, key);
    if (term === undefined) continue;
    return {
      singleton: `<meta ${key}="${decodeEntities(term)}">`,
      value: decodeEntities(attributeOf(tag, "content") ?? ""),
    };
  }
  return undefined;
}

const ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
  ["&#39;", "'"],
]);

/** One pass: `&amp;lt;` is the text `&lt;`, not `<`. */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|#x27|#39);/g,
    (found) => ENTITIES.get(found) ?? found,
  );
}

function tableModeAround(open: readonly string[]): string | undefined {
  for (let at = open.length - 1; at >= 0; at -= 1) {
    const element = open[at] as string;
    if (TABLE_CELLS.has(element)) return undefined;
    if (TABLE_CONTAINERS.has(element)) return element;
  }
  return undefined;
}

/**
 * Outranks the table at any depth, so it is asked first and searches the whole
 * stack.
 */
function divertingHostAround(
  open: readonly string[],
): "select" | "template" | undefined {
  for (let at = open.length - 1; at >= 0; at -= 1) {
    const element = open[at];
    if (element === "select" || element === "template") return element;
  }
  return undefined;
}

function prefixOf(tag: string): string | undefined {
  const match = new RegExp(`${ISLAND_PREFIX_ATTRIBUTE}="([^"]*)"`).exec(tag);
  return match?.[1];
}

const HOISTED_ATTRIBUTE = /\sdata-precedence=/;

/** Case-insensitive: React writes `charSet`, and a parser lowercases names. */
function attributeOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

const defeatedCount = (faults: MarkerFaults): number =>
  faults.table.length + faults.select.length + faults.template.length;

interface DefeatedFault {
  component: string;
  where: string;
  line: string;
}

interface DefeatedKind {
  place: string;
  fix: string;
  consequence: string;
  remedy: (islands: string) => string;
  faults: readonly DefeatedFault[];
}

function defeatedKinds(faults: MarkerFaults): readonly DefeatedKind[] {
  const kinds: readonly DefeatedKind[] = [
    {
      place: "<select>",
      fix: SELECT_FIX,
      consequence: "would not be in the document at all",
      remedy: (islands) => `move ${islands} out of the <select>`,
      faults: faults.select.map((component) => ({
        component,
        where: "<select>",
        line: component,
      })),
    },
    {
      place: "<template>",
      fix: TEMPLATE_FIX,
      consequence: "would not be in the document the runtime searches",
      remedy: (islands) => `move ${islands} out of the <template>`,
      faults: faults.template.map((component) => ({
        component,
        where: "<template>",
        line: component,
      })),
    },
    {
      place: "table markup",
      fix: TABLE_FIX,
      consequence: "would not survive to be hydrated",
      remedy: (islands) => `put ${islands} inside a <td> or <th>`,
      faults: faults.table.map(({ component, ancestor }) => ({
        component,
        where: `<${ancestor}>`,
        line: `${component}: inside <${ancestor}>`,
      })),
    },
  ];
  return kinds.filter((kind) => kind.faults.length > 0);
}

const defeatedSentence = (
  kind: DefeatedKind,
  fault: DefeatedFault,
  page: PageContext,
): string =>
  `Component "${fault.component}": is an island inside ${fault.where}, and entry ${entryId(page)} renders it — ${kind.fix}, so the hydration marker ${kind.consequence}; ${kind.remedy("the island")}, or drop its hydration`;

function defeatedParagraph(kind: DefeatedKind, page: PageContext): string {
  const many = kind.faults.length > 1;
  const headline = `Entry ${entryId(page)}: ${String(kind.faults.length)} ${many ? "islands are" : "island is"} inside ${kind.place}`;
  const tail = `${kind.fix}, so ${many ? "their hydration markers" : "its hydration marker"} ${kind.consequence}; ${kind.remedy(many ? "each island" : "the island")}, or drop its hydration`;
  const lines = kind.faults.map((fault) => `  ${fault.line}`).join("\n");
  return `${headline} — ${tail}:\n${lines}`;
}

function defeatedReport(faults: MarkerFaults, page: PageContext): string {
  const kinds = defeatedKinds(faults);
  const [first] = kinds;
  if (kinds.length === 1 && first?.faults.length === 1) {
    // Non-null: the branch above tested the length.
    const only = first.faults[0] as DefeatedFault;
    return defeatedSentence(first, only, page);
  }
  return kinds.map((kind) => defeatedParagraph(kind, page)).join("\n\n");
}

const HOISTED_WHY =
  "inside <body>, where it outranks the <head> the build owns as the single writer of the CSS tiers";

const hoistedRemedy = (many: boolean): string =>
  many
    ? "import each stylesheet from its component's module so the build places it in a tier, or remove the precedence prop"
    : "import the stylesheet from the component's module so the build places it in a tier, or remove the precedence prop";

const UNATTRIBUTED = "the entry's own tree";

function hoistedReport(
  sheets: readonly HoistedSheet[],
  page: PageContext,
): string {
  const [only] = sheets;
  if (sheets.length === 1 && only !== undefined) {
    const subject =
      only.component === undefined
        ? `Entry ${entryId(page)}: declares`
        : `Component "${only.component}": declares a stylesheet with React's precedence prop, and entry ${entryId(page)} renders it — React hoists`;
    const front =
      only.component === undefined
        ? `a stylesheet with React's precedence prop — React hoists "${only.href}" to the front of the page's fragment`
        : `"${only.href}" to the front of the island's own fragment`;
    return `${subject} ${front}, ${HOISTED_WHY}; ${hoistedRemedy(false)}`;
  }
  const lines = sheets
    .map(
      (sheet) =>
        `  ${sheet.component === undefined ? UNATTRIBUTED : `"${sheet.component}"`} — "${sheet.href}"`,
    )
    .join("\n");
  return `Entry ${entryId(page)}: ${String(sheets.length)} stylesheets are declared with React's precedence prop — React hoists each to the front of the fragment it was rendered in, ${HOISTED_WHY}; ${hoistedRemedy(true)}:\n${lines}`;
}

function suspectFrom(componentStack: string | undefined): string | undefined {
  const match = /\n\s*at (\S+)/.exec(componentStack ?? "");
  return match?.[1];
}

interface PassFailure {
  error: unknown;
  component: string | undefined;
  chrome?: ChromeRegion | undefined;
}

interface PassResult {
  html?: string;
  failures: readonly PassFailure[];
}

const SUSPENSION_FIX =
  "a build render must not fetch for itself, because a page that does cannot be built twice identically; resolve the data in the collection's loader and read it with useBuildData()";

const UNNAMED = "(unnamed component)";

function failureLine(failure: PassFailure): string {
  const name = `${failure.component ?? UNNAMED}${chromeSuffix(failure.chrome)}`;
  if (failure.error === UNRESOLVED_SUSPENSION) {
    return `  ${name}: suspended on data the framework did not resolve — ${SUSPENSION_FIX}`;
  }
  if (failure.error instanceof Error) {
    return `  ${name}: threw — ${failure.error.message}`;
  }
  return `  ${name}: threw — ${String(failure.error)}`;
}

function renderFailure(
  failures: readonly PassFailure[],
  page: PageContext,
): RenderError {
  const [only] = failures;
  if (failures.length === 1 && only !== undefined) {
    // Already names the entry; rewrapping would bury the specific message.
    if (only.error instanceof RenderError) return only.error;
    const subject =
      only.component === undefined
        ? `Entry ${entryId(page)}: a component${chromeSuffix(only.chrome)}`
        : `Component "${only.component}":`;
    const source = nodeSource(page, only.chrome);
    const giver = only.chrome === undefined ? "the entry" : "build.chrome";
    if (only.error === UNRESOLVED_SUSPENSION) {
      const where =
        only.component === undefined
          ? "suspended on data the framework did not resolve"
          : `suspended on data the framework did not resolve, while rendering ${source}`;
      return new RenderError(`${subject} ${where} — ${SUSPENSION_FIX}`);
    }
    const where =
      only.component === undefined
        ? "threw while rendering"
        : `threw while rendering ${source}`;
    return new RenderError(
      `${subject} ${where} — fix the component, or the props ${giver} gives it`,
      { cause: only.error },
    );
  }
  const detail = failures.map(failureLine).join("\n");
  return new RenderError(
    `Entry ${entryId(page)}: ${String(failures.length)} components failed to render — fix the components, or the props the entry gives them:\n${detail}`,
  );
}

/**
 * `prerender`, never `renderToString`, which bakes a Suspense fallback in; an
 * `onError` React recovered from still fails the pass.
 */
async function prerenderToHtml(
  tree: ReactNode,
  seam: BuildData,
  identifierPrefix?: string,
): Promise<PassResult> {
  const controller = new AbortController();
  const reported: PassFailure[] = [];
  let finished = false;

  const pending = prerender(tree, {
    identifierPrefix,
    signal: controller.signal,
    onError(error: unknown, info: { componentStack?: string }) {
      reported.push({ error, component: suspectFrom(info?.componentStack) });
    },
  }).then(
    (result) => {
      finished = true;
      return result;
    },
    (error: unknown) => {
      finished = true;
      throw error;
    },
  );

  abortIfBlockedOutsideSeam(seam, controller, () => finished);

  let prelude: ReadableStream<Uint8Array>;
  try {
    ({ prelude } = await pending);
  } catch (error) {
    return {
      failures:
        reported.length > 0
          ? reported
          : [{ error, component: undefined }],
    };
  }

  // An abort resolves with partial HTML; only `onError` shows the suspension.
  if (reported.length > 0) return { failures: reported };

  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of prelude) html += decoder.decode(chunk, { stream: true });
  return { html: html + decoder.decode(), failures: [] };
}

export async function renderPage(
  input: RenderPageInput,
): Promise<RenderedPage> {
  const {
    page,
    locale,
    socialCard,
    registry,
    providers = [],
    data = {},
  } = input;

  // Before any pass: under the wrong locale a component can throw for a reason
  // that is not this entry's.
  refuseMismatchedLocale(locale, page);

  // `false`: a build refuses (`StoreError`) rather than letting the shell's
  // environment decide (#252).
  checkSharedStore(providers, false);

  const pageEnd = pageTree(input).length;
  const before = input.chrome?.before ?? [];
  const after = input.chrome?.after ?? [];
  const hasChrome = before.length + after.length > 0;
  const bounds: ChromeBounds | undefined = hasChrome
    ? { pageEnd, afterStart: pageEnd + before.length }
    : undefined;
  const prepared = await preparePage({
    page,
    content: hasChrome ? { tree: [...pageTree(input), ...before, ...after] } : input,
    registry,
    data,
    modules: input.modules,
    foldStrategy: input.foldStrategy,
    ...(bounds === undefined ? {} : { chrome: bounds }),
  });
  const { tree, values, components, instances } = prepared;

  const rendered = new Map<string, ComposedIsland>();
  const byPrefix = new Map<string, RenderedIsland>();
  const results = new Map<string, InstanceResult>();
  const broken = new Set<string>();

  const proxyIslands: RenderedIsland[] = [];
  const contradictions = new Map<string, ContradictedHydration>();
  const proxyFaults: ProxyFaults = {
    duplicates: [],
    unserializable: [],
    refused: [],
    children: [],
  };

  /**
   * Two phases when a proxy is found, never a nested `prerender`: React retries
   * on `setImmediate`, so the outer watchdog would abort it (#168).
   */
  const pass = async (
    inner: ReactNode,
    prefix?: string,
    renderedBy?: string,
  ): Promise<PassResult> => {
    const run = (element: ReactElement): Promise<PassResult> => {
      const opened = openSeam(element, page, values, providers);
      return prerenderToHtml(opened.element, opened.seam, prefix);
    };
    // Closed over the pass, so both phases derive one prefix from one `useId`.
    const derive = (id: string, name: string): string =>
      proxyPrefix(page, prefix ?? "", id, name);

    const collected = new Map<string, ProxyInstance>();
    const discovery = await run(
      openProxyScope(
        {
          page,
          derive,
          renderedBy,
          phase: "collect",
          collected,
          duplicates: proxyFaults.duplicates,
          contradictions,
        },
        inner,
      ),
    );
    if (discovery.html === undefined || collected.size === 0) return discovery;

    const composed = new Map<string, ComposedIsland>();
    const renderable: ProxyInstance[] = [];
    for (const instance of collected.values()) {
      recordProxyInstance({
        entry: entryId(page),
        component: instance.name,
        renderedBy: instance.renderedBy ?? null,
        prefix: instance.prefix,
        refusedChildren: instance.hasChildren,
      });
      if (instance.hasChildren) {
        proxyFaults.children.push({
          component: instance.name,
          renderedBy: instance.renderedBy,
        });
        continue;
      }
      const found: Omit<RefusedProp, "component">[] = [];
      refusedProps(instance.props, [], new Set(), found);
      if (found.length > 0) {
        for (const prop of found) {
          proxyFaults.refused.push({
            component: instance.name,
            renderedBy: instance.renderedBy,
            ...prop,
          });
        }
        continue;
      }
      renderable.push(instance);
    }

    for (const instance of renderable) {
      const own = await pass(
        createElement(instance.component, instance.props),
        instance.prefix,
        instance.name,
      );
      if (own.html === undefined) return own;

      const island: RenderedIsland = {
        component: instance.name,
        mode: instance.mode,
        prefix: instance.prefix,
        html: own.html,
      };
      const payload = islandProps(instance.props, instance.name);
      if ("failure" in payload) {
        proxyFaults.unserializable.push({
          ...payload.failure,
          renderedBy: instance.renderedBy,
        });
        continue;
      }
      if ("refused" in payload) {
        for (const prop of payload.refused) {
          proxyFaults.refused.push({ ...prop, renderedBy: instance.renderedBy });
        }
        continue;
      }
      composed.set(instance.prefix, { island, props: payload.props });
      byPrefix.set(island.prefix, island);
      proxyIslands.push(island);
    }

    return run(
      openProxyScope(
        { page, derive, renderedBy, phase: "compose", composed },
        inner,
      ),
    );
  };

  const brokenInside = (key: string): boolean =>
    [...broken].some((other) => other.startsWith(`${key}.`));

  // Deepest-first: a container's pass needs its slots' HTML.
  for (const instance of [...instances].reverse()) {
    const key = instance.position.join(".");
    const prefix = islandPrefix(page, instance.position);
    if (brokenInside(key)) {
      results.set(key, EMPTY_RESULT);
      continue;
    }

    const slots: RenderedSlot[] = [];
    const slotFailures: PassFailure[] = [];
    const children = instance.node.children ?? [];
    for (const [at, child] of children.entries()) {
      const position = [...instance.position, at];
      const slot = await pass(
        elementFor(child, components, position, rendered),
        islandPrefix(page, position),
        child.component,
      );
      if (slot.html === undefined) {
        slotFailures.push(...slot.failures);
        continue;
      }
      slots.push({
        id: position.join("."),
        component: child.component,
        html: slot.html,
      });
    }
    if (slotFailures.length > 0) {
      broken.add(key);
      results.set(key, { failures: slotFailures, duplicates: [] });
      continue;
    }

    const result = await pass(
      islandElement(instance.node, components, instance.position, slots),
      prefix,
      instance.node.component,
    );
    const passHtml = result.html;
    if (passHtml === undefined) {
      broken.add(key);
      results.set(key, { failures: result.failures, duplicates: [] });
      continue;
    }

    const duplicates: DuplicateSlot[] = [];
    const stashed: RenderedSlot[] = [];
    slots.forEach((slot, index) => {
      const copies = slotCopies(passHtml, slot.id);
      if (copies === 0) stashed.push(slot);
      else if (copies > 1) {
        duplicates.push({
          container: instance.node.component,
          child: slot.component,
          index,
          copies,
        });
      }
    });

    const island: RenderedIsland = {
      component: instance.node.component,
      mode: instance.mode,
      prefix,
      html: passHtml + stashMarkup(stashed),
      path: instance.position,
      ...(instance.foldAdjustment === undefined
        ? {}
        : { foldAdjustment: instance.foldAdjustment }),
    };
    byPrefix.set(island.prefix, island);
    const payload = islandProps(instance.node.props, instance.node.component);
    if ("failure" in payload) {
      results.set(key, { failures: [], duplicates, island, props: payload.failure });
      continue;
    }
    if ("refused" in payload) {
      results.set(key, {
        failures: [],
        duplicates,
        island,
        refused: payload.refused,
      });
      continue;
    }
    rendered.set(key, { island, props: payload.props });
    results.set(key, { failures: [], duplicates, island });
  }

  const islands: RenderedIsland[] = [];
  const failures: PassFailure[] = [];
  const unserializable: PropsFailure[] = [];
  const refused: RefusedProp[] = [];
  const duplicated: DuplicateSlot[] = [];
  for (const instance of instances) {
    // Non-null: the loop above visited every instance and recorded one result.
    const result = results.get(instance.position.join(".")) as InstanceResult;
    const region = chromeRegionOf(instance.position, bounds);
    const inRegion = <T,>(one: T): T =>
      region === undefined ? one : { ...one, chrome: region };
    failures.push(...result.failures.map(inRegion));
    duplicated.push(...result.duplicates);
    if (result.island !== undefined) islands.push(result.island);
    if (result.props !== undefined) unserializable.push(inRegion(result.props));
    if (result.refused !== undefined) {
      refused.push(...result.refused.map(inRegion));
    }
  }

  // Stop here: composing the page would render each failed island again.
  if (failures.length > 0) throw renderFailure(failures, page);
  if (unserializable.length > 0) throw propsFailure(unserializable, page);
  if (refused.length > 0) throw refusedFailure(refused, page);
  if (duplicated.length > 0) throw duplicateFailure(duplicated, page);

  const result = await pass(
    pageNodes(
      prepared,
      page,
      locale,
      rendered,
      undefined,
      [0, pageEnd],
      socialCard,
    ),
    undefined,
    input.template,
  );
  if (result.html === undefined) throw renderFailure(result.failures, page);

  // A prefix of its own, or a chrome component would repeat the page's
  // `useId`s.
  const region = async (
    start: number,
    end: number,
    name: ChromeRegion,
  ): Promise<string> => {
    if (start === end) return "";
    const markup = await pass(
      pageNodes(
        prepared,
        page,
        locale,
        rendered,
        undefined,
        [start, end],
        socialCard,
      ),
      `chrome-${name}-`,
    );
    if (markup.html === undefined) {
      throw renderFailure(
        markup.failures.map((failure) => ({ ...failure, chrome: name })),
        page,
      );
    }
    return markup.html;
  };
  const chrome = hasChrome
    ? {
        before: await region(pageEnd, pageEnd + before.length, "before"),
        after: await region(
          pageEnd + before.length,
          pageEnd + before.length + after.length,
          "after",
        ),
      }
    : undefined;

  throwContradictedHydration(contradictions, page);

  throwProxyFaults(proxyFaults, page);

  const own = faultsInEmittedHtml(result.html, byPrefix);
  const chromeScan =
    chrome === undefined
      ? undefined
      : {
          before: faultsInEmittedHtml(chrome.before, byPrefix),
          after: faultsInEmittedHtml(chrome.after, byPrefix),
        };
  const scanned =
    chromeScan === undefined
      ? [own]
      : [chromeScan.before, own, chromeScan.after];
  const markers: MarkerFaults = {
    table: scanned.flatMap((one) => one.markers.table),
    select: scanned.flatMap((one) => one.markers.select),
    template: scanned.flatMap((one) => one.markers.template),
  };
  const sheets = scanned.flatMap((one) => one.sheets);
  const absorbed = scanned.flatMap((one) => one.absorbed);
  const emitted = [
    ...(defeatedCount(markers) > 0 ? [defeatedReport(markers, page)] : []),
    ...(sheets.length > 0 ? [hoistedReport(sheets, page)] : []),
  ];
  if (emitted.length > 0) throw new RenderError(emitted.join("\n\n"));

  return {
    html: own.body,
    islands: [...islands, ...proxyIslands],
    absorbed,
    ...(chromeScan === undefined
      ? {}
      : {
          chrome: { before: chromeScan.before.body, after: chromeScan.after.body },
        }),
  };
}
