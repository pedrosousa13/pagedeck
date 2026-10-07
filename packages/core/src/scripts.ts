import { CONSENT_DENIED, CONSENT_GRANTED } from "./consent.js";
import { ConfigError } from "./exit.js";
import { matchingPattern, parsePatterns, patternMapFaultReport } from "./page-patterns.js";
import { quote } from "./quote.js";
import type { ConsentCategory } from "./consent.js";
import type { PageIdentity } from "./page-patterns.js";

export type ScriptStrategy = "worker" | "idle" | "interaction" | "facade";

/** A record, not a list: `tsc` fails here when a category is added (#459). */
const CONSENT_CATEGORY_KEYS: Readonly<Record<ConsentCategory, true>> = {
  analytics: true,
  functional: true,
  marketing: true,
  necessary: true,
};
const CONSENT_CATEGORIES = Object.keys(
  CONSENT_CATEGORY_KEYS,
) as readonly ConsentCategory[];

export type ConsentDefault = typeof CONSENT_GRANTED | typeof CONSENT_DENIED;

const CONSENT_DEFAULTS: readonly ConsentDefault[] = [
  CONSENT_GRANTED,
  CONSENT_DENIED,
];

/**
 * `denied`, against `DEFAULT_SCRIPT_STRATEGY`'s fastest-first: a wrong guess
 * here runs a script without permission, which nothing takes back.
 */
export const DEFAULT_CONSENT: ConsentDefault = CONSENT_DENIED;

const SCRIPT_STRATEGIES: readonly ScriptStrategy[] = [
  "worker",
  "idle",
  "interaction",
  "facade",
];

const OVERRIDE_VALUES: readonly (ScriptStrategy | "off")[] = [
  ...SCRIPT_STRATEGIES,
  "off",
];

export const DEFAULT_SCRIPT_STRATEGY: ScriptStrategy = "worker";

export interface ScriptFacade {
  readonly html: string;
  readonly mount?: string;
}

export interface ScriptRuntimeRequest {
  readonly scripts: readonly ScriptDeclaration[];
}

export type ScriptRuntimeAdapter = (
  request: ScriptRuntimeRequest,
) => readonly string[];

export type ScriptAttributes = Readonly<Record<`data-${string}`, string>>;

export interface ScriptDeclaration {
  readonly name: string;
  readonly src: string;
  readonly strategy?: ScriptStrategy;
  readonly attributes?: ScriptAttributes;
  readonly integrity?: string;
  readonly facade?: ScriptFacade;
  readonly category?: ConsentCategory;
}

export type ConsentDefaultMap = Readonly<
  Record<
    string,
    Readonly<
      Partial<Record<Exclude<ConsentCategory, "necessary">, ConsentDefault>>
    >
  >
>;

export type ScriptOverrideMap = Readonly<
  Record<string, Readonly<Record<string, ScriptStrategy | "off">>>
>;

export interface ScriptsSetting {
  readonly scripts: readonly ScriptDeclaration[];
  readonly pageTypes?: ScriptOverrideMap;
  readonly pages?: ScriptOverrideMap;
  readonly runtime?: ScriptRuntimeAdapter;
  readonly consentDefaults?: ConsentDefaultMap;
}

export function resolveConsentDefault(
  settings: ScriptsSetting,
  category: ConsentCategory,
  page: PageIdentity,
): ConsentDefault {
  if (category === "necessary") return "granted";
  return layerConsentDefault(settings.consentDefaults, category, page) ?? DEFAULT_CONSENT;
}

function layerConsentDefault(
  map: ConsentDefaultMap | undefined,
  category: Exclude<ConsentCategory, "necessary">,
  page: PageIdentity,
): ConsentDefault | undefined {
  if (map === undefined) return undefined;
  const naming = Object.keys(map).filter((key) => {
    const defaults = map[key];
    return defaults !== undefined && Object.hasOwn(defaults, category);
  });
  const winner = matchingPattern(parsePatterns(naming), page);
  return winner === undefined ? undefined : map[winner.key]?.[category];
}

export function resolveScriptStrategy(
  settings: ScriptsSetting,
  script: ScriptDeclaration,
  page: PageIdentity,
): ScriptStrategy | "off" {
  return (
    overridingLayer(settings, script.name, page)?.value ??
    script.strategy ??
    DEFAULT_SCRIPT_STRATEGY
  );
}

