import { ConfigError } from "./exit.js";
import { quote, quoteAddress } from "./quote.js";

export type Direction = "ltr" | "rtl";

export interface LocaleDefinition {
  label: string;
  direction: Direction;
  fallback?: string;
  domain?: string;
}

export interface PlacedLocale extends LocaleDefinition {
  /**
   * The set's key, duplicated: a locale handed on alone still says which it is.
   */
  code: string;
  prefix: string;
}

export type LocaleSet = ReadonlyMap<string, PlacedLocale>;

const SUBJECT = "Locale set: ";

interface MissingFallback {
  code: string;
  fallback: string;
}

const MISSING_FALLBACK_FIX =
  "declare the target, or point the fallback at a declared locale";

function missingFallbackReport(missing: readonly MissingFallback[]): string {
  const count = missing.length;
  const headline =
    count === 1
      ? "1 locale falls back to a locale that is not declared"
      : `${String(count)} locales fall back to locales that are not declared`;
  const detail = missing
    .map(({ code, fallback }) => `  "${code}" falls back to "${fallback}"`)
    .join("\n");
  return `${SUBJECT}${headline} — ${MISSING_FALLBACK_FIX}:\n${detail}`;
}

const CYCLE_FIX =
  "remove one of the fallbacks on the cycle, or point one at a locale outside it";

function cycleReport(cycles: readonly (readonly string[])[]): string {
  const count = cycles.length;
  const headline =
    count === 1
      ? "1 fallback chain closes on itself, so resolving an untranslated page would follow it forever"
      : `${String(count)} fallback chains close on themselves, so resolving an untranslated page would follow one of them forever`;
  const detail = cycles
    .map((cycle) => {
      const closed = [...cycle, cycle[0] as string];
      return `  ${closed.map((code) => `"${code}"`).join(" → ")}`;
    })
    .join("\n");
  return `${SUBJECT}${headline} — ${CYCLE_FIX}:\n${detail}`;
}

interface DomainFault {
  code: string;
  shown: string;
  faults: readonly string[];
}

const DOMAIN_FIX =
  'write the host a locale\'s pages are served from and nothing else, as domain: "example.de"';

function domainFaultReport(faulted: readonly DomainFault[]): string {
  const count = faulted.length;
  const headline =
    count === 1
      ? "1 locale declares a domain that is not a bare host"
      : `${String(count)} locales declare domains that are not bare hosts`;
  const detail = faulted
    .flatMap(({ code, shown, faults }) =>
      faults.map((fault) => `  "${code}": ${shown} — ${fault}`),
    )
    .join("\n");
  return `${SUBJECT}${headline} — ${DOMAIN_FIX}:\n${detail}`;
}

function cycleFrom(
  start: string,
  fallbackOf: ReadonlyMap<string, string>,
): string[] | undefined {
  const walked: string[] = [];
  let at: string | undefined = start;
  while (at !== undefined) {
    const already = walked.indexOf(at);
    if (already !== -1) return walked.slice(already);
    walked.push(at);
    at = fallbackOf.get(at);
  }
  return undefined;
}

function cyclesIn(
  declared: readonly (readonly [string, LocaleDefinition])[],
): string[][] {
  const fallbackOf = new Map(
    declared.flatMap(([code, locale]) =>
      locale.fallback === undefined ? [] : [[code, locale.fallback] as const],
    ),
  );
  const seen = new Set<string>();
  const cycles: string[][] = [];
  for (const [code] of declared) {
    const cycle = cycleFrom(code, fallbackOf);
    if (cycle === undefined) continue;
    const key = [...cycle].sort().join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    cycles.push(cycle);
  }
  return cycles;
}

const DOMAIN_SCHEME = /^([a-zA-Z][a-zA-Z\d+.-]*:)\/\//;

/**
 * Not `\s` alone: the URL parser folds controls and invisible characters away,
 * so the emitted link would differ unseen from the host it reaches (#396).
 */
