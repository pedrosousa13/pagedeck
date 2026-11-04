import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, inlineScriptFault, scriptRuntimeBase } from "@pagedeck/core";
import type {
  ScriptDeclaration,
  ScriptRuntimeAdapter,
  ScriptRuntimeFile,
  ScriptRuntimeLatePickup,
  ScriptRuntimeMarkup,
  ScriptRuntimeRequest,
} from "@pagedeck/core";
import { partytownSnippet } from "@qwik.dev/partytown/integration";
import type { PartytownConfig } from "@qwik.dev/partytown/integration";
import { libDirPath } from "@qwik.dev/partytown/utils";

export type PartytownForward =
  | string
  | readonly [name: string, settings?: { readonly preserveBehavior?: boolean }];

/** A vendor's https origin, to the path prefix on this site an upstream forwards to it. */
export type PartytownRoutes = Readonly<Record<string, string>>;

export interface PartytownOptions {
  readonly forward?: readonly PartytownForward[];
  readonly resolveUrl?: PartytownRoutes;
  readonly globalFns?: readonly string[];
  readonly mainWindowAccessors?: readonly string[];
  readonly loadScriptsOnMainThread?: readonly (string | RegExp)[];
  readonly fallbackTimeout?: number;
  readonly strictProxyHas?: boolean;
}

export interface PartytownRuntime extends ScriptRuntimeAdapter {
  (request: ScriptRuntimeRequest): Required<ScriptRuntimeMarkup>;
  readonly files: readonly ScriptRuntimeFile[];
  readonly checksIntegrity: false;
  readonly latePickup: ScriptRuntimeLatePickup;
  /** The CSP source expression for the snippet every worker page carries. */
  readonly inlineScriptHash: string;
}

/** No `partytown.js`: the snippet inlines it. No Atomics file: service-worker mode only (#275). */
const LIB_FILES = ["partytown-sw.js", "partytown-media.js", "partytown-sandbox-sw.html"];

const WHERE = 'Partytown runtime "build.scripts.runtime"';

/**
 * Partytown 1.0.3 reads the next unclaimed `text/partytown` script on
 * `ptupdate`, and on a `MutationObserver` that sees one added (#281).
 */
const LATE_PICKUP: ScriptRuntimeLatePickup = { type: "text/partytown", event: "ptupdate" };

/**
 * The snippet with no `lib`, written beside the lib files so that a change to
 * any option moves the directory, and the build renders again every page that
 * named the old one (#275).
 */
const CONFIG_FILE = "partytown-config.txt";

const ACCEPTED_OPTIONS = [
  "forward",
  "resolveUrl",
  "globalFns",
  "mainWindowAccessors",
  "loadScriptsOnMainThread",
  "fallbackTimeout",
  "strictProxyHas",
] as const satisfies readonly (keyof PartytownOptions)[];

/** The options the snippet carries as written, which an option's text can break out of. */
const WRITTEN_OPTIONS = [
  "forward",
  "globalFns",
  "mainWindowAccessors",
  "loadScriptsOnMainThread",
] as const;

const ROUTES_FIX =
  'resolveUrl: { "https://collector.example": "/vendor/collector/" }';

const PATH_PREFIX = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)+$/;

export function definePartytown(options: PartytownOptions = {}): PartytownRuntime {
  const routes = options.resolveUrl;
  const written = writtenTexts(options);
  const reports = [
    routes === undefined ? undefined : routesFaultReport(routes),
    optionsFaultReport(options, written),
    writtenOptionsFaultReport(written),
  ].filter((report) => report !== undefined);
  if (reports.length > 0) throw new ConfigError(reports.join("\n"));

  const { resolveUrl: _, ...passed } = options;
  const snippetAt = (lib: string): string =>
    partytownSnippet({
      ...passed,
      lib,
      ...(routes === undefined ? {} : { resolveUrl: resolveUrlFunction(routes) }),
    } as PartytownConfig);
  const config = snippetAt("/");
  const lib = libDirPath();
  const files: readonly ScriptRuntimeFile[] = [
    ...LIB_FILES.map((name) => ({ name, contents: readFileSync(join(lib, name)) })),
    { name: CONFIG_FILE, contents: config },
  ];
  const snippet = snippetAt(scriptRuntimeBase(files));
  const emitted = emittedSnippetFaultReport([config, snippet]);
  if (emitted !== undefined) throw new ConfigError(emitted);
  const element = `<script>${snippet}</script>`;

  const runtime = ({ scripts }: ScriptRuntimeRequest): Required<ScriptRuntimeMarkup> => ({
    head: [element],
    body: scripts.map(scriptElement),
  });
  return Object.assign(runtime, {
    files,
    checksIntegrity: false as const,
    latePickup: LATE_PICKUP,
    inlineScriptHash: `'sha256-${createHash("sha256").update(snippet, "utf8").digest("base64")}'`,
  });
}

function optionsFaultReport(
  options: PartytownOptions,
  written: WrittenTexts,
): string | undefined {
  const accepted: readonly string[] = ACCEPTED_OPTIONS;
  const faults = Object.entries(options).flatMap(([name, value]: [string, unknown]) => {
    if (!accepted.includes(name)) {
      return [`  ${JSON.stringify(name)} — not an option this runtime takes`];
    }
    if (value === undefined) return [];
    if (
      name === "fallbackTimeout" &&
      !(typeof value === "number" && Number.isFinite(value) && value >= 0)
    ) {
      return [`  "fallbackTimeout" — ${describedValue(value)} is not a finite number 0 or more`];
    }
    if (name === "strictProxyHas" && typeof value !== "boolean") {
      return [`  "strictProxyHas" — ${describedValue(value)} is not true or false`];
    }
    const text = written.get(name);
    if (text instanceof Error) {
      return [`  ${JSON.stringify(name)} — cannot be read (${text.message}) — pass a plain value`];
    }
    return [];
  });
  if (faults.length === 0) return undefined;
  return `${WHERE}: ${String(faults.length)} ${
    faults.length === 1 ? "option" : "options"
  } this runtime cannot take — write fallbackTimeout as a finite number of milliseconds, 0 or more, strictProxyHas as true or false, and no option but ${ACCEPTED_OPTIONS.slice(0, -1).join(", ")} and ${ACCEPTED_OPTIONS[ACCEPTED_OPTIONS.length - 1]}:\n${faults.join("\n")}`;
}

function describedValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "function") return "a function";
  if (typeof value === "object" && value !== null) return "an object";
  if (typeof value === "bigint") return `${String(value)}n`;
  return String(value);
}

/** Catches an option that read safe when checked and different when built (#290). */
function emittedSnippetFaultReport(texts: readonly string[]): string | undefined {
  for (const text of texts) {
    const fault = inlineScriptFault(text);
    if (fault !== undefined) {
      return `${WHERE}: the snippet Partytown writes ${fault}; no option held it when checked, so pass each option as a plain value that reads the same every time`;
    }
  }
  return undefined;
}

/** The snippet Partytown writes for each written option set, or what reading the option threw. */
type WrittenTexts = ReadonlyMap<string, string | Error>;

function writtenTexts(options: PartytownOptions): WrittenTexts {
  return new Map(
    WRITTEN_OPTIONS.flatMap((name): [string, string | Error][] => {
      const value = options[name];
      if (value === undefined) return [];
      try {
        return [[name, partytownSnippet({ [name]: value } as PartytownConfig)]];
      } catch (error) {
        return [
          [name, error instanceof Error ? error : new Error("a value that is not an Error was thrown")],
        ];
      }
    }),
  );
}

function writtenOptionsFaultReport(written: WrittenTexts): string | undefined {
  const faults = [...written].flatMap(([name, text]) => {
    const fault = text instanceof Error ? undefined : inlineScriptFault(text);
    return fault === undefined ? [] : [`  ${JSON.stringify(name)} — ${fault}`];
  });
  if (faults.length === 0) return undefined;
  return `${WHERE}: ${String(faults.length)} ${
    faults.length === 1 ? "option holds" : "options hold"
  } a sequence that cannot sit inside the snippet's <script> element, which carries each option as written — take the sequence out of ${
    faults.length === 1 ? "it" : "each"
  }:\n${faults.join("\n")}`;
}

function routesFaultReport(routes: PartytownRoutes): string | undefined {
  const faults: string[] = [];
  for (const [origin, prefix] of Object.entries(routes)) {
    const prefixFault = typeof prefix !== "string" || !isPathPrefix(prefix);
    const shown = prefixFault
      ? `${JSON.stringify(origin)} → ${JSON.stringify(prefix)}`
      : JSON.stringify(origin);
    const reason = originFault(origin);
    if (reason !== undefined) {
      faults.push(
        `  ${shown} — ${reason}${prefixFault ? ", and not a path prefix on this site" : ""}`,
      );
    } else if (prefixFault) {
      faults.push(`  ${shown} — not a path prefix on this site`);
    }
  }
  if (faults.length === 0) return undefined;
  return `${WHERE}: "resolveUrl" declares ${String(faults.length)} ${
    faults.length === 1 ? "route" : "routes"
  } this runtime cannot take — a route sends a request for one vendor origin to one path prefix on this site, which an upstream forwards to that origin, so a page cannot steer it anywhere else — write each key as the https origin of a vendor's DNS name, with no path, and each value as a path prefix that starts and ends with "/", such as ${ROUTES_FIX}:\n${faults.join("\n")}`;
}

/** The parsed host, not the key: the URL parser respells `127.1`, `0x7f.1` and `LOCALHOST`. */
function originFault(key: string): string | undefined {
  const url = URL.canParse(key) ? new URL(key) : undefined;
  if (
    url === undefined ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^https:\/\/[^/?#]*\/?$/i.test(key)
  ) {
    return "not an https origin with nothing after the host";
  }
  if (!isDnsName(url.hostname)) {
    return 'names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name';
  }
  if (url.origin !== key) {
    return `not written as the origin it names — write it as ${JSON.stringify(url.origin)}`;
  }
  return undefined;
}

/** The URL parser has already normalized every IPv4 spelling to dotted decimal. */
function isDnsName(host: string): boolean {
  return (
    host.includes(".") &&
    !host.endsWith(".") &&
    !host.startsWith("[") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
    !host.endsWith(".localhost")
  );
}

function isPathPrefix(value: string): boolean {
  return PATH_PREFIX.test(value) && !value.split("/").includes("..");
}

/**
 * Source text, not a closure: Partytown serializes the function and rebuilds
 * it inside its worker, where nothing this module closes over exists.
 */
function resolveUrlFunction(routes: PartytownRoutes): (url: URL) => URL | undefined {
  const table = JSON.stringify(routes);
  return new Function(
    "url",
    "location",
    "type",
    `if(type==="iframe")return;var routes=${table};if(Object.prototype.hasOwnProperty.call(routes,url.origin))return new URL(routes[url.origin]+url.pathname.slice(1)+url.search,location.href)`,
  ) as (url: URL) => URL | undefined;
}

function scriptElement(script: ScriptDeclaration): string {
  const attributes = Object.entries(script.attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `<script type="text/partytown" src="${escapeAttribute(script.src)}"${attributes}></script>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