export const WORKER_FALLBACK_STRATEGY: ScriptStrategy = "idle";

/**
 * A categorized `worker` script takes the fallback too: no gate can wrap the
 * runtime's markup, so it would load without consent (#47).
 */
export function loadedScriptStrategy(
  settings: ScriptsSetting,
  script: ScriptDeclaration,
  page: PageIdentity,
): ScriptStrategy | "off" {
  const resolved = resolveScriptStrategy(settings, script, page);
  if (resolved !== "worker") return resolved;
  if (settings.runtime === undefined) return WORKER_FALLBACK_STRATEGY;
  return script.category === undefined || script.category === "necessary"
    ? resolved
    : WORKER_FALLBACK_STRATEGY;
}

export function workerFallbackWarning(
  settings: ScriptsSetting | undefined,
): string | undefined {
  if (settings === undefined || settings.runtime !== undefined) return undefined;
  const reaching = workerReachingScripts(settings);
  if (reaching.length === 0) return undefined;
  const subject =
    reaching.length === 1
      ? "1 script can resolve to the worker strategy and this site configures no script runtime, so it loads on idle instead"
      : `${String(reaching.length)} scripts can resolve to the worker strategy and this site configures no script runtime, so each of them loads on idle instead`;
  const lines = reaching.map(
    ({ name, door }) => `  ${JSON.stringify(name)} — ${door}`,
  );
  return `Script runtime: ${subject} — worker moves a script off the main thread, and core ships no mechanism to do that with because a framework that picked one would carry a vendor's runtime into every site that never asked for it; this is a warning and not a refusal because idle is the fallback spec §12 states for this case, and a site that did not want off-main-thread loading is served correctly by it — supply build.scripts.runtime, or declare strategy: "idle" to say the fallback is what you meant:\n${lines.join("\n")}`;
}

interface WorkerReaching {
  readonly name: string;
  readonly door: string;
}

function workerReachingScripts(settings: ScriptsSetting): WorkerReaching[] {
  const reaching: WorkerReaching[] = [];
  const named = new Set<string>();
  for (const script of settings.scripts) {
    const strategy = script.strategy ?? DEFAULT_SCRIPT_STRATEGY;
    if (strategy !== "worker" || named.has(script.name)) continue;
    named.add(script.name);
    reaching.push({
      name: script.name,
      door:
        script.strategy === undefined
          ? "declares no strategy, so it takes the worker default"
          : 'declares strategy "worker"',
    });
  }
  for (const layer of ["pageTypes", "pages"] as const) {
    const map = settings[layer];
    if (map === undefined) continue;
    for (const [key, overrides] of Object.entries(map)) {
      for (const [name, strategy] of Object.entries(overrides)) {
        if (strategy !== "worker" || named.has(name)) continue;
        named.add(name);
        reaching.push({
          name,
          door: `${layer} ${JSON.stringify(key)} sets "worker"`,
        });
      }
    }
  }
  return reaching;
}

/**
 * Ranks only the keys that name this script: a narrower key silent about it is
 * no opinion about it.
 */
function layerAnswer(
  map: ScriptOverrideMap | undefined,
  name: string,
  page: PageIdentity,
): { key: string; value: ScriptStrategy | "off" } | undefined {
  if (map === undefined) return undefined;
  const naming = Object.keys(map).filter((key) => {
    const overrides = map[key];
    return overrides !== undefined && Object.hasOwn(overrides, name);
  });
  const winner = matchingPattern(parsePatterns(naming), page);
  if (winner === undefined) return undefined;
  const value = map[winner.key]?.[name];
  return value === undefined ? undefined : { key: winner.key, value };
}

function overridingLayer(
  settings: ScriptsSetting,
  name: string,
  page: PageIdentity,
):
  | { layer: "pages" | "pageTypes"; key: string; value: ScriptStrategy | "off" }
  | undefined {
  for (const layer of ["pages", "pageTypes"] as const) {
    const answer = layerAnswer(settings[layer], name, page);
    if (answer !== undefined) {
      return { layer, key: answer.key, value: answer.value };
    }
  }
  return undefined;
}