const NOT_IN_A_HOST = /[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/**
 * A scan of the string, not a parse: a domain is concatenated as written, and
 * `new URL` forgives exactly the faults that matter here (#319).
 */
function domainFaults(value: string): string[] {
  if (value === "") {
    return [
      "the domain is empty, and a locale served from the site's own origin leaves the field out",
    ];
  }

  let rest = value;
  const hash = rest.indexOf("#");
  if (hash !== -1) rest = rest.slice(0, hash);
  const mark = rest.indexOf("?");
  if (mark !== -1) rest = rest.slice(0, mark);
  const scheme = DOMAIN_SCHEME.exec(rest);
  if (scheme !== null) rest = rest.slice(scheme[0].length);
  const slash = rest.search(/[/\\]/);
  if (slash !== -1) rest = rest.slice(0, slash);
  const at = rest.lastIndexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  const bracketed = rest.startsWith("[") && rest.endsWith("]");

  return [
    ...(NOT_IN_A_HOST.test(value)
      ? [
          "the domain holds a character that is not part of a host, and a domain is a host and nothing else",
        ]
      : []),
    ...(scheme === null
      ? []
      : [
          `the domain opens with the scheme "${scheme[1] as string}", and the origin supplies the scheme`,
        ]),
    ...(at === -1
      ? []
      : ["the domain holds userinfo, and a domain is a host and nothing else"]),
    ...(!bracketed && rest.includes(":")
      ? [
          "the domain holds a colon, and the origin supplies the scheme and the port",
        ]
      : []),
    ...(slash === -1
      ? []
      : [
          "the domain holds a path, and this build appends each page's own path to it",
        ]),
    ...(mark === -1
      ? []
      : ["the domain holds a query, and a domain is a host and nothing else"]),
    ...(hash === -1
      ? []
      : [
          "the domain holds a fragment, and a domain is a host and nothing else",
        ]),
  ];
}

const HOST_NAME_LABEL = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

function hostNameFault(domain: string): string | undefined {
  const host = domainHost(domain);
  if (host === undefined) {
    return "the domain is not a host, so every URL composed from it would be malformed";
  }
  if (host.startsWith("[")) return undefined;
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  return name.length <= 253 &&
    name.split(".").every((label) => HOST_NAME_LABEL.test(label))
    ? undefined
    : "the domain parses to a tree key that is not a host name, so it cannot key a tree under the output directory; a host name is dot-separated labels of 1 to 63 ASCII letters, digits and hyphens, none starting or ending with a hyphen, at most 253 characters in all and optionally ending in one dot";
}

function faultyDomains(
  declared: readonly (readonly [string, LocaleDefinition])[],
): DomainFault[] {
  const faulted: DomainFault[] = [];
  for (const [code, locale] of declared) {
    const { domain } = locale as { domain?: unknown };
    if (domain === undefined) continue;
    if (typeof domain !== "string") {
      faulted.push({
        code,
        shown: quote(domain),
        faults: ["the domain is not a string, and a host is written as one"],
      });
      continue;
    }
    const faults = domainFaults(domain);
    if (faults.length === 0) {
      const fault = hostNameFault(domain);
      if (fault !== undefined) faults.push(fault);
    }
    if (faults.length > 0) {
      faulted.push({ code, shown: quoteAddress(domain), faults });
    }
  }
  return faulted;
}

export function domainHost(domain: string): string | undefined {
  try {
    return new URL(`https://${domain}`).hostname;
  } catch {
    return undefined;
  }
}

export function localeTree(
  locale: Pick<LocaleDefinition, "domain">,
): string | undefined {
  if (locale.domain === undefined) return undefined;
  return domainHost(locale.domain) ?? locale.domain;
}

function treeSizes(
  declared: readonly (readonly [string, LocaleDefinition])[],
): Map<string | undefined, number> {
  const sizes = new Map<string | undefined, number>();
  for (const [, locale] of declared) {
    const tree = localeTree(locale);
    sizes.set(tree, (sizes.get(tree) ?? 0) + 1);
  }
  return sizes;
}

export function defineLocales(
  locales: Record<string, LocaleDefinition>,
): LocaleSet {
  const declared = Object.entries(locales);
  if (declared.length === 0) {
    throw new ConfigError(
      `${SUBJECT}no locales are declared, so no page can be routed — declare at least one, like { en: { label: "English", direction: "ltr" } }`,
    );
  }

  const sections: string[] = [];
  const faultyDomain = faultyDomains(declared);
  if (faultyDomain.length > 0) sections.push(domainFaultReport(faultyDomain));

  const codes = new Set(declared.map(([code]) => code));
  const missing: MissingFallback[] = [];
  for (const [code, locale] of declared) {
    const { fallback } = locale;
    if (fallback !== undefined && !codes.has(fallback)) {
      missing.push({ code, fallback });
    }
  }
  if (missing.length > 0) sections.push(missingFallbackReport(missing));
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));

  // A separate throw: a missing target is a hole in the graph, so cycles are
  // measured only once every target exists.
  const cycles = cyclesIn(declared);
  if (cycles.length > 0) throw new ConfigError(cycleReport(cycles));

  const sizes = treeSizes(declared);
  return new Map(
    declared.map(([code, locale]) => [
      code,
      {
        ...locale,
        code,
        prefix: sizes.get(localeTree(locale)) === 1 ? "" : `/${code}`,
      },
    ]),
  );
}
