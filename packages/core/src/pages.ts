import { listDueEntries, listEntries } from "@pagedeck/content";
import type {
  Collection,
  ContentStoreReader,
  Entry,
  EntryId,
} from "@pagedeck/content";
import { ConfigError, printable } from "./exit.js";
import { defineLocales, localeTree } from "./locales.js";
import { quoteIdentifier } from "./quote.js";
import type { LocaleSet, PlacedLocale } from "./locales.js";

export type TrailingSlash = "always" | "never";

export interface EntryRef {
  collection: string;
  locale: string;
  path: string;
}

export interface Page {
  locale: string;
  path: `/${string}`;
  domain?: string;
  declaredDomain?: string;
  output: string;
  collection?: string;
  entry?: EntryId;
  template?: string;
  layout?: string;
  fallbackFrom?: string;
  dependencies: readonly EntryRef[];
  relations?: readonly EntryRef[];
  paging?: Paging;
}

export interface Paging {
  readonly number: number;
  readonly total: number;
  readonly prev?: string;
  readonly next?: string;
}

export type Route = string | readonly string[];

export interface EntryOrigin {
  collection: string;
  entry: EntryId;
  template?: string;
}

export interface RouteInstance<P> {
  locale: string;
  params: P;
  dependencies: readonly EntryRef[];
  relations?: readonly EntryRef[];
  entry?: EntryOrigin;
  paging?: Paging;
}

export interface PageSource<P> {
  route: (instance: RouteInstance<P>) => Route | undefined;
  layout?: string;
  instances: (
    store: ContentStoreReader,
    now: string | undefined,
    site: SiteAddressing,
  ) => readonly RouteInstance<P>[];
}

export interface SiteAddressing {
  readonly trailingSlash: TrailingSlash;
  readonly locales: LocaleSet;
}

export function refKey(ref: EntryRef): string {
  return `${ref.collection} ${ref.locale} ${ref.path}`;
}

function dedupeRefs(refs: readonly EntryRef[]): EntryRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = refKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DraftBase {
  locale: string;
  collection?: string;
  entry?: EntryId;
  template?: string;
  layout?: string;
  dependencies: readonly EntryRef[];
  relations?: readonly EntryRef[];
  paging?: Paging;
  sourceIndex: number;
  instanceIndex: number;
}

interface RoutableDraft extends DraftBase {
  route: string;
  /**
   * Declared `undefined`, so a spread carrying a verdict cannot widen into this
   * variant.
   */
  segmentReason?: undefined;
}

interface FaultedDraft extends DraftBase {
  route?: undefined;
  segmentReason: string;
}

type DraftPage = RoutableDraft | FaultedDraft;

export interface PageSet<S extends string = never> extends SiteAddressing {
  readonly sources: readonly ((
    store: ContentStoreReader,
    now: string | undefined,
  ) => DraftPage[])[];
  readonly layouts: readonly (string | undefined)[];
  href<T extends Paramless<S>>(template: T, locale?: string): string;
  href<T extends S>(template: T, params: ParamsOf<T>, locale?: string): string;
}

