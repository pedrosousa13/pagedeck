import { ConfigError } from "./exit.js";
import { domainHost } from "./locales.js";
import { quote } from "./quote.js";
import { fileKey, MANIFEST_FILE } from "./manifest.js";
import type { EmittedFile, SiteFacts } from "./manifest.js";
import type { RedirectRecord } from "./incremental.js";
import { normalizeOutputPath, normalizeOutputPrefix } from "./pages.js";
import type { Page, TrailingSlash } from "./pages.js";

/**
 * Apart from `MANIFEST_VERSION` because `@pagedeck/edge` reads this document alone.
 * When it moves is ADR 0008's rule.
 */
export const ROUTING_VERSION = 1;

export type { TrailingSlash } from "./pages.js";

export type RedirectStatus = 301 | 302 | 307 | 308;

export type RedirectSource = "config" | "deleted-page";

export interface ResolvedRedirect {
  from: string;
  to: string;
  file?: true;
  status: RedirectStatus;
  source: RedirectSource;
  via: readonly string[];
}

export interface HeaderField {
  name: string;
  value: string;
}

export interface HeaderRule {
  prefix: string;
  set: readonly HeaderField[];
}

/**
 * No HSTS and no CSP: a value spread unread must not be able to lock a host out
 * of plain HTTP or break a page (#318).
 */
export const SECURITY_HEADERS = [
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "X-Frame-Options", value: "DENY" },
  { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
] as const satisfies readonly HeaderField[];

export const VARIANT_SEGMENT = "_v";

export const DEPLOY_MANIFEST_PATH = `/${MANIFEST_FILE}`;

export const DEPLOY_DIRECTORY = "/.pagedeck";

export function isReservedDeployKey(path: string): boolean {
  const bare = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return (
    bare === DEPLOY_MANIFEST_PATH ||
    bare === DEPLOY_DIRECTORY ||
    bare.startsWith(`${DEPLOY_DIRECTORY}/`)
  );
}

const VARIANT_PREFIX = `/${VARIANT_SEGMENT}/`;

/**
 * Normalizes nothing: both callers pass a spelled path, and a respelling could
 * rewrite a name the manifest and the cookie agree on.
 */
export function variantPath(name: string, path: string): string {
  return `${VARIANT_PREFIX}${name}${path}`;
}

export interface WeightedVariant {
  name: string;
  weight: number;
}

export interface ResolvedExperiment {
  path: string;
  cookie: string;
  /**
   * Sorted by `name`: in authored order, reordering the config would re-assign
   * every visitor already holding a cookie.
   */
  variants: readonly WeightedVariant[];
}

export interface RoutingTree {
  domain?: string;
  redirects: readonly ResolvedRedirect[];
  notFound?: string;
  headers: readonly HeaderRule[];
  experiments?: readonly ResolvedExperiment[];
}

export interface RoutingManifest {
  version: number;
  site: SiteFacts;
  trees: readonly RoutingTree[];
}

export interface RedirectRule {
  domain?: string;
  from: string;
  to: string;
  status?: RedirectStatus;
}

export interface NotFoundRule {
  domain?: string;
  locale: string;
  path: string;
}

export interface VariantRule {
  domain?: string;
  locale: string;
  path: string;
  cookie: string;
  variants: readonly WeightedVariant[];
}

export interface RoutingConfig {
  redirects?: readonly RedirectRule[];
  notFound?: readonly NotFoundRule[];
  headers?: readonly (HeaderRule & { domain?: string })[];
  experiments?: readonly VariantRule[];
}

export interface RoutingInput {
  pages: readonly Page[];
  trailingSlash: TrailingSlash;
  config?: RoutingConfig;
  emitted?: readonly Pick<EmittedFile, "domain" | "path" | "page">[];
  removals?: readonly RedirectRecord[];
}

const STATUSES: readonly number[] = [301, 302, 307, 308];

const DEFAULT_STATUS: RedirectStatus = 308;

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const CONTROL = /[\u0000-\u001F\u007F]/;

const CRLF = /[\r\n]/;

export const OFFSITE_TARGET_FIX =
  'write a tree-relative path like "/pricing"; a target off this site compiles to an open redirect at the edge';
export const OFFSITE_SOURCE_FIX =
  'write a tree-relative path like "/pricing"; the edge matches the path alone, so a source spelled as a URL is a rule that can never fire';
const HEADER_INJECTION_FIX =
  "remove it — a header field that can hold a line break can write a second header";
export const UNSENDABLE_HEADER_VALUE_FIX =
  "remove the character; a field value may hold no control character but HTAB (RFC 9110 forbids the C0 ones and DEL, and a C1 one reaches a headers file as two bytes of UTF-8), since a line break can write a second header, and a Worker's Headers refuses any character above U+00FF";
export const HEADER_NAME_TOKEN_FIX =
  'write the name as a header field name, such as "X-Frame-Options"; a name that is not one is emitted verbatim, and each target then either reads that line as a different field than the one written, or refuses it outright after the build has already reported success';
export const HEADER_NAME_LEADING_FIX = "drop the leading character from the name";
const LOCATION_HEADER_FIX =
  "to send a path elsewhere, write a redirect rule";
const BAD_STATUS_FIX = "use 301, 302, 307 or 308";
const UNOCCUPIED_DOMAIN_FIX =
  "route a locale to that domain, or move the rule to a tree this build emits";
const SHADOWED_PAGE_FIX =
  "move the page or drop the rule — a page and a redirect cannot both answer one path, and the route table has no precedence rules";
const CONTESTED_PATH_FIX = "give each path one target and one status";
const CONTESTED_PREFIX_FIX = "give each prefix one header set";
const DEAD_TARGET_FIX =
  "point it at a page this build routes or a file it emits, or drop the rule";
const CROSS_TREE_TARGET_FIX =
  "redirect within one tree — a tree-relative path cannot name a page on another host";
const UNROUTED_NOT_FOUND_FIX =
  "name a page by the locale and path the route table spells it with";
const CONTESTED_NOT_FOUND_FIX = "give each output tree one 404 page";
const LOOP_FIX = "point one of these at a page this build routes";
const NO_VARIANTS_FIX =
  "list at least one variant, or drop the experiment; an experiment with no variants emits nothing and assigns nobody";
const VARIANT_NAME_FIX =
  'name each variant the way a path spells one segment, such as "b"';
const REPEATED_VARIANT_FIX = "give each variant of one page its own name";
const VARIANT_WEIGHT_FIX =
  "write a positive number, such as 50; the shares are relative, so they need not total anything in particular";