const SHAPE_FIX =
  'scripts: { scripts: [{ name: "analytics", src: "https://example.com/analytics.js" }] }';
const SETTINGS_FIELDS = [
  "scripts",
  "pageTypes",
  "pages",
  "runtime",
  "consentDefaults",
];
const RUNTIME_FIX =
  'write the adapter the worker strategy loads through, as runtime: ({ scripts }) => ["<script>…</script>"]';
const DECLARATION_FIELDS = [
  "name",
  "src",
  "strategy",
  "facade",
  "category",
  "attributes",
  "integrity",
];
const CONSENT_DEFAULT_FIX =
  'write a map of consent category to granted or denied, such as { "de:/**": { analytics: "denied" } }';
const CONSENT_DEFAULT_SHAPE_FIX =
  'consentDefaults: { "de:/**": { analytics: "denied" } }';
const ATTRIBUTES_FIX =
  'write a map of data attribute to value, as attributes: { "data-domain": "example.com" }';
const INTEGRITY_FIX =
  'write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"';
const INTEGRITY_TOKEN = /^sha(?:256|384|512)-/;
const ATTRIBUTE_KEY_REASON =
  'not a data attribute name — write a key of the form data-<name>, such as "data-domain"';
/**
 * Mirrors `ScriptAttributes` and narrows nothing: `setAttribute` takes
 * `data-Domain` and `data-1` alike (#440).
 */
const ATTRIBUTE_NAME = /^data-.+$/s;
/** XML 1.0 fifth edition's `NameChar`: the names `setAttribute` throws on. */
const ATTRIBUTE_NAME_CHAR =
  /^[-.0-9:A-Z_a-z\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C\u200D\u203F\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]$/u;
const ATTRIBUTE_VALUE_REASON =
  'not an attribute value — write the text the vendor reads, such as "example.com"';
const FACADE_FIX =
  'declare the placeholder the page shows until the script loads, as facade: { html: "<button>Chat</button>" }';
const OVERRIDE_FIX =
  'write a map of script name to strategy or "off", such as { "/blog/**": { analytics: "idle" } }';
const OVERRIDE_SHAPE_FIX = 'pageTypes: { "/blog/**": { analytics: "idle" } }';
const DECLARATION_FIX =
  '{ name: "analytics", src: "https://example.com/analytics.js" }';

export function defineScripts(settings: ScriptsSetting): ScriptsSetting {
  const report = scriptsFaultReport(settings, SCRIPTS_WHERE);
  if (report !== undefined) throw new ConfigError(report);
  return settings;
}

const SCRIPTS_WHERE = "Script settings";

