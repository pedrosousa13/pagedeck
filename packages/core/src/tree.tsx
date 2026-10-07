// Browser-safe by construction: nothing here imports `node:` or a bundler,
// which is what lets `@pagedeck/core/tree` ship to preview (spec §14).
import { createContext, createElement, Fragment, use, useContext } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import {
  entryId,
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_FACADE_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
  RegistryError,
  resolveComponent,
  resolveHydrationMode,
  wrapInProviders,
} from "@pagedeck/islands";
import { foldPositions, tuneHydration } from "./fold.js";
import type {
  FoldAdjustment,
  FoldPosition,
  FoldStrategy,
  TunedHydration,
} from "./fold.js";
import type {
  ComponentDefinition,
  ComponentRegistry,
  HydrationMode,
  ModuleFacts,
  PageContext,
  RootProvider,
} from "@pagedeck/islands";
import type { PlacedLocale } from "./locales.js";

export type { PlacedLocale };
export interface EntryNode {
  component: string;
  props?: Readonly<Record<string, unknown>>;
  children?: readonly EntryNode[];
}

export type { RootProvider };

export type PageContent =
  | {
      tree: readonly EntryNode[];
      template?: undefined;
    }
  | {
      template: string;
      props?: Readonly<Record<string, unknown>>;
      tree?: undefined;
    };

export interface PageChrome {
  readonly before?: readonly EntryNode[];
  readonly after?: readonly EntryNode[];
}

export type ChromeRegion = "before" | "after";

export interface ChromeBounds {
  readonly pageEnd: number;
  readonly afterStart: number;
}

export function chromeRegionOf(
  position: readonly number[],
  bounds: ChromeBounds | undefined,
): ChromeRegion | undefined {
  const top = position[0] ?? 0;
  if (bounds === undefined || top < bounds.pageEnd) return undefined;
  return top < bounds.afterStart ? "before" : "after";
}

export function nodeSource(
  page: PageContext,
  region: ChromeRegion | undefined,
): string {
  return region === undefined
    ? `entry ${entryId(page)}`
    : `build.chrome (${region} <main>) on entry ${entryId(page)}`;
}

export function chromeSuffix(region: ChromeRegion | undefined): string {
  return region === undefined ? "" : ` in build.chrome (${region} <main>)`;
}

export class RenderError extends Error {
  override readonly name = "RenderError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface BuildData {
  page: PageContext;
  values: ReadonlyMap<string, SeamValue>;
  consumed: Set<SeamValue>;
}

/**
 * A box, never the value: resolving a promise with the value reads its `then`,
 * and a getter could answer differently after the boundary checked it.
 */
export type SeamValue = Promise<{ value: unknown }>;

export const BuildDataContext = createContext<BuildData | undefined>(undefined);

export interface SocialCard {
  readonly href: string;
  readonly width: number;
  readonly height: number;
}

interface PageLocale {
  page: PageContext;
  locale?: PlacedLocale;
  socialCard?: SocialCard;
}

export const PageLocaleContext = createContext<PageLocale | undefined>(undefined);

/**
 * Strips only the framework's reserved names (#109). Every other byte reaches
 * the page as written, so the HTML must already be sanitised.
 */
export function unescapedHtml(html: string): {
  dangerouslySetInnerHTML: { __html: string };
} {
  return rawHtml(stripReservedNames(html));
}

/**
 * No strip: only `islandMarker` calls it, on markup this render produced.
 * Content goes through `unescapedHtml`.
 */
function rawHtml(html: string): {
  dangerouslySetInnerHTML: { __html: string };
} {
  return { dangerouslySetInnerHTML: { __html: html } };
}

export const SEARCH_ATTRIBUTE = "data-fw-search";

const NAME_CHARACTER = "[-\\w]";

export const IS_NAME_CHARACTER = new RegExp(NAME_CHARACTER);

/**
 * An enumeration, not a `data-fw-` prefix (#394, #566). Bytes, not a parse, so
 * a whole reserved name is removed wherever it is spelled.
 */