const COOKIE_KEY_FIX = 'write the key as a cookie name, such as "fw_pricing"';
const UNROUTED_EXPERIMENT_FIX =
  "name a page by the locale and path the route table spells it with, or drop the experiment";
const CONTESTED_EXPERIMENT_FIX = "give each page one experiment";
const RESERVED_SEGMENT_FIX = `move the page out of "${VARIANT_PREFIX}", or drop the experiments in its tree`;
const RESERVED_KEY_FIX = `move each off "${DEPLOY_MANIFEST_PATH}" and out of "${DEPLOY_DIRECTORY}/"; every target answers 404 there, so nothing routed at one of them is ever served`;

function report(headline: string, lines: readonly string[]): string {
  return `Routing manifest: ${headline}:\n${lines.join("\n")}`;
}

function treeNamer(
  pages: readonly Page[],
): (domain: string | undefined) => string {
  const declared = new Map<string, Set<string>>();
  for (const page of pages) {
    const { domain, declaredDomain } = page;
    if (domain === undefined || declaredDomain === undefined) continue;
    if (declaredDomain === domain) continue;
    const spellings = declared.get(domain) ?? new Set<string>();
    declared.set(domain, spellings);
    spellings.add(declaredDomain);
  }
  return (domain) => {
    if (domain === undefined) return "the default tree";
    const spellings = [...(declared.get(domain) ?? [])].sort();
    const aside =
      spellings.length === 0
        ? ""
        : ` (declared ${spellings.map((one) => `"${one}"`).join(", ")})`;
    return `the "${domain}" tree${aside}`;
  };
}

function at(list: string, index: number, field?: string): string {
  const where = `${list}[${String(index)}]`;
  return field === undefined ? where : `${where}.${field}`;
}

const REDIRECTS = "build.routing.redirects";
const HEADERS = "build.routing.headers";
const NOT_FOUND = "build.routing.notFound";
const REMOVAL = "a redirect for a page this build deleted";

interface DraftRedirect {
  domain?: string;
  from: string;
  to: string;
  status: RedirectStatus;
  source: RedirectSource;
  where: string;
}

interface DraftHeaders {
  domain?: string;
  prefix: string;
  set: readonly HeaderField[];
  where: string;
}

interface DraftNotFound {
  domain?: string;
  locale: string;
  path: string;
  where: string;
}

interface DraftExperiment {
  domain?: string;
  locale: string;
  path: string;
  cookie: string;
  variants: readonly WeightedVariant[];
  where: string;
}

const COOKIE_SEPARATORS = new Set([...'()<>@,;:\\"/[]?={} \t']);

function unusableCookie(key: string): string | undefined {
  if (key === "") return "the cookie key is empty";
  if (CONTROL.test(key)) return "the cookie key holds a control character";
  const separator = [...key].find((one) => COOKIE_SEPARATORS.has(one));
  if (separator !== undefined) {
    return `the cookie key holds ${JSON.stringify(separator)}, which ends a cookie name`;
  }
  const wide = [...key].find((one) => (one.codePointAt(0) ?? 0) > 0x7e);
  return wide === undefined
    ? undefined
    : `the cookie key holds ${JSON.stringify(wide)}, and a cookie name is ASCII`;
}

/** An alphabet, not a normalizer: `..` must be refused, not resolved. */
const VARIANT_NAME_CHARACTER = /[^A-Za-z0-9._-]/;

function unusableVariantName(name: string): string | undefined {
  if (name === "") return "the variant name is empty";
  if (name === "." || name === "..") {
    return "the variant name is a dot segment, which resolves out of the variant tree";
  }
  const held = [...name].find((one) => VARIANT_NAME_CHARACTER.test(one));
  return held === undefined
    ? undefined
    : `the variant name holds ${JSON.stringify(held)}, and a variant name is one path segment of a URL`;
}

const HEADER_NAME_CHARACTER = /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/;

/**
 * `__proto__` is a legal name and passes: the CloudFront generator is where
 * that one is handled (`headerStage`).
 */
export function unusableHeaderName(name: string): string | undefined {
  if (name === "") return "the header name is empty";
  const held = [...name].find((one) => HEADER_NAME_CHARACTER.test(one));
  return held === undefined
    ? undefined
    : `the header name holds ${JSON.stringify(held)}, and a header name is one RFC 9110 token`;
}

/** A token all the same, so read only after `unusableHeaderName` passes the name. */
export function unwritableHeaderName(name: string): string | undefined {
  if (name.startsWith("#")) {
    return 'the header name begins "#", which a line-based headers file can read as the start of a comment';
  }
  if (name.startsWith("!")) {
    return 'the header name begins "!", which a line-based headers file can read as a detach';
  }
  return undefined;
}

function unsendableInHeaderValue(point: number): boolean {
  return (point < 0x20 && point !== 0x09) || (point >= 0x7f && point <= 0x9f) || point > 0xff;
}

export function unusableHeaderValue(value: string): string | undefined {
  const held = [...value]
    .map((one) => one.codePointAt(0) ?? 0)
    .find(unsendableInHeaderValue);
  return held === undefined
    ? undefined
    : `the header value holds U+${held.toString(16).toUpperCase().padStart(4, "0")}`;
}

function spell(
  path: string,
  spelling: (path: string) => string,
  where: string,
  unusable: string[],
): string | undefined {
  try {
    return spelling(path);
  } catch (cause) {
    unusable.push(`  ${where} — ${(cause as Error).message}`);
    return undefined;
  }
}

/**
 * Read before normalization, which spells `//evil.example` as the local
 * `/evil.example`; a browser reads `\` as `/`, so it is refused anywhere.
 */
export function offsiteReason(
  value: string,
  end: "target" | "source",
): string | undefined {
  if (SCHEME.test(value)) return `the ${end} holds a scheme`;
  if (value.startsWith("//")) return `the ${end} begins "//", which is a host`;
  if (value.includes("\\")) return `the ${end} holds a backslash`;
  if (CONTROL.test(value)) return `the ${end} holds a control character`;
  return undefined;
}

function throwIfAny(sections: readonly string[]): void {
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));
}