export function scriptsFaultReport(
  value: unknown,
  where: string,
  field?: string,
): string | undefined {
  const heading = field === undefined ? where : `${where}: "${field}"`;
  const subField = (name: string): string =>
    field === undefined ? name : `${field}.${name}`;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${heading}: must be an object declaring the site's third-party scripts — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (name: string): unknown =>
    Object.hasOwn(record, name) ? record[name] : undefined;
  const sections: string[] = [];

  const unknownFields = Object.keys(record).filter(
    (key) => !SETTINGS_FIELDS.includes(key),
  );
  if (unknownFields.length > 0) {
    sections.push(
      `${heading}: declares ${count(unknownFields.length, "field")} this build does not read — delete the field, or correct it to one of: ${SETTINGS_FIELDS.join(", ")}:\n${unknownFields
        .map((key) => `  ${JSON.stringify(key)}`)
        .join("\n")}`,
    );
  }

  const declared = read("scripts");
  if (!Array.isArray(declared)) {
    sections.push(
      `${heading}: declares no scripts to load — write scripts as a list of declarations, such as ${SHAPE_FIX}`,
    );
  } else if (declared.length === 0) {
    sections.push(
      `${heading}: declares an empty list of scripts, so the script layer would do nothing — list at least one, or declare no scripts at all`,
    );
  } else {
    sections.push(...declarationSections(declared, heading));
  }

  const usable = Array.isArray(declared) ? usableNames(declared) : undefined;
  const names = usable !== undefined && usable.size > 0 ? usable : undefined;
  sections.push(...facadeSections(declared, record, heading));

  const runtime = read("runtime");
  if (runtime !== undefined && typeof runtime !== "function") {
    sections.push(
      `${heading}: declares a script runtime this build cannot call — ${quote(runtime)} — ${RUNTIME_FIX}`,
    );
  }

  for (const name of ["pageTypes", "pages"] as const) {
    const map = read(name);
    if (map === undefined) continue;
    const report = overrideMapFaultReport(map, where, subField(name), names);
    if (report !== undefined) sections.push(report);
  }

  const consentDefaults = read("consentDefaults");
  if (consentDefaults !== undefined) {
    const report = consentDefaultsFaultReport(
      consentDefaults,
      where,
      subField("consentDefaults"),
    );
    if (report !== undefined) sections.push(report);
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

function declarationSections(
  declared: readonly unknown[],
  heading: string,
): string[] {
  const notDeclarations: string[] = [];
  const unknown: string[] = [];
  const faults: string[] = [];
  const sections: string[] = [];

  declared.forEach((script, index) => {
    const at = `scripts[${String(index)}]`;
    if (typeof script !== "object" || script === null || Array.isArray(script)) {
      notDeclarations.push(`  ${at} — ${quote(script)}`);
      return;
    }
    const fields = script as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!DECLARATION_FIELDS.includes(key)) {
        unknown.push(`  ${at} — ${JSON.stringify(key)}`);
      }
    }
    const value = (key: string): unknown =>
      Object.hasOwn(fields, key) ? fields[key] : undefined;
    for (const [key, reason] of declarationFaults(value)) {
      faults.push(`  ${at} — ${JSON.stringify(key)} — ${reason}`);
    }
  });

  if (notDeclarations.length > 0) {
    sections.push(
      `${heading}: declares ${
        notDeclarations.length === 1
          ? "1 entry that is not a script declaration"
          : `${String(notDeclarations.length)} entries that are not script declarations`
      } — write each as a name and a source, as ${DECLARATION_FIX}:\n${notDeclarations.join("\n")}`,
    );
  }
  if (unknown.length > 0) {
    sections.push(
      `${heading}: declares ${count(unknown.length, "script field")} this build does not read — delete the field, or correct it to one of: ${DECLARATION_FIELDS.join(", ")}:\n${unknown.join("\n")}`,
    );
  }
  if (faults.length > 0) {
    sections.push(
      `${heading}: declares ${count(faults.length, "script field")} that cannot be loaded from — declare each as the type its own line names:\n${faults.join("\n")}`,
    );
  }
  return sections;
}

function declarationFaults(
  value: (key: string) => unknown,
): readonly (readonly [string, string])[] {
  const faults: (readonly [string, string])[] = [];
  const name = value("name");
  if (typeof name !== "string" || name.trim() === "") {
    faults.push([
      "name",
      `${quote(name)} — not a script name — write the name an override addresses this script by, such as "analytics"`,
    ]);
  }
  const src = value("src");
  if (typeof src !== "string" || src.trim() === "") {
    faults.push([
      "src",
      `${quote(src)} — not a script source — write the URL or path the script is served from, such as "https://example.com/analytics.js"`,
    ]);
  }
  const strategy = value("strategy");
  if (strategy !== undefined && !isStrategy(strategy)) {
    faults.push(["strategy", `${quote(strategy)} — ${STRATEGY_REASON}`]);
  }
  const facade = value("facade");
  if (facade !== undefined) {
    if (typeof facade !== "object" || facade === null || Array.isArray(facade)) {
      faults.push([
        "facade",
        `${quote(facade)} — not a facade declaration — ${FACADE_FIX}`,
      ]);
    } else {
      const html = Object.hasOwn(facade, "html")
        ? (facade as Record<string, unknown>)["html"]
        : undefined;
      if (typeof html !== "string" || html.trim() === "") {
        faults.push([
          "facade.html",
          `${quote(html)} — not placeholder HTML — write the markup the page shows until the script loads, such as "<button>Chat</button>"`,
        ]);
      }
    }
  }
  const category = value("category");
  if (category !== undefined && !isCategory(category)) {
    faults.push(["category", `${quote(category)} — ${CATEGORY_REASON}`]);
  }
  faults.push(...attributeFaults(value("attributes")));
  const integrity = value("integrity");
  if (integrity !== undefined) {
    if (typeof integrity !== "string" || integrity.trim() === "") {
      faults.push([
        "integrity",
        `${quote(integrity)} — not integrity metadata — ${INTEGRITY_FIX}`,
      ]);
    } else if (
      !integrity.split(/[\t\n\f\r ]+/).some((token) => INTEGRITY_TOKEN.test(token))
    ) {
      faults.push([
        "integrity",
        `${quote(integrity)} — holds no sha256-, sha384- or sha512- hash, and a browser ignores integrity it cannot parse, so the script would load unchecked — ${INTEGRITY_FIX}`,
      ]);
    }
  }
  return faults;
}