function assembleRoute(route: Route): string {
  if (typeof route === "string") return route;
  return route.map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Reported, not thrown, so `collectPages` can enumerate every such route
 * (rule 5). The value is never quoted (rule 6).
 */
function unusableSegmentReason(route: Route): string | undefined {
  if (typeof route === "string") return undefined;
  const faults = route.flatMap((segment, index) => {
    const position = `segments[${String(index)}]`;
    if (segment === "") return [`${position} is empty`];
    if (segment === "." || segment === "..") {
      return [`${position} is a dot segment`];
    }
    if (LONE_SURROGATE.test(segment)) {
      return [`${position} holds a lone surrogate`];
    }
    return [];
  });
  if (faults.length === 0) return undefined;
  return `the route holds a segment that is not a path segment: ${faults.join(", ")}`;
}

function erase<P>(
  source: PageSource<P>,
  sourceIndex: number,
  site: SiteAddressing,
): (store: ContentStoreReader, now: string | undefined) => DraftPage[] {
  return (store, now) => {
    const drafts: DraftPage[] = [];
    for (const [instanceIndex, instance] of source
      .instances(store, now, site)
      .entries()) {
      const route = source.route(instance);
      if (route === undefined) continue;
      const base: DraftBase = {
        locale: instance.locale,
        sourceIndex,
        instanceIndex,
        collection: instance.entry?.collection,
        entry: instance.entry?.entry,
        template: instance.entry?.template,
        ...(source.layout === undefined ? {} : { layout: source.layout }),
        dependencies: dedupeRefs(instance.dependencies),
        relations:
          instance.relations === undefined
            ? undefined
            : dedupeRefs(instance.relations),
        paging: instance.paging,
      };
      // Before assembly: `encodeURIComponent` throws on a lone surrogate
      // (#131), and once joined a `..` reads like one a string route meant.
      const segmentReason = unusableSegmentReason(route);
      drafts.push(
        segmentReason === undefined
          ? { ...base, route: assembleRoute(route) }
          : { ...base, segmentReason },
      );
    }
    return drafts;
  };
}

export function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

const INDEX = "index";

function entryRoute(path: string): Route {
  const parts = segments(path);
  if (parts.at(-1) !== INDEX) return parts;
  return parts.length === 1 ? "/" : parts.slice(0, -1);
}

/**
 * Throws on the first scheduled collection with no instant: there is no page
 * set yet to collect a second fault over.
 */
function scheduledEntries<TOut, TIn>(
  collection: Collection<TOut, TIn>,
  store: ContentStoreReader,
  now: string | undefined,
): Entry<TOut>[] {
  const declared = [
    ...(collection.publishField === undefined ? [] : ["publishField"]),
    ...(collection.unpublishField === undefined ? [] : ["unpublishField"]),
  ];
  if (declared.length === 0) return listEntries(store, collection);
  if (now === undefined) {
    throw new ConfigError(
      `Collection "${collection.name}": is scheduled by ${declared.join(" and ")}, but this page set was collected with no instant to schedule against — pass one to collectPages, as pagedeck build passes its build stamp's createdAt`,
    );
  }
  return listDueEntries(store, collection, now);
}

export function fromCollection<TOut, TIn = TOut>(
  collection: Collection<TOut, TIn>,
  source: {
    route?: (entry: Entry<TOut>) => Route | undefined;
    dependsOn?: (
      entry: Entry<TOut>,
      store: ContentStoreReader,
    ) => readonly EntryRef[];
    sharedDependsOn?: (store: ContentStoreReader) => readonly EntryRef[];
    relatesTo?: (
      entry: Entry<TOut>,
      store: ContentStoreReader,
    ) => readonly EntryRef[];
    layout?: string;
  } = {},
): PageSource<Entry<TOut>> {
  return {
    ...(source.layout === undefined ? {} : { layout: source.layout }),
    route: (instance) =>
      source.route === undefined
        ? entryRoute(instance.params.path)
        : source.route(instance.params),
    instances: (store, now) => {
      const shared = source.sharedDependsOn?.(store) ?? [];
      return scheduledEntries(collection, store, now).map((entry) => ({
        locale: entry.locale,
        params: entry,
        entry: {
          collection: entry.collection,
          entry: { locale: entry.locale, path: entry.path },
          template: collection.templates?.templateOf(entry),
        },
        dependencies: [
          {
            collection: entry.collection,
            locale: entry.locale,
            path: entry.path,
          },
          ...(source.dependsOn?.(entry, store) ?? []),
          ...shared,
        ],
        relations: source.relatesTo?.(entry, store),
      }));
    },
  };
}

type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * One match per param, the catch-all told apart afterwards: a `[...` branch
 * tried first scans past every param before it and drops them.
 */
type Parse<S extends string> = S extends `${string}[${infer N}]${infer Tail}`
  ? (N extends `...${infer R}`
      ? { [K in R]: readonly string[] }
      : { [K in N]: string }) &
      Parse<Tail>
  : {};

/** Off the raw `Parse<S>`: `keyof Record<string, never>` is `string`. */
type HasParams<S extends string> = keyof Parse<S> extends never ? false : true;

/** `Record<string, never>`, not `{}`, which accepts `href("/about", 42)`. */
export type ParamsOf<S extends string> =
  HasParams<S> extends true ? Prettify<Parse<S>> : Record<string, never>;

declare const TEMPLATE: unique symbol;

/** The brand is required: optional, every object type satisfies it. */
type Templated<S extends string> = ParamsOf<S> & {
  readonly [TEMPLATE]: S;
};

type TemplatesOf<T extends readonly unknown[]> = Extract<
  T[number],
  { readonly [TEMPLATE]: string }
>[typeof TEMPLATE];

/**
 * Distributed over the union: undistributed, a set mixing templated and
 * paramless sources fits neither overload.
 */
type Paramless<S extends string> = S extends unknown
  ? HasParams<S> extends true
    ? never
    : S
  : never;

const CATCH_ALL_SEGMENT = /^\[\.\.\.([^[\]]+)\]$/;

/** Global is safe here: only `replace` reads it, and it resets `lastIndex`. */
const PARAM = /\[([^[\]]+)\]/g;

function refuseMixedCatchAll(template: string): void {
  for (const [index, segment] of segmentsOf(template).entries()) {
    if (!segment.includes("[...")) continue;
    if (CATCH_ALL_SEGMENT.test(segment)) continue;
    throw new ConfigError(
      `Route template "${template}": segments[${String(index)}] holds a catch-all alongside other text, and a catch-all stands for whole segments — give it a segment of its own, like "/x/[...rest]"`,
    );
  }
}

function segmentsOf(template: string): string[] {
  return template.split("/").filter((segment) => segment !== "");
}

/**
 * Checks every param although the types do: `href` is reachable from JavaScript
 * and CMS data, and an unchecked param links to `/blog/undefined` (#131).
 */
function lowerTemplate(
  template: string,
  params: Record<string, unknown>,
): Route {
  const segments = segmentsOf(template).flatMap((segment) => {
    const catchAll = CATCH_ALL_SEGMENT.exec(segment);
    if (catchAll === null) {
      return [
        segment.replace(PARAM, (_match, name: string) =>
          plainParam(template, params, name),
        ),
      ];
    }
    return catchAllParam(template, params, catchAll[1] ?? "");
  });
  // The root as the string form: an empty list assembles to `""`, which is
  // refused as an empty route.
  return segments.length === 0 ? "/" : segments;
}

function plainParam(
  template: string,
  params: Record<string, unknown>,
  name: string,
): string {
  const value = params[name];
  if (value === undefined) {
    throw new ConfigError(
      `Route template "${template}": param "${name}" has no value, so the route would spell it "undefined" — pass a value for every param the template names`,
    );
  }
  if (typeof value !== "string") {
    throw new ConfigError(
      `Route template "${template}": param "${name}" has type "${typeof value}", not "string" — pass a string for every param the template names`,
    );
  }
  return value;
}

function catchAllParam(
  template: string,
  params: Record<string, unknown>,
  name: string,
): string[] {
  const value = params[name];
  if (!isSegmentList(value)) {
    throw new ConfigError(
      `Route template "${template}": catch-all param "${name}" is not a list of strings — pass one string per segment, like ["guide", "intro"]`,
    );
  }
  if (value.length === 0) {
    throw new ConfigError(
      `Route template "${template}": catch-all param "${name}" holds no segments, so the route would collapse onto a shorter path — pass at least one segment`,
    );
  }
  return [...value];
}

/** A predicate, because `Array.isArray` alone narrows to `any[]`. */
function isSegmentList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === "string")
  );
}