function draft(input: RoutingInput): {
  redirects: DraftRedirect[];
  headers: DraftHeaders[];
  notFound: DraftNotFound[];
  experiments: DraftExperiment[];
} {
  const { trailingSlash } = input;
  const asPath = (path: string): string =>
    normalizeOutputPath(path, trailingSlash);
  // An emitted file keeps its own spelling, matched before the policy, which
  // would turn `/sitemap.xml` into `/sitemap.xml/` (#607).
  const files = fileTargets(input);
  const asTarget =
    (domain: string | undefined) =>
    (path: string): string => {
      const file = normalizeOutputPath(path, "never");
      return files.has(fileKey(domain, file)) ? file : asPath(path);
    };
  const rules = input.config?.redirects ?? [];
  const removals = input.removals ?? [];
  const headerRules = input.config?.headers ?? [];
  const notFoundRules = input.config?.notFound ?? [];
  const experimentRules = input.config?.experiments ?? [];

  const keyOf = new Map<string, string>();
  for (const page of input.pages) {
    if (page.declaredDomain !== undefined && page.domain !== undefined)
      keyOf.set(page.declaredDomain, page.domain);
  }
  const inTree = (domain: string | undefined): { domain?: string } =>
    domain === undefined
      ? {}
      : { domain: keyOf.get(domain) ?? domainHost(domain) ?? domain };

  const unusable: string[] = [];
  const offsiteTarget: string[] = [];
  const offsiteSource: string[] = [];
  const injected: string[] = [];
  const badHeaderNames: string[] = [];
  const unwritableHeaderNames: string[] = [];
  const badHeaderValues: string[] = [];
  const locationHeaders: string[] = [];
  const badStatus: string[] = [];
  const noVariants: string[] = [];
  const variantNames: string[] = [];
  const repeatedVariants: string[] = [];
  const badWeights: string[] = [];
  const badCookies: string[] = [];

  const redirects: DraftRedirect[] = [];
  rules.forEach((rule, index) => {
    const where = at(REDIRECTS, index);
    const fromReason = offsiteReason(rule.from, "source");
    if (fromReason !== undefined)
      offsiteSource.push(`  ${where} — ${fromReason}`);
    const from =
      fromReason === undefined
        ? spell(rule.from, asPath, `${where}.from`, unusable)
        : undefined;
    const tree = inTree(rule.domain);
    const toReason = offsiteReason(rule.to, "target");
    if (toReason !== undefined) offsiteTarget.push(`  ${where} — ${toReason}`);
    const to =
      toReason === undefined
        ? spell(rule.to, asTarget(tree.domain), `${where}.to`, unusable)
        : undefined;
    const status = rule.status ?? DEFAULT_STATUS;
    if (!STATUSES.includes(status)) {
      badStatus.push(`  ${where} — status ${String(status)}`);
      return;
    }
    if (from === undefined || to === undefined) return;
    redirects.push({
      ...tree,
      from,
      to,
      status,
      source: "config",
      where,
    });
  });

  removals.forEach((record) => {
    const where = REMOVAL;
    // Checked although typed: `RedirectRecord.status` widens to `number`.
    if (!STATUSES.includes(record.status)) {
      badStatus.push(`  ${where} — status ${String(record.status)}`);
      return;
    }
    // Spelled again: `from` comes off the previous manifest, whose
    // trailing-slash policy nothing records.
    const from = spell(record.from, asPath, `${where} — "from"`, unusable);
    const to = spell(record.to, asPath, `${where} — "to"`, unusable);
    if (from === undefined || to === undefined) return;
    redirects.push({
      ...(record.domain === undefined ? {} : { domain: record.domain }),
      from,
      to,
      status: record.status as RedirectStatus,
      source: "deleted-page",
      where,
    });
  });

  const headers: DraftHeaders[] = [];
  headerRules.forEach((rule, index) => {
    const where = at(HEADERS, index);
    // The prefix normalizer: the trailing slash is the matcher's boundary, and
    // the path policy would widen `/docs/` onto `/docsearch`.
    const prefix = spell(
      rule.prefix,
      normalizeOutputPrefix,
      `${where}.prefix`,
      unusable,
    );
    rule.set.forEach((field, fieldIndex) => {
      const at_ = `${where}.set[${String(fieldIndex)}]`;
      if (CRLF.test(field.name))
        injected.push(`  ${at_} — the header name holds a line break`);
      const nameReason = CRLF.test(field.name)
        ? undefined
        : unusableHeaderName(field.name);
      if (nameReason !== undefined) {
        badHeaderNames.push(
          `  ${at_} — ${JSON.stringify(field.name)} — ${nameReason}`,
        );
      }
      const lineReason =
        CRLF.test(field.name) || nameReason !== undefined
          ? undefined
          : unwritableHeaderName(field.name);
      if (lineReason !== undefined) {
        unwritableHeaderNames.push(
          `  ${at_} — ${JSON.stringify(field.name)} — ${lineReason}`,
        );
      }
      const valueReason = unusableHeaderValue(field.value);
      if (valueReason !== undefined) {
        badHeaderValues.push(
          `  ${at_} — ${JSON.stringify(field.name)} — ${valueReason}`,
        );
      }
      // A token, and still refused: every target writes `Location` itself
      // (#559).
      if (field.name.toLowerCase() === "location") {
        locationHeaders.push(`  ${at_} — ${JSON.stringify(field.name)}`);
      }
    });
    if (prefix === undefined) return;
    headers.push({
      ...inTree(rule.domain),
      prefix,
      set: rule.set.map((field) => ({ name: field.name, value: field.value })),
      where,
    });
  });

  const notFound: DraftNotFound[] = [];
  notFoundRules.forEach((rule, index) => {
    const where = at(NOT_FOUND, index);
    // Through `spell`, never the normalizer directly: its throw would end the
    // pass.
    const path = spell(rule.path, asPath, `${where}.path`, unusable);
    if (path === undefined) return;
    notFound.push({
      ...inTree(rule.domain),
      locale: rule.locale,
      path,
      where,
    });
  });

  const experiments: DraftExperiment[] = [];
  experimentRules.forEach((rule, index) => {
    const where = at("experiments", index);
    // Through `spell`, never the normalizer directly: its throw would end the
    // pass.
    const path = spell(rule.path, asPath, `${where}.path`, unusable);
    const cookieReason = unusableCookie(rule.cookie);
    // The cookie key is never quoted: a site may spell one out of a secret.
    if (cookieReason !== undefined)
      badCookies.push(`  ${where} — ${cookieReason}`);
    const seen = new Set<string>();
    const repeated = new Set<string>();
    rule.variants.forEach((variant, variantIndex) => {
      const at_ = at(`${where}.variants`, variantIndex);
      const nameReason = unusableVariantName(variant.name);
      if (nameReason !== undefined) {
        variantNames.push(
          `  ${at_} — ${JSON.stringify(variant.name)} — ${nameReason}`,
        );
      } else if (seen.has(variant.name)) repeated.add(variant.name);
      else seen.add(variant.name);
      // A `.js` config is never typechecked, and `"50"` divides into `NaN` at
      // the edge.
      if (
        typeof variant.weight !== "number" ||
        !Number.isFinite(variant.weight) ||
        variant.weight <= 0
      ) {
        badWeights.push(`  ${at_} — ${JSON.stringify(variant.weight)}`);
      }
    });
    for (const name of [...repeated].sort())
      repeatedVariants.push(`  ${where} — ${JSON.stringify(name)}`);
    if (path === undefined) return;
    if (rule.variants.length === 0) {
      noVariants.push(`  ${where} — ${rule.locale} ${path}`);
      return;
    }
    experiments.push({
      ...inTree(rule.domain),
      locale: rule.locale,
      path,
      cookie: rule.cookie,
      variants: rule.variants.map((variant) => ({
        name: variant.name,
        weight: variant.weight,
      })),
      where,
    });
  });

  throwIfAny(
    [
      unusable.length === 0
        ? undefined
        : report(
            unusable.length === 1
              ? "1 configured path is not a usable path"
              : `${String(unusable.length)} configured paths are not usable paths`,
            unusable,
          ),
      offsiteTarget.length === 0
        ? undefined
        : report(
            `${
              offsiteTarget.length === 1
                ? "1 redirect target is not a path on this site"
                : `${String(offsiteTarget.length)} redirect targets are not paths on this site`
            } — ${OFFSITE_TARGET_FIX}`,
            offsiteTarget,
          ),
      offsiteSource.length === 0
        ? undefined
        : report(
            `${
              offsiteSource.length === 1
                ? "1 redirect source is not a path on this site"
                : `${String(offsiteSource.length)} redirect sources are not paths on this site`
            } — ${OFFSITE_SOURCE_FIX}`,
            offsiteSource,
          ),
      injected.length === 0
        ? undefined
        : report(
            `${
              injected.length === 1
                ? "1 header name holds a line break"
                : `${String(injected.length)} header names hold line breaks`
            } — ${HEADER_INJECTION_FIX}`,
            injected,
          ),
      badHeaderNames.length === 0
        ? undefined
        : report(
            `${
              badHeaderNames.length === 1
                ? "1 header name is not a token"
                : `${String(badHeaderNames.length)} header names are not tokens`
            } — ${HEADER_NAME_TOKEN_FIX}`,
            badHeaderNames,
          ),
      unwritableHeaderNames.length === 0
        ? undefined
        : report(
            `${
              unwritableHeaderNames.length === 1
                ? "1 header name cannot be written to a line-based headers file"
                : `${String(unwritableHeaderNames.length)} header names cannot be written to a line-based headers file`
            } — ${HEADER_NAME_LEADING_FIX}`,
            unwritableHeaderNames,
          ),
      badHeaderValues.length === 0
        ? undefined
        : report(
            `${
              badHeaderValues.length === 1
                ? "1 header value cannot be sent"
                : `${String(badHeaderValues.length)} header values cannot be sent`
            } — ${UNSENDABLE_HEADER_VALUE_FIX}`,
            badHeaderValues,
          ),
      locationHeaders.length === 0
        ? undefined
        : report(
            `${
              locationHeaders.length === 1
                ? '1 header field is named "Location" in some letter case — remove it'
                : `${String(locationHeaders.length)} header fields are named "Location" in some letter case — remove each`
            }; every target writes "Location" itself on the redirects it answers and it means nothing on any other response, so it is refused wherever it is declared — ${LOCATION_HEADER_FIX}`,
            locationHeaders,
          ),
      badStatus.length === 0
        ? undefined
        : report(
            `${
              badStatus.length === 1
                ? "1 redirect declares a status no static host serves"
                : `${String(badStatus.length)} redirects declare statuses no static host serves`
            } — ${BAD_STATUS_FIX}`,
            badStatus,
          ),
      noVariants.length === 0
        ? undefined
        : report(
            `${
              noVariants.length === 1
                ? "1 experiment declares no variants"
                : `${String(noVariants.length)} experiments declare no variants`
            } — ${NO_VARIANTS_FIX}`,
            noVariants,
          ),
      variantNames.length === 0
        ? undefined
        : report(
            `${
              variantNames.length === 1
                ? "1 variant name is not a path segment"
                : `${String(variantNames.length)} variant names are not path segments`
            }, and each variant is written under "${VARIANT_PREFIX}<name>/" — ${VARIANT_NAME_FIX}`,
            variantNames,
          ),
      repeatedVariants.length === 0
        ? undefined
        : report(
            `${
              repeatedVariants.length === 1
                ? "1 experiment declares one variant name more than once"
                : `${String(repeatedVariants.length)} experiments declare one variant name more than once`
            }, and a name is what the experiment assigns a visitor to — ${REPEATED_VARIANT_FIX}`,
            repeatedVariants,
          ),
      badWeights.length === 0
        ? undefined
        : report(
            `${
              badWeights.length === 1
                ? "1 variant weight is not a share of visitors"
                : `${String(badWeights.length)} variant weights are not shares of visitors`
            } — ${VARIANT_WEIGHT_FIX}`,
            badWeights,
          ),
      badCookies.length === 0
        ? undefined
        : report(
            `${
              badCookies.length === 1
                ? "1 experiment declares a cookie key no browser will carry"
                : `${String(badCookies.length)} experiments declare cookie keys no browser will carry`
            } — ${COOKIE_KEY_FIX}`,
            badCookies,
          ),
    ].filter((section) => section !== undefined),
  );

  return { redirects, headers, notFound, experiments };
}