const RESERVED_NAMES = new RegExp(
  [
    `</?(?:${[ISLAND_TAG, ISLAND_SLOT_TAG].join("|")})(?=[\\s/>]|$)[^>]*>?`,
    `\\s*(?<!${NAME_CHARACTER})(?:${[
      ISLAND_PREFIX_ATTRIBUTE,
      ISLAND_COMPONENT_ATTRIBUTE,
      ISLAND_MODE_ATTRIBUTE,
      ISLAND_PROPS_ATTRIBUTE,
      ISLAND_SLOT_ATTRIBUTE,
      ISLAND_TEMPLATE_ATTRIBUTE,
      ISLAND_FACADE_ATTRIBUTE,
      SEARCH_ATTRIBUTE,
    ].join("|")})(?!${NAME_CHARACTER})(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>&"'=<\`]*))?`,
  ].join("|"),
  "gi",
);

/**
 * Repeated to a fixed point: a removal can join its neighbours into a new
 * reserved name. Case-insensitive, as the parser lowercases names.
 */
function stripReservedNames(html: string): string {
  let stripped = html;
  for (;;) {
    const next = stripped.replace(RESERVED_NAMES, "");
    if (next === stripped) return stripped;
    stripped = next;
  }
}

export function useBuildData<T>(key: string): T {
  const context = useContext(BuildDataContext);
  if (context === undefined) {
    throw new RenderError(
      `Build data "${key}": read outside a page render — useBuildData() only works inside a component rendered by renderPage()`,
    );
  }
  const value = context.values.get(key);
  if (value === undefined) {
    throw new RenderError(
      `Build data "${key}": not resolved for entry ${entryId(context.page)} — resolve it in the collection's loader and pass it in this page's render data`,
    );
  }
  // Before `use()`, which suspends: the pass must already hold this promise.
  context.consumed.add(value);
  return use(value).value as T;
}

/**
 * Build-time only: an island's pass does not provide it, because hydration
 * replays an island without the build's contexts.
 */
export function useLocale(): PlacedLocale {
  const context = useContext(PageLocaleContext);
  if (context === undefined) {
    throw new RenderError(
      `Locale: read outside the page's own render pass — useLocale() is build-time only, so an island's components must be given the locale as a prop instead`,
    );
  }
  if (context.locale === undefined) {
    throw new RenderError(
      `Locale: not resolved for entry ${entryId(context.page)} — pass the page's locale from the set defineLocales() returned as renderPage()'s locale`,
    );
  }
  return context.locale;
}

/**
 * Build-time only: an island's pass does not provide it, because hydration
 * replays an island without the build's contexts.
 */
export function useSocialCard(): SocialCard | undefined {
  const context = useContext(PageLocaleContext);
  if (context === undefined) {
    throw new RenderError(
      `Social card: read outside the page's own render pass — useSocialCard() is build-time only, so an island's components must be given the card as a prop instead`,
    );
  }
  return context.socialCard;
}

export function refuseMismatchedLocale(
  locale: PlacedLocale | undefined,
  page: PageContext,
): void {
  if (locale === undefined || locale.code === page.locale) return;
  throw new RenderError(
    `Locale "${locale.code}": is not entry ${entryId(page)}'s locale, which is "${page.locale}" — pass the locale the set defineLocales() returned under "${page.locale}"`,
  );
}

const MAXIMUM_TREE_DEPTH = 64;