export function fromTemplate<const S extends string>(
  template: S,
  instances: (
    store: ContentStoreReader,
  ) => readonly RouteInstance<ParamsOf<S>>[],
): PageSource<Templated<S>> {
  refuseMixedCatchAll(template);
  return {
    route: (instance: RouteInstance<ParamsOf<S>>) =>
      lowerTemplate(template, instance.params),
    instances,
    // Through `unknown`: with `S` unresolved the compiler relates neither type
    // to the other. They differ only by a phantom field.
  } as unknown as PageSource<Templated<S>>;
}

function linkSubject(template: string): string {
  return `Link to "${template}"`;
}

function spellLocales(locales: LocaleSet): string {
  return [...locales.keys()].map((code) => `"${code}"`).join(", ");
}

function linkLocale(
  locales: LocaleSet,
  template: string,
  code: string | undefined,
): PlacedLocale {
  if (code === undefined) {
    const only = locales.size === 1 ? [...locales.values()][0] : undefined;
    if (only === undefined) {
      throw new ConfigError(
        `${linkSubject(template)}: no locale was given, and the site declares more than one — pass the locale as the last argument, one of: ${spellLocales(locales)}`,
      );
    }
    return only;
  }
  const declared = locales.get(code);
  if (declared === undefined) {
    throw new ConfigError(
      `${linkSubject(template)}: locale ${quoteIdentifier(code)} is not declared, so it has no output tree — pass a declared locale, one of: ${spellLocales(locales)}`,
    );
  }
  return declared;
}