/**
 * The default tree is prepended, not sorted: `sort` moves `undefined` last
 * without calling the comparator.
 */
function treesOf(pages: readonly Page[]): (string | undefined)[] {
  const domains = new Set(pages.map((page) => page.domain));
  const hosts = [...domains]
    .filter((domain) => domain !== undefined)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  return domains.has(undefined) ? [undefined, ...hosts] : hosts;
}

function claimant(rule: DraftRedirect): string {
  return `${rule.where} (${rule.source}) to "${rule.to}" ${String(rule.status)}`;
}

function fileTargets(input: RoutingInput): Set<string> {
  return new Set(
    (input.emitted ?? [])
      .filter(
        (file) =>
          file.page === undefined &&
          !isReservedDeployKey(file.path) &&
          file.path !== `/${VARIANT_SEGMENT}` &&
          !file.path.startsWith(VARIANT_PREFIX),
      )
      .map((file) => fileKey(file.domain, file.path)),
  );
}

function check(
  input: RoutingInput,
  drafted: {
    redirects: DraftRedirect[];
    headers: DraftHeaders[];
    notFound: DraftNotFound[];
    experiments: DraftExperiment[];
  },
): void {
  const treeOf = treeNamer(input.pages);
  const trees = new Set(treesOf(input.pages));
  const liveIn = new Map<string, Page>();
  for (const page of input.pages)
    liveIn.set(fileKey(page.domain, page.output), page);
  const emittedIn = fileTargets(input);
  const pageOf = new Map(
    input.pages.map((page) => [`${page.locale} ${page.path}`, page]),
  );

  const unoccupied: string[] = [];
  const named = (where: string, domain: string | undefined): boolean => {
    if (domain === undefined || trees.has(domain)) return true;
    unoccupied.push(`  ${where} — "${domain}"`);
    return false;
  };
  const redirects = drafted.redirects.filter((rule) =>
    named(rule.where, rule.domain),
  );
  const headers = drafted.headers.filter((rule) =>
    named(rule.where, rule.domain),
  );
  const notFound = drafted.notFound.filter((rule) =>
    named(rule.where, rule.domain),
  );
  const experiments = drafted.experiments.filter((rule) =>
    named(rule.where, rule.domain),
  );
  throwIfAny(
    unoccupied.length === 0
      ? []
      : [
          report(
            `${
              unoccupied.length === 1
                ? "1 rule names a domain no page occupies"
                : `${String(unoccupied.length)} rules name domains no page occupies`
            } — ${UNOCCUPIED_DOMAIN_FIX}`,
            [...unoccupied].sort(),
          ),
        ],
  );

  const shadowed: string[] = [];
  const dead: string[] = [];
  const crossTree: string[] = [];
  const sources = new Set(
    redirects.map((rule) => fileKey(rule.domain, rule.from)),
  );
  const contested = new Map<string, DraftRedirect[]>();

  for (const rule of redirects) {
    const fromKey = fileKey(rule.domain, rule.from);
    const page = liveIn.get(fromKey);
    if (page !== undefined) {
      shadowed.push(
        `  "${rule.from}" in ${treeOf(rule.domain)} — ${rule.where}, and the page ${page.locale} ${page.path}`,
      );
    }
    contested.set(fromKey, [...(contested.get(fromKey) ?? []), rule]);
    const toKey = fileKey(rule.domain, rule.to);
    if (liveIn.has(toKey) || emittedIn.has(toKey) || sources.has(toKey))
      continue;
    const elsewhere = [...liveIn.values()].find(
      (candidate) => candidate.output === rule.to,
    );
    if (elsewhere === undefined) {
      dead.push(`  ${rule.where} — "${rule.to}" in ${treeOf(rule.domain)}`);
    } else {
      crossTree.push(
        `  ${rule.where} — "${rule.to}" is a page of ${treeOf(elsewhere.domain)}, and the rule is in ${treeOf(rule.domain)}`,
      );
    }
  }

  const perPrefix = new Map<string, DraftHeaders[]>();
  for (const rule of headers) {
    const key = fileKey(rule.domain, rule.prefix);
    perPrefix.set(key, [...(perPrefix.get(key) ?? []), rule]);
  }

  const unrouted: string[] = [];
  const perTree = new Map<string, DraftNotFound[]>();
  for (const rule of notFound) {
    const key = fileKey(rule.domain, "");
    perTree.set(key, [...(perTree.get(key) ?? []), rule]);
    const page = pageOf.get(`${rule.locale} ${rule.path}`);
    if (page === undefined) {
      unrouted.push(
        `  ${rule.where} — the route table holds no ${rule.locale} ${rule.path}`,
      );
    } else if (page.domain !== rule.domain) {
      unrouted.push(
        `  ${rule.where} — ${rule.locale} ${rule.path} renders into ${treeOf(page.domain)}`,
      );
    }
  }

  const unroutedExperiment: string[] = [];
  const perPage = new Map<string, DraftExperiment[]>();
  for (const rule of experiments) {
    const key = `${rule.locale} ${rule.path}`;
    perPage.set(key, [...(perPage.get(key) ?? []), rule]);
    const page = pageOf.get(key);
    if (page === undefined) {
      unroutedExperiment.push(
        `  ${rule.where} — the route table holds no ${rule.locale} ${rule.path}`,
      );
    } else if (page.domain !== rule.domain) {
      unroutedExperiment.push(
        `  ${rule.where} — ${rule.locale} ${rule.path} renders into ${treeOf(page.domain)}`,
      );
    }
  }

  // Only in trees a split claims: a site with no experiment writes nothing
  // under `/_v/` (#34).
  const claimed = new Set(experiments.map((rule) => rule.domain));
  const reserved: string[] = [];
  for (const page of input.pages) {
    if (!claimed.has(page.domain)) continue;
    if (
      page.output === `/${VARIANT_SEGMENT}` ||
      page.output.startsWith(VARIANT_PREFIX)
    ) {
      reserved.push(
        `  ${treeOf(page.domain)} — ${page.locale} ${page.path} is written to "${page.output}"`,
      );
    }
  }

  const reservedKeys: string[] = [];
  for (const page of input.pages) {
    if (!isReservedDeployKey(page.output)) continue;
    reservedKeys.push(
      `  "${page.output}" in ${treeOf(page.domain)} — the page ${page.locale} ${page.path}`,
    );
  }
  for (const rule of redirects) {
    if (!isReservedDeployKey(rule.from)) continue;
    reservedKeys.push(`  "${rule.from}" in ${treeOf(rule.domain)} — ${rule.where}`);
  }

  throwIfAny(
    [
      shadowed.length === 0
        ? undefined
        : report(
            `${
              shadowed.length === 1
                ? "1 redirect starts at a path this build serves"
                : `${String(shadowed.length)} redirects start at paths this build serves`
            } — ${SHADOWED_PAGE_FIX}`,
            [...shadowed].sort(),
          ),
      ...(() => {
        const groups = [...contested].filter(([, rules]) => {
          const [first] = rules;
          return (
            first !== undefined &&
            rules.some(
              (rule) => rule.to !== first.to || rule.status !== first.status,
            )
          );
        });
        if (groups.length === 0) return [];
        return [
          report(
            `${
              groups.length === 1
                ? "1 path is redirected by more than one rule"
                : `${String(groups.length)} paths are redirected by more than one rule`
            } — ${CONTESTED_PATH_FIX}`,
            groups
              .map(([, rules]) => {
                const [first] = rules as [DraftRedirect, ...DraftRedirect[]];
                return `  "${first.from}" in ${treeOf(first.domain)} — ${rules
                  .map(claimant)
                  .join(", ")}`;
              })
              .sort(),
          ),
        ];
      })(),
      dead.length === 0
        ? undefined
        : report(
            `${
              dead.length === 1
                ? "1 redirect target is no page of this build"
                : `${String(dead.length)} redirect targets are no pages of this build`
            } — ${DEAD_TARGET_FIX}`,
            [...dead].sort(),
          ),
      crossTree.length === 0
        ? undefined
        : report(
            `${
              crossTree.length === 1
                ? "1 redirect target is a page in another output tree"
                : `${String(crossTree.length)} redirect targets are pages in other output trees`
            } — ${CROSS_TREE_TARGET_FIX}`,
            [...crossTree].sort(),
          ),
      ...(() => {
        const groups = [...perPrefix].filter(([, rules]) => rules.length > 1);
        if (groups.length === 0) return [];
        return [
          report(
            `${
              groups.length === 1
                ? "1 prefix carries more than one header set"
                : `${String(groups.length)} prefixes carry more than one header set`
            } — ${CONTESTED_PREFIX_FIX}`,
            groups
              .map(([, rules]) => {
                const [first] = rules as [DraftHeaders, ...DraftHeaders[]];
                return `  "${first.prefix}" in ${treeOf(first.domain)} — ${rules
                  .map((rule) => rule.where)
                  .join(", ")}`;
              })
              .sort(),
          ),
        ];
      })(),
      unrouted.length === 0
        ? undefined
        : report(
            `${
              unrouted.length === 1
                ? "1 configured 404 page is no page of its tree"
                : `${String(unrouted.length)} configured 404 pages are no pages of their trees`
            } — ${UNROUTED_NOT_FOUND_FIX}`,
            [...unrouted].sort(),
          ),
      ...(() => {
        const groups = [...perTree].filter(([, rules]) => rules.length > 1);
        if (groups.length === 0) return [];
        return [
          report(
            `${
              groups.length === 1
                ? "1 output tree has more than one 404 page"
                : `${String(groups.length)} output trees have more than one 404 page`
            } — ${CONTESTED_NOT_FOUND_FIX}`,
            groups
              .map(
                ([, rules]) =>
                  `  ${treeOf((rules as [DraftNotFound, ...DraftNotFound[]])[0].domain)} — ${rules
                    .map((rule) => rule.where)
                    .join(", ")}`,
              )
              .sort(),
          ),
        ];
      })(),
      unroutedExperiment.length === 0
        ? undefined
        : report(
            `${
              unroutedExperiment.length === 1
                ? "1 experiment names no page of its tree"
                : `${String(unroutedExperiment.length)} experiments name no page of their trees`
            } — ${UNROUTED_EXPERIMENT_FIX}`,
            [...unroutedExperiment].sort(),
          ),
      ...(() => {
        const groups = [...perPage].filter(([, rules]) => rules.length > 1);
        if (groups.length === 0) return [];
        return [
          report(
            `${
              groups.length === 1
                ? "1 page carries more than one experiment"
                : `${String(groups.length)} pages carry more than one experiment`
            }, and a visitor is assigned to one variant of one page — ${CONTESTED_EXPERIMENT_FIX}`,
            groups
              .map(
                ([key, rules]) =>
                  `  ${key} — ${rules.map((rule) => rule.where).join(", ")}`,
              )
              .sort(),
          ),
        ];
      })(),
      reserved.length === 0
        ? undefined
        : report(
            `${
              reserved.length === 1
                ? "1 page is written under"
                : `${String(reserved.length)} pages are written under`
            } "${VARIANT_PREFIX}", the segment this build reserves for variant outputs — ${RESERVED_SEGMENT_FIX}`,
            [...reserved].sort(),
          ),
      reservedKeys.length === 0
        ? undefined
        : report(
            `${
              reservedKeys.length === 1
                ? "1 page or redirect is at a path"
                : `${String(reservedKeys.length)} pages or redirects are at paths`
            } this build keeps off the edge for the deploy's own manifest and history — ${RESERVED_KEY_FIX}`,
            [...reservedKeys].sort(),
          ),
    ].filter((section) => section !== undefined),
  );
}