function attributeFaults(
  attributes: unknown,
): readonly (readonly [string, string])[] {
  if (attributes === undefined) return [];
  if (
    typeof attributes !== "object" ||
    attributes === null ||
    Array.isArray(attributes)
  ) {
    return [
      [
        "attributes",
        `${quote(attributes)} — not an attribute map — ${ATTRIBUTES_FIX}`,
      ],
    ];
  }
  const faults: (readonly [string, string])[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (!ATTRIBUTE_NAME.test(key)) {
      faults.push([`attributes.${key}`, ATTRIBUTE_KEY_REASON]);
      continue;
    }
    const refused = refusedCharacters(key);
    if (refused.length > 0) {
      faults.push([`attributes.${key}`, attributeNameReason(refused)]);
    } else if (typeof value !== "string") {
      faults.push([
        `attributes.${key}`,
        `${quote(value)} — ${ATTRIBUTE_VALUE_REASON}`,
      ]);
    }
  }
  return faults;
}

function refusedCharacters(name: string): readonly string[] {
  return [...new Set(name)].filter((char) => !ATTRIBUTE_NAME_CHAR.test(char));
}

function attributeNameReason(refused: readonly string[]): string {
  const named = refused
    .map(
      (char) =>
        `${JSON.stringify(char)} (U+${(char.codePointAt(0) ?? 0)
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")})`,
    )
    .join(", ");
  return `a name setAttribute throws on — it holds ${count(refused.length, "character")} outside XML's Name production, ${named}, and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete ${refused.length === 1 ? "it" : "them"}, or write the name the vendor documents, such as "data-domain"`;
}

const STRATEGY_REASON = `not a loading strategy — write one of: ${SCRIPT_STRATEGIES.join(", ")}`;
const OVERRIDE_REASON = `not a loading strategy or "off" — write one of: ${OVERRIDE_VALUES.join(", ")}`;
const CATEGORY_REASON = `not a consent category — write one of: ${CONSENT_CATEGORIES.join(", ")}`;
const CONSENT_REASON = `not a consent default — write one of: ${CONSENT_DEFAULTS.join(", ")}`;

function isStrategy(value: unknown): value is ScriptStrategy {
  return (
    typeof value === "string" &&
    (SCRIPT_STRATEGIES as readonly string[]).includes(value)
  );
}

function isOverrideValue(value: unknown): value is ScriptStrategy | "off" {
  return (
    typeof value === "string" &&
    (OVERRIDE_VALUES as readonly string[]).includes(value)
  );
}

function isCategory(value: unknown): value is ConsentCategory {
  return (
    typeof value === "string" &&
    (CONSENT_CATEGORIES as readonly string[]).includes(value)
  );
}

function isConsentDefault(value: unknown): value is ConsentDefault {
  return (
    typeof value === "string" &&
    (CONSENT_DEFAULTS as readonly string[]).includes(value)
  );
}

function usableNames(declared: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const script of declared) {
    if (typeof script !== "object" || script === null) continue;
    const name = (script as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.trim() !== "") names.add(name);
  }
  return names;
}