function linkTo(
  site: SiteAddressing,
  template: string,
  params: Record<string, unknown>,
  code: string | undefined,
): string {
  const locale = linkLocale(site.locales, template, code);
  const route = lowerTemplate(template, params);
  const reason = unusableSegmentReason(route);
  if (reason !== undefined) {
    throw new ConfigError(
      `${linkSubject(template)}: ${reason} — give the param a value that is one, or link to a different page`,
    );
  }
  return addressOf(site, locale.prefix, route);
}

function addressOf(site: SiteAddressing, prefix: string, route: Route): string {
  const path = normalizeOutputPath(assembleRoute(route), site.trailingSlash);
  return normalizeOutputPath(`${prefix}${path}`, site.trailingSlash);
}

const PAGE_SEGMENT = "page";

function pageRoute(path: readonly string[], number: number): Route {
  if (number === 1) return path.length === 0 ? "/" : [...path];
  return [...path, PAGE_SEGMENT, String(number)];
}

export interface PagedList<TOut> {
  readonly locale: string;
  readonly path: readonly string[];
  readonly entries: readonly Entry<TOut>[];
  readonly dependsOn?: readonly EntryRef[];
}

export interface PagedRoute {
  readonly path: readonly string[];
  readonly number: number;
}

export function paginate<TOut>(options: {
  pageSize: number;
  lists: (
    store: ContentStoreReader,
    now: string | undefined,
  ) => readonly PagedList<TOut>[];
}): PageSource<PagedRoute> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1) {
    throw new ConfigError(
      `Paged list: pageSize is ${JSON.stringify(options.pageSize)}, and a page holds at least one entry — pass a whole number of 1 or more`,
    );
  }
  return {
    route: ({ params }) => pageRoute(params.path, params.number),
    instances: (store, now, site) =>
      // Annotated: the two branches infer different object types.
      options.lists(store, now).flatMap((list): RouteInstance<PagedRoute>[] => {
        if (unusableSegmentReason(list.path) !== undefined) {
          return [
            {
              locale: list.locale,
              params: { path: list.path, number: 1 },
              dependencies: [],
            },
          ];
        }
        const prefix = site.locales.get(list.locale)?.prefix ?? "";
        const total = Math.max(
          1,
          Math.ceil(list.entries.length / options.pageSize),
        );
        const addressAt = (number: number): string =>
          addressOf(site, prefix, pageRoute(list.path, number));
        return Array.from({ length: total }, (_unused, index) => {
          const number = index + 1;
          const entries = list.entries.slice(
            index * options.pageSize,
            number * options.pageSize,
          );
          return {
            locale: list.locale,
            params: { path: list.path, number },
            paging: {
              number,
              total,
              ...(number === 1 ? {} : { prev: addressAt(number - 1) }),
              ...(number === total ? {} : { next: addressAt(number + 1) }),
            },
            // The page's own entries first: `erase` keeps the first occurrence
            // of a ref.
            dependencies: [
              ...entries.map((entry) => ({
                collection: entry.collection,
                locale: entry.locale,
                path: entry.path,
              })),
              ...(list.dependsOn ?? []),
            ],
          };
        });
      }),
  };
}

/**
 * `sources` is a bare mapped type, not `readonly [...{ … }]`: under the spread,
 * sources over unrelated entry types leave each `route` parameter `any`.
 */
export function definePages<T extends readonly unknown[]>(options: {
  sources: { [K in keyof T]: PageSource<T[K]> };
  trailingSlash?: TrailingSlash;
  locales?: LocaleSet;
}): PageSet<TemplatesOf<T>> {
  const site: SiteAddressing = {
    trailingSlash: options.trailingSlash ?? "never",
    locales:
      options.locales ??
      defineLocales({ en: { label: "English", direction: "ltr" } }),
  };
  return {
    ...site,
    sources: options.sources.map((source, index) => erase(source, index, site)),
    layouts: options.sources.map((source) => source.layout),
    href: hrefIn(site),
  };
}