function loops(rules: readonly DraftRedirect[]): string[] {
  const next = new Map(rules.map((rule) => [rule.from, rule.to]));
  const found = new Map<string, readonly string[]>();
  for (const rule of rules) {
    const walk: string[] = [];
    let node: string | undefined = rule.from;
    while (node !== undefined && !walk.includes(node)) {
      walk.push(node);
      node = next.get(node);
    }
    if (node === undefined) continue;
    const cycle = walk.slice(walk.indexOf(node));
    const smallest = cycle.indexOf([...cycle].sort()[0] as string);
    const rotated = [...cycle.slice(smallest), ...cycle.slice(0, smallest)];
    found.set(rotated.join("\u0000"), rotated);
  }
  return [...found.values()].map((cycle) =>
    [...cycle, cycle[0]].map((hop) => `"${hop}"`).join(" → "),
  );
}

/** Total only because `loops` has run: a walk with no loop in it ends. */
function flatten(
  rule: DraftRedirect,
  next: ReadonlyMap<string, DraftRedirect>,
): ResolvedRedirect {
  const via: string[] = [];
  let to = rule.to;
  for (let hop = next.get(to); hop !== undefined; hop = next.get(to)) {
    via.push(to);
    to = hop.to;
  }
  return { from: rule.from, to, status: rule.status, source: rule.source, via };
}