function facadeSections(
  declared: unknown,
  record: Record<string, unknown>,
  heading: string,
): string[] {
  if (!Array.isArray(declared)) return [];
  const withoutFacade = new Set<string>();
  for (const script of declared) {
    if (typeof script !== "object" || script === null) continue;
    const fields = script as Record<string, unknown>;
    const name = fields["name"];
    if (typeof name !== "string" || name.trim() === "") continue;
    if (fields["facade"] === undefined) withoutFacade.add(name);
  }

  const duplicates: string[] = [];
  const positions = new Map<string, string[]>();
  declared.forEach((script, index) => {
    if (typeof script !== "object" || script === null) return;
    const name = (script as Record<string, unknown>)["name"];
    if (typeof name !== "string" || name.trim() === "") return;
    const at = positions.get(name) ?? [];
    at.push(`scripts[${String(index)}]`);
    positions.set(name, at);
  });
  for (const [name, at] of positions) {
    if (at.length > 1) {
      duplicates.push(`  ${JSON.stringify(name)} — ${at.join(", ")}`);
    }
  }

  const missing: string[] = [];
  const reported = new Set<string>();
  for (const script of declared) {
    if (typeof script !== "object" || script === null) continue;
    const fields = script as Record<string, unknown>;
    const name = fields["name"];
    if (typeof name !== "string" || !withoutFacade.has(name)) continue;
    if (fields["strategy"] === "facade" && !reported.has(name)) {
      reported.add(name);
      missing.push(`  ${JSON.stringify(name)} — declares strategy "facade"`);
    }
  }
  for (const layer of ["pageTypes", "pages"] as const) {
    const map = Object.hasOwn(record, layer) ? record[layer] : undefined;
    if (typeof map !== "object" || map === null) continue;
    for (const [key, overrides] of Object.entries(map)) {
      if (typeof overrides !== "object" || overrides === null) continue;
      for (const [name, strategy] of Object.entries(
        overrides as Record<string, unknown>,
      )) {
        if (strategy !== "facade") continue;
        if (!withoutFacade.has(name) || reported.has(name)) continue;
        reported.add(name);
        missing.push(
          `  ${JSON.stringify(name)} — ${layer} ${JSON.stringify(key)} sets "facade"`,
        );
      }
    }
  }

  const sections: string[] = [];
  if (duplicates.length > 0) {
    sections.push(
      `${heading}: declares ${count(duplicates.length, "name")} that more than one script uses, and an override addresses a script by name — give each script its own name:\n${duplicates.join("\n")}`,
    );
  }
  if (missing.length > 0) {
    sections.push(
      `${heading}: ${count(missing.length, "script")} can resolve to the facade strategy with no facade to render — ${FACADE_FIX}:\n${missing.join("\n")}`,
    );
  }
  return sections;
}

function overrideMapFaultReport(
  value: unknown,
  where: string,
  field: string,
  names: ReadonlySet<string> | undefined,
): string | undefined {
  return patternMapFaultReport({
    value,
    where,
    field,
    shapeFix: OVERRIDE_SHAPE_FIX,
    rule: {
      fault: (overrides) => {
        if (
          typeof overrides !== "object" ||
          overrides === null ||
          Array.isArray(overrides)
        ) {
          return `${quote(overrides)} — not a map of script name to strategy`;
        }
        const faults = Object.entries(overrides as Record<string, unknown>)
          .flatMap(([name, strategy]) => {
            if (names !== undefined && !names.has(name)) {
              return [
                `${JSON.stringify(name)} — not a declared script, and the declared scripts are ${[...names]
                  .map((declared) => JSON.stringify(declared))
                  .join(", ")}`,
              ];
            }
            if (!isOverrideValue(strategy)) {
              return [
                `${JSON.stringify(name)} — ${quote(strategy)} — ${OVERRIDE_REASON}`,
              ];
            }
            return [];
          });
        return faults.length === 0 ? undefined : faults.join("; ");
      },
      subject: [
        "declares % override no script can take",
        "declares % overrides no script can take",
      ],
      fix: OVERRIDE_FIX,
      ambiguousFix:
        "make one of the pair more specific, or give both the same strategies",
    },
  });
}

/**
 * No check against the declared scripts: a default may wait for its category's
 * first script.
 */
