export interface PageIdentity {
  locale: string;
  path: string;
}

export interface Pattern {
  key: string;
  locale?: string;
  segments: readonly string[];
  literals: number;
  /**
   * Counted apart from `*`: summed, `/blog/*` and `/blog/**` would tie (#21).
   */
  segmentWildcards: number;
  characterWildcards: number;
}

function parsePattern(key: string): Pattern | { fault: string } {
  const colon = key.indexOf(":");
  const locale = colon === -1 ? undefined : key.slice(0, colon);
  const glob = colon === -1 ? key : key.slice(colon + 1);
  if (!glob.startsWith("/")) {
    return { fault: 'the path does not start with "/"' };
  }
  if (locale !== undefined && locale.length === 0) {
    return { fault: 'the locale scope before ":" is empty' };
  }
  const segments = glob.slice(1).split("/");
  return {
    key,
    ...(locale === undefined ? {} : { locale }),
    segments,
    literals: [...glob].filter((character) => character !== "*").length,
    segmentWildcards: segments.filter((segment) => segment === "**").length,
    characterWildcards: segments
      .filter((segment) => segment !== "**")
      .reduce((count, segment) => count + segment.split("*").length - 1, 0),
  };
}

/** Drops an unusable key: `patternMapFaultReport` refused it at config load. */
export function parsePatterns(keys: readonly string[]): Pattern[] {
  return keys
    .map((key) => parsePattern(key))
    .filter((pattern): pattern is Pattern => !("fault" in pattern));
}

export function patternFault(key: string): string | undefined {
  const pattern = parsePattern(key);
  return "fault" in pattern ? pattern.fault : undefined;
}

const SEGMENT_REGEXES = new Map<string, RegExp>();

function segmentRegex(segment: string): RegExp {
  const cached = SEGMENT_REGEXES.get(segment);
  if (cached !== undefined) return cached;
  const source = segment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const regex = new RegExp(`^${source}$`);
  SEGMENT_REGEXES.set(segment, regex);
  return regex;
}

function matchSegments(
  pattern: readonly string[],
  path: readonly string[],
  i = 0,
  j = 0,
): boolean {
  if (i === pattern.length) return j === path.length;
  if (pattern[i] === "**") {
    for (let skip = j; skip <= path.length; skip += 1) {
      if (matchSegments(pattern, path, i + 1, skip)) return true;
    }
    return false;
  }
  if (j === path.length) return false;
  if (!segmentRegex(pattern[i] as string).test(path[j] as string)) return false;
  return matchSegments(pattern, path, i + 1, j + 1);
}

function matches(pattern: Pattern, page: PageIdentity): boolean {
  if (pattern.locale !== undefined && pattern.locale !== page.locale) {
    return false;
  }
  return matchSegments(pattern.segments, page.path.slice(1).split("/"));
}

function moreSpecific(a: Pattern, b: Pattern): number {
  const scope = Number(a.locale !== undefined) - Number(b.locale !== undefined);
  if (scope !== 0) return scope;
  if (a.literals !== b.literals) return a.literals - b.literals;
  if (a.segmentWildcards !== b.segmentWildcards) {
    return b.segmentWildcards - a.segmentWildcards;
  }
  return b.characterWildcards - a.characterWildcards;
}

export function matchingPattern(
  patterns: readonly Pattern[],
  page: PageIdentity,
): Pattern | undefined {
  return patterns
    .filter((pattern) => matches(pattern, page))
    .reduce<Pattern | undefined>(
      (best, pattern) =>
        best === undefined || moreSpecific(pattern, best) > 0 ? pattern : best,
      undefined,
    );
}

function pathWitness(
  a: readonly string[],
  b: readonly string[],
  i = 0,
  j = 0,
): string[] | undefined {
  if (i === a.length && j === b.length) return [];
  if (a[i] === "**") {
    const empty = pathWitness(a, b, i + 1, j);
    if (empty !== undefined) return empty;
    if (j < b.length && b[j] !== "**") {
      const rest = pathWitness(a, b, i, j + 1);
      if (rest !== undefined) return [(b[j] as string).replaceAll("*", ""), ...rest];
    }
  }
  if (b[j] === "**") {
    const empty = pathWitness(a, b, i, j + 1);
    if (empty !== undefined) return empty;
    if (i < a.length && a[i] !== "**") {
      const rest = pathWitness(a, b, i + 1, j);
      if (rest !== undefined) return [(a[i] as string).replaceAll("*", ""), ...rest];
    }
  }
  if (a[i] === "**" || b[j] === "**") return undefined;
  if (i === a.length || j === b.length) return undefined;
  const here = segmentWitness(a[i] as string, b[j] as string);
  if (here === undefined) return undefined;
  const rest = pathWitness(a, b, i + 1, j + 1);
  return rest === undefined ? undefined : [here, ...rest];
}