export function notFoundPages(
  config: RoutingConfig | undefined,
  trailingSlash: TrailingSlash,
): (page: Pick<Page, "locale" | "path">) => boolean {
  const named = new Set<string>();
  for (const rule of config?.notFound ?? []) {
    try {
      const path = normalizeOutputPath(rule.path, trailingSlash);
      named.add(`${rule.locale} ${path}`);
    } catch (cause) {
      // A path `planRouting` will refuse is skipped: that build fails there
      // with every fault. Any other throw is a bug.
      if (!(cause instanceof ConfigError)) throw cause;
    }
  }
  return (page) => named.has(`${page.locale} ${page.path}`);
}

/**
 * Shape, then the route table, then the graph: a loop walk over refused rules
 * would report members that do not exist.
 */
export function planRouting(input: RoutingInput): RoutingManifest {
  const drafted = draft(input);
  check(input, drafted);

  const treeOf = treeNamer(input.pages);
  const trees = treesOf(input.pages);
  const files = fileTargets(input);
  const cycles: string[] = [];
  for (const domain of trees) {
    const mine = drafted.redirects.filter((rule) => rule.domain === domain);
    for (const cycle of loops(mine))
      cycles.push(`  ${treeOf(domain)} — ${cycle}`);
  }
  throwIfAny(
    cycles.length === 0
      ? []
      : [
          report(
            `${
              cycles.length === 1
                ? "1 redirect chain is a loop"
                : `${String(cycles.length)} redirect chains are loops`
            } — ${LOOP_FIX}`,
            [...cycles].sort(),
          ),
        ],
  );

  const outputOf = new Map(
    input.pages.map((page) => [`${page.locale} ${page.path}`, page.output]),
  );
  const isNotFound = notFoundPages(input.config, input.trailingSlash);

  return {
    version: ROUTING_VERSION,
    site: { trailingSlash: input.trailingSlash },
    trees: trees.map((domain): RoutingTree => {
      const splits = drafted.experiments
        .filter((rule) => rule.domain === domain)
        .map((rule): ResolvedExperiment => ({
          // Checked in pass 2, so the read is total.
          path: outputOf.get(`${rule.locale} ${rule.path}`) as string,
          cookie: rule.cookie,
          variants: [...rule.variants].sort((a, b) =>
            a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
          ),
        }))
        .sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
      const mine = drafted.redirects.filter((rule) => rule.domain === domain);
      const next = new Map(mine.map((rule) => [rule.from, rule]));
      const byFrom = new Map(
        mine.map((rule) => {
          const resolved = flatten(rule, next);
          return [
            rule.from,
            files.has(fileKey(domain, resolved.to))
              ? { ...resolved, file: true as const }
              : resolved,
          ];
        }),
      );
      const notFound = input.pages.find(
        (page) => page.domain === domain && isNotFound(page),
      );
      return {
        ...(domain === undefined ? {} : { domain }),
        redirects: [...byFrom.values()].sort((a, b) =>
          a.from === b.from ? 0 : a.from < b.from ? -1 : 1,
        ),
        ...(notFound === undefined ? {} : { notFound: notFound.output }),
        headers: drafted.headers
          .filter((rule) => rule.domain === domain)
          .map((rule) => ({ prefix: rule.prefix, set: rule.set }))
          .sort((a, b) =>
            a.prefix.length !== b.prefix.length
              ? b.prefix.length - a.prefix.length
              : a.prefix === b.prefix
                ? 0
                : a.prefix < b.prefix
                  ? -1
                  : 1,
          ),
        // Last and omitted when empty, so a site with no split keeps its bytes
        // (#34).
        ...(splits.length === 0 ? {} : { experiments: splits }),
      };
    }),
  };
}