function nodePastDepth(
  nodes: readonly EntryNode[],
  depth: number,
): EntryNode | undefined {
  for (const node of nodes) {
    if (depth >= MAXIMUM_TREE_DEPTH) return node;
    const found = nodePastDepth(node.children ?? [], depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function refuseDeepTree(tree: readonly EntryNode[], page: PageContext): void {
  const deep = nodePastDepth(tree, 0);
  if (deep === undefined) return;
  throw new RenderError(
    `Entry ${entryId(page)}: the component tree nests more than ${String(MAXIMUM_TREE_DEPTH)} levels deep at "${deep.component}" — flatten the entry's tree`,
  );
}

function referencedComponents(tree: readonly EntryNode[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (node: EntryNode): void => {
    if (!seen.has(node.component)) {
      seen.add(node.component);
      names.push(node.component);
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of tree) visit(node);
  return names;
}

function nameLines(names: readonly string[]): string {
  return names.map((name) => `  ${name}`).join("\n");
}

/**
 * Collects across the tree, then throws unregistered names first and alone
 * (exit 2): a missing default export is a different class (exit 1).
 */
export async function loadComponents(
  tree: readonly EntryNode[],
  registry: ComponentRegistry,
  page: PageContext,
): Promise<Map<string, ComponentType<never>>> {
  const loaded = new Map<string, ComponentType<never>>();
  const unregistered: { name: string; refusal: unknown }[] = [];
  const withoutDefault: string[] = [];
  for (const name of referencedComponents(tree)) {
    let definition: ComponentDefinition;
    try {
      definition = resolveComponent(registry, name, page);
    } catch (refusal) {
      unregistered.push({ name, refusal });
      continue;
    }
    const module = (await definition.import()) as {
      default?: ComponentType<never>;
    };
    if (typeof module?.default !== "function") {
      withoutDefault.push(name);
      continue;
    }
    loaded.set(name, unwrapClientReference(module.default));
  }
  const [onlyUnregistered] = unregistered;
  if (onlyUnregistered !== undefined) {
    if (unregistered.length === 1) throw onlyUnregistered.refusal;
    throw new RegistryError(
      `Entry ${entryId(page)}: ${String(unregistered.length)} components are not registered — declare each under build.components, or add each to the registry passed to renderPage, or remove the reference from the entry:\n${nameLines(unregistered.map((one) => one.name))}`,
    );
  }
  const [onlyWithoutDefault] = withoutDefault;
  if (onlyWithoutDefault !== undefined) {
    if (withoutDefault.length === 1) {
      throw new RenderError(
        `Component "${onlyWithoutDefault}": its module has no default export, and entry ${entryId(page)} renders it — export the component as its module's default`,
      );
    }
    throw new RenderError(
      `Entry ${entryId(page)}: ${String(withoutDefault.length)} components have no default export — export each component as its module's default:\n${nameLines(withoutDefault)}`,
    );
  }
  return loaded;
}

export type AnyComponent = ComponentType<Record<string, unknown>>;

/** `Symbol.for`: the proxy may be minted in another module realm. */
export const CLIENT_REFERENCE_TARGET = Symbol.for(
  "@pagedeck/core client reference target",
);

/**
 * A component the entry names is islanded by the tree already; rendering its
 * proxy would island it a second time (#168).
 */
export function unwrapClientReference<T>(component: T): T {
  const target = (component as Record<symbol, unknown>)[
    CLIENT_REFERENCE_TARGET
  ];
  return target === undefined ? component : (target as T);
}

const NO_DIRECTIVE: ModuleFacts = { useClient: false };

export interface RenderedIsland {
  component: string;
  mode: Exclude<HydrationMode, "none">;
  prefix: string;
  html: string;
  path?: readonly number[];
  foldAdjustment?: FoldAdjustment;
}

export interface IslandInstance {
  node: EntryNode;
  position: readonly number[];
  mode: Exclude<HydrationMode, "none">;
  foldAdjustment?: FoldAdjustment;
}

export function islandInstances(
  tree: readonly EntryNode[],
  registry: ComponentRegistry,
  page: PageContext,
  modules: Readonly<Record<string, ModuleFacts>>,
  strategy?: FoldStrategy,
): IslandInstance[] {
  const found: IslandInstance[] = [];
  const visit = (
    numbered: FoldPosition<EntryNode>,
    path: readonly number[],
  ): void => {
    const node = numbered.node;
    const facts = modules[node.component] ?? NO_DIRECTIVE;
    const resolved = resolveHydrationMode(registry, node.component, page, facts);
    const tuned: TunedHydration =
      strategy === undefined
        ? { mode: resolved.mode }
        : tuneHydration({
            component: node.component,
            resolved,
            position: numbered.position,
            treeSize: numbered.treeSize,
            strategy,
          });
    if (tuned.mode !== "none") {
      found.push({
        node,
        position: path,
        mode: tuned.mode,
        ...(tuned.adjustment === undefined
          ? {}
          : { foldAdjustment: tuned.adjustment }),
      });
    }
    numbered.children.forEach((child, index) => {
      visit(child, [...path, index]);
    });
  };
  foldPositions(tree, (node) => node.children).forEach((numbered, index) => {
    visit(numbered, [index]);
  });
  return found;
}

export interface ComposedIsland {
  island: RenderedIsland;
  props: string;
}

export interface PropsFailure {
  component: string;
  reason: string;
  error: unknown;
  renderedBy?: string | undefined;
  chrome?: ChromeRegion | undefined;
}

export const PROPS_FIX =
  "a hydration marker carries each instance's own props inline";

export interface RefusedProp {
  component: string;
  path: string;
  problem: string;
  fix: string;
  reason?: string | undefined;
  renderedBy?: string | undefined;
  chrome?: ChromeRegion | undefined;
}

/**
 * Names React or the language reads as instructions. Not `prototype`: on a
 * plain object nothing reads it.
 */
const REFUSED_PROP_NAMES: readonly string[] = [
  "__proto__",
  "dangerouslySetInnerHTML",
  "ref",
  "key",
  "constructor",
];

const DATA_FIX = "give it a value JSON can hold";

const MAXIMUM_PROP_DEPTH = 32;

function refusal(
  at: readonly string[],
  problem: string,
  fix: string,
  reason?: string,
): Omit<RefusedProp, "component"> {
  return { path: at.join("."), problem, fix, reason };
}

const refusedName = (at: readonly string[]): Omit<RefusedProp, "component"> =>
  refusal(at, "a name the framework refuses", "rename the field");

const TOO_DEEP_REASON =
  "the walk stops at a depth so a chain from outside cannot overflow the stack, and props nested this far are not content";

const tooDeep = (at: readonly string[]): Omit<RefusedProp, "component"> =>
  refusal(
    at,
    `nested more than ${String(MAXIMUM_PROP_DEPTH)} levels deep`,
    "flatten it",
    TOO_DEEP_REASON,
  );

/**
 * Reads values off descriptors, so an accessor is refused without being run.
 */
export function refusedProps(
  value: unknown,
  path: readonly string[],
  seen: Set<object>,
  found: Omit<RefusedProp, "component">[],
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (path.length > MAXIMUM_PROP_DEPTH) {
    found.push(tooDeep(path));
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    const at = [...path, String(key)];
    if (typeof key === "symbol") {
      found.push(refusal(at, "a symbol key", DATA_FIX));
      continue;
    }
    if (REFUSED_PROP_NAMES.includes(key)) {
      found.push(refusedName(at));
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      found.push(refusal(at, "an accessor", DATA_FIX));
      continue;
    }
    if (typeof descriptor.value === "function") {
      found.push(refusal(at, "a function", DATA_FIX));
      continue;
    }
    refusedProps(descriptor.value, at, seen, found);
  }
}

/**
 * The payload walk: `Reflect.ownKeys` cannot see what a prototype `toJSON`
 * writes.
 */
function refusedPayloadProps(
  value: unknown,
  path: readonly string[],
  found: Omit<RefusedProp, "component">[],
): void {
  if (typeof value !== "object" || value === null) return;
  if (path.length > MAXIMUM_PROP_DEPTH) {
    found.push(tooDeep(path));
    return;
  }
  const object = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string") continue;
    const at = [...path, key];
    if (REFUSED_PROP_NAMES.includes(key)) {
      found.push(refusedName(at));
      continue;
    }
    refusedPayloadProps(object[key], at, found);
  }
}

/**
 * Both walks, because each is blind to what the other sees. A `Proxy` is out of
 * scope: it can only come from the site's own code (#109).
 */
function refusedIslandProps(
  props: Readonly<Record<string, unknown>> | undefined,
  payload: unknown,
): Omit<RefusedProp, "component">[] {
  const found: Omit<RefusedProp, "component">[] = [];
  refusedProps(props, [], new Set(), found);
  refusedPayloadProps(payload, [], found);
  const paths = new Set<string>();
  return found.filter((prop) => {
    if (paths.has(prop.path)) return false;
    paths.add(prop.path);
    return true;
  });
}

export function islandProps(
  props: Readonly<Record<string, unknown>> | undefined,
  component: string,
):
  | { props: string }
  | { failure: PropsFailure }
  | { refused: readonly RefusedProp[] } {
  let serialized: string;
  try {
    const json = JSON.stringify(props ?? {});
    // `JSON.stringify` answers `undefined` when a `toJSON` does, which would
    // leave the marker with no props attribute.
    if (typeof json !== "string") {
      throw new TypeError("Props reduce to no JSON value at all");
    }
    serialized = json;
  } catch (error) {
    return {
      failure: {
        component,
        reason: error instanceof Error ? error.message : String(error),
        error,
      },
    };
  }
  const found = refusedIslandProps(props, JSON.parse(serialized) as unknown);
  if (found.length > 0) {
    return { refused: found.map((prop) => ({ component, ...prop })) };
  }
  return { props: serialized };
}

export function propsFailure(
  failures: readonly PropsFailure[],
  page: PageContext,
): RenderError {
  const [only] = failures;
  if (failures.length === 1 && only !== undefined) {
    return new RenderError(
      `Component "${only.component}": its props do not serialize to JSON, and ${nodeSource(page, only.chrome)} renders it as an island — ${PROPS_FIX}, so give it props that are JSON`,
      { cause: only.error },
    );
  }
  const detail = failures
    .map(
      (failure) =>
        `  ${failure.component}${chromeSuffix(failure.chrome)}: ${failure.reason}`,
    )
    .join("\n");
  return new RenderError(
    `Entry ${entryId(page)}: ${String(failures.length)} islands have props that do not serialize to JSON — ${PROPS_FIX}, so give them props that are JSON:\n${detail}`,
  );
}

const REFUSED_FIX =
  "island props are content and a marker hands them to React unchanged";

const refusedLine = (prop: RefusedProp): string =>
  `  ${prop.component}${chromeSuffix(prop.chrome)}: ${prop.path} is ${prop.problem} — ${prop.reason === undefined ? prop.fix : `${prop.reason}, so ${prop.fix}`}`;

export function refusedFailure(
  refused: readonly RefusedProp[],
  page: PageContext,
): RenderError {
  const [only] = refused;
  if (refused.length === 1 && only !== undefined) {
    return new RenderError(
      `Component "${only.component}": prop "${only.path}" is ${only.problem}, and ${nodeSource(page, only.chrome)} renders it as an island — ${only.reason ?? REFUSED_FIX}, so ${only.fix}`,
    );
  }
  const detail = refused.map(refusedLine).join("\n");
  return new RenderError(
    `Entry ${entryId(page)}: the framework refuses ${String(refused.length)} island props — ${REFUSED_FIX}, so rename, replace or flatten each one below:\n${detail}`,
  );
}

interface PropStep {
  key: string;
  from: PropStep | undefined;
}

function stepPath(step: PropStep): string[] {
  const path: string[] = [];
  for (let at: PropStep | undefined = step; at !== undefined; at = at.from) {
    path.push(at.key);
  }
  return path.reverse();
}

/**
 * Iterative, with no depth limit: a limit would let a name ride past it. An
 * accessor is skipped unread, a known residual (#135).
 */
function refusedNodeNames(
  props: unknown,
  found: Omit<RefusedProp, "component">[],
): void {
  const seen = new Set<object>();
  const pending: { value: unknown; at: PropStep | undefined }[] = [
    { value: props, at: undefined },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value } = next;
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    // Pushed in reverse, so the stack walks sub-objects in key order.
    const children: { value: unknown; at: PropStep }[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      const at: PropStep = { key, from: next.at };
      if (REFUSED_PROP_NAMES.includes(key)) {
        found.push(refusedName(stepPath(at)));
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      children.push({ value: descriptor.value, at });
    }
    children.reverse();
    for (const child of children) pending.push(child);
  }
}

export function refusedTreeProps(
  tree: readonly EntryNode[],
  islands: ReadonlySet<string>,
  chrome?: ChromeBounds,
): RefusedProp[] {
  const found: RefusedProp[] = [];
  const visit = (node: EntryNode, position: readonly number[]): void => {
    const region = chromeRegionOf(position, chrome);
    const refused: Omit<RefusedProp, "component">[] = [];
    if (islands.has(position.join("."))) {
      refusedProps(node.props, [], new Set(), refused);
    } else {
      refusedNodeNames(node.props, refused);
    }
    for (const prop of refused) {
      found.push({
        component: node.component,
        ...prop,
        ...(region === undefined ? {} : { chrome: region }),
      });
    }
    (node.children ?? []).forEach((child, at) => {
      visit(child, [...position, at]);
    });
  };
  tree.forEach((node, at) => {
    visit(node, [at]);
  });
  return found;
}

const NODE_REFUSED_FIX =
  "an entry's props are content and the build hands them to React unchanged";

export function nodeRefusedFailure(
  refused: readonly RefusedProp[],
  page: PageContext,
): RenderError {
  const [only] = refused;
  if (refused.length === 1 && only !== undefined) {
    return new RenderError(
      `Component "${only.component}": prop "${only.path}" is ${only.problem}, and ${nodeSource(page, only.chrome)} renders it — ${only.reason ?? NODE_REFUSED_FIX}, so ${only.fix}`,
    );
  }
  const detail = refused.map(refusedLine).join("\n");
  return new RenderError(
    `Entry ${entryId(page)}: the framework refuses ${String(refused.length)} component props — ${NODE_REFUSED_FIX}, so rename, replace or flatten each one below:\n${detail}`,
  );
}

export function islandMarker(
  composed: ComposedIsland,
  key: string,
): ReactElement {
  const { island, props } = composed;
  return createElement(ISLAND_TAG, {
    key,
    [ISLAND_PREFIX_ATTRIBUTE]: island.prefix,
    [ISLAND_COMPONENT_ATTRIBUTE]: island.component,
    [ISLAND_MODE_ATTRIBUTE]: island.mode,
    [ISLAND_PROPS_ATTRIBUTE]: props,
    role: "presentation",
    style: { display: "contents" },
    ...rawHtml(island.html),
  });
}

export interface IslandNodeElement {
  node: EntryNode;
  position: readonly number[];
  type: AnyComponent;
  props: Record<string, unknown>;
  children: readonly ReactElement[];
}

export type WrapIsland = (island: IslandNodeElement) => ReactElement;

export interface IslandOverride {
  positions: ReadonlySet<string>;
  wrap: WrapIsland;
}

export function elementFor(
  node: EntryNode,
  components: ReadonlyMap<string, ComponentType<never>>,
  position: readonly number[],
  islands: ReadonlyMap<string, ComposedIsland>,
  override?: IslandOverride,
): ReactElement {
  const key = String(position[position.length - 1]);
  const at = position.join(".");
  const island = islands.get(at);
  // The pass already rendered this subtree under its own prefix.
  if (island !== undefined) return islandMarker(island, key);

  const children = (node.children ?? []).map((child, index) =>
    elementFor(child, components, [...position, index], islands, override),
  );
  // Non-null: `loadComponents` walked the same tree and filled every name.
  const type = components.get(node.component) as AnyComponent;
  const props: Record<string, unknown> = { ...node.props, key };
  if (override !== undefined && override.positions.has(at)) {
    return override.wrap({ node, position, type, props, children });
  }
  return children.length === 0
    ? createElement(type, props)
    : createElement(type, props, ...children);
}

/**
 * The module's only read of `then`, made once: a getter may answer differently
 * on a second read. A getter that throws counts as a promise.
 */
function readsAsPromise(value: unknown): boolean {
  const canHold =
    (typeof value === "object" && value !== null) ||
    typeof value === "function";
  if (!canHold) return false;
  try {
    return typeof (value as PromiseLike<unknown>).then === "function";
  } catch {
    return true;
  }
}

/**
 * Refuses a thenable rather than awaiting it: `Promise.resolve` would adopt it
 * and turn the watchdog's wait into real IO.
 */
export function seamValues(
  data: Readonly<Record<string, unknown>>,
  page: PageContext,
): Map<string, SeamValue> {
  const entries = Object.entries(data);
  const refused = entries
    .filter(([, value]) => readsAsPromise(value))
    .map(([key]) => key);

  if (refused.length === 1) {
    throw new RenderError(
      `Build data "${String(refused[0])}": is a promise for entry ${entryId(page)} — a build render must not wait on it, so await it in the collection's loader and pass the resolved value`,
    );
  }
  if (refused.length > 1) {
    const detail = refused.map((key) => `  ${key}`).join("\n");
    throw new RenderError(
      `Entry ${entryId(page)}: ${String(refused.length)} build data values are promises — await them in the collection's loader and pass the resolved values:\n${detail}`,
    );
  }

  return new Map(
    entries.map(([key, value]) => [key, Promise.resolve({ value })]),
  );
}

export function pageTree(content: PageContent): readonly EntryNode[] {
  if (content.template === undefined) return content.tree;
  return [{ component: content.template, props: content.props }];
}
export interface PreparedPageInput {
  page: PageContext;
  content: PageContent;
  registry: ComponentRegistry;
  data?: Readonly<Record<string, unknown>>;
  modules?: Readonly<Record<string, ModuleFacts>>;
  foldStrategy?: FoldStrategy;
  chrome?: ChromeBounds;
}

export interface PreparedPage {
  tree: readonly EntryNode[];
  values: ReadonlyMap<string, SeamValue>;
  components: ReadonlyMap<string, ComponentType<never>>;
  instances: readonly IslandInstance[];
}

/**
 * Depth, seam, components, then island instances and prop refusals: each step
 * relies on the ones before it, and refusals must precede the first sink.
 */
export async function preparePage(
  input: PreparedPageInput,
): Promise<PreparedPage> {
  const { page, registry, data = {}, modules = {} } = input;
  const tree = pageTree(input.content);

  refuseDeepTree(tree, page);
  const values = seamValues(data, page);
  const components = await loadComponents(tree, registry, page);
  const instances = islandInstances(
    tree,
    registry,
    page,
    modules,
    input.foldStrategy,
  );

  const refused = refusedTreeProps(
    tree,
    new Set(instances.map((instance) => instance.position.join("."))),
    input.chrome,
  );
  if (refused.length > 0) throw nodeRefusedFailure(refused, page);

  return { tree, values, components, instances };
}

export function openSeam(
  inner: ReactNode,
  page: PageContext,
  values: ReadonlyMap<string, SeamValue>,
  providers: readonly RootProvider[],
): { element: ReactElement; seam: BuildData } {
  const seam: BuildData = { page, values, consumed: new Set() };
  return {
    seam,
    element: createElement(
      BuildDataContext.Provider,
      { value: seam },
      wrapInProviders(inner, providers),
    ),
  };
}

export function pageNodes(
  prepared: PreparedPage,
  page: PageContext,
  locale: PlacedLocale | undefined,
  islands: ReadonlyMap<string, ComposedIsland>,
  override?: IslandOverride,
  span: readonly [number, number] = [0, prepared.tree.length],
  socialCard?: SocialCard,
): ReactElement {
  const [start, end] = span;
  const nodes = prepared.tree
    .slice(start, end)
    .map((node, at) =>
      elementFor(node, prepared.components, [start + at], islands, override),
    );
  return createElement(
    PageLocaleContext.Provider,
    {
      value: {
        page,
        locale,
        ...(socialCard === undefined ? {} : { socialCard }),
      },
    },
    createElement(Fragment, null, ...nodes),
  );
}

export interface PageTreeInput extends PreparedPageInput {
  locale?: PlacedLocale;
  providers?: readonly RootProvider[];
  islands?: ReadonlyMap<string, ComposedIsland>;
  wrapIsland?: WrapIsland;
}

/**
 * No suspension watchdog: the caller mounting this tree owns the Suspense
 * boundary that refuses a component suspending on its own IO.
 */
export async function buildPageTree(
  input: PageTreeInput,
): Promise<ReactElement> {
  // Before the prepare: nothing further down can see a wrong `lang` and `dir`.
  refuseMismatchedLocale(input.locale, input.page);
  const prepared = await preparePage(input);
  const override =
    input.wrapIsland === undefined
      ? undefined
      : {
          positions: new Set(
            prepared.instances.map((instance) => instance.position.join(".")),
          ),
          wrap: input.wrapIsland,
        };
  return openSeam(
    pageNodes(
      prepared,
      input.page,
      input.locale,
      input.islands ?? new Map(),
      override,
    ),
    input.page,
    prepared.values,
    input.providers ?? [],
  ).element;
}