function consentDefaultsFaultReport(
  value: unknown,
  where: string,
  field: string,
): string | undefined {
  return patternMapFaultReport({
    value,
    where,
    field,
    shapeFix: CONSENT_DEFAULT_SHAPE_FIX,
    rule: {
      fault: (defaults) => {
        if (
          typeof defaults !== "object" ||
          defaults === null ||
          Array.isArray(defaults)
        ) {
          return `${quote(defaults)} — not a map of consent category to default`;
        }
        const faults = Object.entries(defaults as Record<string, unknown>)
          .flatMap(([category, declared]) => {
            if (!isCategory(category)) {
              return [`${JSON.stringify(category)} — ${CATEGORY_REASON}`];
            }
            if (category === "necessary") {
              return [
                `${JSON.stringify(category)} — a necessary script loads without waiting on consent, which is what the category means — delete the key, or give the script a category a visitor can withhold`,
              ];
            }
            if (!isConsentDefault(declared)) {
              return [
                `${JSON.stringify(category)} — ${quote(declared)} — ${CONSENT_REASON}`,
              ];
            }
            return [];
          });
        return faults.length === 0 ? undefined : faults.join("; ");
      },
      subject: [
        "declares % default no category can take",
        "declares % defaults no category can take",
      ],
      fix: CONSENT_DEFAULT_FIX,
      ambiguousFix:
        "make one of the pair more specific, or give both the same defaults",
    },
  });
}

export function workerConsentWarning(
  settings: ScriptsSetting | undefined,
): string | undefined {
  if (settings === undefined || settings.runtime === undefined) return undefined;
  const categories = new Map<string, ConsentCategory>();
  for (const script of settings.scripts) {
    if (script.category !== undefined && script.category !== "necessary") {
      categories.set(script.name, script.category);
    }
  }
  const reaching = workerReachingScripts(settings).filter((line) =>
    categories.has(line.name),
  );
  if (reaching.length === 0) return undefined;
  const subject =
    reaching.length === 1
      ? "1 script declares a consent category and can resolve to the worker strategy, so it loads on idle instead"
      : `${String(reaching.length)} scripts declare a consent category and can resolve to the worker strategy, so each of them loads on idle instead`;
  const lines = reaching.map(
    ({ name, door }) =>
      `  ${JSON.stringify(name)} — category ${JSON.stringify(categories.get(name))} — ${door}`,
  );
  return `Script consent: ${subject} — the consent gate this build writes lives in the loader that backs the main-thread strategies, and a worker script is loaded by the elements build.scripts.runtime returned, which core never reads, so leaving it there would load a categorized script with no gate on it at all; this is a warning and not a refusal because idle is the fallback spec §12 states for a worker script this build cannot deliver, and it is the strategy the gate does reach — declare strategy: "idle" to say the downgrade is what you meant, or drop the category and gate the script inside the adapter, which is the only place a worker script can be gated:\n${lines.join("\n")}`;
}

/** A site with no pages names no script, which would all be vacuously off. */
export function unloadedScriptWarning(
  settings: ScriptsSetting | undefined,
  pages: readonly PageIdentity[],
): string | undefined {
  if (settings === undefined || pages.length === 0) return undefined;
  const unloaded: { name: string; keys: readonly string[] }[] = [];
  for (const script of settings.scripts) {
    const keys = offEverywhere(settings, script, pages);
    if (keys !== undefined) unloaded.push({ name: script.name, keys });
  }
  if (unloaded.length === 0) return undefined;
  const subject =
    unloaded.length === 1
      ? '1 script resolves to "off" on every page this site builds, so no page loads it'
      : `${String(unloaded.length)} scripts resolve to "off" on every page this site builds, so no page loads any of them`;
  const lines = unloaded
    .map(({ name, keys }) => `  ${JSON.stringify(name)} — ${keys.join(", ")}`)
    .sort();
  return `Script reach: ${subject} — this site builds ${count(pages.length, "page")}, and an override takes a script off every page its key covers, so a key that covers them all leaves a declaration nothing acts on while it still reads in the config like a script that loads; this is a warning and not a refusal because every field of the declaration is well formed and a site mid-migration may have taken a script off every page on purpose — drop the declaration from build.scripts.scripts, or narrow the override that takes it off so at least one page keeps it:\n${lines.join("\n")}`;
}

function offEverywhere(
  settings: ScriptsSetting,
  script: ScriptDeclaration,
  pages: readonly PageIdentity[],
): readonly string[] | undefined {
  const keys = new Set<string>();
  for (const page of pages) {
    if (resolveScriptStrategy(settings, script, page) !== "off") return undefined;
    const answer = overridingLayer(settings, script.name, page);
    if (answer !== undefined) {
      keys.add(`${answer.layer} ${JSON.stringify(answer.key)} sets "off"`);
    }
  }
  return [...keys].sort();
}