export function redirectIndex(
  manifest: RoutingManifest,
): (domain: string | undefined, path: string) => ResolvedRedirect | undefined {
  const byKey = new Map<string, ResolvedRedirect>();
  for (const tree of manifest.trees) {
    for (const rule of tree.redirects) {
      byKey.set(fileKey(tree.domain, rule.from), rule);
    }
  }
  return (domain, path) =>
    byKey.get(
      fileKey(domain, normalizeOutputPath(path, manifest.site.trailingSlash)),
    );
}

export function undeclaredHeadersWarning(
  config: RoutingConfig | undefined,
): string | undefined {
  if (config !== undefined && (config.headers ?? []).length > 0) {
    return undefined;
  }
  const lines = SECURITY_HEADERS.map(
    ({ name, value }) => `  ${name}: ${value}`,
  );
  return [
    "Security headers: this site declares no header set, so no response its output serves carries one — build.routing.headers is the only place a generated site can put a response header, and with the field absent no _headers file, no nginx add_header block and no CloudFront viewer-response function is emitted at all; this is a warning and not a refusal because every page this build emitted is correct and a host that already sets these headers would be handed duplicates by a default nobody wrote — spread SECURITY_HEADERS into the set of a rule over \"/\", which is these three, or declare a set of your own to say the host is doing it:",
    ...lines,
  ].join("\n");
}

const ROUTING_SHAPE_FIX =
  'routing: { redirects: [{ from: "/old", to: "/pricing" }] }';
const ROUTING_KEY_FIX =
  "delete the field, or correct it to one of: redirects, notFound, headers, experiments";
const ROUTING_LIST_FIX = `write each as an array, as ${ROUTING_SHAPE_FIX}`;
const ROUTING_ENTRY_FIX = `write each as an object, as ${ROUTING_SHAPE_FIX}`;
const FROM_FIX =
  'write the path this rule starts at, as authored, such as "/old"';
const TO_FIX =
  'write the path this rule ends at, as authored, such as "/pricing"';
const STATUS_FIX =
  "write the 3xx a static host answers with, as status: 301, or leave it out for 308";
const DOMAIN_FIX =
  'write the host of the output tree this rule is in, such as "shop.example"';
const NOT_FOUND_LOCALE_FIX =
  'write the locale the route table spells this page with, such as "en"';
const NOT_FOUND_PATH_FIX =
  'write the path the route table spells this page with, such as "/404"';
const PREFIX_FIX =
  'write the path prefix these headers apply under, such as "/docs/"';
const SET_FIX =
  'write the headers this prefix carries, as set: [{ name: "X-Frame-Options", value: "DENY" }]';
const HEADER_NAME_FIX =
  'write the header name as it goes on the wire, such as "X-Frame-Options"';
const HEADER_VALUE_FIX =
  'write the header value as it goes on the wire, such as "DENY"';
const EXPERIMENT_LOCALE_FIX =
  'write the locale the route table spells this page with, such as "en"';
const EXPERIMENT_PATH_FIX =
  'write the path the route table spells this page with, such as "/pricing"';
const COOKIE_FIX =
  'write the cookie key this experiment is assigned and read by, such as "fw_pricing"';
const VARIANTS_FIX =
  'write the variants of this experiment, as variants: [{ name: "b", weight: 50 }]';
const VARIANT_TYPE_FIX =
  'write the variant name as one path segment, such as "b"';
const WEIGHT_FIX = "write this variant's share of visitors, such as weight: 50";

const ROUTING_KEYS: readonly string[] = [
  "redirects",
  "notFound",
  "headers",
  "experiments",
];