function segmentWitness(
  a: string,
  b: string,
  i = 0,
  j = 0,
): string | undefined {
  if (i === a.length && j === b.length) return "";
  if (a[i] === "*") {
    const empty = segmentWitness(a, b, i + 1, j);
    if (empty !== undefined) return empty;
    if (j < b.length) {
      const rest = segmentWitness(a, b, i, j + 1);
      if (rest !== undefined) return (b[j] === "*" ? "" : b[j]) + rest;
    }
  }
  if (b[j] === "*") {
    const empty = segmentWitness(a, b, i, j + 1);
    if (empty !== undefined) return empty;
    if (i < a.length) {
      const rest = segmentWitness(a, b, i + 1, j);
      if (rest !== undefined) return (a[i] === "*" ? "" : a[i]) + rest;
    }
  }
  if (a[i] === "*" || b[j] === "*") return undefined;
  if (i === a.length || j === b.length) return undefined;
  if (a[i] !== b[j]) return undefined;
  const rest = segmentWitness(a, b, i + 1, j + 1);
  return rest === undefined ? undefined : (a[i] as string) + rest;
}

function witnessOf(a: Pattern, b: Pattern): string | undefined {
  const path = pathWitness(a.segments, b.segments);
  if (path === undefined) return undefined;
  const locale = a.locale ?? b.locale;
  return `${locale === undefined ? "" : `${locale} `}/${path.join("/")}`;
}

const PATTERN_FIX =
  'write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing"';

function paragraph(
  where: string,
  field: string,
  count: number,
  subject: string,
  fix: string,
  lines: readonly string[],
): string {
  return `${where}: "${field}" ${subject.replace("%", String(count))} — ${fix}:\n${lines
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

export interface PatternValueRule {
  fault(value: unknown): string | undefined;
  subject: readonly [string, string];
  fix: string;
  ambiguousFix: string;
}

export function patternMapFaultReport(input: {
  value: unknown;
  where: string;
  field: string;
  shapeFix: string;
  rule: PatternValueRule;
}): string | undefined {
  const { value, where, field, rule } = input;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "${field}" must be an object — ${input.shapeFix}`;
  }

  const valueFaults: string[] = [];
  const patternFaults: string[] = [];
  const patterns: Pattern[] = [];
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, declared] of entries) {
    const fault = rule.fault(declared);
    if (fault !== undefined) valueFaults.push(`"${key}" — ${fault}`);
    const pattern = parsePattern(key);
    if ("fault" in pattern) {
      patternFaults.push(`"${key}" — ${pattern.fault}`);
    } else {
      patterns.push(pattern);
    }
  }

  const sections: string[] = [];
  if (valueFaults.length > 0) {
    sections.push(
      paragraph(
        where,
        field,
        valueFaults.length,
        rule.subject[valueFaults.length === 1 ? 0 : 1],
        rule.fix,
        valueFaults,
      ),
    );
  }
  if (patternFaults.length > 0) {
    sections.push(
      paragraph(
        where,
        field,
        patternFaults.length,
        patternFaults.length === 1
          ? "declares % key that is not a page pattern"
          : "declares % keys that are not page patterns",
        PATTERN_FIX,
        patternFaults,
      ),
    );
  }
  const ambiguous = ambiguousPairs(patterns, value as Record<string, unknown>);
  if (ambiguous.length > 0) {
    sections.push(
      paragraph(
        where,
        field,
        ambiguous.length,
        ambiguous.length === 1
          ? "holds % pair of patterns no page can choose between"
          : "holds % pairs of patterns no page can choose between",
        rule.ambiguousFix,
        ambiguous,
      ),
    );
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function ambiguousPairs(
  patterns: readonly Pattern[],
  values: Record<string, unknown>,
): string[] {
  const faults: string[] = [];
  for (let i = 0; i < patterns.length; i += 1) {
    for (let j = i + 1; j < patterns.length; j += 1) {
      const a = patterns[i] as Pattern;
      const b = patterns[j] as Pattern;
      if (moreSpecific(a, b) !== 0) continue;
      if (a.locale !== b.locale) continue;
      if (values[a.key] === values[b.key]) continue;
      const witness = witnessOf(a, b);
      if (witness === undefined) continue;
      faults.push(
        `"${a.key}" and "${b.key}" — equally specific, and both match "${witness}"`,
      );
    }
  }
  return faults;
}