/**
 * Standalone, so its declared return type checks it against both overloads; an
 * inline method is checked against one.
 */
function hrefIn(site: SiteAddressing): PageSet<string>["href"] {
  return (
    template: string,
    paramsOrLocale?: Record<string, unknown> | string,
    locale?: string,
  ): string =>
    typeof paramsOrLocale === "string" || paramsOrLocale === undefined
      ? linkTo(site, template, {}, paramsOrLocale)
      : linkTo(site, template, paramsOrLocale, locale);
}

function dotSegment(segment: string): "." | ".." | undefined {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (decoded === "." || decoded === "..") return decoded;
  return undefined;
}

function removeDotSegments(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/").slice(1)) {
    const dots = dotSegment(segment);
    if (dots === ".") continue;
    if (dots === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/** Not global: a `/g` regex carries `lastIndex`, and two readers share this. */
const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;

const PATH_DELIMITER = /[?#]/;

const LONE_SURROGATE = /\p{Surrogate}/u;

const UNRESERVED = /[A-Za-z0-9\-._~]/;

const ESCAPE_OR_RUN = /%[0-9A-Fa-f]{2}|[^%]+/g;

function upTo(path: string, pattern: RegExp): string {
  return `${path.slice(0, path.search(pattern) + 1)}…`;
}

/**
 * Decodes escapes of unreserved characters only: a decoded `%2F` would invent a
 * segment. The delimiter is tested first, so no credential reaches a message.
 */
export function canonicalizePath(path: string): string {
  if (PATH_DELIMITER.test(path)) {
    throw new ConfigError(
      `Path "${upTo(path, PATH_DELIMITER)}": holds a query or fragment — pass the path alone, or escape the delimiter as "%3F" or "%23"`,
    );
  }
  if (MALFORMED_ESCAPE.test(path)) {
    throw new ConfigError(
      `Path "${upTo(path, MALFORMED_ESCAPE)}": holds a malformed percent-escape — complete it with two hex digits, or write "%25" for a literal percent sign`,
    );
  }
  if (LONE_SURROGATE.test(path)) {
    throw new ConfigError(
      `Path "${upTo(path, LONE_SURROGATE)}": holds a lone surrogate — pair it with the other half of its code point, or remove it`,
    );
  }
  return path.replace(ESCAPE_OR_RUN, (token) => {
    if (!token.startsWith("%")) return encodeURI(token);
    // One byte: only an ASCII byte can be unreserved, so `%C3%A9` stays
    // escaped.
    const character = String.fromCharCode(Number.parseInt(token.slice(1), 16));
    return UNRESERVED.test(character) ? character : token.toUpperCase();
  });
}

export function normalizeOutputPath(
  route: string,
  trailingSlash: TrailingSlash,
): `/${string}` {
  const canonical = normalizeOutputPrefix(route);
  const bare = canonical.slice(1).replace(/\/$/, "");
  if (bare === "") return "/";
  return trailingSlash === "always" ? `/${bare}/` : `/${bare}`;
}

/**
 * Resolves dot segments before collapsing slashes: collapsed first, `/a//../b`
 * becomes `/b`, where a browser resolves `/a/b`.
 */
export function normalizeOutputPrefix(prefix: string): `/${string}` {
  const rooted = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const resolved = removeDotSegments(rooted);
  const collapsed = resolved.replace(/\/{2,}/g, "/");
  const canonical = canonicalizePath(collapsed);
  const bare = canonical.startsWith("/") ? canonical.slice(1) : canonical;
  return `/${bare}`;
}

interface RoutedPage extends Page {
  sourceIndex: number;
  instanceIndex: number;
}

interface Collision {
  locale: string;
  path: string;
  claimants: readonly RoutedPage[];
}

function findCollisions(table: readonly RoutedPage[]): Collision[] {
  const claimed = new Map<string, RoutedPage[]>();
  for (const page of table) {
    const key = `${page.locale} ${page.path}`;
    const already = claimed.get(key);
    if (already === undefined) claimed.set(key, [page]);
    else already.push(page);
  }
  return [...claimed.values()]
    .filter((claimants) => claimants.length > 1)
    .map((claimants) => ({
      locale: claimants[0]?.locale ?? "",
      path: claimants[0]?.path ?? "",
      claimants,
    }));
}

function describeClaimant(
  row: {
    sourceIndex: number;
    instanceIndex: number;
    locale: string;
    collection?: string;
    entry?: EntryId;
  },
  { spellLocale }: { spellLocale: boolean },
): string {
  const source = `sources[${String(row.sourceIndex)}]`;
  if (row.collection === undefined || row.entry === undefined) {
    const instance = `${source} instances[${String(row.instanceIndex)}]`;
    return spellLocale
      ? `${instance} in locale ${quoteIdentifier(row.locale)}`
      : instance;
  }
  return `${source} "${row.collection}" ${printable(`/${row.entry.locale}/${row.entry.path}`)}`;
}

const SUBJECT = "Route table: ";

const COLLISION_FIX = "give each entry its own route, or emit only one of them";

function collisionReport(collisions: readonly Collision[]): string {
  const count = collisions.length;
  const headline =
    count === 1
      ? "1 route is claimed by more than one entry"
      : `${String(count)} routes are each claimed by more than one entry`;
  const detail = collisions
    .flatMap((collision) =>
      collision.claimants.map(
        (page) =>
          `  ${quoteIdentifier(collision.path)} in locale ${quoteIdentifier(collision.locale)} — ${describeClaimant(page, { spellLocale: false })}`,
      ),
    )
    .join("\n");
  return `${SUBJECT}${headline} — ${COLLISION_FIX}:\n${detail}`;
}

interface UnusableRoute {
  draft: DraftPage;
  reason: string;
}

const UNUSABLE_ROUTE_FIX =
  'return a path like "/pricing", or undefined to emit no page';

function unusableRouteReport(unusable: readonly UnusableRoute[]): string {
  const count = unusable.length;
  const headline =
    count === 1
      ? "1 route is not a usable path"
      : `${String(count)} routes are not usable paths`;
  const detail = unusable
    .map(
      ({ draft, reason }) =>
        `  ${describeClaimant(draft, { spellLocale: true })} — ${reason}`,
    )
    .join("\n");
  return `${SUBJECT}${headline} — ${UNUSABLE_ROUTE_FIX}:\n${detail}`;
}

const UNDECLARED_LOCALE_FIX =
  "declare the locale in defineLocales, or stop emitting the entry";

function undeclaredLocaleReport(drafts: readonly DraftPage[]): string {
  const count = drafts.length;
  const headline =
    count === 1
      ? "1 page is in a locale the site does not declare"
      : `${String(count)} pages are in locales the site does not declare`;
  const detail = drafts
    .map(
      (draft) =>
        `  ${describeClaimant(draft, { spellLocale: false })} — locale ${quoteIdentifier(draft.locale)}`,
    )
    .join("\n");
  return `${SUBJECT}${headline} — ${UNDECLARED_LOCALE_FIX}:\n${detail}`;
}

/**
 * The delimiter is tested first, so a route holding one is cut there and
 * nothing past it reaches the message (rule 6).
 */
function unusableReason(route: string): string | undefined {
  if (route === "") return "the route is empty";
  if (PATH_DELIMITER.test(route)) {
    return `the route holds a query or fragment: ${quoteIdentifier(upTo(route, PATH_DELIMITER))}`;
  }
  if (MALFORMED_ESCAPE.test(route)) {
    return `the route holds a malformed percent-escape: ${quoteIdentifier(upTo(route, MALFORMED_ESCAPE))}`;
  }
  if (LONE_SURROGATE.test(route)) {
    return `the route holds a lone surrogate: ${quoteIdentifier(upTo(route, LONE_SURROGATE))}`;
  }
  return undefined;
}

/**
 * Keyed by path, never by entry id: a locale serving `/pricing` from an entry
 * named `preise` has translated that path.
 */
function nativePaths(
  table: readonly RoutedPage[],
): Map<string, Map<string, RoutedPage>> {
  const native = new Map<string, Map<string, RoutedPage>>();
  for (const page of table) {
    const inLocale = native.get(page.locale) ?? new Map<string, RoutedPage>();
    native.set(page.locale, inLocale);
    if (!inLocale.has(page.path)) inLocale.set(page.path, page);
  }
  return native;
}

/** Keeps its own `visited` set: a hand-built `LocaleSet` can hold a cycle. */
function fallbackPages(
  table: readonly RoutedPage[],
  locales: LocaleSet,
  trailingSlash: TrailingSlash,
): RoutedPage[] {
  const native = nativePaths(table);
  const filled: RoutedPage[] = [];
  for (const locale of locales.values()) {
    const claimed = new Set(native.get(locale.code)?.keys() ?? []);
    const visited = new Set([locale.code]);
    let hop = locale.fallback;
    while (hop !== undefined && !visited.has(hop)) {
      visited.add(hop);
      for (const [path, supplier] of native.get(hop) ?? []) {
        if (claimed.has(path)) continue;
        claimed.add(path);
        filled.push({
          locale: locale.code,
          path: supplier.path,
          domain: localeTree(locale),
          declaredDomain: locale.domain,
          output: normalizeOutputPath(
            `${locale.prefix}${supplier.path}`,
            trailingSlash,
          ),
          collection: supplier.collection,
          entry: supplier.entry,
          template: supplier.template,
          ...(supplier.layout === undefined ? {} : { layout: supplier.layout }),
          dependencies: supplier.dependencies,
          relations: supplier.relations,
          fallbackFrom: supplier.locale,
          sourceIndex: supplier.sourceIndex,
          instanceIndex: supplier.instanceIndex,
        });
      }
      hop = locales.get(hop)?.fallback;
    }
  }
  return filled;
}

export function collectPages(
  store: ContentStoreReader,
  pages: PageSet,
  now?: string,
): Page[] {
  const drafts = pages.sources.flatMap((source) => source(store, now));

  const unusable: UnusableRoute[] = [];
  const undeclared: DraftPage[] = [];
  const routable: RoutableDraft[] = [];
  for (const draft of drafts) {
    // The segment verdict first: assembled, a bad segment reads as a good path.
    if (draft.segmentReason !== undefined) {
      unusable.push({ draft, reason: draft.segmentReason });
    } else {
      const reason = unusableReason(draft.route);
      if (reason === undefined) routable.push(draft);
      else unusable.push({ draft, reason });
    }
    if (!pages.locales.has(draft.locale)) undeclared.push(draft);
  }
  const wiringFaults = [
    ...(unusable.length > 0 ? [unusableRouteReport(unusable)] : []),
    ...(undeclared.length > 0 ? [undeclaredLocaleReport(undeclared)] : []),
  ];
  if (wiringFaults.length > 0) {
    throw new ConfigError(wiringFaults.join("\n\n"));
  }

  const table: RoutedPage[] = routable.map((draft) => {
    const path = normalizeOutputPath(draft.route, pages.trailingSlash);
    // Always hits: pass 1 refused every undeclared locale.
    const locale = pages.locales.get(draft.locale);
    const prefix = locale?.prefix ?? "";
    return {
      locale: draft.locale,
      path,
      domain: locale === undefined ? undefined : localeTree(locale),
      declaredDomain: locale?.domain,
      // From the normalized path: a bare `pricing` under `/de` would be
      // `/depricing`.
      output: normalizeOutputPath(`${prefix}${path}`, pages.trailingSlash),
      collection: draft.collection,
      entry: draft.entry,
      template: draft.template,
      ...(draft.layout === undefined ? {} : { layout: draft.layout }),
      dependencies: draft.dependencies,
      relations: draft.relations,
      paging: draft.paging,
      sourceIndex: draft.sourceIndex,
      instanceIndex: draft.instanceIndex,
    };
  });
  const filled = fallbackPages(table, pages.locales, pages.trailingSlash);
  table.push(...filled);
  const collisions = findCollisions(table);
  if (collisions.length > 0) throw new Error(collisionReport(collisions));

  table.sort((a, b) => {
    if (a.locale !== b.locale) return a.locale < b.locale ? -1 : 1;
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
  return table.map(
    ({ sourceIndex: _sourceIndex, instanceIndex: _instanceIndex, ...page }) =>
      page,
  );
}