function configReport(
  where: string,
  headline: string,
  lines: readonly string[],
): string {
  return `${where}: "build.routing" ${headline}:\n${lines.join("\n")}`;
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${String(n)} ${many}`;
}

function textFault(value: unknown, noun: string): string | undefined {
  if (typeof value !== "string") return "not a string";
  if (value.trim() === "") {
    return value === ""
      ? `the ${noun} is empty`
      : `the ${noun} is only whitespace`;
  }
  return undefined;
}

/**
 * An explicit `undefined` is absent: without `exactOptionalPropertyTypes` the
 * published types accept it.
 */
function optional(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Types only. Values are `planRouting`'s, which `removals` reaches without this
 * door, so a status is checked for being a number and not one of the four.
 */
export function routingFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return (
      `${where}: "build.routing" must be an object of redirects, 404 pages,` +
      ` header rules and experiments — ${ROUTING_SHAPE_FIX}`
    );
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknown = Object.keys(record)
    .filter((key) => !ROUTING_KEYS.includes(key))
    .sort();
  if (unknown.length > 0) {
    sections.push(
      configReport(
        where,
        `declares ${count(
          unknown.length,
          "field this build does not read",
          "fields this build does not read",
        )} — ${ROUTING_KEY_FIX}`,
        unknown.map((key) => `  "${key}"`),
      ),
    );
  }

  const notLists: string[] = [];
  const notEntries: string[] = [];
  const fields: string[] = [];
  const field = (
    at_: string,
    name: string,
    held: unknown,
    reason: string | undefined,
    fix: string,
  ): void => {
    if (reason === undefined) return;
    fields.push(`  ${at_} — "${name}" — ${quote(held)} — ${reason} — ${fix}`);
  };

  const list = (
    key: string,
    check: (entry: object, at_: string) => void,
  ): void => {
    const held = optional(record, key);
    if (held === undefined) return;
    if (!Array.isArray(held)) {
      notLists.push(`  "${key}" — ${quote(held)}`);
      return;
    }
    (held as readonly unknown[]).forEach((entry, index) => {
      const at_ = at(key, index);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        notEntries.push(`  ${at_} — ${quote(entry)}`);
        return;
      }
      const rule = entry as Record<string, unknown>;
      const domain = optional(rule, "domain");
      if (domain !== undefined)
        field(at_, "domain", domain, textFault(domain, "domain"), DOMAIN_FIX);
      check(rule, at_);
    });
  };

  list("redirects", (rule, at_) => {
    const held = rule as Record<string, unknown>;
    field(at_, "from", held["from"], textFault(held["from"], "path"), FROM_FIX);
    field(at_, "to", held["to"], textFault(held["to"], "path"), TO_FIX);
    const status = optional(held, "status");
    if (status !== undefined) {
      field(
        at_,
        "status",
        status,
        typeof status === "number" ? undefined : "not a number",
        STATUS_FIX,
      );
    }
  });

  list("notFound", (rule, at_) => {
    const held = rule as Record<string, unknown>;
    field(
      at_,
      "locale",
      held["locale"],
      textFault(held["locale"], "locale"),
      NOT_FOUND_LOCALE_FIX,
    );
    field(
      at_,
      "path",
      held["path"],
      textFault(held["path"], "path"),
      NOT_FOUND_PATH_FIX,
    );
  });

  list("headers", (rule, at_) => {
    const held = rule as Record<string, unknown>;
    field(
      at_,
      "prefix",
      held["prefix"],
      textFault(held["prefix"], "prefix"),
      PREFIX_FIX,
    );
    const set = held["set"];
    if (!Array.isArray(set)) {
      field(at_, "set", set, "not a list of header fields", SET_FIX);
      return;
    }
    (set as readonly unknown[]).forEach((one, index) => {
      const there = `${at_}.set[${String(index)}]`;
      if (typeof one !== "object" || one === null || Array.isArray(one)) {
        notEntries.push(`  ${there} — ${quote(one)}`);
        return;
      }
      const header = one as Record<string, unknown>;
      field(
        there,
        "name",
        header["name"],
        textFault(header["name"], "header name"),
        HEADER_NAME_FIX,
      );
      field(
        there,
        "value",
        header["value"],
        typeof header["value"] === "string" ? undefined : "not a string",
        HEADER_VALUE_FIX,
      );
    });
  });

  list("experiments", (rule, at_) => {
    const held = rule as Record<string, unknown>;
    field(
      at_,
      "locale",
      held["locale"],
      textFault(held["locale"], "locale"),
      EXPERIMENT_LOCALE_FIX,
    );
    field(
      at_,
      "path",
      held["path"],
      textFault(held["path"], "path"),
      EXPERIMENT_PATH_FIX,
    );
    field(
      at_,
      "cookie",
      held["cookie"],
      textFault(held["cookie"], "cookie key"),
      COOKIE_FIX,
    );
    const variants = held["variants"];
    if (!Array.isArray(variants)) {
      field(at_, "variants", variants, "not a list of variants", VARIANTS_FIX);
      return;
    }
    (variants as readonly unknown[]).forEach((one, index) => {
      const there = at(`${at_}.variants`, index);
      if (typeof one !== "object" || one === null || Array.isArray(one)) {
        notEntries.push(`  ${there} — ${quote(one)}`);
        return;
      }
      const variant = one as Record<string, unknown>;
      field(
        there,
        "name",
        variant["name"],
        textFault(variant["name"], "variant name"),
        VARIANT_TYPE_FIX,
      );
      field(
        there,
        "weight",
        variant["weight"],
        typeof variant["weight"] === "number" ? undefined : "not a number",
        WEIGHT_FIX,
      );
    });
  });

  if (notLists.length > 0) {
    sections.push(
      configReport(
        where,
        `declares ${count(
          notLists.length,
          "member that is not a list of rules",
          "members that are not lists of rules",
        )} — ${ROUTING_LIST_FIX}`,
        notLists,
      ),
    );
  }
  if (notEntries.length > 0) {
    sections.push(
      configReport(
        where,
        `declares ${count(
          notEntries.length,
          "entry that is not a rule",
          "entries that are not rules",
        )} — ${ROUTING_ENTRY_FIX}`,
        notEntries,
      ),
    );
  }
  if (fields.length > 0) {
    sections.push(
      configReport(
        where,
        `declares ${count(
          fields.length,
          "rule field this build cannot route with",
          "rule fields this build cannot route with",
        )} — declare each as the type its own line names`,
        fields,
      ),
    );
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}
